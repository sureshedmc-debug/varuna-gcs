"""Physics sanity checks for boat_sim (run: py sim_check.py)."""
import time
import numpy as np
from boat_sim import VecBoat, OBS_DIM, PRIV_DIM

def run(thr, steer, ramp, secs, n=64, d=0.0):
    e = VecBoat(n, seed=1, difficulty=d, ep_seconds=999)
    # big empty pond so the shore never ends it
    e.poly *= 20; e.pos[:] = 0; e.home[:] = 0
    a = np.zeros((n, 2), np.float32); a[:, 0] = thr * 2 - 1; a[:, 1] = steer
    ra = np.full(n, ramp)
    for _ in range(int(secs / 0.05)):
        e.step(a, ra)
    return e

ok = True
def check(name, val, lo, hi):
    global ok
    good = lo <= val <= hi
    ok &= good
    print(f"{'PASS' if good else 'FAIL'} {name}: {val:.3f} (want {lo}..{hi})")

e = run(1.0, 0, 1, 20); check("top speed, ramp up (m/s)", e.u.mean(), 1.1, 1.7)
e = run(1.0, 0, 0, 20); check("top speed, ramp down (m/s)", e.u.mean(), 0.7, 1.3)
e = run(0.5, 0, 1, 20); check("half throttle speed (m/s)", e.u.mean(), 0.4, 1.0)
e = run(0.6, 1.0, 1, 15); check("full right turn rate (deg/s)", np.degrees(e.r.mean()), 25, 150)
e = run(0.6, -1.0, 1, 15); check("full left turn rate (deg/s)", np.degrees(e.r.mean()), -150, -25)
e = run(0.6, 0, 1, 15); check("straight: |yaw rate| (deg/s)", abs(np.degrees(e.r.mean())), 0, 0.5)
e = run(1.0, 0, 1, 15)
a = np.zeros((64, 2), np.float32); a[:, 0] = -1
t = 0
while e.u.mean() > 0.2 and t < 400:
    e.step(a, np.ones(64, int)); t += 1
check("coast 1.3 -> 0.2 m/s (s)", t * 0.05, 1.0, 8.0)
e = VecBoat(256, seed=2, difficulty=1.0)
o = e.obs(); check("obs finite", float(np.isfinite(o).all()), 1, 1)
check("obs dim", o.shape[1], OBS_DIM, OBS_DIM); check("priv dim", e.priv(o).shape[1], PRIV_DIM, PRIV_DIM)
e = VecBoat(2048, seed=3, difficulty=1.0)
a = np.random.uniform(-1, 1, (2048, 2)).astype(np.float32)
t0 = time.time()
for _ in range(50):
    r, te, tr = e.step(a, np.random.randint(0, 3, 2048)); o = e.obs()
    done = te | tr
    e.reset_envs(np.where(done)[0])
sps = 50 * 2048 / (time.time() - t0)
print(f"speed: {sps:,.0f} boat-steps/s with 2048 boats")
print("ALL PASS" if ok else "SOME FAILED")
