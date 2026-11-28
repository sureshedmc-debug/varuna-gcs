"""
Find the boat's link on the laptop's network, and (with --run) keep the boat
program connected to it no matter what.

The link is the phone on the boat running VARUNA Boat Link (boat-phone/): the
boat brain's MAVLink (UNO R4, or a Pixhawk) on TCP port 5760 and the phone's
camera on port 8080. It is looked for in this order:

  1. the address you gave (the command line, VARUNA_BOAT_PHONE, or the file
     boat_phone_ip.txt) - an IP or a Tailscale name
  2. Tailscale - the phone named "varuna-boat" (VARUNA_BOAT_NAME), then every
                 other device this computer can see (tailscale.py). The phone
                 and the laptop need no shared Wi-Fi at all: they can be on
                 mobile data, anywhere, as long as both are logged in to the
                 same Tailscale account. This is the normal way now.
  3. the local network - the laptop's hotspot (192.168.137.x) first, then any
                 other network it is on. Used when Tailscale is off.

The old ESP32 bridge (boat-esp32/, TCP 5760, no camera) is found the same way.

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

import tailscale

HOTSPOT_PREFIX = "192.168.137."
BACKEND_PORT = 8001
CAMERA_PORT = 8080        # VARUNA Boat Link's MJPEG camera
STARTUP_GRACE_S = 30      # time the boat program gets to connect after a (re)start
NO_PIXHAWK_S = 45         # no Pixhawk this long -> find the ESP32 again and restart
NO_ANSWER_S = 30          # boat program not answering this long -> restart it
BOAT_NAME = os.environ.get("VARUNA_BOAT_NAME", "varuna-boat")   # the phone's Tailscale machine name


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
            if a.address.startswith("100."):        # Tailscale: asked peer by peer, never swept
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


def fixed_phone():
    """The boat phone's address if you gave one (VARUNA_BOAT_PHONE, or the file
    boat_phone_ip.txt next to this script). An address here is tried first and
    works over Tailscale, Wi-Fi or a hotspot alike. A Tailscale name
    (varuna-boat) is turned into its address."""
    out = []
    raw = os.environ.get("VARUNA_BOAT_PHONE", "")
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "boat_phone_ip.txt"),
                  encoding="ascii") as f:
            raw += " " + f.read()
    except OSError:
        pass
    for ip in raw.replace(",", " ").split():
        ip = ip.split(":")[0].strip()
        if ip and not ip[0].isdigit():
            ip = tailscale.find(ip) or _resolve(ip)
        if ip and ip not in out:
            out.append(ip)
    return out


def _resolve(name):
    """A name through DNS (MagicDNS answers Tailscale names), or None."""
    try:
        return socket.gethostbyname(name)
    except OSError:
        return None


def tailscale_phones():
    """The boat phone by its Tailscale name first, then the other Tailscale devices."""
    out = []
    named = tailscale.find(BOAT_NAME)
    if named:
        out.append(named)
    for ip in tailscale.phone_ips():
        if ip not in out:
            out.append(ip)
    return out


def find(port=5760, prefer=None):
    """The boat's link: `prefer` (ip) if it still answers, then the address you
    gave, then the Tailscale devices, then a scan of the local networks. A phone
    running VARUNA Boat Link wins over anything else with `port` open."""
    if prefer and answers(prefer, port, 1.5):
        return f"{prefer}:{port}"
    # 1 + 2: a given address and the Tailscale devices - asked one by one, no sweep.
    direct = []
    for ip in fixed_phone() + tailscale_phones():
        if ip != prefer and ip not in direct:
            direct.append(ip)
    if direct:
        with ThreadPoolExecutor(max_workers=16) as pool:
            hits = [ip for ip, ok in zip(direct, pool.map(lambda h: answers(h, port, 2.0), direct)) if ok]
        if hits:
            phones = [ip for ip in hits if is_boat_phone(ip)]
            return f"{(phones or hits)[0]}:{port}"
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


def find_serial_pixhawk():
    if os.name == "nt":
        try:
            import serial.tools.list_ports
            for p in serial.tools.list_ports.comports():
                desc = (p.description or "").lower()
                if "ardupilot" in desc or "pixhawk" in desc or "px4" in desc:
                    return p.device
            for p in serial.tools.list_ports.comports():
                if p.device.upper() != "COM1":
                    return p.device
        except Exception:
            pass
    return None


def wait_for_esp(port, prefer=None):
    first = True
    for _ in range(3):
        found = find(port, prefer)
        if found:
            return found
        sp = find_serial_pixhawk()
        if sp:
            say(f"Found Pixhawk on serial port {sp}.")
            return sp
        if first:
            say("Boat not found yet - check: VARUNA Boat Link open on the boat's phone, and Tailscale "
                f"ON on the phone (named {BOAT_NAME}) and on this laptop. Still looking...")
            say("  " + tailscale.describe())
            first = False
        time.sleep(2)
    # Check serial port directly
    sp = find_serial_pixhawk()
    if sp:
        return sp
    return wait_for_esp(port, prefer)


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
                say("Looking for the boat (phone with VARUNA Boat Link over Tailscale or Wi-Fi, or a USB boat brain) ...")
                addr = wait_for_esp(port, prefer=addr.split(":")[0] if addr else None)
            is_serial = addr.upper().startswith("COM") or addr.startswith("/dev/")
            ip = addr.rsplit(":", 1)[0] if not is_serial else "127.0.0.1"
            # No turbidity sensor (it was on the Pi's pins). The phone's camera, when
            # there is one, is the boat's camera; wildlife watching needs it.
            env = dict(os.environ, BOAT_TURBIDITY_ENABLED="0")
            if not is_serial and answers(ip, CAMERA_PORT, 1.5):
                env.update(BOAT_CAMERA_SOURCE="usb", BOAT_CAMERA_URL=f"http://{ip}:{CAMERA_PORT}/video",
                           BOAT_PHONE_URL=f"http://{ip}:{CAMERA_PORT}")    # phone GPS / USB status
                say(f"Boat link at {addr} (phone, camera on) - starting the boat program.")
            elif is_serial:
                say(f"Boat link at {addr} (USB serial) - starting the boat program.")
            else:
                env.update(BOAT_CAMERA_SOURCE="off", BOAT_WILDLIFE_ENABLED="0")
                say(f"Boat link at {addr} (no camera) - starting the boat program.")
            conn_arg = addr if is_serial else f"tcp:{addr}"
            proc = subprocess.Popen(
                [sys.executable, "boat_extras.py", "--connection", conn_arg, "--port", str(BACKEND_PORT)],
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
                    say("Boat brain CONNECTED - the app can control the boat." if fc
                        else "Boat brain link lost - waiting for it to come back ...")
                    was_fc = fc
                if now - started < STARTUP_GRACE_S:
                    continue
                if now - last_answer > NO_ANSWER_S:
                    reason = "the boat program stopped answering"
                elif now - last_fc > NO_PIXHAWK_S:
                    reason = f"no boat brain for {NO_PIXHAWK_S} s"
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
