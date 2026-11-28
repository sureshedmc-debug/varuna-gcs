"""Export the trained captain for the boat phone.

    py export.py                # runs/best.pt (or latest.pt) -> out/captain.json + .bin + .onnx

captain.bin is the same numbers, packed small for the Boat Link app (assets/):
    "VCAP", int32 version=1, int32 obs_dim, int32 trained_iterations, int64 trained_steps,
    float32 clip, float32 mean[obs_dim], float32 std[obs_dim], int32 n_layers,
    then per layer: int32 out, int32 in, float32 W[out*in] (row-major), float32 b[out]
    (all little-endian)

captain.json holds the observation normaliser and the actor's layers (ELU between
them), so Boat Link can run it in plain Java with no ML library:
    x = clip((obs - mean) / std, -8, 8); for each layer: x = W x + b, ELU except last
    throttle = clip((x[0] + 1) / 2, 0, 1); steer = clip(x[1], -1, 1); ramp = argmax(x[2:5])
    (ramp 0 = lower and collect, 1 = raise and hold, 2 = tip into the bin)
"""
import json
import os
import sys

import numpy as np
import torch

from boat_sim import OBS_DIM
from train import RUNS, Captain, evaluate  # noqa: F401

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RUNS, "best.pt")
    if not os.path.exists(path):
        path = os.path.join(RUNS, "latest.pt")
    st = torch.load(path, weights_only=False)
    m = Captain()
    m.load_state_dict(st["model"])
    m.eval()
    norm = st["norm"]
    os.makedirs(OUT, exist_ok=True)
    layers = [l for l in m.actor if isinstance(l, torch.nn.Linear)]
    doc = {
        "name": "VARUNA boat captain", "obs_dim": OBS_DIM, "activation": "elu",
        "trained_iterations": st["it"], "trained_steps": st["steps"], "eval": st.get("eval"),
        "obs_mean": norm.mean.tolist(), "obs_std": np.sqrt(norm.var + 1e-8).tolist(), "obs_clip": 8,
        "layers": [{"W": l.weight.detach().numpy().round(6).tolist(), "b": l.bias.detach().numpy().round(6).tolist()}
                   for l in layers],
        "outputs": ["throttle (-1..1 -> 0..1)", "steer (-1..1)", "ramp lower", "ramp hold", "ramp tip"],
    }
    jp = os.path.join(OUT, "captain.json")
    json.dump(doc, open(jp, "w"))
    # self-check: the plain maths above gives the same answer as torch
    x = np.random.default_rng(0).normal(0, 1, (8, OBS_DIM)).astype(np.float32)
    h = norm(x)
    for i, l in enumerate(doc["layers"]):
        h = h @ np.array(l["W"]).T + np.array(l["b"])
        if i < len(doc["layers"]) - 1:
            h = np.where(h > 0, h, np.expm1(np.minimum(h, 0)))
    with torch.no_grad():
        ref = m.actor(torch.from_numpy(norm(x))).numpy()
    err = float(np.abs(h - ref).max())
    print(f"wrote {jp} ({os.path.getsize(jp)/1024:.0f} KB), plain-maths check max error {err:.2e}")
    bp = os.path.join(OUT, "captain.bin")
    with open(bp, "wb") as f:
        f.write(b"VCAP")
        f.write(np.array([1, OBS_DIM, int(st["it"])], "<i4").tobytes())
        f.write(np.array([int(st["steps"])], "<i8").tobytes())
        f.write(np.array([8.0], "<f4").tobytes())
        f.write(np.asarray(norm.mean, "<f4").tobytes())
        f.write(np.sqrt(np.asarray(norm.var) + 1e-8).astype("<f4").tobytes())
        f.write(np.array([len(layers)], "<i4").tobytes())
        for l in layers:
            W = l.weight.detach().numpy().astype("<f4")
            f.write(np.array(W.shape, "<i4").tobytes())
            f.write(W.tobytes())
            f.write(l.bias.detach().numpy().astype("<f4").tobytes())
    print(f"wrote {bp} ({os.path.getsize(bp)/1024:.0f} KB) for the Boat Link app")
    try:
        mean = torch.tensor(norm.mean, dtype=torch.float32)
        std = torch.tensor(np.sqrt(norm.var + 1e-8), dtype=torch.float32)

        class Wrapped(torch.nn.Module):
            def __init__(s):
                super().__init__()
                s.a = m.actor

            def forward(s, obs):
                return s.a(((obs - mean) / std).clamp(-8, 8))

        op = os.path.join(OUT, "captain.onnx")
        torch.onnx.export(Wrapped(), torch.zeros(1, OBS_DIM), op, input_names=["obs"], output_names=["act"],
                          dynamo=False)
        print("wrote", op)
    except Exception as e:  # ONNX is optional (the phone uses the JSON)
        print("ONNX export skipped:", e)


if __name__ == "__main__":
    main()
