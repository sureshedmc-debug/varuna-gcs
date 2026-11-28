"""Train the VARUNA boat captain with PPO on thousands of simulated boats at once.

    py train.py                 # train (resumes from runs/latest.pt if it exists)
    py train.py --hours 6       # stop after 6 hours
    py train.py --fresh         # start over

The policy (actor) only sees what the phone will see (noisy GPS, compass, gyro,
camera memory). The critic also sees the true state and this boat's physics
(asymmetric actor-critic: it trains faster, and only the actor goes on the boat).
Curriculum: difficulty (randomisation, wind, noise, weeds, pond size) rises as the
captain gets good. Every few minutes it is tested on 512 never-seen boats at full
difficulty; the best one is kept in runs/best.pt and exported for the phone.
"""
import argparse
import collections
import csv
import json
import os
import time

import numpy as np
import torch
import torch.nn as nn

from boat_sim import OBS_DIM, PRIV_DIM, VecBoat, load_fitted
from vec_workers import ParallelBoats, RunningNorm  # noqa: F401

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "runs")




def snapshot(world, frames, it, steps, difficulty, hrs, sps):
    """runs/live.json: the last few seconds of 6 training boats, for live.html."""
    for i, b in enumerate(world):
        b["frames"] = [f[i] for f in frames]
    tmp = os.path.join(RUNS, "live.tmp")
    try:                 # only a viewer snapshot: never let a busy file stop the training
        with open(tmp, "w") as f:
            json.dump(dict(it=it, steps=steps, difficulty=difficulty, hours=hrs, sps=sps, dt=0.05, boats=world), f)
        os.replace(tmp, os.path.join(RUNS, "live.json"))
    except OSError as e:
        print(f"(skipped a live.json snapshot: {e.__class__.__name__})", flush=True)


def mlp(i, o, h=256):
    return nn.Sequential(nn.Linear(i, h), nn.ELU(), nn.Linear(h, h), nn.ELU(), nn.Linear(h, 128), nn.ELU(), nn.Linear(128, o))


class Captain(nn.Module):
    def __init__(self):
        super().__init__()
        self.actor = mlp(OBS_DIM, 2 + 3)               # throttle, steer (Gaussian) + ramp (3 choices)
        self.critic = mlp(PRIV_DIM, 1)
        self.log_std = nn.Parameter(torch.full((2,), -0.5))
        with torch.no_grad():
            self.actor[-1].weight.mul_(0.01)
            self.actor[-1].bias.zero_()
            self.actor[-1].bias[0] = 0.2               # start gently moving
            self.actor[-1].bias[3] = 0.5               # and holding the ramp up

    def dist(self, o):
        out = self.actor(o)
        mu = out[:, :2]
        std = self.log_std.clamp(-3.0, 0.5).exp().expand_as(mu)
        return torch.distributions.Normal(mu, std), torch.distributions.Categorical(logits=out[:, 2:])

    def act(self, o, deterministic=False):
        g, c = self.dist(o)
        a = g.mean if deterministic else g.sample()
        r = c.probs.argmax(1) if deterministic else c.sample()
        return a, r, g.log_prob(a).sum(1) + c.log_prob(r)


def evaluate(model, norm, n=512, seed=12345, difficulty=1.0, nominal=None):
    env = VecBoat(n, seed=seed, difficulty=difficulty, nominal=nominal)
    done = np.zeros(n, bool)
    s = {k: np.zeros(n) for k in env.stats}
    t_end = np.zeros(n)
    o = env.obs()
    with torch.no_grad():
        for _ in range(env.max_steps):
            a, r, _ = model.act(torch.from_numpy(norm(o)), deterministic=True)
            _, te, tr = env.step(a.numpy(), r.numpy())
            new = (te | tr) & ~done
            for k in s:                      # freeze each boat's score the moment its run ends
                s[k][new] = env.stats[k][new]
            t_end[new] = env.t[new]
            done |= new
            if done.all():
                break
            o = env.obs()
    mins = np.maximum(t_end, 1) / 60
    return dict(caught=s["caught"].mean(), binned=s["binned"].mean(), per_min=(s["binned"] / mins).mean(),
                lost=s["lost"].mean(), weed=s["weed"].mean(), crash=s["collide"].mean(), home=s["home"].mean(),
                flat=s["flat"].mean(),
                wobble=np.degrees((s["yaw_abs"] / np.maximum(s["straight_t"], 1e-3)).mean()),
                score=(s["binned"] + 3 * s["home"] - 8 * s["collide"] - 2 * s["weed"]).mean()
                - 0.1 * np.degrees((s["yaw_abs"] / np.maximum(s["straight_t"], 1e-3)).mean()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--envs", type=int, default=2048)
    ap.add_argument("--horizon", type=int, default=64)
    ap.add_argument("--hours", type=float, default=8.0)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--polish", action="store_true", help="final phase: stricter straight-line, ramp and weed rewards")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--workers", type=int, default=7)
    ap.add_argument("--eval-every", type=int, default=40)
    ap.add_argument("--lr", type=float, default=3e-4, help="learning rate (also applied when resuming)")
    ap.add_argument("--patience-hours", type=float, default=0.0,
                    help="train until the best test score has not improved for this long (0 = off). "
                         "The learning rate halves after each third of it without a new best.")
    args = ap.parse_args()
    if args.polish:
        os.environ["VARUNA_POLISH"] = "1"   # workers read it when they start
    torch.set_num_threads(args.threads)
    os.makedirs(RUNS, exist_ok=True)
    nominal, fitted = load_fitted()
    print("physics centre:", "the REAL boat's logs (sysid)" if fitted else "estimated from the build (no logs yet)")

    N, T = args.envs, args.horizon
    gamma, lam, clip, epochs, mb = 0.995, 0.95, 0.2, 3, 16384
    model = Captain()
    opt = torch.optim.Adam(model.parameters(), lr=3e-4, eps=1e-5)
    norm, rnorm = RunningNorm(OBS_DIM), RunningNorm(PRIV_DIM)
    ret_rms, ret_acc = RunningNorm(1), np.zeros(N)
    it, steps, difficulty, best = 0, 0, 0.15, -1e9
    ck = os.path.join(RUNS, "latest.pt")
    if os.path.exists(ck) and not args.fresh:
        st = torch.load(ck, weights_only=False)
        model.load_state_dict(st["model"]); opt.load_state_dict(st["opt"])
        norm, rnorm, ret_rms = st["norm"], st["rnorm"], st["ret_rms"]
        it, steps, difficulty, best = st["it"], st["steps"], st["difficulty"], st["best"]
        if args.polish and not st.get("polish"):
            best = -1e9                       # new score (counts weaving): start the best-model race again
        print(f"resumed at iteration {it}, {steps/1e6:.1f} M steps, difficulty {difficulty:.2f}")
    for g in opt.param_groups:
        g["lr"] = args.lr
    if args.patience_hours:
        print(f"learning rate {args.lr:g}; stops after {args.patience_hours:g} h with no better captain (best so far {best:.2f})")
    env = ParallelBoats(N, args.workers, difficulty, nominal, seed=it + 7)
    log_path = os.path.join(RUNS, "log.csv")
    new_log = not os.path.exists(log_path) or args.fresh
    logf = open(log_path, "w" if new_log else "a", newline="")
    w = csv.writer(logf)
    if new_log:
        w.writerow(["it", "steps", "hours", "difficulty", "ep_return", "caught", "binned", "crash", "home", "weed",
                    "eval_binned", "eval_per_min", "eval_crash", "eval_home", "eval_weed", "eval_wobble", "eval_score",
                    "steps_per_s"])
    t_start, deadline = time.time(), time.time() + args.hours * 3600
    o, pv = env.start()
    fin = {k: collections.deque(maxlen=1500) for k in ("ep_ret", "caught", "binned", "collide", "home", "weed")}

    last_best = time.time()
    while time.time() < deadline:
        if args.patience_hours:
            stall = time.time() - last_best
            if stall > args.patience_hours * 3600:
                print(f"done: no better captain for {args.patience_hours:g} h (best {best:.2f})", flush=True)
                break
            want = args.lr * 0.5 ** int(stall / (args.patience_hours * 1200))
            if want < opt.param_groups[0]["lr"] - 1e-12:
                for g in opt.param_groups:
                    g["lr"] = want
                print(f"no new best for {stall/3600:.1f} h: learning rate now {want:g}", flush=True)
        t0 = time.time()
        buf = {k: [] for k in ("o", "p", "a", "r", "lp", "rew", "done", "v")}
        model.eval()
        frames = []
        with torch.no_grad():
            for _ in range(T):
                norm.update(o); rnorm.update(pv)
                on, pn = norm(o), rnorm(pv)
                a, r, lp = model.act(torch.from_numpy(on))
                v = model.critic(torch.from_numpy(pn)).squeeze(1)
                rew, te, tr, o, pv, pv_tr, fdone, frame = env.step(a.numpy(), r.numpy())
                frames.append(frame)
                if tr.any():   # time ran out (not the boat's fault): bootstrap from where it got to
                    vt = model.critic(torch.from_numpy(rnorm(pv_tr))).squeeze(1).numpy()
                    rew = rew.copy(); rew[tr] += gamma * vt * np.sqrt(ret_rms.var[0] + 1e-8)
                done = te | tr
                ret_acc = ret_acc * gamma * (1 - done) + rew
                ret_rms.update(ret_acc[:, None])
                for k, x in zip(("o", "p", "a", "r", "lp", "rew", "done", "v"), (on, pn, a, r, lp, rew, done, v)):
                    buf[k].append(torch.as_tensor(x))
                if fdone is not None:
                    for k in fin:
                        fin[k].extend(fdone[k].tolist())
            last_v = model.critic(torch.from_numpy(rnorm(pv))).squeeze(1)
        t_roll = time.time() - t0
        steps += N * T
        rs = np.sqrt(ret_rms.var[0] + 1e-8)
        rew = torch.stack(buf["rew"]).float() / rs
        done = torch.stack(buf["done"]).float()
        val = torch.stack(buf["v"])
        adv = torch.zeros_like(rew)
        g = torch.zeros(N)
        for t in reversed(range(T)):
            nv = last_v if t == T - 1 else val[t + 1]
            delta = rew[t] + gamma * nv * (1 - done[t]) - val[t]
            g = delta + gamma * lam * (1 - done[t]) * g
            adv[t] = g
        ret = adv + val
        O = torch.stack(buf["o"]).reshape(N * T, -1)
        P = torch.stack(buf["p"]).reshape(N * T, -1)
        A = torch.stack(buf["a"]).reshape(N * T, -1)
        R = torch.stack(buf["r"]).reshape(-1)
        LP, ADV, RET, V0 = (x.reshape(-1) for x in (torch.stack(buf["lp"]), adv, ret, val))
        ADV = (ADV - ADV.mean()) / (ADV.std() + 1e-8)
        model.train()
        kl_stop = False
        for _ in range(epochs):
            perm = torch.randperm(N * T)
            for s in range(0, N * T, mb):
                j = perm[s:s + mb]
                gd, cd = model.dist(O[j])
                lp = gd.log_prob(A[j]).sum(1) + cd.log_prob(R[j])
                ratio = (lp - LP[j]).exp()
                pl = -torch.min(ratio * ADV[j], ratio.clamp(1 - clip, 1 + clip) * ADV[j]).mean()
                v = model.critic(P[j]).squeeze(1)
                vc = V0[j] + (v - V0[j]).clamp(-clip, clip)
                vl = 0.5 * torch.max((v - RET[j]) ** 2, (vc - RET[j]) ** 2).mean()
                ent = gd.entropy().sum(1).mean() + 0.5 * cd.entropy().mean()
                # smooth hands: penalise a jumpy policy (nearby states -> nearby actions)
                q = j[: len(j) // 4]           # (checked on a quarter of the batch: same effect, 35% faster)
                smooth = ((gd.mean[: len(q)] - model.dist(O[q] + 0.05 * torch.randn_like(O[q]))[0].mean) ** 2).mean()
                loss = pl + 0.5 * vl - 0.003 * ent + 0.5 * smooth
                opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
                with torch.no_grad():
                    kl = (LP[j] - lp).mean().item()
                if kl > 0.03:
                    kl_stop = True
                    break
            if kl_stop:
                break
        it += 1
        sps = N * T / (time.time() - t0)
        # curriculum: harder when the captain copes
        hrs = (time.time() - t_start) / 3600
        snapshot(env.world(), frames, it, steps, difficulty, hrs, sps)
        if len(fin["ep_ret"]) >= 20:
            m = {k: float(np.mean(v)) for k, v in fin.items()}
            if len(fin["ep_ret"]) >= 400:
                old = difficulty
                if m["collide"] < 0.12 and m["binned"] >= 2.0 and difficulty < 1.0:
                    difficulty = min(1.0, difficulty + 0.05)
                elif m["collide"] > 0.35 and difficulty > 0.15:
                    difficulty = max(0.15, difficulty - 0.05)
                if difficulty != old:
                    env.set_difficulty(difficulty)
                    for v in fin.values():
                        v.clear()
            ev = {}
            if it % args.eval_every == 0:
                model.eval()
                ev = evaluate(model, norm, n=256, nominal=nominal)
                if ev["score"] > best and difficulty >= 0.6:
                    best = ev["score"]
                    last_best = time.time()
                    print(f"new best captain: score {best:.2f} at iteration {it + 0}", flush=True)
                    torch.save({"model": model.state_dict(), "norm": norm, "it": it, "steps": steps, "eval": ev,
                                "difficulty": difficulty}, os.path.join(RUNS, "best.pt"))
            w.writerow([it, steps, f"{hrs:.3f}", f"{difficulty:.2f}", f"{m['ep_ret']:.1f}", f"{m['caught']:.2f}",
                        f"{m['binned']:.2f}", f"{m['collide']:.3f}", f"{m['home']:.3f}", f"{m['weed']:.2f}"]
                       + ([f"{ev[k]:.3f}" for k in ("binned", "per_min", "crash", "home", "weed", "wobble", "score")]
                          if ev else [""] * 7) + [f"{sps:.0f}"])
            logf.flush()
            print(f"it {it:5d} | {steps/1e6:7.1f} M steps | diff {difficulty:.2f} | ret {m['ep_ret']:7.1f} | "
                  f"caught {m['caught']:5.2f} binned {m['binned']:5.2f} crash {m['collide']:.2f} home {m['home']:.2f} "
                  f"| {sps:,.0f} st/s (sim {t_roll:.1f}s)" + (f" || EVAL binned {ev['binned']:.2f} ({ev['per_min']:.2f}/min) crash "
                                         f"{ev['crash']:.2f} home {ev['home']:.2f} wobble {ev['wobble']:.1f} deg/s "
                                         f"score {ev['score']:.2f}" if ev else ""), flush=True)
        if it % 20 == 0:
            torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "norm": norm, "rnorm": rnorm,
                        "ret_rms": ret_rms, "it": it, "steps": steps, "difficulty": difficulty, "best": best, "polish": args.polish}, ck)
    torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "norm": norm, "rnorm": rnorm,
                "ret_rms": ret_rms, "it": it, "steps": steps, "difficulty": difficulty, "best": best, "polish": args.polish}, ck)
    env.close()
    print("done: time limit reached")


if __name__ == "__main__":
    main()
