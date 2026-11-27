"""
Test the mission upload check: after every upload the boat reads the mission
back from the Pixhawk and compares it item by item. A good upload must pass;
a Pixhawk that stored a moved waypoint, a different hold or the wrong number of
items must be caught. Hold times must be whole seconds (ArduRover stores them
that way). Uses the simulated Pixhawk in-process. Run:  python test_mission_upload.py
"""

import tempfile
import time
from pathlib import Path

from pymavlink.dialects.v20 import ardupilotmega as mavlink

import mav_link
from camera_model import offset
from config import DEFAULTS
from mission import MissionManager
from sim_vehicle import SimBoat

HOME = (17.4239, 78.4738)
PORT = 5831


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def expect_error(fn, words):
    try:
        fn()
    except mav_link.LinkError as exc:
        return words in str(exc), str(exc)
    return False, "no error"


def main():
    sim = SimBoat(*HOME, f"tcpin:127.0.0.1:{PORT}")
    sim.start()
    link = mav_link.BoatLink(f"tcp:127.0.0.1:{PORT}", 115200)
    link.start()
    try:
        end = time.time() + 20
        while not link.fc_connected and time.time() < end:
            time.sleep(0.2)
        check(link.fc_connected, "connected to the simulated Pixhawk")

        missions = MissionManager(link, dict(DEFAULTS), Path(tempfile.mkdtemp()))
        pts = [offset(*HOME, 15, 0), offset(*HOME, 30, 8), offset(*HOME, 45, 0)]
        wps = [{"id": f"p{i}", "lat": la, "lng": lo} for i, (la, lo) in enumerate(pts, 1)]

        items, seq_map, _ = missions._build_items(wps, 2.6, 1.2, True)
        holds = [it["param1"] for s, it in enumerate(items) if s in seq_map]
        check(holds == [3, 3, 3], f"hold 2.6 s is sent as whole seconds: {holds}")

        plan = missions.upload("Upload check", [dict(w) for w in wps], hold_s=2.6, speed_mps=1.2)
        check(plan["item_count"] == len(sim.mission), f"good mission uploaded and verified ({plan['item_count']} items)")
        stored = [m for m in sim.mission if m.command == mavlink.MAV_CMD_NAV_WAYPOINT][1:]
        check([(m.x, m.y) for m in stored[:3]] == [(round(a * 1e7), round(b * 1e7)) for a, b in pts],
              "the Pixhawk holds every waypoint at the exact position")

        # A Pixhawk that stores item 3 two metres off must be caught.
        real_handle = sim._handle

        def moved(msg):
            if msg.get_type() == "MISSION_ITEM_INT" and msg.seq == 3:
                msg.x += 180
            real_handle(msg)
        sim._handle = moved
        ok, why = expect_error(lambda: link.upload_mission(items), "stored mission item 3 differently")
        check(ok, f"moved waypoint caught: {why}")

        # A different hold time must be caught.
        def held(msg):
            if msg.get_type() == "MISSION_ITEM_INT" and msg.seq == 4:
                msg.param1 = 9.0
            real_handle(msg)
        sim._handle = held
        ok, why = expect_error(lambda: link.upload_mission(items), "hold 9 s instead of 3 s")
        check(ok, f"changed hold caught: {why}")

        # A Pixhawk that reports the wrong number of items must be caught.
        sim._handle = real_handle
        real_count = sim.m.mav.mission_count_send
        sim.m.mav.mission_count_send = lambda s, c, n, *a: real_count(s, c, n - 1, *a)
        ok, why = expect_error(lambda: link.upload_mission(items), "instead of")
        check(ok, f"missing item caught: {why}")
        sim.m.mav.mission_count_send = real_count

        # And a normal upload works again afterwards.
        check(link.upload_mission(items) == len(items), "clean upload passes again after the faults")
    finally:
        link.stop()
        sim.stop()
    print("\nMISSION UPLOAD TESTS PASSED")


if __name__ == "__main__":
    main()
