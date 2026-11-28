"""Check analyze_log.py: a fake boat with known numbers must be found again (within 15 %).

    py boat-r4\\sysid\\test_sysid.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "test")
env = dict(os.environ, PYTHONIOENCODING="utf-8")
subprocess.run([sys.executable, os.path.join(HERE, "make_test_log.py")], check=True, env=env, capture_output=True)
subprocess.run([sys.executable, os.path.join(HERE, "analyze_log.py"), os.path.join(T, "fake_boat.tlog"),
                "--out", os.path.join(T, "out")], check=True, env=env, capture_output=True)
truth = json.load(open(os.path.join(T, "truth.json")))
model = json.load(open(os.path.join(T, "out", "boat_model.json")))
ok = fail = 0
for part in ("surge", "yaw"):
    for k, want in truth[part].items():
        if k == "bias":
            continue                       # it also takes in the phone gyro's own offset
        got = model[part]["delay_s"] if k == "delay_s" else model[part]["coef"].get(k)
        good = got is not None and (abs(got - want) <= 0.06 if k == "delay_s" else abs(got - want) <= 0.15 * abs(want))
        print(f"{'ok  ' if good else 'FAIL'} {part:5} {k:9} true {want:<7g} found {got if got is None else round(got, 3)}")
        ok += good
        fail += not good
drift = model["surge"].get("water_drift_ms", [{}])[0]
good = abs(drift.get("north", 9) - 0.05) < 0.02 and abs(drift.get("east", 9) + 0.03) < 0.02
print(f"{'ok  ' if good else 'FAIL'} water drift found {drift}")
ok += good
fail += not good
print(f"{ok}/{ok + fail} passed")
sys.exit(1 if fail else 0)
