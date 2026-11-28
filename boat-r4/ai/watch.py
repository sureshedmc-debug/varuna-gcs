"""Overnight watcher: keeps Windows awake while training runs (no settings changed; it ends
when this exits) and exits with one line when something needs attention:
FINISHED, ERROR, HANG, STUCK (curriculum not advancing) or PLATEAU (test score flat).

    py watch.py [stuck_hours=3] [plateau_hours=2.5]
"""
import csv
import ctypes
import os
import sys
import time

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")
if os.name == "nt":
    ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
STUCK_H = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
PLATEAU_H = float(sys.argv[2]) if len(sys.argv) > 2 else 2.5
FULL_EXIT = "--full" in sys.argv


def rows():
    with open(os.path.join(RUNS, "log.csv"), newline="") as f:
        return list(csv.DictReader(f))


out_path = os.path.join(RUNS, "train_out.txt")
err_at = os.path.getsize(out_path)
start = time.time()
last_n, last_new = len(rows()), start
diff_since = (rows()[-1]["difficulty"], start)       # (difficulty, when it last changed)
best = (-1e9, start)                                  # (best test score at full difficulty, when)
while True:
    time.sleep(60)
    now = time.time()
    with open(out_path, errors="ignore") as f:
        f.seek(err_at)
        tail = f.read()
    if "Traceback" in tail:
        print("ERROR: training crashed:", tail[-600:].replace("\n", " | "), flush=True)
        break
    r = rows()
    for x in r[last_n:]:
        if x["difficulty"] != diff_since[0]:
            diff_since = (x["difficulty"], now)
        if x["eval_score"] and float(x["difficulty"]) >= 1.0 and float(x["eval_score"]) > best[0]:
            best = (float(x["eval_score"]), now)
    if len(r) > last_n:
        last_n, last_new = len(r), now
    if "done: time limit" in tail:
        print(f"FINISHED: {r[-1]['it']} iterations, {int(r[-1]['steps'])/1e6:.0f} M steps, difficulty {r[-1]['difficulty']}",
              flush=True)
        break
    if now - last_new > 900:
        print("HANG: no progress for 15 minutes", flush=True)
        break
    if float(diff_since[0]) < 1.0 and now - diff_since[1] > STUCK_H * 3600:
        print(f"STUCK: difficulty {diff_since[0]} has not moved for {STUCK_H} h", flush=True)
        break
    if FULL_EXIT and float(diff_since[0]) >= 1.0 and now - diff_since[1] > 1800:
        print("FULL: difficulty 1.0 reached 30 min ago: time for the polish phase", flush=True)
        break
    if float(diff_since[0]) >= 1.0 and best[0] > -1e9 and now - best[1] > PLATEAU_H * 3600:
        print(f"PLATEAU: best full-difficulty test score {best[0]:.2f}, no better for {PLATEAU_H} h", flush=True)
        break
