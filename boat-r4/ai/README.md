# VARUNA boat captain (reinforcement learning)

An AI "captain" for the air boat, trained the NVIDIA way: thousands of simulated
boats at once, each with slightly different physics, weather and sensor errors,
so that what works on all of them works on the real one.

| File | What it does |
|---|---|
| `boat_sim.py` | Vectorised simulator of the real boat (60 x 40 cm, 1.5 kg, 1.27 cm draft, two 2200 KV motors 30 cm up, a fin and servo behind each, bow mesh ramp, open-well bin). Domain randomisation, weeds, drifting bottles, shore, wind, gusts, current, phone GPS/compass/gyro/camera errors and delay |
| `sim_check.py` | Physics sanity tests (top speed, ramp drag, turning, coasting, speed) |
| `train.py` | PPO, 2048 boats in parallel, asymmetric actor-critic, curriculum, smooth-action penalty. Saves `runs/latest.pt`, `runs/best.pt`, `runs/log.csv` |
| `live3d.html` | 3D training world (Isaac-style grid of 16 training ponds, ride-along camera). Start the `boat-ai-live` preview, open `/live3d.html` |
| `live.html` | 2D view + learning curves |
| `vec_workers.py` | Runs the fleet on all CPU cores |
| `export.py` | `out/captain.json` (plain maths, for Java in Boat Link) + `out/captain.onnx` |
| `play_captain.py` | Watch the trained captain drive (no learning) in `live3d.html`: one boat by default, `--boats 16` for a grid |

`export.py` also writes `out/captain.bin`, which Boat Link (boat-phone, 2.4.0+) copies into
its assets at every build. On the phone the captain runs **watch only** (shows what it would
do) or, switched on and confirmed on the phone screen, **full control** (MANUAL + RC override,
only while armed, GPS and compass good, within 60 m of home; SwD up on the FS-i6 always wins).

```powershell
py sim_check.py
py train.py --hours 8          # resumes from runs/latest.pt; --fresh to start over
py export.py
```

## What the captain does
Every 50 ms (20 Hz) it reads what the phone knows (speed, turn rate, the ramp,
how full the ramp and bin are, the battery, the 4 nearest bottles the camera
has seen, the 2 nearest weed patches, 8 distance rays to the shore, home and the
next search point) and outputs throttle, steer (both fins + a little motor
difference, mixed like the ESP32 brain) and a ramp command: lower and collect,
raise and hold, or tip into the bin.

It learns to: hold a straight line in wind, steer to bottles, lower the ramp
just before reaching one and slow down so the bow wave does not push it away,
raise the ramp across weed, tip into the bin when the ramp is full (slowly),
search when it sees nothing, keep off the shore, and come home when the bin is
full or the battery is low.

## Sim to real
The physics centre is an estimate from the build until real logs exist. After
driving `../sysid/TEST_RUNS.md` and running `../sysid/analyze_log.py`,
`train.py` automatically centres the randomisation on the fitted
`sysid/out/boat_model.json`; then train again (resume) for a calibrated captain.
The ESP32 keeps every failsafe and the FS-i6 override: the captain only sends
commands in AUTO, and the brain still limits them.
