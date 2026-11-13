"""
Test the Pixhawk search: the configured TELEM2 port only sends garbage (wrong
baud), and the real Pixhawk is "plugged in by USB". The link must report what it
saw on TELEM2, then find the Pixhawk on USB and hand the working link over to be
saved. Uses TCP stand-ins for the serial ports. Run:  python test_link_search.py
"""

import random
import socket
import threading
import time

import mav_link
from sim_vehicle import SimBoat

mav_link.SILENT_SWITCH_S = 1.5
GARBAGE_PORT, PIXHAWK_PORT = 5821, 5822
GARBAGE = f"tcp:127.0.0.1:{GARBAGE_PORT}"
PIXHAWK = f"tcp:127.0.0.1:{PIXHAWK_PORT}"


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


def make_link(candidates, saved):
    # "/dev/serial0" makes the link search; the stand-in ports replace the real ones.
    link = mav_link.BoatLink("/dev/serial0", 57600, on_link_found=lambda d, b: saved.append((d, b)))
    link._serial_candidates = lambda: list(candidates)
    return link


def main():
    threading.Thread(target=garbage_server, daemon=True).start()
    sim = SimBoat(17.4239, 78.4738, f"tcpin:127.0.0.1:{PIXHAWK_PORT}")
    sim.start()
    saved = []
    link = make_link([(GARBAGE, 57600), (PIXHAWK, 115200)], saved)
    link.start()
    try:
        t0 = time.time()
        while time.time() - t0 < 60 and not link.fc_connected:
            time.sleep(0.5)
        check(link.fc_connected, f"Pixhawk found after {time.time() - t0:.0f}s on {link.connection}")
        check(saved == [(PIXHAWK, 115200)], f"working link handed over to be saved: {saved}")
        s = link.snapshot()
        check(s["fc_connected"] and s["link_error"] is None, "status clean once connected")
    finally:
        link.stop()
        sim.stop()

    # Nothing anywhere: the status must explain what was seen.
    link2 = make_link([(GARBAGE, 57600), (GARBAGE, 115200)], [])
    link2.start()
    try:
        time.sleep(1.5 * 3 + 2)
        msg = link2.snapshot()["link_error"] or ""
        print("  status:", msg[:200].encode("ascii", "replace").decode())
        check("data but no MAVLink" in msg and "SERIAL2_PROTOCOL" in msg, "garbage on TELEM2 -> 'wrong baud/protocol' explanation")
    finally:
        link2.stop()

    # A network link (simulator / SITL) is used as it is — no search.
    link3 = mav_link.BoatLink("tcp:127.0.0.1:5999", 57600)
    check(link3._candidates() == [("tcp:127.0.0.1:5999", 57600)], "network links are not searched")
    print("\nLINK SEARCH TESTS PASSED")


if __name__ == "__main__":
    main()
