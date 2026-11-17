"""
Find the boat's link on the laptop's network, and (with --run) keep the boat
program connected to it no matter what.

The link is the phone on the boat running VARUNA Boat Link (boat-phone/): the
Pixhawk's MAVLink on TCP port 5760 and the phone's camera on port 8080 (the
laptop's hotspot, 192.168.137.x, is searched first). The old ESP32 bridge
(boat-esp32/, TCP 5760, no camera) is found the same way.

    py find_boat.py [port]              print "ip:port" of the ESP32 (exit 1 if none)
    py find_boat.py --run [ip:port]     find it, run the boat program, and watch it:
                                          * the program crashes or hangs     -> restarted
                                          * no Pixhawk for 45 s              -> ESP32 found
                                            again (new address is fine) and the program restarted
                                          * the laptop is kept awake while this runs
                                          * the phone's camera (port 8080) is the boat's camera
"""

import ipaddress
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import psutil

HOTSPOT_PREFIX = "192.168.137."
BACKEND_PORT = 8001
CAMERA_PORT = 8080        # VARUNA Boat Link's MJPEG camera
STARTUP_GRACE_S = 30      # time the boat program gets to connect after a (re)start
NO_PIXHAWK_S = 45         # no Pixhawk this long -> find the ESP32 again and restart
NO_ANSWER_S = 30          # boat program not answering this long -> restart it


def local_networks():
    """The laptop's private IPv4 /24 networks, hotspot first, as (own_ip, network)."""
    nets = []
    for addrs in psutil.net_if_addrs().values():
        for a in addrs:
            if a.family != socket.AF_INET:
                continue
            ip = ipaddress.ip_address(a.address)
            if not ip.is_private or ip.is_loopback or a.address.startswith("169.254."):
                continue
            if a.address.startswith("100."):        # NetBird / CGNAT: not a hotspot
                continue
            nets.append((a.address, ipaddress.ip_network(f"{a.address}/24", strict=False)))
    nets.sort(key=lambda n: not n[0].startswith(HOTSPOT_PREFIX))
    return nets


def answers(ip, port, timeout=0.6):
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def is_boat_phone(ip):
    """True if VARUNA Boat Link answers at ip (its /status.json), not some other
    device with port 5760 open (e.g. the drone's DroneBridge ESP32)."""
    try:
        with urllib.request.urlopen(f"http://{ip}:{CAMERA_PORT}/status.json", timeout=2) as r:
            data = json.loads(r.read())
        return isinstance(data, dict) and "gps_sent" in data and "pixhawk" in data
    except Exception:
        return False


def find(port=5760, prefer=None):
    """The boat's link: `prefer` (ip) if it still answers, else a scan. A phone
    running VARUNA Boat Link wins over anything else with `port` open."""
    if prefer and answers(prefer, port, 1.5):
        return f"{prefer}:{port}"
    for own, net in local_networks():
        hosts = [str(h) for h in net.hosts() if str(h) != own]
        with ThreadPoolExecutor(max_workers=64) as pool:
            hits = [ip for ip, ok in zip(hosts, pool.map(lambda h: answers(h, port), hosts)) if ok]
        if hits:
            phones = [ip for ip in hits if is_boat_phone(ip)]
            return f"{(phones or hits)[0]}:{port}"
    return None


# ----------------------------------------------------------------- supervisor

def say(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def keep_awake():
    """Stop Windows from sleeping while this runs (ends by itself when it exits)."""
    if os.name == "nt":
        try:
            import ctypes
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        except Exception:
            pass


def backend_state():
    """(answered, fc_connected) from the running boat program."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{BACKEND_PORT}/api/telemetry", timeout=4) as r:
            return True, bool(json.loads(r.read()).get("fc_connected"))
    except Exception:
        return False, False


def port_busy():
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", BACKEND_PORT)) == 0


def stop(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def wait_for_esp(port, prefer=None):
    first = True
    while True:
        found = find(port, prefer)
        if found:
            return found
        if first:
            say("Boat not found yet - check: phone on the laptop's hotspot, VARUNA Boat Link open on it. Still looking...")
            first = False
        time.sleep(3)


def run(port=5760, fixed=None):
    here = os.path.dirname(os.path.abspath(__file__))
    keep_awake()
    if port_busy():
        say(f"Something is already using port {BACKEND_PORT} - is another boat window open? Close it first.")
        while port_busy():
            time.sleep(3)
    addr = fixed
    proc = None
    try:
        while True:
            if not fixed:
                say("Looking for the boat (phone with VARUNA Boat Link) ...")
                addr = wait_for_esp(port, prefer=addr.split(":")[0] if addr else None)
            ip = addr.rsplit(":", 1)[0]
            # No turbidity sensor (it was on the Pi's pins). The phone's camera, when
            # there is one, is the boat's camera; wildlife watching needs it.
            env = dict(os.environ, BOAT_TURBIDITY_ENABLED="0")
            if answers(ip, CAMERA_PORT, 1.5):
                env.update(BOAT_CAMERA_SOURCE="usb", BOAT_CAMERA_URL=f"http://{ip}:{CAMERA_PORT}/video",
                           BOAT_PHONE_URL=f"http://{ip}:{CAMERA_PORT}")    # phone GPS / USB status
                say(f"Boat link at {addr} (phone, camera on) - starting the boat program.")
            else:
                env.update(BOAT_CAMERA_SOURCE="off", BOAT_WILDLIFE_ENABLED="0")
                say(f"Boat link at {addr} (no camera) - starting the boat program.")
            proc = subprocess.Popen(
                [sys.executable, "boat_extras.py", "--connection", f"tcp:{addr}", "--port", str(BACKEND_PORT)],
                cwd=here, env=env)
            started = time.time()
            last_answer = last_fc = time.time()
            was_fc = False
            reason = None
            while reason is None:
                time.sleep(5)
                if proc.poll() is not None:
                    reason = f"the boat program stopped (exit code {proc.returncode})"
                    break
                answered, fc = backend_state()
                now = time.time()
                if answered:
                    last_answer = now
                if fc:
                    last_fc = now
                if fc != was_fc and answered:
                    say("Pixhawk CONNECTED - the app can control the boat." if fc
                        else "Pixhawk link lost - waiting for it to come back ...")
                    was_fc = fc
                if now - started < STARTUP_GRACE_S:
                    continue
                if now - last_answer > NO_ANSWER_S:
                    reason = "the boat program stopped answering"
                elif now - last_fc > NO_PIXHAWK_S:
                    reason = f"no Pixhawk for {NO_PIXHAWK_S} s"
            say(f"Restarting: {reason}.")
            stop(proc)
            proc = None
            time.sleep(3)
    except KeyboardInterrupt:
        pass
    finally:
        stop(proc)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--run":
        target = args[1] if len(args) > 1 else None
        p = int(target.rsplit(":", 1)[1]) if target and ":" in target else 5760
        run(p, target if target and ":" in target else None)
        sys.exit(0)
    port = int(args[0]) if args else 5760
    found = find(port)
    if found:
        print(found)
        sys.exit(0)
    sys.exit(1)
