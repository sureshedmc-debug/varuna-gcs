"""
Test the Pixhawk search: the configured TELEM2 port only sends garbage (wrong
baud), and the real Pixhawk is "plugged in by USB". The link must report what it
saw on TELEM2, then find the Pixhawk on USB and remember it.

Uses TCP stand-ins for the serial ports and the boat backend's simulated
ArduPilot vehicle (any ArduPilot heartbeat will do). Run:  python test_link_search.py
"""

import os
import random
import socket
import sys
import threading
import time

import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
BOAT = os.path.join(HERE, "..", "boat-pi")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# The boat's simulator imports "mav_link" (the boat's); load it first under that
# name, then load the drone's link under its own name.
_load("mav_link", os.path.join(BOAT, "mav_link.py"))
SimBoat = _load("sim_vehicle", os.path.join(BOAT, "sim_vehicle.py")).SimBoat
mav_link = _load("drone_mav_link", os.path.join(HERE, "mav_link.py"))

mav_link.SILENT_SWITCH_S = 1.5
GARBAGE_PORT, PIXHAWK_PORT = 5811, 5812


class Cfg(dict):
    saved = 0

    def __getitem__(self, k):
        return dict.__getitem__(self, k)

    def set(self, k, v):
        self[k] = v

    def save(self):
        Cfg.saved += 1


def garbage_server():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", GARBAGE_PORT))
    srv.listen(5)
    while True:
        c, _ = srv.accept()

        def pump(conn):
            try:
                while True:
                    conn.sendall(bytes(random.randrange(256) for _ in range(200)).replace(b"\xfd", b"\x00").replace(b"\xfe", b"\x00"))
                    time.sleep(0.05)
            except OSError:
                pass
        threading.Thread(target=pump, args=(c,), daemon=True).start()


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def main():
    threading.Thread(target=garbage_server, daemon=True).start()
    sim = SimBoat(17.4239, 78.4738, f"tcpin:127.0.0.1:{PIXHAWK_PORT}")
    sim.start()
    cfg = Cfg(mav_connection="", link_prefer="telem2", telem2_device=f"tcp:127.0.0.1:{GARBAGE_PORT}",
              telem2_baud=57600, usb_device="/dev/ttyACM0", usb_baud=115200)
    link = mav_link.DroneLink(cfg)
    link._usb_devices = staticmethod(lambda: [f"tcp:127.0.0.1:{PIXHAWK_PORT}"])
    link.start()
    try:
        t0 = time.time()
        while time.time() - t0 < 60 and not link.fc_connected:
            time.sleep(0.5)
        err_seen = link._tried.copy()
        check(link.fc_connected, f"Pixhawk found after {time.time() - t0:.0f}s via {link.link_name} ({link.connection})")
        check(link.link_name == "usb", "found on the USB fallback although TELEM2 was preferred")
        check(cfg["usb_device"] == f"tcp:127.0.0.1:{PIXHAWK_PORT}" and Cfg.saved >= 1, "working link remembered and saved")
        check(cfg["link_prefer"] == "auto", "wrong preference (TELEM2, Pixhawk on USB) reset to auto, so the next start finds it at once")
        check(link._worked_key == link._cand_key, "the working link is the one kept longest on a dropout")
        s = link.snapshot()
        check(s["fc_connected"] and s["link_error"] is None, "status clean once connected")
        print("  tried:", err_seen)
    finally:
        link.stop()
        sim.stop()

    # Nothing anywhere: the status must explain what was seen.
    cfg2 = Cfg(mav_connection="", link_prefer="telem2", telem2_device=f"tcp:127.0.0.1:{GARBAGE_PORT}",
               telem2_baud=57600, usb_device="/dev/ttyACM0", usb_baud=115200)
    link2 = mav_link.DroneLink(cfg2)
    link2._usb_devices = staticmethod(lambda: [])
    link2.start()
    try:
        time.sleep(1.5 * 3 + 2)
        msg = link2.snapshot()["link_error"] or ""
        print("  status:", msg[:300])
        check("data but no MAVLink" in msg and "SERIAL2_PROTOCOL" in msg, "garbage on TELEM2 → 'wrong baud/protocol' explanation")
    finally:
        link2.stop()
    print("\nLINK SEARCH TESTS PASSED")


if __name__ == "__main__":
    main()
