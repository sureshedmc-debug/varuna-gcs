"""Learn the boat's model from its run logs (step 1 of training it in a simulator).

    py boat-r4\\sysid\\analyze_log.py                   (every log in boat-r4\\sysid\\logs)
    py boat-r4\\sysid\\analyze_log.py run1.tlog run2.tlog

The logs (VARUNA Boat Link 2.3+, ESP32 brain with AB_LOG_HZ 25) hold what the
brain sent the motors, fins and scoop, and what the phone measured: compass +
gyro 50x a second, GPS 10x a second. From them this fits:

  surge   du/dt = k_thrust*T - d_lin*u - d_quad*u|u| - d_scoop*s*u
  yaw     dr/dt = k_fin*fin*T + k_diff*D - d_r*r - d_ru*r*|u| + bias
          T = (L^2 + R^2)/2  (thrust grows with the square of the ESC signal)
          D = (L^2 - R^2)/2  (one motor harder than the other)
          u speed along the bow (m/s), r turn rate (deg/s, + = right),
          fin -1..1 (+ = right), s scoop 0 raised .. 1 lowered,
          each input seen after a delay (motor spin-up, servo travel, phone lag)

and measures the sensors' noise, the update rates and the delays. It writes:

  sysid/out/boat_model.json   the numbers the training simulator uses
  sysid/out/report.md         how good the fit is and what runs are still missing
  sysid/out/fit.png           measured vs model, 5-second predictions
"""
import argparse
import glob
import json
import math
import os
import sys

import numpy as np
from scipy.signal import butter, filtfilt

os.environ.setdefault("MAVLINK20", "1")
from pymavlink import mavutil  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DT = 0.02                      # analysis grid: 50 Hz
SURGE_HZ, YAW_HZ = 1.0, 4.0    # smoothing of the speed (GPS) and the turn rate (gyro)
PHONE = (254, 220)             # the phone's id on the brain's link (GPS_INPUT, ATTITUDE)
BRAIN = (1, 1)


# ------------------------------------------------------------------ reading a log
def read_log(path):
    c = mavutil.mavlink_connection(path, dialect="ardupilotmega", robust_parsing=True)
    d = {k: [] for k in ("att", "gps", "out", "hb", "rc", "batt")}
    params = {}
    while True:
        m = c.recv_match()
        if m is None:
            break
        typ = m.get_type()
        src = (m.get_srcSystem(), m.get_srcComponent())
        t = getattr(m, "_timestamp", None)
        if t is None:
            continue
        if src == PHONE and typ == "ATTITUDE":
            d["att"].append((t, m.yaw, m.yawspeed))
        elif src == PHONE and typ == "GPS_INPUT":
            if m.fix_type >= 3:
                d["gps"].append((t, m.lat / 1e7, m.lon / 1e7, m.vn, m.ve, m.horiz_accuracy, m.speed_accuracy))
        elif src == BRAIN and typ == "SERVO_OUTPUT_RAW":
            d["out"].append((t, m.servo1_raw, m.servo2_raw, m.servo3_raw, m.servo4_raw, m.servo5_raw))
        elif src == BRAIN and typ == "HEARTBEAT" and m.type != 6:
            d["hb"].append((t, 1 if m.base_mode & 128 else 0, m.custom_mode))
        elif src == BRAIN and typ == "SYS_STATUS":
            if 0 < m.voltage_battery < 65535:
                d["batt"].append((t, m.voltage_battery / 1000.0))
        elif src == BRAIN and typ == "PARAM_VALUE":
            params[m.param_id.strip("\x00") if isinstance(m.param_id, str) else m.param_id] = m.param_value
    return {k: np.array(v, dtype=float) if v else np.zeros((0, 1)) for k, v in d.items()}, params


def p_or(params, name, default):
    v = params.get(name)
    return default if v is None else float(v)


def hold(t_src, v_src, t):
    """Zero-order hold (commands: they stay until the next one)."""
    i = np.searchsorted(t_src, t, side="right") - 1
    out = v_src[np.clip(i, 0, len(v_src) - 1)].astype(float)
    out[i < 0] = np.nan
    return out


def lowpass(x, hz):
    b, a = butter(2, hz / (0.5 / DT))
    return filtfilt(b, a, x)


def to_grid(raw, params):
    """One log -> 50 Hz arrays. None if it has no phone heading or no brain outputs."""
    att, out = raw["att"], raw["out"]
    if len(att) < 100 or len(out) < 20:
        return None
    t = np.arange(max(att[0, 0], out[0, 0]), min(att[-1, 0], out[-1, 0]), DT)
    if len(t) < 200:
        return None
    g = {"t": t}
    yaw = np.unwrap(att[:, 1])
    g["psi"] = np.degrees(np.interp(t, att[:, 0], yaw))                 # heading, deg (unwrapped)
    g["r_raw"] = np.degrees(np.interp(t, att[:, 0], att[:, 2]))         # gyro turn rate, deg/s
    # commands as the brain sent them
    def fin_norm(p, s):
        mn, tr, mx = p_or(params, f"SERVO{s}_MIN", 1100), p_or(params, f"SERVO{s}_TRIM", 1500), p_or(params, f"SERVO{s}_MAX", 1900)
        f = np.where(p >= tr, (p - tr) / max(1.0, mx - tr), (p - tr) / max(1.0, tr - mn))
        return -f if p_or(params, f"SERVO{s}_REVERSED", 0) > 0.5 else f
    pw = {k: hold(out[:, 0], out[:, k], t) for k in range(1, 6)}
    fin = fin_norm(pw[1], 1)
    if p_or(params, "SERVO5_FUNCTION", 26) == 26 and np.nanmax(pw[5]) > 0:
        fin = (fin + fin_norm(pw[5], 5)) / 2
    g["fin"] = np.clip(fin, -1, 1)
    for k, s, name in ((3, 3, "L"), (4, 4, "R")):
        stop, mx = p_or(params, f"SERVO{s}_TRIM", 1000), p_or(params, f"SERVO{s}_MAX", 2000)
        g[name] = np.clip((pw[k] - stop) / max(1.0, mx - stop), 0, 1)
    mn2, mx2 = p_or(params, "SERVO2_MIN", 1000), p_or(params, "SERVO2_MAX", 2000)
    s = np.clip((pw[2] - mn2) / max(1.0, mx2 - mn2), 0, 1)
    g["scoop"] = 1 - s if p_or(params, "SERVO2_REVERSED", 0) > 0.5 else s
    g["T"] = (g["L"] ** 2 + g["R"] ** 2) / 2
    g["D"] = (g["L"] ** 2 - g["R"] ** 2) / 2
    hb = raw["hb"]
    g["armed"] = hold(hb[:, 0], hb[:, 1], t) > 0.5 if len(hb) else np.ones_like(t, bool)
    # speed along the bow and sideways (drift), from the GPS velocity and the compass
    gps = raw["gps"]
    if len(gps) >= 20:
        vn = np.interp(t, gps[:, 0], gps[:, 3])
        ve = np.interp(t, gps[:, 0], gps[:, 4])
        ps = np.radians(g["psi"])
        g["u_raw"] = vn * np.cos(ps) + ve * np.sin(ps)
        g["v_raw"] = -vn * np.sin(ps) + ve * np.cos(ps)
        gap = np.diff(gps[:, 0])
        bad = np.zeros_like(t, bool)
        for i in np.where(gap > 0.5)[0]:                                 # GPS outages: no speed there
            bad |= (t > gps[i, 0]) & (t < gps[i + 1, 0])
        g["gps_ok"] = ~bad & (t >= gps[0, 0]) & (t <= gps[-1, 0])
    else:
        g["u_raw"] = np.full_like(t, np.nan)
        g["v_raw"] = np.full_like(t, np.nan)
        g["gps_ok"] = np.zeros_like(t, bool)
    ok = ~np.isnan(g["fin"]) & ~np.isnan(g["T"])
    for k in ("fin", "T", "D", "L", "R", "scoop"):
        g[k] = np.nan_to_num(g[k])
    g["valid"] = ok
    u = np.nan_to_num(g["u_raw"])
    g["u0"] = u
    g["u"] = lowpass(u, SURGE_HZ)
    g["du"] = np.gradient(g["u"], DT)
    g["r"] = lowpass(g["r_raw"], YAW_HZ)
    g["dr"] = np.gradient(g["r"], DT)
    g["raw"] = raw
    return g


# ------------------------------------------------------------------ fitting
def shift(x, k):
    """x seen k samples late."""
    if k == 0:
        return x
    return np.concatenate([np.full(k, x[0]), x[:-k]])


# Each term is built from the raw signals and then smoothed exactly like the
# measured acceleration (du / dr come from smoothed speed / turn rate): the same
# filter on both sides keeps the equation true, so the fit is not biased by it.
def surge_cols(g, k):
    T = shift(g["T"], k)
    u = g["u0"]
    c = {"k_thrust": T, "d_lin": -u, "d_quad": -u * np.abs(u), "d_scoop": -g["scoop"] * u}
    return {n: lowpass(v, SURGE_HZ) for n, v in c.items()}


def yaw_cols(g, k):
    T = shift(g["T"], k)
    r = g["r_raw"]
    c = {"k_fin": shift(g["fin"], k) * T, "k_diff": shift(g["D"], k), "d_r": -r,
         "d_ru": -r * np.abs(g["u0"]), "bias": np.ones_like(T)}
    return {n: lowpass(v, YAW_HZ) for n, v in c.items()}


def fit(grids, cols_fn, target, mask_fn, drop_if_flat):
    best = None
    for k in range(0, 26):                       # 0 .. 0.5 s
        X, y = [], []
        names = None
        for g in grids:
            c = cols_fn(g, k)
            m = mask_fn(g)
            names = list(c)
            X.append(np.column_stack([c[n][m] for n in names]))
            y.append(g[target][m])
        X, y = np.vstack(X), np.concatenate(y)
        if len(y) < 250:
            return None
        keep = [i for i, n in enumerate(names) if not (n in drop_if_flat and np.std(X[:, i]) < 0.02)]
        Xk = X[:, keep]
        coef, *_ = np.linalg.lstsq(Xk, y, rcond=None)
        res = y - Xk @ coef
        sse = float(res @ res)
        if best is None or sse < best["sse"]:
            sigma2 = sse / max(1, len(y) - len(keep))
            try:
                se = np.sqrt(np.diag(sigma2 * np.linalg.inv(Xk.T @ Xk)))
            except np.linalg.LinAlgError:
                se = np.full(len(keep), np.nan)
            best = {"sse": sse, "k": k, "n": len(y),
                    "coef": {names[i]: float(coef[j]) for j, i in enumerate(keep)},
                    "stderr": {names[i]: float(se[j]) for j, i in enumerate(keep)},
                    "not_measured": [names[i] for i in range(len(names)) if i not in keep],
                    "r2": float(1 - sse / max(1e-9, float(((y - y.mean()) ** 2).sum())))}
    best["delay_s"] = best.pop("k") * DT
    best.pop("sse")
    return best


def windows(grids, mask_fn, n, step):
    """Start samples (grid, i0) of n-sample stretches that are all usable."""
    out = []
    for gi, g in enumerate(grids):
        m = mask_fn(g)
        for i0 in range(0, len(g["t"]) - n, step):
            if m[i0:i0 + n].all():
                out.append((gi, i0))
    return out


def refine(grids, first, kind, secs=5.0):
    """Second pass: tune the numbers so the model, run 5 s from the logged state on
    the logged commands, follows what the boat really did (all stretches at once).
    The first pass (accelerations) gives the start; this one is what the simulator needs."""
    from scipy.optimize import least_squares
    if first is None:
        return None
    n = int(secs / DT)
    mask_fn = surge_mask if kind == "surge" else (lambda g: moving(g) & g["gps_ok"])
    wins = windows(grids, mask_fn, n, n // 2)
    if len(wins) < 8:
        return first
    names = list(first["coef"])
    nc = len(names)
    # Surge: the GPS measures speed over the ground; the water (current, wind drift)
    # may move too. Its north / east speed is learnt per log along with the boat.
    ng = len(grids) if kind == "surge" else 0
    gidx = np.array([gi for gi, _ in wins])
    cs = np.array([np.cos(np.radians(grids[gi]["psi"][i0:i0 + n])) for gi, i0 in wins])
    sn = np.array([np.sin(np.radians(grids[gi]["psi"][i0:i0 + n])) for gi, i0 in wins])
    st, meas, inp = [], [], {}
    for gi, i0 in wins:
        g = grids[gi]
        st.append(g["u"][i0] if kind == "surge" else g["r"][i0])
        meas.append((g["u"] if kind == "surge" else g["r"])[i0:i0 + n])
    st, meas = np.array(st), np.array(meas)

    def inputs(k):
        if k in inp:
            return inp[k]
        sl = lambda a: np.array([a[gi][i0:i0 + n] for gi, i0 in wins])  # noqa: E731
        T = sl([shift(g["T"], k) for g in grids])
        d = {"T": T, "scoop": sl([g["scoop"] for g in grids]), "u": sl([g["u"] for g in grids]),
             "fin": sl([shift(g["fin"], k) for g in grids]), "D": sl([shift(g["D"], k) for g in grids])}
        inp[k] = d
        return d

    def run(p, k):
        c = dict(zip(names, p[:nc]))
        d = inputs(k)
        cur = 0
        if ng:
            cn, ce = p[nc::2], p[nc + 1::2]
            cur = cn[gidx][:, None] * cs + ce[gidx][:, None] * sn
        x = st - (cur[:, 0] if ng else 0)
        out = np.empty_like(meas)
        for j in range(n):
            if kind == "surge":
                dx = c.get("k_thrust", 0) * d["T"][:, j] - c.get("d_lin", 0) * x - c.get("d_quad", 0) * x * np.abs(x) \
                    - c.get("d_scoop", 0) * d["scoop"][:, j] * x
            else:
                dx = c.get("k_fin", 0) * d["fin"][:, j] * d["T"][:, j] + c.get("k_diff", 0) * d["D"][:, j] \
                    - c.get("d_r", 0) * x - c.get("d_ru", 0) * x * np.abs(d["u"][:, j]) + c.get("bias", 0)
            x = x + dx * DT
            out[:, j] = x
        return out + cur

    best = None
    k0 = int(round(first["delay_s"] / DT))
    for k in range(max(0, k0 - 4), k0 + 5):
        r = least_squares(lambda p: (run(p, k) - meas).ravel(), [first["coef"][q] for q in names] + [0.0] * (2 * ng),
                          method="lm")
        cost = float(r.fun @ r.fun)
        if best is None or cost < best[0]:
            best = (cost, k, r)
    cost, k, r = best
    res = dict(first)
    res["coef"] = {q: float(v) for q, v in zip(names, r.x[:nc])}
    if ng:
        res["water_drift_ms"] = [{"north": float(r.x[nc + 2 * i]), "east": float(r.x[nc + 2 * i + 1])} for i in range(ng)]
    try:
        J = r.jac
        cov = np.linalg.inv(J.T @ J) * cost / max(1, len(r.fun) - len(names))
        res["stderr"] = {q: float(math.sqrt(max(0.0, cov[i, i]))) for i, q in enumerate(names)}
    except np.linalg.LinAlgError:
        pass
    res["delay_s"] = k * DT
    res["fitted_on"] = f"{len(wins)} stretches of {secs:.0f} s"
    return res


def moving(g):
    return g["valid"] & g["armed"]


def surge_mask(g):
    return moving(g) & g["gps_ok"] & (np.abs(g["u"]) < 6)


# ------------------------------------------------------------------ checking: 5-second predictions
def simulate(g, sm, ym, i0, n):
    """From sample i0, run the model n steps on the logged commands."""
    ks, ky = int(round(sm["delay_s"] / DT)), int(round(ym["delay_s"] / DT))
    cs, cy = sm["coef"], ym["coef"]
    T_s, T_y = shift(g["T"], ks), shift(g["T"], ky)
    fin_y, D_y = shift(g["fin"], ky), shift(g["D"], ky)
    u, r = g["u"][i0], g["r"][i0]
    U, R = np.empty(n), np.empty(n)
    for j in range(n):
        i = i0 + j
        du = cs.get("k_thrust", 0) * T_s[i] - cs.get("d_lin", 0) * u - cs.get("d_quad", 0) * u * abs(u) \
            - cs.get("d_scoop", 0) * g["scoop"][i] * u
        dr = cy.get("k_fin", 0) * fin_y[i] * T_y[i] + cy.get("k_diff", 0) * D_y[i] - cy.get("d_r", 0) * r \
            - cy.get("d_ru", 0) * r * abs(u) + cy.get("bias", 0)
        u += du * DT
        r += dr * DT
        U[j], R[j] = u, r
    return U, R


def check(grids, sm, ym, secs=5.0):
    n = int(secs / DT)
    eu, er, ep = [], [], []
    for g in grids:
        m = surge_mask(g)
        for i0 in range(0, len(g["t"]) - n, n):
            if not m[i0:i0 + n].all():
                continue
            U, R = simulate(g, sm, ym, i0, n)
            eu.append(np.sqrt(np.mean((U - g["u"][i0:i0 + n]) ** 2)))
            er.append(np.sqrt(np.mean((R - g["r"][i0:i0 + n]) ** 2)))
            psi = g["psi"][i0] + np.cumsum(R) * DT
            ep.append(abs(psi[-1] - g["psi"][i0 + n - 1]))
    if not eu:
        return None
    return {"windows": len(eu), "speed_rms_ms": float(np.median(eu)), "turn_rate_rms_dps": float(np.median(er)),
            "heading_err_after_5s_deg": float(np.median(ep))}


# ------------------------------------------------------------------ sensors + what the runs covered
def rate_stats(ts):
    if len(ts) < 10:
        return None
    d = np.diff(ts)
    d = d[d > 0]
    return {"hz": float(1 / np.median(d)), "gap_p95_ms": float(np.percentile(d, 95) * 1000),
            "gap_max_ms": float(d.max() * 1000)}


def sensors(grids):
    gyro, head, spd, pos = [], [], [], []
    for g in grids:
        still = g["valid"] & (g["T"] < 0.01)
        # still for 3 s+: what the sensors read when nothing moves = their noise
        run = np.convolve(still.astype(int), np.ones(150, int), "same") >= 150
        if run.sum() > 100:
            gyro.append(g["r_raw"][run])
            hp = g["psi"][run] - lowpass(g["psi"], 0.2)[run]
            head.append(hp)
            if g["gps_ok"][run].any():
                spd.append(g["u_raw"][run & g["gps_ok"]])
        gps = g["raw"]["gps"]
        if len(gps) > 50:
            lat0 = gps[:, 1].mean()
            n_m = (gps[:, 1] - lat0) * 111320
            e_m = (gps[:, 2] - gps[:, 2].mean()) * 111320 * math.cos(math.radians(lat0))
            pos.append(np.sqrt((n_m - lowpass_any(n_m)) ** 2 + (e_m - lowpass_any(e_m)) ** 2))
    cat = lambda xs: np.concatenate(xs) if xs else np.zeros(0)  # noqa: E731
    G, H, S, P = cat(gyro), cat(head), cat(spd), cat(pos)
    return {
        "gyro_noise_dps": float(G.std()) if len(G) else None,
        "gyro_bias_dps": float(G.mean()) if len(G) else None,
        "heading_noise_deg": float(H.std()) if len(H) else None,
        "gps_speed_noise_ms": float(S.std()) if len(S) else None,
        "gps_pos_jitter_m": float(np.median(P)) if len(P) else None,
        "phone_attitude": rate_stats(cat([g["raw"]["att"][:, 0] for g in grids])),
        "phone_gps": rate_stats(cat([g["raw"]["gps"][:, 0] for g in grids if len(g["raw"]["gps"])])),
        "brain_outputs": rate_stats(cat([g["raw"]["out"][:, 0] for g in grids])),
    }


def lowpass_any(x):
    if len(x) < 30:
        return np.full_like(x, x.mean())
    b, a = butter(2, 0.05)
    return filtfilt(b, a, x)


def coverage(grids):
    c = {"armed_s": 0.0, "driving_s": 0.0, "throttle_levels": 0, "fin_steps": 0, "coast_downs": 0,
         "scoop_down_driving_s": 0.0, "scoop_up_driving_s": 0.0, "motor_difference_s": 0.0, "gps_s": 0.0}
    levels = set()
    for g in grids:
        a = g["valid"] & g["armed"]
        drv = a & (g["T"] > 0.05)
        c["armed_s"] += a.sum() * DT
        c["driving_s"] += drv.sum() * DT
        c["gps_s"] += (drv & g["gps_ok"]).sum() * DT
        levels |= set(np.round(np.sqrt(g["T"][drv]) * 5).astype(int).tolist())
        f = g["fin"]
        c["fin_steps"] += int(np.sum(np.abs(f[15:] - f[:-15]) > 0.5) / 15)
        T = g["T"]
        c["coast_downs"] += int(np.sum((T[:-25] > 0.15) & (T[25:] < 0.005)) / 25)
        c["scoop_down_driving_s"] += (drv & (g["scoop"] > 0.7)).sum() * DT
        c["scoop_up_driving_s"] += (drv & (g["scoop"] < 0.3)).sum() * DT
        c["motor_difference_s"] += (drv & (np.abs(g["D"]) > 0.05)).sum() * DT
    c["throttle_levels"] = len(levels - {0})
    return c


def missing(c, sm, ym):
    w = []
    if c["gps_s"] < 120:
        w.append("Less than 2 minutes of driving with GPS: drive more, in open sky.")
    if c["throttle_levels"] < 3:
        w.append("Few throttle levels: do straight runs at about 30 %, 60 % and 100 % throttle, 15 s each.")
    if c["coast_downs"] < 3:
        w.append("Few coast-downs: at speed, drop the throttle to zero and let the boat glide 10 s (3 or more times).")
    if c["fin_steps"] < 6:
        w.append("Few fin steps: at steady speed, flick the rudder stick full left / full right and hold 3 s (6 or more).")
    if c["scoop_down_driving_s"] < 20 or c["scoop_up_driving_s"] < 20:
        w.append("Need runs with the scoop both lowered and raised (20 s+ each) to learn its drag.")
    if c["motor_difference_s"] < 10:
        w.append("No motor difference yet (in MANUAL both motors get the same signal): an AUTO or ACRO run adds it.")
    for name, m in (("surge", sm), ("yaw", ym)):
        if m is None:
            continue
        for k, v in m["coef"].items():
            if k != "bias" and v < 0:
                w.append(f"{name}: {k} came out negative ({v:.3g}) - not enough of that kind of data yet, "
                         f"or a reversed servo / motor (check SERVOn_REVERSED).")
    return w


# ------------------------------------------------------------------ plot
def plot(grids, sm, ym, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    g = max(grids, key=lambda g: (surge_mask(g)).sum())
    m = surge_mask(g)
    idx = np.where(m)[0]
    if len(idx) < 500:
        return False
    i0, i1 = idx[0], min(idx[0] + 6000, idx[-1])       # up to 2 minutes
    t = g["t"][i0:i1] - g["t"][i0]
    U, R = np.full(i1 - i0, np.nan), np.full(i1 - i0, np.nan)
    n = 250
    for s in range(0, i1 - i0 - n, n):                   # 5 s predictions, restarted from the log
        if m[i0 + s:i0 + s + n].all():
            U[s:s + n], R[s:s + n] = simulate(g, sm, ym, i0 + s, n)
    fig, ax = plt.subplots(3, 1, figsize=(11, 8), sharex=True)
    ax[0].plot(t, g["u"][i0:i1], label="measured (GPS + compass)")
    ax[0].plot(t, U, label="model, 5 s ahead")
    ax[0].set_ylabel("speed m/s")
    ax[0].legend(loc="upper right")
    ax[1].plot(t, g["r"][i0:i1], label="measured (phone gyro)")
    ax[1].plot(t, R, label="model, 5 s ahead")
    ax[1].set_ylabel("turn rate deg/s")
    ax[1].legend(loc="upper right")
    ax[2].plot(t, np.sqrt(g["T"][i0:i1]), label="thrust (ESC 0..1)")
    ax[2].plot(t, g["fin"][i0:i1], label="fin -1..1")
    ax[2].plot(t, g["scoop"][i0:i1], label="scoop (1 = lowered)")
    ax[2].set_ylabel("commands")
    ax[2].set_xlabel("seconds")
    ax[2].legend(loc="upper right")
    fig.suptitle("VARUNA boat: measured vs learnt model")
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)
    return True


# ------------------------------------------------------------------ main
def fmt(m):
    if m is None:
        return "not enough data\n"
    s = f"delay {m['delay_s']:.2f} s, R² {m['r2']:.2f}, {m['n']} samples\n\n| term | value | ± |\n|---|---|---|\n"
    for k, v in m["coef"].items():
        s += f"| {k} | {v:.4g} | {m['stderr'][k]:.2g} |\n"
    if m["not_measured"]:
        s += f"\nNot measured yet: {', '.join(m['not_measured'])}\n"
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("logs", nargs="*")
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    a = ap.parse_args()
    paths = a.logs or sorted(glob.glob(os.path.join(HERE, "logs", "*.tlog")))
    if not paths:
        sys.exit("No logs. Copy them first: py boat-r4\\sysid\\get_logs.py --phone <address>")
    grids, used = [], []
    for p in paths:
        raw, params = read_log(p)
        g = to_grid(raw, params)
        print(f"{os.path.basename(p)}: {len(raw['att'])} heading, {len(raw['gps'])} GPS, {len(raw['out'])} output "
              f"messages{'' if g is not None else '  -> skipped (no brain outputs or phone heading in it)'}")
        if g is not None:
            grids.append(g)
            used.append(os.path.basename(p))
    if not grids:
        sys.exit("None of the logs can be used (they need the ESP32 brain on the phone, AB_LOG_HZ > 0).")
    sm = fit(grids, surge_cols, "du", surge_mask, drop_if_flat=("d_scoop",))
    ym = fit(grids, yaw_cols, "dr", moving, drop_if_flat=("k_diff", "d_ru"))
    print("Fitting to 5-second runs ...")
    sm = refine(grids, sm, "surge")
    # From here on: speed through the WATER (the drift the surge fit found taken out)
    for g, dr in zip(grids, (sm or {}).get("water_drift_ms", [])):
        ps = np.radians(g["psi"])
        w = dr["north"] * np.cos(ps) + dr["east"] * np.sin(ps)
        g["u"] = g["u"] - w
        g["u0"] = g["u0"] - w
    ym = refine(grids, ym, "yaw")
    chk = check(grids, sm, ym) if sm and ym else None
    sen = sensors(grids)
    cov = coverage(grids)
    warn = missing(cov, sm, ym)
    speeds = np.concatenate([g["u"][surge_mask(g)] for g in grids])
    rates = np.concatenate([g["r"][moving(g)] for g in grids])
    model = {
        "boat": "VARUNA air boat (2 air motors, 2 air fins, bow scoop)",
        "logs": used,
        "surge": sm, "yaw": ym, "check_5s": chk, "sensors": sen, "coverage": cov,
        "seen": {"max_speed_ms": float(np.percentile(speeds, 99)) if len(speeds) else None,
                 "max_turn_rate_dps": float(np.percentile(np.abs(rates), 99)) if len(rates) else None},
        # what the training simulator varies around these numbers (domain randomisation)
        "randomize_fraction": {"k_thrust": 0.25, "d_lin": 0.3, "d_quad": 0.3, "d_scoop": 0.4,
                               "k_fin": 0.3, "k_diff": 0.4, "d_r": 0.3, "bias": 1.0, "delay_s": 0.5},
        "warnings": warn,
    }
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "boat_model.json"), "w") as f:
        json.dump(model, f, indent=2)
    have_plot = sm and ym and plot(grids, sm, ym, os.path.join(a.out, "fit.png"))
    rep = ["# VARUNA boat model from the logs\n", f"Logs: {', '.join(used)}\n",
           "## Speed (surge)\n", fmt(sm), "## Turning (yaw)\n", fmt(ym)]
    if chk:
        rep.append(f"## How well it predicts\n\nOver {chk['windows']} five-second stretches (median): speed off by "
                   f"{chk['speed_rms_ms']:.2f} m/s, turn rate by {chk['turn_rate_rms_dps']:.1f} deg/s, heading "
                   f"{chk['heading_err_after_5s_deg']:.1f} deg after 5 s.\n")
    rep.append("## Sensors\n\n```\n" + json.dumps(sen, indent=2) + "\n```\n")
    rep.append("## What the runs covered\n\n```\n" + json.dumps(cov, indent=2) + "\n```\n")
    rep.append("## Still missing\n\n" + ("\n".join(f"- {w}" for w in warn) if warn else "Nothing - enough to train on.") + "\n")
    if have_plot:
        rep.append("\n![fit](fit.png)\n")
    with open(os.path.join(a.out, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(rep))
    print("\n" + "\n".join(rep[1:6 + (1 if chk else 0)]))
    print("Still missing:" if warn else "Enough data to train on.")
    for w in warn:
        print("  -", w)
    print(f"\nWrote {os.path.join(a.out, 'boat_model.json')}, report.md" + (", fit.png" if have_plot else ""))


if __name__ == "__main__":
    main()
