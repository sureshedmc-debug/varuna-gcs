"""
Bench tool: run the intake belt from the laptop with the boat Pixhawk on USB.

    py belt_usb.py            (finds the Pixhawk's COM port)
    py belt_usb.py COM7

Keys:  F / R  run forward      B  run in reverse      S / Space  stop
       + / -  speed            1-9  run that many seconds in the last direction
       Q  quit

The belt is the brushed ESC on Pixhawk output 2 (SERVO2_FUNCTION 0), driven
with DO_SET_SERVO: 1500 stops it, above runs it forward, below in reverse
(a forward/reverse ESC). Changing direction while running stops it for half a
second first, so the motor and gearbox aren't slammed. Close Mission Planner
first, it holds the port. The belt is always stopped on quit, on Ctrl+C and
on errors.
"""

import msvcrt
import sys
import time

from pymavlink import mavutil
from serial.tools import list_ports

OUTPUT = 2
STOP = 1500
SPEED_MIN, SPEED_MAX, STEP = 50, 500, 50     # µs away from STOP
REVERSE_PAUSE_S = 0.5


def find_port():
    for p in list_ports.comports():
        if p.vid == 0x1209 or "ArduPilot" in (p.description or "") or "PX4" in (p.description or ""):
            return p.device
    raise SystemExit("No Pixhawk found on USB. Plug it in, or pass the port: py belt_usb.py COM7")


def main():
    port = sys.argv[1] if len(sys.argv) > 1 else find_port()
    m = mavutil.mavserial(port, baud=115200, autoreconnect=False)
    if not m.wait_heartbeat(timeout=10):
        raise SystemExit(f"No heartbeat from the Pixhawk on {port}.")

    def out(pwm):
        m.mav.command_long_send(m.target_system, m.target_component, 183, 0, OUTPUT, pwm, 0, 0, 0, 0, 0)
        ack = m.recv_match(type="COMMAND_ACK", blocking=True, timeout=2)
        if not ack or ack.result != 0:
            print(f"\n  Pixhawk refused output {OUTPUT} = {pwm} — is SERVO{OUTPUT}_FUNCTION 0?")
            return False
        return True

    speed = 300              # 1800 forward / 1200 reverse
    direction = 1            # 1 forward, -1 reverse: the last one asked for
    running = 0              # 0 stopped, 1 forward, -1 reverse

    def pwm(d):
        return STOP + d * speed

    def run(d):
        nonlocal running, direction
        direction = d
        if running == -d:                    # changing direction: stop first
            out(STOP)
            running = 0
            time.sleep(REVERSE_PAUSE_S)
        running = d if out(pwm(d)) else running

    def stop():
        nonlocal running
        out(STOP)
        running = 0

    def show():
        state = {1: "FORWARD", -1: "REVERSE", 0: "stopped"}[running]
        sig = pwm(running) if running else STOP
        print(f"\r  Belt: {state:<8} signal {sig}  speed {speed}  ", end="", flush=True)

    print(f"Pixhawk on {port}. F/R forward, B reverse, S/Space stop, +/- speed, 1-9 run N s, Q quit.")
    stop()
    show()
    try:
        while True:
            m.recv_match(blocking=False)              # keep the link drained
            if not msvcrt.kbhit():
                time.sleep(0.02)
                continue
            k = msvcrt.getwch().lower()
            if k in ("f", "r"):
                run(1)
            elif k == "b":
                run(-1)
            elif k in ("s", " "):
                stop()
            elif k in ("+", "=", "-", "_"):
                speed = min(SPEED_MAX, speed + STEP) if k in ("+", "=") else max(SPEED_MIN, speed - STEP)
                if running:
                    out(pwm(running))
            elif k.isdigit() and k != "0":
                run(direction)
                show()
                if running:
                    time.sleep(int(k))
                stop()
            elif k == "q":
                break
            show()
    finally:
        out(STOP)
        print("\n  Belt stopped.")


if __name__ == "__main__":
    main()
