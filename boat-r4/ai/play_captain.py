"""Watch the trained captain drive, in the 3D viewer (live3d.html).

    py play_captain.py                 # runs/best.pt, one boat, real time
    py play_captain.py --boats 16      # a pond grid, like training
    py play_captain.py runs/latest.pt --difficulty 0.6

No learning happens here: the saved captain drives the simulated boat(s)
(deterministic actions, the same as on the real boat) and runs/play.json is
written every few seconds in the format the training viewers already read.
Ctrl+C to stop.
"""
import argparse
import json
import os
import time

import numpy as np
import torch

from boat_sim import VecBoat, load_fitted
from train import RUNS, Captain
import vec_workers

DT = 0.05            # sim step (20 Hz, same as the captain on the boat)
CHUNK = 200          # frames per update = 10 s of driving


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", nargs="?", default=os.path.join(RUNS, "best.pt"))
    ap.add_argument("--difficulty", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--boats", type=int, default=1, help="how many ponds to show (1-16)")
    ap.add_argument("--speed", type=float, default=1.0, help="playback speed vs real time")
    ap.add_argument("--river", action="store_true", help="a bending river with a current instead of ponds")
    args = ap.parse_args()

    st = torch.load(args.model, weights_only=False)
    model = Captain()
    model.load_state_dict(st["model"])
    model.eval()
    norm = st["norm"]
    nominal, fitted = load_fitted()
    n = max(1, min(16, args.boats))
    vec_workers.WATCH = n                       # _world() lists this many boats
    env = VecBoat(n, seed=args.seed, difficulty=args.difficulty, nominal=nominal)
    name = os.path.basename(args.model)
    label = f"VARUNA · trained captain ({name}, iteration {st['it']}) driving" + (" in a river" if args.river else "")
    if args.river:
        import river_world
        river_world.setup(env, np.arange(n))
    floated = 0
    print(f"{label}; physics fitted to real logs: {fitted}. Open live3d.html. Ctrl+C to stop.", flush=True)

    o = env.obs()
    chunk = 0
    runs_done, binned_done = 0, 0
    while True:
        t0 = time.time()
        frames = []
        with torch.no_grad():
            for _ in range(CHUNK):
                a, r, _ = model.act(torch.from_numpy(norm(o)), deterministic=True)
                a, r = a.numpy(), r.numpy()
                _, te, tr = env.step(a, r)
                if args.river:
                    floated += river_world.drift(env, env.ctrl_dt)
                done = te | tr
                frames.append([[round(float(env.pos[i, 0]), 2), round(float(env.pos[i, 1]), 2),
                                round(float(env.psi[i]), 3), round(float(env.ramp[i]), 2),
                                round(float(np.clip((a[i, 0] + 1) / 2, 0, 1)), 2),
                                round(float(np.clip(a[i, 1], -1, 1)), 2), bool(done[i])] for i in range(n)])
                if done.any():
                    idx = np.where(done)[0]
                    runs_done += len(idx)
                    binned_done += int(env.stats["binned"][idx].sum())
                    for i in idx:
                        why = ("crashed" if env.stats["collide"][i] else "home" if env.stats["home"][i]
                               else "time up")
                        print(f"  run {runs_done}: {why} after {env.t[i]:.0f} s | caught {int(env.stats['caught'][i])} "
                              f"in bin {int(env.stats['binned'][i])} | weed hits {int(env.stats['weed'][i])}", flush=True)
                    env.reset_envs(idx)
                    if args.river:
                        river_world.setup(env, idx)
                o = env.obs()
        world = vec_workers._world(env)
        for i, b in enumerate(world):
            b["frames"] = [f[i] for f in frames]
        chunk += 1
        tmp = os.path.join(RUNS, "play.tmp")
        json.dump(dict(it=chunk, steps=st["steps"], difficulty=args.difficulty, hours=0, sps=1 / DT,
                       dt=DT, label=label, boats=world), open(tmp, "w"))
        for k in range(20):          # Windows refuses the swap while the viewer's server is reading it
            try:
                os.replace(tmp, os.path.join(RUNS, "play.json"))   # its own file: training keeps writing live.json
                break
            except PermissionError:
                time.sleep(0.05)
        if runs_done:
            print(f"{chunk * CHUNK * DT / 60:5.1f} min | finished runs {runs_done} | "
                  f"avg in bin {binned_done / runs_done:.1f}" + (f" | floated away {floated}" if args.river else ""), flush=True)
        time.sleep(max(0.0, CHUNK * DT / args.speed - (time.time() - t0)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
