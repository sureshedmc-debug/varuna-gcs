"""Run the simulated boats on all CPU cores: each worker process owns a slice of the
fleet (its own VecBoat) and steps it when the trainer sends actions."""
import multiprocessing as mp
import os

import numpy as np

WATCH = 16           # boats (in worker 0) shown in the live viewers
STAT_KEYS = ("ep_ret", "caught", "binned", "collide", "home", "weed")


class RunningNorm:
    def __init__(self, dim):
        self.mean, self.var, self.count = np.zeros(dim), np.ones(dim), 1e-4

    def update(self, x):
        bm, bv, bc = x.mean(0), x.var(0), len(x)
        d = bm - self.mean
        tot = self.count + bc
        self.mean = self.mean + d * bc / tot
        self.var = (self.var * self.count + bv * bc + d ** 2 * self.count * bc / tot) / tot
        self.count = tot

    def __call__(self, x):
        return np.clip((x - self.mean) / np.sqrt(self.var + 1e-8), -8, 8).astype(np.float32)


def _world(env):
    out = []
    for i in range(WATCH):
        out.append(dict(
            poly=env.poly[i].round(2).tolist(), home=env.home[i].round(2).tolist(),
            weeds=[[*env.w_pos[i, j].round(2).tolist(), round(float(env.w_rad[i, j]), 2)]
                   for j in range(env.w_on.shape[1]) if env.w_on[i, j]],
            bottles=env.b_pos[i][env.b_alive[i]].round(2).tolist(),
            seen=env.m_pos[i][env.m_valid[i]].round(2).tolist(),
            caught=int(env.stats["caught"][i]), binned=int(env.stats["binned"][i]),
            ramp_load=int(env.ramp_load[i]), bin=int(env.bin[i]), t=round(float(env.t[i]), 1),
            wind=env.wind[i].round(2).tolist(), diff=round(float(env.diff[i]), 2)))
    return out


def _worker(wid, n, seed, difficulty, nominal, conn):
    from boat_sim import VecBoat
    env = VecBoat(n, seed=seed, difficulty=difficulty, nominal=nominal)
    while True:
        cmd, data = conn.recv()
        if cmd == "start":
            o = env.obs()
            conn.send((o, env.priv(o)))
        elif cmd == "step":
            a, r = data
            rew, te, tr = env.step(a, r)
            frame = None
            if wid == 0:
                frame = [[round(float(env.pos[i, 0]), 2), round(float(env.pos[i, 1]), 2), round(float(env.psi[i]), 3),
                          round(float(env.ramp[i]), 2), round(float(np.clip((a[i, 0] + 1) / 2, 0, 1)), 2),
                          round(float(np.clip(a[i, 1], -1, 1)), 2), bool(te[i] | tr[i])] for i in range(WATCH)]
            o = env.obs()
            pv_tr = env.priv(o)[tr] if tr.any() else None
            done = te | tr
            fin = None
            if done.any():
                idx = np.where(done)[0]
                fin = {k: env.stats[k][idx].copy() for k in STAT_KEYS}
                env.reset_envs(idx)
                o = env.obs()
            conn.send((rew, te, tr, o, env.priv(o), pv_tr, fin, frame))
        elif cmd == "diff":
            env.diff_max = data
            conn.send(True)
        elif cmd == "world":
            conn.send(_world(env))
        elif cmd == "close":
            break


class ParallelBoats:
    def __init__(self, n, workers, difficulty, nominal, seed=0):
        os.environ.setdefault("OMP_NUM_THREADS", "1")
        os.environ["MKL_NUM_THREADS"] = os.environ["OPENBLAS_NUM_THREADS"] = "1"
        ctx = mp.get_context("spawn")
        sizes = [n // workers + (1 if i < n % workers else 0) for i in range(workers)]
        self.n, self.sizes, self.conns, self.procs = n, sizes, [], []
        for i, k in enumerate(sizes):
            a, b = ctx.Pipe()
            p = ctx.Process(target=_worker, args=(i, k, seed * 100 + i, difficulty, nominal, b), daemon=True)
            p.start()
            self.conns.append(a)
            self.procs.append(p)
        self.cuts = np.cumsum([0] + sizes)

    def start(self):
        for c in self.conns:
            c.send(("start", None))
        res = [c.recv() for c in self.conns]
        return np.concatenate([r[0] for r in res]), np.concatenate([r[1] for r in res])

    def step(self, a, r):
        for i, c in enumerate(self.conns):
            s, e = self.cuts[i], self.cuts[i + 1]
            c.send(("step", (a[s:e], r[s:e])))
        res = [c.recv() for c in self.conns]
        cat = lambda j: np.concatenate([x[j] for x in res])  # noqa: E731
        rew, te, tr, o, pv = cat(0), cat(1), cat(2), cat(3), cat(4)
        pv_tr = [x[5] for x in res if x[5] is not None]
        pv_tr = np.concatenate(pv_tr) if pv_tr else None
        fin = {k: np.concatenate([x[6][k] for x in res if x[6] is not None]) for k in STAT_KEYS} \
            if any(x[6] is not None for x in res) else None
        return rew, te, tr, o, pv, pv_tr, fin, res[0][7]

    def set_difficulty(self, d):
        for c in self.conns:
            c.send(("diff", d))
        for c in self.conns:
            c.recv()

    def world(self):
        self.conns[0].send(("world", None))
        return self.conns[0].recv()

    def close(self):
        for c in self.conns:
            try:
                c.send(("close", None))
            except Exception:
                pass
        for p in self.procs:
            p.join(timeout=2)
