"""A river stretch for play_captain.py --river (viewing only; training still uses ponds).

Replaces each pond with a 55-80 m long, 11-16 m wide bending river with a steady
current down it. Bottles float down the middle of the channel, new ones drift in
from upstream now and then, and any that reach the downstream end float away.
The captain is the same trained network, driving exactly as on the real boat.
"""
import numpy as np

F = np.float32
TAU = 2 * np.pi

_riv = {}          # env index -> (L, W, A, k, ph, dir)


def _centre(i, x):
    L, W, A, k, ph, d = _riv[i]
    return A * np.sin(k * x + ph)


def setup(env, idx, rng=np.random):
    """Turn the ponds `idx` into river stretches (call right after reset_envs)."""
    K = env.poly.shape[1]
    half = K // 2
    for i in np.atleast_1d(idx):
        L = rng.uniform(55, 80)
        W = rng.uniform(11, 16)
        A = rng.uniform(1.5, 4.0)
        k = TAU / rng.uniform(45, 70)
        ph = rng.uniform(0, TAU)
        d = 1.0 if rng.uniform() < 0.5 else -1.0          # which way the water flows
        _riv[i] = (L, W, A, k, ph, d)
        xs = np.linspace(-L / 2, L / 2, half)
        c = A * np.sin(k * xs + ph)
        left = np.stack([xs, c + W / 2], -1)
        right = np.stack([xs[::-1], c[::-1] - W / 2], -1)
        env.poly[i] = np.concatenate([left, right]).astype(F)

        # home: by the upstream bank; the boat starts there facing downstream, a little into the river
        hx = -d * (L / 2 - 5)
        side = 1.0 if rng.uniform() < 0.5 else -1.0
        env.home[i] = (hx, _centre(i, hx) + side * (W / 2 - 2.2))
        env.pos[i] = env.home[i] + rng.uniform(-1, 1, 2)
        env.psi[i] = ((0.0 if d > 0 else np.pi) - side * rng.uniform(0.2, 0.6)) % TAU

        # current along the river (kept within what the captain trained on: up to 0.15 m/s)
        cs = rng.uniform(0.08, 0.15)
        env.vel_c[i] = (d * cs, 0.0)

        # bottles spread along the channel, a few in clumps
        nb = int(env.b_alive[i].sum())
        bx = rng.uniform(-L / 2 + 8, L / 2 - 6, env.b_pos.shape[1])
        by = _centre(i, bx) + rng.uniform(-W / 2 + 2, W / 2 - 2, env.b_pos.shape[1])
        env.b_pos[i, :, 0], env.b_pos[i, :, 1] = bx, by
        env.b_alive[i] = np.arange(env.b_pos.shape[1]) < max(nb, 6)

        # weeds: 0-2 patches hugging the banks, away from home
        env.w_on[i] = False
        for j in range(rng.randint(0, 3)):
            wx = rng.uniform(-L / 2 + 15, L / 2 - 8)
            env.w_pos[i, j] = (wx, _centre(i, wx) + rng.choice([-1, 1]) * (W / 2 - 1.8))
            env.w_rad[i, j] = rng.uniform(0.8, 1.8)
            env.w_on[i, j] = True

        # search: zig-zag down the river and back
        wx = np.linspace(-L / 2 + 8, L / 2 - 8, 6) * d          # upstream -> downstream
        wx = np.concatenate([wx[::2], wx[1::2][::-1]])
        wy = _centre(i, wx) + np.array([1, -1, 1, -1, 1, -1]) * W * 0.18
        env.wps[i, :, 0], env.wps[i, :, 1] = wx, wy

        env.m_valid[i] = False
        env.m_miss[i] = 0
        env.m_seen[i] = 0
        env.goal_kind[i] = -1
    idx = np.atleast_1d(idx)
    env._sense(idx, first=True)
    env.phi[idx] = env._potential(idx)


def drift(env, dt, rng=np.random):
    """After each env.step: bottles follow the river's bends, leave at the downstream end,
    and new ones drift in from upstream every so often. Returns how many floated away."""
    gone = 0
    for i, (L, W, A, k, ph, d) in _riv.items():
        x = env.b_pos[i, :, 0]
        x_old = x - env.vel_c[i, 0] * dt
        env.b_pos[i, :, 1] += _centre(i, x) - _centre(i, x_old)        # stay in the channel through bends
        out = env.b_alive[i] & ((x * d) > L / 2 - 1.5)
        gone += int(out.sum())
        env.b_alive[i] &= ~out
        free = np.where(~env.b_alive[i])[0]
        if len(free) and rng.uniform() < dt / 25.0:                      # about one new bottle per 25 s
            j = free[0]
            sx = -d * (L / 2 - 3)
            env.b_pos[i, j] = (sx, _centre(i, sx) + rng.uniform(-W / 2 + 2.5, W / 2 - 2.5))
            env.b_alive[i, j] = True
    return gone
