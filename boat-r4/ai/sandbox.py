"""Sandbox: drop plastic bottles on a calm pond and watch the trained captain fetch them.

    py sandbox.py                    # runs/best.pt, then open http://localhost:8094
    py sandbox.py runs/latest.pt

No training happens here. The saved captain drives exactly as it does on the real boat
(deterministic actions, same sensors): it only "knows" about a bottle once its camera
has seen it (35 deg each side, up to 8 m), otherwise it searches the pond.
Click the water to drop a bottle. The boat starts at home and waits there while the
pond is clean.
"""
import argparse
import json
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

from boat_sim import CAM_FOV, CAM_RANGE, M_BOTTLES, VecBoat, load_fitted
from train import Captain

HERE = os.path.dirname(os.path.abspath(__file__))
lock = threading.Lock()
state = {}
cmds = []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", nargs="?", default=os.path.join(HERE, "runs", "best.pt"))
    ap.add_argument("--port", type=int, default=8094)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--wind", type=float, default=0.0, help="steady wind in m/s (0 = calm)")
    args = ap.parse_args()
    torch.set_num_threads(2)

    st = torch.load(args.model, weights_only=False)
    model = Captain()
    model.load_state_dict(st["model"])
    model.eval()
    norm = st["norm"]
    torch.manual_seed(0)
    untrained = Captain()                         # same network shape, random weights: never trained
    untrained.eval()
    brain = ["trained"]
    nominal, fitted = load_fitted()

    # one boat; easy physics spread, then a calm, clean, roomy pond
    env = VecBoat(1, seed=args.seed, difficulty=0.15, nominal=nominal)
    ang = np.linspace(0, 2 * np.pi, env.poly.shape[1], endpoint=False)
    rad = 13 * (1 + 0.06 * np.sin(3 * ang + 0.7) + 0.04 * np.cos(5 * ang))
    env.poly[0, :, 0], env.poly[0, :, 1] = rad * np.cos(ang), rad * np.sin(ang)
    env.home[0] = (0.0, -10.0)
    wa = np.linspace(0.9, 2 * np.pi - 0.9, 6) - np.pi / 2
    env.wps[0, :, 0], env.wps[0, :, 1] = 6 * np.cos(wa), 6 * np.sin(wa)
    env.w_on[0] = False
    env.wind[0] = (args.wind, 0.0)
    env.vel_c[0] = 0.0
    env.b_alive[0] = False
    env.max_steps = 10 ** 9

    def to_home():
        env.pos[0] = env.home[0] + (0.0, 0.6)
        env.psi[0] = np.pi / 2                    # facing into the pond (north is +n, east is +e)
        for a in ("u", "v", "r", "thr_l", "thr_r", "fin", "ramp", "ramp_load", "weed_load", "bin"):
            getattr(env, a)[0] = 0
        env.cmd_buf[0] = 0
        env.m_valid[0] = False
        env.goal_kind[0] = -1
        env._sense(np.array([0]), first=True)
        env.phi[0] = env._potential(np.array([0]))[0]

    to_home()
    totals = {"binned": 0, "crashes": 0}
    msg = ["Click the water to drop a plastic bottle."]

    def handle(cmd):
        kind = cmd.get("do")
        if kind == "bottle":
            pt = np.array([[float(cmd["n"]), float(cmd["e"])]], np.float32)
            free = np.where(~env.b_alive[0])[0]
            if not env._inside(pt)[0]:
                msg[0] = "That spot is on land: click the water."
            elif not len(free):
                msg[0] = f"The pond already has {M_BOTTLES} bottles (the most the sim tracks)."
            else:
                env.b_pos[0, free[0]] = pt[0]
                env.b_alive[0, free[0]] = True
                near_bank = env._rays(pt, np.array([0.0], np.float32)).min() < 2.5
                msg[0] = ("Bottle dropped right by the bank: the captain was trained to keep off the banks, "
                          "so it may leave this one." if near_bank else "Bottle dropped.")
        elif kind == "random":
            for _ in range(int(cmd.get("count", 5))):
                free = np.where(~env.b_alive[0])[0]
                if not len(free):
                    break
                r, a = np.sqrt(np.random.uniform(0.05, 1)) * 9.5, np.random.uniform(0, 2 * np.pi)
                env.b_pos[0, free[0]] = (r * np.cos(a), r * np.sin(a))
                env.b_alive[0, free[0]] = True
            msg[0] = "Dropped some bottles around the pond."
        elif kind == "clear":
            env.b_alive[0] = False
            env.m_valid[0] = False
            msg[0] = "Pond cleared."
        elif kind == "brain":
            brain[0] = "untrained" if cmd.get("which") == "untrained" else "trained"
            to_home()
            totals["binned"], totals["crashes"] = 0, 0
            msg[0] = ("UNTRAINED network (random weights) is driving now. Counters reset."
                      if brain[0] == "untrained" else "TRAINED captain is driving now. Counters reset.")
        elif kind == "home":
            to_home()
            msg[0] = "Boat put back at home."

    obs = env.obs()
    dt = env.ctrl_dt
    nxt = time.time()
    k = 0
    while True:
        with lock:
            while cmds:
                handle(cmds.pop(0))
                obs = env.obs()
        with torch.no_grad():
            net = untrained if brain[0] == "untrained" else model
            a, r, _ = net.act(torch.from_numpy(norm(obs)), deterministic=True)
        a, r = a.numpy(), r.numpy()
        binned_before = float(env.stats["binned"][0])
        _, te, _ = env.step(a, r)
        env.soc[0] = 1.0                          # sandbox: the battery never runs down
        totals["binned"] += int(env.stats["binned"][0] - binned_before)
        crashed = bool(env.stats["collide"][0] > 0)
        if crashed:
            totals["crashes"] += 1
            env.stats["collide"][0] = 0
            msg[0] = "The boat hit the bank and was put back at home."
            to_home()
        at_home = np.linalg.norm(env.pos[0] - env.home[0]) < 2.0 and env.home_flag[0] > 0.5
        if at_home and env.bin[0] > 0:
            env.bin[0] = 0                        # someone empties the bin at home
        obs = env.obs()
        k += 1
        alive = env.b_alive[0]
        if env.home_flag[0] > 0.5 and not alive.any():
            doing = "at home, pond clean" if at_home else "pond clean: home signal on"
        elif env.ramp[0] < -0.5:
            doing = "scoop tipping into the bin"
        elif env.m_valid[0, :M_BOTTLES].any() or env.ramp_load[0] > 0:
            doing = "plastic in camera view" if env.ramp[0] < 0.85 else "plastic in view, scoop down"
        else:
            doing = "no plastic in camera view"
        snap = dict(
            k=k, t=round(float(env.t[0]), 2),
            pos=env.pos[0].round(3).tolist(), psi=round(float(env.psi[0]), 4), ramp=round(float(env.ramp[0]), 3),
            thr=round(float(np.clip((a[0, 0] + 1) / 2, 0, 1)), 3), steer=round(float(np.clip(a[0, 1], -1, 1)), 3),
            u=round(float(env.u[0]), 2),
            bottles=env.b_pos[0][alive].round(3).tolist(),
            seen=env.m_pos[0][env.m_valid[0]].round(2).tolist(),
            ramp_load=int(env.ramp_load[0]), bin=int(env.bin[0]), binned=totals["binned"],
            crashes=totals["crashes"], doing=doing, msg=msg[0],
            poly=env.poly[0].round(2).tolist(), home=env.home[0].round(2).tolist(),
            cam=[round(CAM_FOV, 3), CAM_RANGE],
            label=(f"UNTRAINED (random weights)" if brain[0] == "untrained"
                   else f"{os.path.basename(args.model)} · iteration {st.get('it')}"),
            brain=brain[0],
        )
        with lock:
            state.clear()
            state.update(snap)
        nxt += dt
        time.sleep(max(0.0, nxt - time.time()))
        if time.time() - nxt > 1.0:               # fell behind (laptop busy): don't try to catch up
            nxt = time.time()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/state"):
            with lock:
                return self._json(dict(state))
        if self.path in ("/", "/index.html"):
            self.path = "/sandbox.html"
        return super().do_GET()

    def do_POST(self):
        if self.path != "/cmd":
            return self._json({"error": "unknown"}, 404)
        n = int(self.headers.get("Content-Length", 0))
        try:
            cmd = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._json({"error": "bad json"}, 400)
        with lock:
            cmds.append(cmd)
        return self._json({"ok": True})


if __name__ == "__main__":
    import sys
    port = 8094
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"sandbox: open http://localhost:{port}  (Ctrl+C to stop)", flush=True)
    try:
        main()
    except KeyboardInterrupt:
        pass
