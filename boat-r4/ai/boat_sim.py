"""VARUNA boat simulator: thousands of boats at once (numpy, vectorised), for training
the autonomous "captain" with reinforcement learning.

The boat (the user's real one): 0.60 m long, 0.40 m wide, 1.5 kg, 12.7 cm tall,
1.27 cm in the water; two 2200 KV BLDC motors with pusher props on posts 30 cm
above the deck, an air fin behind each prop (each on its own servo), a mesh ramp
hinged on the bow (lowered = collecting), an open well (the bin) in the middle.

Each boat gets its OWN physics, randomised around those numbers (domain
randomisation, like NVIDIA's robots): motor thrust, motor and servo lag, phone /
USB delay, fin power, drag, mass, wind and gusts, current, waves, GPS drift and
noise, compass offset (and the motors' pull on it), gyro bias, camera misses and
false sightings. A policy that works on all of them works on the real boat.
`difficulty` (0..1, per boat) scales how wild the randomisation, the weather,
the noise and the task are (curriculum). When the real boat's logs have been
analysed (sysid/out/boat_model.json), its fitted numbers become the centre.

Frames: world = north (n), east (e); heading psi = compass (0 north, clockwise +).
Body: u forward, v to the right, r turn rate (+ = turning right).

Control 20 Hz (the phone), physics 100 Hz.
Policy actions: throttle 0..1, steer -1..1 (fins + motor difference, mixed like
the ESP32 brain), ramp: 0 lower (collect) / 1 raise (hold) / 2 tip into the bin.
"""
import json
import math
import os

import numpy as np

F = np.float32
TAU = 2 * math.pi

# ------------------------------------------------------------------ the real boat
BOAT = dict(L=0.60, B=0.40, mass=1.5, height=0.127, draft=0.0127, motor_height=0.30, kv=2200)

# nominal value, randomisation (+-fraction at difficulty 1)
NOMINAL = {
    "t_max": (3.2, 0.40),       # N per motor at full throttle (2200 KV, small 5-blade pusher, 3S)
    "thr_exp": (1.7, 0.20),     # thrust ~ throttle^exp
    "motor_tau": (0.08, 0.60),  # s, prop spin-up lag
    "latency": (0.06, 0.70),    # s, phone -> USB -> ESP32 -> ESC / servo
    "fin_eta": (0.60, 0.35),    # share of the prop wash a full fin turns sideways
    "fin_max": (0.52, 0.15),    # rad, fin travel (30 deg)
    "fin_rate": (7.0, 0.35),    # rad/s, fin servo speed
    "l_fin": (0.33, 0.08),      # m, centre of the boat -> fins
    "y_mot": (0.11, 0.15),      # m, centre line -> each motor
    "mass": (1.5, 0.20),        # kg (+ catch, + battery)
    "iz_k": (1.0, 0.25),        # yaw inertia vs a flat plate 0.60 x 0.40
    "xu": (0.5, 0.60),          # N/(m/s)    forward drag, linear
    "xuu": (3.2, 0.35),         # N/(m/s)^2  forward drag (blunt flat bow, 1.27 cm draft)
    "yv": (2.0, 0.50),          # sideways drag, linear
    "yvv": (14.0, 0.40),        # sideways drag (flat bottom + keel strips): it skids
    "nr": (0.02, 0.50),         # N m/(rad/s)    turning drag
    "nrr": (0.10, 0.50),        # N m/(rad/s)^2
    "ramp_xuu": (2.2, 0.45),    # extra forward drag of the lowered ramp
    "ramp_yvv": (3.0, 0.50),    # its sideways drag at the bow (makes it less stable)
    "a_cdA_front": (0.11, 0.30),  # m^2 x Cd, above-water front (hull + posts + motors)
    "a_cdA_side": (0.09, 0.30),   # m^2 x Cd, above-water side
    "x_cp": (-0.06, 1.0),       # m, where the side wind pushes (posts at the stern: behind centre)
    "batt_min": (14.0, 0.40),   # minutes of full throttle in a full battery
}
RAMP_X = 0.50          # m, centre -> the ramp's under-water lip
RHO_W, RHO_A = 1000.0, 1.2

# task
M_BOTTLES, P_PHANTOM, W_WEEDS, K_POLY = 16, 3, 4, 16
K_TARGETS, K_WEEDS = 4, 2
RAY_ANGLES = np.radians([0, 30, -30, 65, -65, 110, -110, 180]).astype(F)
RAY_MAX = 15.0
RAMP_CAP, BIN_CAP = 6, 30
CAM_FOV, CAM_RANGE = math.radians(35), 8.0
EP_SECONDS = 180.0

OBS_DIM = 63

# reward weights; VARUNA_POLISH=1 (set by train.py --polish) asks for a straighter, tidier captain
POLISH = os.environ.get("VARUNA_POLISH") == "1"
W_YAW = 0.03 if POLISH else 0.004          # turning when it need not: weaving costs more
W_RAMP_IDLE = 0.03 if POLISH else 0.008    # ramp down with nothing ahead (drag, weed)
W_WEED = 8.0 if POLISH else 4.0
W_JERK = 0.05 if POLISH else 0.02
PRIV_DIM = OBS_DIM + 22


def load_fitted(path=None):
    """Centre the randomisation on the real boat's logged numbers when there are some."""
    path = path or os.path.join(os.path.dirname(__file__), "..", "sysid", "out", "boat_model.json")
    nom = {k: v for k, v in NOMINAL.items()}
    if not os.path.exists(path):
        return nom, False
    m = json.load(open(path))
    s, y = (m.get("surge") or {}).get("coef", {}), (m.get("yaw") or {}).get("coef", {})
    mass = NOMINAL["mass"][0]
    # surge: du/dt = k_thrust*T - d_lin*u - d_quad*u|u|, T = (L^2+R^2)/2  ->  per-motor force, drag in N
    if s.get("k_thrust", 0) > 0:
        nom["t_max"] = (s["k_thrust"] * mass, 0.2)
    if s.get("d_lin", -1) >= 0:
        nom["xu"] = (s["d_lin"] * mass, 0.3)
    if s.get("d_quad", 0) > 0:
        nom["xuu"] = (s["d_quad"] * mass, 0.25)
    if s.get("d_scoop", 0) > 0:
        nom["ramp_xuu"] = (s["d_scoop"] * mass, 0.3)
    if m.get("surge", {}).get("delay_s"):
        nom["latency"] = (max(0.02, m["surge"]["delay_s"] - nom["motor_tau"][0]), 0.4)
    del y  # yaw terms are checked against the sim in sim_check.py; the fin model stays physical
    return nom, True


class VecBoat:
    def __init__(self, n, seed=0, difficulty=0.0, nominal=None, ep_seconds=EP_SECONDS):
        self.n = n
        self.rng = np.random.default_rng(seed)
        self.nom = nominal or NOMINAL
        self.ctrl_dt, self.sub = 0.05, 5
        self.dt = self.ctrl_dt / self.sub
        self.max_steps = int(ep_seconds / self.ctrl_dt)
        self.diff_max = float(difficulty)
        self.LAT_BUF = 24
        z = lambda *s: np.zeros((n,) + s, F)  # noqa: E731
        self.p = {k: z() for k in self.nom}
        for k in ("pos", "vel_c", "wind", "gps_bias"):
            setattr(self, k, z(2))
        for k in ("psi", "u", "v", "r", "thr_l", "thr_r", "fin", "ramp", "soc", "wave", "gust", "diff",
                  "comp_bias", "gyro_bias", "ramp_load", "weed_load", "bin", "t", "phi", "home_flag",
                  "prev_thr", "prev_steer", "prev_ramp_pos", "lost_since", "wp_i", "fp_rate"):
            setattr(self, k, z())
        self.steps = np.zeros(n, np.int32)
        self.lat_steps = np.zeros(n, np.int32)
        self.cmd_buf = z(self.LAT_BUF, 3)
        self.buf_i = 0
        self.prev_ramp_act = np.ones(n, np.int64)
        self.r_hist = z(3)
        self.s_hist = z(2)
        self.poly = z(K_POLY, 2)
        self.home = z(2)
        self.wps = z(6, 2)
        self.b_pos = z(M_BOTTLES, 2)
        self.b_alive = np.zeros((n, M_BOTTLES), bool)
        self.m_pos = z(M_BOTTLES + P_PHANTOM, 2)
        self.m_valid = np.zeros((n, M_BOTTLES + P_PHANTOM), bool)
        self.m_seen = z(M_BOTTLES + P_PHANTOM)
        self.m_miss = z(M_BOTTLES + P_PHANTOM)
        self.w_pos = z(W_WEEDS, 2)
        self.w_rad = z(W_WEEDS)
        self.w_on = np.zeros((n, W_WEEDS), bool)
        self.goal_kind = np.zeros(n, np.int32)
        self.stats = {k: z() for k in ("caught", "binned", "lost", "weed", "collide", "home", "flat", "ep_ret",
                                       "dist", "yaw_abs", "straight_t")}
        self.reset_envs(np.arange(n))

    # ------------------------------------------------------------------ episodes
    def reset_envs(self, idx):
        if len(idx) == 0:
            return
        rng, k = self.rng, len(idx)
        U = lambda lo=-1.0, hi=1.0, *s: rng.uniform(lo, hi, (k,) + s).astype(F)  # noqa: E731
        d = (rng.uniform(0, 1, k) ** 0.7 * self.diff_max).astype(F)        # easy ones stay in the mix
        self.diff[idx] = d
        for name, (nom, frac) in self.nom.items():
            self.p[name][idx] = nom * (1 + frac * d * U())
        self.p["x_cp"][idx] = self.nom["x_cp"][0] + 0.06 * d * U()
        # the pond: a lumpy round shape, 10..35 m across
        R = 8 + 9 * d * U(0, 1) + U(0, 3)
        ang = np.linspace(0, TAU, K_POLY, endpoint=False).astype(F)
        lump = np.cumsum(U(-1, 1, K_POLY) * 0.12, axis=1)
        lump -= lump.mean(1, keepdims=True)
        rad = R[:, None] * (1 + np.clip(lump, -0.3, 0.3))
        self.poly[idx, :, 0] = rad * np.cos(ang)
        self.poly[idx, :, 1] = rad * np.sin(ang)
        # home: just inside the shore; the boat starts there, bow roughly into the pond
        a0 = U(0, TAU)
        rh = R * 0.75
        self.home[idx, 0], self.home[idx, 1] = rh * np.cos(a0), rh * np.sin(a0)
        self.pos[idx] = self.home[idx] + U(-1.5, 1.5, 2)
        self.psi[idx] = (np.arctan2(-self.home[idx, 1], -self.home[idx, 0]) + U() * (0.4 + 1.2 * d)) % TAU
        for a in ("u", "v", "r", "thr_l", "thr_r", "fin", "ramp_load", "weed_load", "bin", "t", "wave", "gust",
                  "prev_thr", "prev_steer", "home_flag", "lost_since", "wp_i"):
            getattr(self, a)[idx] = 0
        self.ramp[idx] = 0
        self.prev_ramp_pos[idx] = 0
        self.prev_ramp_act[idx] = 1
        self.r_hist[idx] = 0
        self.s_hist[idx] = 0
        self.steps[idx] = 0
        self.cmd_buf[idx] = 0
        self.lat_steps[idx] = np.clip(np.round(self.p["latency"][idx] / self.dt), 1, self.LAT_BUF - 1).astype(np.int32)
        self.soc[idx] = np.where(rng.uniform(0, 1, k) < 0.25 * d, U(0.12, 0.4), U(0.85, 1.0))
        # weather: wind 0..5 m/s with gusts, current 0..0.15 m/s, small waves
        ws, wd = 5.0 * d * U(0, 1) ** 1.3, U(0, TAU)
        self.wind[idx, 0], self.wind[idx, 1] = -ws * np.cos(wd), -ws * np.sin(wd)
        cs, cd = 0.15 * d * U(0, 1), U(0, TAU)
        self.vel_c[idx, 0], self.vel_c[idx, 1] = cs * np.cos(cd), cs * np.sin(cd)
        # sensors: phone GPS drift, compass offset, gyro bias (always some, more when harder)
        sc = 0.35 + 0.65 * d
        self.gps_bias[idx] = U(-1, 1, 2) * 1.5 * sc[:, None]
        self.comp_bias[idx] = np.radians(8) * sc * U()
        self.gyro_bias[idx] = np.radians(1.0) * sc * U()
        self.fp_rate[idx] = 0.004 * d
        # bottles: scattered, some in clumps, some at weed edges; weeds: 0..4 patches
        nb = rng.integers(5, M_BOTTLES + 1, k)
        self.b_alive[idx] = np.arange(M_BOTTLES)[None] < nb[:, None]
        rr = np.sqrt(U(0, 1, M_BOTTLES)) * (R[:, None] * 0.62)
        th = U(0, TAU, M_BOTTLES)
        self.b_pos[idx, :, 0], self.b_pos[idx, :, 1] = rr * np.cos(th), rr * np.sin(th)
        clump = rng.uniform(0, 1, (k, M_BOTTLES)) < 0.35
        cc = self.b_pos[idx, :1]
        self.b_pos[idx] = np.where(clump[..., None], cc + U(-1.5, 1.5, M_BOTTLES, 2), self.b_pos[idx])
        nw = (rng.uniform(0, 1, k) * (W_WEEDS + 1) * d).astype(int)
        self.w_on[idx] = np.arange(W_WEEDS)[None] < nw[:, None]
        wr, wt = np.sqrt(U(0, 1, W_WEEDS)) * R[:, None] * 0.55, U(0, TAU, W_WEEDS)
        self.w_pos[idx, :, 0], self.w_pos[idx, :, 1] = wr * np.cos(wt), wr * np.sin(wt)
        self.w_rad[idx] = U(0.8, 3.0, W_WEEDS)
        # no weed patch on top of home
        far = np.linalg.norm(self.w_pos[idx] - self.home[idx, None], axis=-1) > self.w_rad[idx] + 3
        self.w_on[idx] &= far
        edge = (rng.uniform(0, 1, (k, M_BOTTLES)) < 0.2) & self.w_on[idx][:, :1]
        ea = U(0, TAU, M_BOTTLES)
        rim = self.w_pos[idx, :1] + (self.w_rad[idx, :1, None] + U(-0.4, 0.4, M_BOTTLES, 1)) * np.stack(
            [np.cos(ea), np.sin(ea)], -1)
        self.b_pos[idx] = np.where(edge[..., None], rim, self.b_pos[idx])
        # keep bottles out of the bin's start and inside the pond
        self.b_pos[idx] *= np.clip((R[:, None, None] * 0.7) / np.maximum(1e-3, np.linalg.norm(self.b_pos[idx], axis=-1, keepdims=True)), 0, 1)
        # search waypoints: a loop around the pond
        wa = a0[:, None] + np.linspace(0.9, TAU - 0.9, 6)[None].astype(F)
        self.wps[idx, :, 0], self.wps[idx, :, 1] = 0.45 * R[:, None] * np.cos(wa), 0.45 * R[:, None] * np.sin(wa)
        self.m_valid[idx] = False
        self.m_miss[idx] = 0
        self.m_seen[idx] = 0
        self.goal_kind[idx] = -1
        for s in self.stats.values():
            s[idx] = 0
        self._sense(idx, first=True)
        self.phi[idx] = self._potential(idx)

    # ------------------------------------------------------------------ physics (100 Hz)
    def _physics(self, thr, steer):
        p, dt = self.p, self.dt
        n = self.n
        ar = np.arange(n)
        # the brain's mixer: fins = steer; the outer motor a little harder (AB_DIFF_MIX 0.3)
        mix = 0.3 * steer
        cl = np.clip(thr * (1 + mix), 0, 1)
        cr = np.clip(thr * (1 - mix), 0, 1)
        for _ in range(self.sub):
            # phone -> USB -> ESP32 delay
            self.cmd_buf[ar, self.buf_i % self.LAT_BUF] = np.stack([cl, cr, steer], -1)
            j = (self.buf_i - self.lat_steps) % self.LAT_BUF
            cmd = self.cmd_buf[ar, j]
            self.buf_i += 1
            k = np.minimum(1.0, dt / p["motor_tau"])
            self.thr_l += (cmd[:, 0] - self.thr_l) * k
            self.thr_r += (cmd[:, 1] - self.thr_r) * k
            df = np.clip(cmd[:, 2] - self.fin, -p["fin_rate"] * dt / p["fin_max"], p["fin_rate"] * dt / p["fin_max"])
            self.fin += df
            batt = 0.82 + 0.18 * self.soc
            tl = p["t_max"] * batt * np.power(np.maximum(self.thr_l, 0), p["thr_exp"])
            tr = p["t_max"] * batt * np.power(np.maximum(self.thr_r, 0), p["thr_exp"])
            tt = tl + tr
            delta = self.fin * p["fin_max"]
            c, s = np.cos(self.psi), np.sin(self.psi)
            # water and air relative to the boat
            cu = self.vel_c[:, 0] * c + self.vel_c[:, 1] * s
            cv = -self.vel_c[:, 0] * s + self.vel_c[:, 1] * c
            ur, vr = self.u - cu, self.v - cv
            g = 1 + self.gust
            wn, we = self.wind[:, 0] * g, self.wind[:, 1] * g
            awu = wn * c + we * s - self.u
            awv = -wn * s + we * c - self.v
            lowered = np.clip(self.ramp, 0, 1)
            fside = p["fin_eta"] * tt * np.sin(delta)
            vb = vr + RAMP_X * self.r
            f_ramp_y = -lowered * p["ramp_yvv"] * vb * np.abs(vb)
            y_air = 0.5 * RHO_A * p["a_cdA_side"] * awv * np.abs(awv)
            X = (tt * (1 - p["fin_eta"] * (1 - np.cos(delta))) - p["xu"] * ur - p["xuu"] * ur * np.abs(ur)
                 - lowered * (p["ramp_xuu"] * (1 + 0.4 * np.minimum(self.weed_load, 3))) * ur * np.abs(ur)
                 + 0.5 * RHO_A * p["a_cdA_front"] * awu * np.abs(awu))
            Y = -fside - p["yv"] * vr - p["yvv"] * vr * np.abs(vr) + f_ramp_y + y_air
            N = (fside * p["l_fin"] + (tl - tr) * p["y_mot"] - p["nr"] * self.r - p["nrr"] * self.r * np.abs(self.r)
                 + RAMP_X * f_ramp_y + p["x_cp"] * y_air + self.wave)
            m = p["mass"]
            mu, mv = m * 1.05, m * 1.25
            iz = p["iz_k"] * m * (BOAT["L"] ** 2 + BOAT["B"] ** 2) / 12 * 1.2
            du = (X + mv * self.v * self.r) / mu
            dv = (Y - mu * self.u * self.r) / mv
            dr = N / iz
            self.u += du * dt
            self.v += dv * dt
            self.r += dr * dt
            self.pos[:, 0] += (self.u * c - self.v * s) * dt
            self.pos[:, 1] += (self.u * s + self.v * c) * dt
            self.psi = (self.psi + self.r * dt) % TAU
            # gusts and waves: slow random wobbles
            self.gust += (-self.gust * dt / 3.0) + 0.3 * self.diff * math.sqrt(2 * dt / 3.0) * self.rng.standard_normal(n).astype(F)
            self.wave += (-self.wave * dt / 0.5) + 0.03 * self.diff * math.sqrt(2 * dt / 0.5) * self.rng.standard_normal(n).astype(F)
            self.soc -= dt * (0.02 + (tt / (2 * p["t_max"])) ** 1.2) / (p["batt_min"] * 60)
        return tt

    # ------------------------------------------------------------------ geometry helpers
    def _body(self, pts, pos=None, psi=None):
        """World points (n, m, 2) -> body x forward, y right, relative to pos / psi."""
        pos = self.pos if pos is None else pos
        psi = self.psi if psi is None else psi
        d = pts - pos[:, None]
        c, s = np.cos(psi)[:, None], np.sin(psi)[:, None]
        return d[..., 0] * c + d[..., 1] * s, -d[..., 0] * s + d[..., 1] * c

    def _rays(self, pos, psi):
        a = psi[:, None] + RAY_ANGLES[None]                      # (n, 8)
        dx, dy = np.cos(a)[..., None], np.sin(a)[..., None]
        p0 = self.poly[:, None]                                  # (n, 1, K, 2)
        p1 = np.roll(self.poly, -1, axis=1)[:, None]
        ex, ey = p1[..., 0] - p0[..., 0], p1[..., 1] - p0[..., 1]
        wx, wy = p0[..., 0] - pos[:, None, None, 0], p0[..., 1] - pos[:, None, None, 1]
        den = dx * ey - dy * ex
        den = np.where(np.abs(den) < 1e-6, 1e-6, den)
        t = (wx * ey - wy * ex) / den
        s = (wx * dy - wy * dx) / den
        hit = (t > 0) & (s >= 0) & (s <= 1)
        return np.where(hit, t, RAY_MAX).min(-1).clip(0, RAY_MAX)

    def _inside(self, pt):
        """Point (n, 2) inside the pond polygon? (ray crossing count)"""
        p0, p1 = self.poly, np.roll(self.poly, -1, axis=1)
        y = pt[:, None, 1]
        cond = (p0[..., 1] > y) != (p1[..., 1] > y)
        xint = p0[..., 0] + (y - p0[..., 1]) * (p1[..., 0] - p0[..., 0]) / np.where(
            np.abs(p1[..., 1] - p0[..., 1]) < 1e-9, 1e-9, p1[..., 1] - p0[..., 1])
        return ((cond & (pt[:, None, 0] < xint)).sum(-1) % 2) == 1

    # ------------------------------------------------------------------ sensors (what the phone knows)
    def _sense(self, idx=None, first=False):
        idx = np.arange(self.n) if idx is None else idx
        rng = self.rng
        k = len(idx)
        sc = 0.35 + 0.65 * self.diff[idx]
        # GPS: slow drift + noise, a little late
        self.gps_bias[idx] += (-self.gps_bias[idx] * self.ctrl_dt / 25.0
                               + 1.2 * sc[:, None] * math.sqrt(2 * self.ctrl_dt / 25.0) * rng.standard_normal((k, 2)))
        c, s = np.cos(self.psi[idx]), np.sin(self.psi[idx])
        vn, ve = self.u[idx] * c - self.v[idx] * s, self.u[idx] * s + self.v[idx] * c
        self.est_pos = getattr(self, "est_pos", np.zeros((self.n, 2), F))
        self.est_psi = getattr(self, "est_psi", np.zeros(self.n, F))
        self.est_uv = getattr(self, "est_uv", np.zeros((self.n, 2), F))
        self.est_r = getattr(self, "est_r", np.zeros(self.n, F))
        lag = 0.15
        self.est_pos[idx, 0] = self.pos[idx, 0] - vn * lag + self.gps_bias[idx, 0] + 0.3 * sc * rng.standard_normal(k)
        self.est_pos[idx, 1] = self.pos[idx, 1] - ve * lag + self.gps_bias[idx, 1] + 0.3 * sc * rng.standard_normal(k)
        # compass: offset + the motors' magnetic pull + noise
        pull = np.radians(4) * sc * ((self.thr_l[idx] + self.thr_r[idx]) / 2)
        self.est_psi[idx] = (self.psi[idx] + self.comp_bias[idx] + pull
                             + np.radians(1.5) * sc * rng.standard_normal(k)) % TAU
        vnm = vn + 0.07 * sc * rng.standard_normal(k)
        vem = ve + 0.07 * sc * rng.standard_normal(k)
        ce, se = np.cos(self.est_psi[idx]), np.sin(self.est_psi[idx])
        self.est_uv[idx, 0] = vnm * ce + vem * se
        self.est_uv[idx, 1] = -vnm * se + vem * ce
        self.est_r[idx] = self.r[idx] + self.gyro_bias[idx] + np.radians(0.5) * sc * rng.standard_normal(k)
        # camera: bottles in view get (re)placed on the map, misses and false sightings
        bx, by = self._body(self.b_pos[idx], self.pos[idx], self.psi[idx])
        rng_ = np.hypot(bx, by)
        brg = np.arctan2(by, bx)
        inview = (np.abs(brg) < CAM_FOV) & (rng_ < CAM_RANGE) & (rng_ > 0.4) & self.b_alive[idx]
        pdet = np.clip(1.05 - (rng_ - 2.5) / 6.0, 0, 0.95) if not first else np.zeros_like(rng_)
        det = inview & (rng.uniform(0, 1, rng_.shape) < pdet)
        mr = rng_ * (1 + 0.08 * sc[:, None] * rng.standard_normal(rng_.shape))
        mb = brg + 0.04 * sc[:, None] * rng.standard_normal(rng_.shape)
        a = self.est_psi[idx, None] + mb
        mx = self.est_pos[idx, None, 0] + mr * np.cos(a)
        my = self.est_pos[idx, None, 1] + mr * np.sin(a)
        old = self.m_valid[idx, :M_BOTTLES]
        blend = np.where(old, 0.5, 1.0)
        mp = self.m_pos[idx, :M_BOTTLES]
        mp[..., 0] = np.where(det, mp[..., 0] * (1 - blend) + mx * blend, mp[..., 0])
        mp[..., 1] = np.where(det, mp[..., 1] * (1 - blend) + my * blend, mp[..., 1])
        self.m_pos[idx, :M_BOTTLES] = mp
        self.m_valid[idx, :M_BOTTLES] = (old | det) & self.b_alive[idx]
        self.m_seen[idx, :M_BOTTLES] = np.where(det, self.t[idx, None], self.m_seen[idx, :M_BOTTLES])
        # a remembered spot in clear view with nothing there (a phantom, or the bottle drifted): forget it
        ex, ey = self._body(self.m_pos[idx], self.est_pos[idx], self.est_psi[idx])
        er = np.hypot(ex, ey)
        look = (np.abs(np.arctan2(ey, ex)) < CAM_FOV * 0.8) & (er < 4.0) & (er > 0.8) & self.m_valid[idx]
        hitnow = np.concatenate([det, np.zeros((k, P_PHANTOM), bool)], 1)
        self.m_miss[idx] = np.where(look & ~hitnow, self.m_miss[idx] + 1, np.where(hitnow, 0, self.m_miss[idx]))
        self.m_valid[idx] &= self.m_miss[idx] < 12
        # false sightings (reflections, foam, leaves)
        fp = (rng.uniform(0, 1, k) < self.fp_rate[idx]) & (not first)   # `not`: ~False is -1, which turned the mask into indices
        if fp.any():
            slot = M_BOTTLES + rng.integers(0, P_PHANTOM, k)
            fr, fb = rng.uniform(2, 7, k), rng.uniform(-CAM_FOV, CAM_FOV, k)
            ii = idx[fp]
            sl = slot[fp]
            a = self.est_psi[ii] + fb[fp]
            self.m_pos[ii, sl, 0] = self.est_pos[ii, 0] + fr[fp] * np.cos(a)
            self.m_pos[ii, sl, 1] = self.est_pos[ii, 1] + fr[fp] * np.sin(a)
            self.m_valid[ii, sl] = True
            self.m_miss[ii, sl] = 0
            self.m_seen[ii, sl] = self.t[ii]

    # ------------------------------------------------------------------ the goal (for reward shaping only)
    def _goal(self, idx):
        """Where the mission wants the boat now: home, the nearest remembered bottle, or a search point."""
        known = self.m_valid[idx]
        dx = self.m_pos[idx] - self.pos[idx, None]
        dist = np.where(known, np.hypot(dx[..., 0], dx[..., 1]), 1e6)
        j = dist.argmin(1)
        has = dist[np.arange(len(idx)), j] < 1e5
        ramp_full = self.ramp_load[idx] >= RAMP_CAP
        g = np.where(has[:, None], self.m_pos[idx, j], self.wps[idx, self.wp_i[idx].astype(int) % 6])
        kind = np.where(has, 1, 2)
        home = self.home_flag[idx] > 0.5
        g = np.where(home[:, None], self.home[idx], g)
        kind = np.where(home, 0, kind)
        kind = np.where(ramp_full & ~home, 3, kind)                  # tip first (no distance goal)
        return g, kind

    def _potential(self, idx):
        g, kind = self._goal(idx)
        d = np.linalg.norm(g - self.pos[idx], axis=1)
        self.goal_kind[idx] = kind
        return np.where(kind == 3, 0.0, -d).astype(F)

    # ------------------------------------------------------------------ one control step (20 Hz)
    def step(self, act, ramp_act):
        n = self.n
        thr = np.clip((act[:, 0] + 1) / 2, 0, 1).astype(F)
        steer = np.clip(act[:, 1], -1, 1).astype(F)
        ramp_t = np.where(ramp_act == 0, 1.0, np.where(ramp_act == 2, -1.0, 0.0)).astype(F)
        rew = np.zeros(n, F)
        # ramp servo: glides about 1 unit per second (lowered 1, raised 0, tipped -1)
        self.ramp += np.clip(ramp_t - self.ramp, -1.1 * self.ctrl_dt, 1.1 * self.ctrl_dt)
        old_pos = self.pos.copy()
        tt = self._physics(thr, steer)
        self.t += self.ctrl_dt
        self.steps += 1
        # bottles drift with the current and the wind
        self.b_pos += (self.vel_c + 0.03 * self.wind)[:, None] * self.ctrl_dt
        # ---- catching
        bx, by = self._body(self.b_pos)
        x0 = BOAT["L"] / 2
        lowered = self.ramp > 0.85
        hw = 0.21 + np.clip((bx - (x0 + 0.5)) / 0.2, 0, 1) * 0.13 + 0.05      # ramp + V-wings + brushes
        inzone = (bx > x0 + 0.02) & (bx < x0 + 0.72) & (np.abs(by) < hw) & self.b_alive
        speed = np.maximum(self.u, 0)
        pcatch = np.clip(1.25 - 0.75 * speed, 0.25, 1.0)[:, None]            # fast: the bow wave pushes them off
        room = (self.ramp_load < RAMP_CAP)[:, None]
        can = inzone & lowered[:, None] & room & (self.u > 0.03)[:, None]
        got = can & (self.rng.uniform(0, 1, can.shape) < pcatch * 0.5)
        ncatch = got.sum(1).astype(F)
        self.b_alive &= ~got
        self.m_valid[:, :M_BOTTLES] &= ~got
        self.ramp_load += ncatch
        rew += 10 * ncatch
        self.stats["caught"] += ncatch
        # not caught (ramp up, full, or missed): the bow / ramp pushes it aside
        push = inzone & ~got & ~can | ((bx > x0 - 0.05) & (bx < x0 + 0.08) & (np.abs(by) < BOAT["B"] / 2 + 0.05) & self.b_alive)
        if push.any():
            side = np.where(by >= 0, 1.0, -1.0)
            ny = side * (np.maximum(np.abs(by), hw) + 0.08)
            c, s = np.cos(self.psi)[:, None], np.sin(self.psi)[:, None]
            nwx = self.pos[:, None, 0] + bx * c - ny * s
            nwy = self.pos[:, None, 1] + bx * s + ny * c
            self.b_pos[..., 0] = np.where(push, nwx, self.b_pos[..., 0])
            self.b_pos[..., 1] = np.where(push, nwy, self.b_pos[..., 1])
        # ---- guidance (early training): ramp down with a bottle just ahead, up otherwise; slow when close
        ahead = ((bx > x0) & (bx < x0 + 1.8) & (np.abs(by) < 0.3) & self.b_alive).any(1)
        low = self.ramp > 0.5
        rew += np.where(ahead, 0.04 * low - 0.03 * np.maximum(self.u - 0.8, 0), -W_RAMP_IDLE * low)
        # ---- weeds: the lowered ramp scoops them (bad), the mesh lets small bits through
        mouth = self.pos + 0.85 * np.stack([np.cos(self.psi), np.sin(self.psi)], -1)
        in_w = (np.linalg.norm(mouth[:, None] - self.w_pos, axis=-1) < self.w_rad) & self.w_on
        in_any = in_w.any(1)
        hull_w = ((np.linalg.norm(self.pos[:, None] - self.w_pos, axis=-1) < self.w_rad) & self.w_on).any(1)
        dw = np.where(in_any & (self.ramp > 0.5), 0.8 * np.maximum(self.u, 0) * self.ctrl_dt, 0)
        self.weed_load += dw
        rew -= W_WEED * dw
        rew -= 0.25 * self.ctrl_dt * hull_w                              # driving through weed: risk of tangles
        self.stats["weed"] += dw
        # raising the ramp lets loose weed fall back through the mesh (shake-out)
        shake = (self.prev_ramp_pos >= 0.5) & (self.ramp < 0.5)
        self.weed_load = np.where(shake, self.weed_load * 0.55, self.weed_load)
        # ---- tipping into the bin
        tip = (self.ramp <= -0.95) & ((self.ramp_load > 0) | (self.weed_load > 0.05))
        if tip.any():
            fast = self.u > 0.6
            lost = np.where(tip & fast, np.round(self.ramp_load * 0.3), 0)
            into = np.where(tip, self.ramp_load - lost, 0)
            room_b = np.maximum(0, BIN_CAP - self.bin)
            into = np.minimum(into, room_b)
            lost = np.where(tip, self.ramp_load - into, 0)
            self.bin += into
            rew += 5 * into - 4 * lost - 1.5 * np.where(tip, self.weed_load, 0)
            self.stats["binned"] += into
            self.stats["lost"] += lost
            if (lost > 0).any():              # lost ones go back into the water just behind
                for i in np.where(lost > 0)[0]:
                    free = np.where(~self.b_alive[i])[0][:int(lost[i])]
                    self.b_alive[i, free] = True
                    self.b_pos[i, free] = self.pos[i] + self.rng.uniform(-0.6, 0.6, (len(free), 2))
            self.ramp_load = np.where(tip, 0, self.ramp_load)
            self.weed_load = np.where(tip, 0, self.weed_load)
        self.prev_ramp_pos = self.ramp.copy()
        # ---- shore
        inside = self._inside(self.pos)
        rays = self._rays(self.pos, self.psi)
        near = rays.min(1)
        hit = ~inside | (near < 0.32)
        rew -= 0.6 * np.clip(1.5 - near, 0, 1.5) * self.ctrl_dt
        # ---- mission state: home when the bin is (nearly) full, the battery is low, or all is collected
        all_done = (~self.b_alive).all(1) & (self.ramp_load == 0)
        self.home_flag = ((self.bin >= 0.8 * BIN_CAP) | (self.soc < 0.2) | all_done).astype(F)
        dhome = np.linalg.norm(self.pos - self.home, axis=1)
        at_home = (self.home_flag > 0.5) & (dhome < 2.0) & (np.abs(self.u) < 0.5) & (self.ramp_load == 0)
        rew += np.where(at_home, 20 + 0.5 * self.bin, 0)
        flat = self.soc <= 0
        rew -= np.where(flat, 20, 0)
        # ---- search waypoints advance when reached
        wp = self.wps[np.arange(n), self.wp_i.astype(int) % 6]
        self.wp_i += (np.linalg.norm(self.pos - wp, axis=1) < 3.0)
        # ---- shaping: getting closer to the goal (potential based), smooth + straight driving, energy
        self._sense()
        phi_new = self._potential(np.arange(n))
        same = self.goal_kind == getattr(self, "_last_kind", self.goal_kind)
        rew += np.where(same, 0.5 * (phi_new - self.phi), 0)
        self._last_kind = self.goal_kind.copy()
        self.phi = phi_new
        rew -= W_JERK * (steer - self.prev_steer) ** 2 + 0.01 * (thr - self.prev_thr) ** 2
        rew -= W_YAW * self.r ** 2
        rew -= 0.01 * (tt / (2 * self.p["t_max"])) * self.ctrl_dt
        rew -= np.where(self.goal_kind == 3, 0.1 * self.ctrl_dt, 0)          # full ramp: tip it soon
        rew += np.where(self.ramp < -0.5, 0, 0)
        rew -= np.where(hit, 30, 0)
        # ---- bookkeeping
        self.stats["dist"] += np.linalg.norm(self.pos - old_pos, axis=1)
        straight = (np.abs(steer) < 0.15) & (self.u > 0.3)
        self.stats["straight_t"] += straight * self.ctrl_dt
        self.stats["yaw_abs"] += straight * np.abs(self.r) * self.ctrl_dt
        self.stats["collide"] += hit
        self.stats["home"] += at_home
        self.stats["flat"] += flat
        self.stats["ep_ret"] += rew
        self.r_hist = np.concatenate([self.est_r[:, None], self.r_hist[:, :2]], 1)
        self.s_hist = np.concatenate([self.prev_steer[:, None], self.s_hist[:, :1]], 1)
        self.prev_thr, self.prev_steer = thr, steer
        self.prev_ramp_act = ramp_act.copy()
        term = hit | at_home | flat
        trunc = (self.steps >= self.max_steps) & ~term
        return rew, term, trunc

    # ------------------------------------------------------------------ observations
    def obs(self):
        n = self.n
        ar = np.arange(n)
        o = np.zeros((n, OBS_DIM), F)
        o[:, 0:2] = self.est_uv
        o[:, 2] = self.est_r
        o[:, 3] = self.ramp
        o[:, 4] = self.ramp_load / RAMP_CAP
        o[:, 5] = np.minimum(self.weed_load, 3) / 3
        o[:, 6] = self.bin / BIN_CAP
        o[:, 7] = self.soc
        o[:, 8] = self.home_flag
        o[:, 9] = self.prev_thr
        o[:, 10] = self.prev_steer
        o[ar, 11 + self.prev_ramp_act] = 1
        o[:, 14:17] = self.r_hist
        o[:, 17:19] = self.s_hist
        # remembered bottles (+ false ones), nearest first, as the phone sees them
        mx, my = self._body(self.m_pos, self.est_pos, self.est_psi)
        md = np.where(self.m_valid, np.hypot(mx, my), 1e6)
        order = np.argsort(md, 1)[:, :K_TARGETS]
        tx, ty, td = (np.take_along_axis(a, order, 1) for a in (mx, my, md))
        tv = np.take_along_axis(self.m_valid, order, 1)
        age = self.t[:, None] - np.take_along_axis(self.m_seen, order, 1)
        blk = np.stack([tx / 10, ty / 10, np.minimum(td, 30) / 10, np.minimum(age, 60) / 30, tv], -1)
        blk[~tv] = 0
        o[:, 19:39] = blk.reshape(n, -1)
        # weed patches (the map; its edge distance), nearest first
        wx, wy = self._body(self.w_pos, self.est_pos, self.est_psi)
        wd = np.where(self.w_on, np.hypot(wx, wy) - self.w_rad, 1e6)
        wo = np.argsort(wd, 1)[:, :K_WEEDS]
        wxs, wys, wds = (np.take_along_axis(a, wo, 1) for a in (wx, wy, wd))
        wrs = np.take_along_axis(self.w_rad, wo, 1)
        wv = np.take_along_axis(self.w_on, wo, 1)
        wb = np.stack([wxs / 10, wys / 10, np.clip(wds, -3, 30) / 10, wrs / 3, wv], -1)
        wb[~wv] = 0
        o[:, 39:49] = wb.reshape(n, -1)
        o[:, 49:57] = self._rays(self.est_pos, self.est_psi) / RAY_MAX
        hx, hy = self._body(self.home[:, None], self.est_pos, self.est_psi)
        o[:, 57], o[:, 58] = hx[:, 0] / 20, hy[:, 0] / 20
        o[:, 59] = np.hypot(hx[:, 0], hy[:, 0]) / 20
        wp = self.wps[ar, self.wp_i.astype(int) % 6][:, None]
        px, py = self._body(wp, self.est_pos, self.est_psi)
        o[:, 60], o[:, 61] = px[:, 0] / 20, py[:, 0] / 20
        o[:, 62] = np.hypot(px[:, 0], py[:, 0]) / 20
        return np.clip(o, -5, 5)

    def priv(self, o):
        """The critic's extra view (training only): the true state and this boat's physics."""
        n = self.n
        x = np.zeros((n, PRIV_DIM - OBS_DIM), F)
        x[:, 0], x[:, 1], x[:, 2] = self.u, self.v, self.r
        x[:, 3] = np.sin(self.est_psi - self.psi)
        x[:, 4:6] = (self.est_pos - self.pos) / 3
        c, s = np.cos(self.psi), np.sin(self.psi)
        x[:, 6] = (self.wind[:, 0] * c + self.wind[:, 1] * s) / 5
        x[:, 7] = (-self.wind[:, 0] * s + self.wind[:, 1] * c) / 5
        x[:, 8] = (self.vel_c[:, 0] * c + self.vel_c[:, 1] * s) / 0.15
        x[:, 9] = (-self.vel_c[:, 0] * s + self.vel_c[:, 1] * c) / 0.15
        for i, k in enumerate(("t_max", "xuu", "fin_eta", "latency", "ramp_xuu", "yvv", "mass", "motor_tau")):
            x[:, 10 + i] = self.p[k] / self.nom[k][0] - 1
        x[:, 18] = self.diff
        x[:, 19] = self.b_alive.sum(1) / M_BOTTLES
        x[:, 20] = self.steps / self.max_steps
        x[:, 21] = self.thr_l - self.thr_r
        return np.concatenate([o, x], 1)
