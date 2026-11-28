#!/usr/bin/env python3
"""Hear where the drone phone (VARUNA Cam 2.6+) is over Tailscale, and write it down.

Over Tailscale the laptop can't find the phone by a broadcast (a WireGuard tunnel
carries none), so the phone announces itself instead: VARUNA Cam sends a small
UDP packet to this laptop every few seconds saying "I'm here at 100.x". This
listener catches it and writes the phone's address into phone_ip.txt, the file
the VARUNA backend already reads (start_laptop_backend.bat) — so the backend
connects to the phone over Tailscale with no IP to type, and follows it if its
Tailscale address ever changes.

Run it next to the backend:

    py tailnet_link.py                 # writes phone_ip.txt next to this script
    py tailnet_link.py C:\\path\\phone_ip.txt

Set the laptop's own Tailscale address (100.x, or its name varuna-laptop) in the VARUNA Cam app on the phone,
so it knows where to send the announce. Nothing here listens on a busy port: the
backend only *sends* discovery on an ephemeral port, so UDP 47800 is free for us.
"""
import json
import os
import socket
import sys
import time

DISCOVERY_PORT = 47800   # the same port VARUNA Cam answers "VARUNA_CAM?" on


def ip_file_path():
    if len(sys.argv) > 1:
        return os.path.abspath(sys.argv[1])
    env = os.environ.get("VARUNA_PHONE_IP_FILE")
    if env:
        return os.path.abspath(env)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "phone_ip.txt")


def read_current(path):
    try:
        with open(path, "r", encoding="ascii") as f:
            return f.read().split()
    except OSError:
        return []


def write_ip(path, ip):
    """Put `ip` first in phone_ip.txt, keeping any other remembered phones after it."""
    others = [x for x in read_current(path) if x != ip]
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="ascii") as f:
            f.write(" ".join([ip] + others) + "\n")
        os.replace(tmp, path)
        return True
    except OSError as exc:
        print("  could not write %s: %s" % (path, exc))
        return False


def main():
    path = ip_file_path()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SIO_UDP_CONNRESET"):
        # Windows: a port-unreachable from a dead peer must not kill the next recv.
        try:
            sock.ioctl(socket.SIO_UDP_CONNRESET, False)
        except OSError:
            pass
    try:
        sock.bind(("0.0.0.0", DISCOVERY_PORT))
    except OSError as exc:
        print("Could not listen on UDP %d: %s" % (DISCOVERY_PORT, exc))
        print("Is another VARUNA Tailscale listener already running? Close it and retry.")
        return 1

    print("VARUNA Tailscale link: listening for the drone phone on UDP %d." % DISCOVERY_PORT)
    print("Writing the phone's address to: %s" % path)
    print("Set THIS laptop's Tailscale address (100.x) in the VARUNA Cam app on the phone.")
    print("Leave this window open next to the VARUNA backend. Ctrl+C to stop.\n")

    last_ip = None
    last_log = 0.0
    while True:
        try:
            data, (src_ip, _port) = sock.recvfrom(1024)
        except (socket.timeout, ConnectionResetError):
            continue
        except OSError as exc:
            print("socket error: %s" % exc)
            time.sleep(1.0)
            continue
        except KeyboardInterrupt:
            break
        try:
            info = json.loads(data.decode("utf-8", "replace"))
        except ValueError:
            continue
        if not (isinstance(info, dict) and info.get("varuna_cam")):
            continue
        # Trust the real sender address; fall back to the one in the message.
        ip = src_ip or str(info.get("ip") or "").strip()
        if not ip:
            continue
        now = time.time()
        if ip != last_ip:
            if write_ip(path, ip):
                state = str(info.get("state", ""))
                print("[%s] drone phone at %s  (%s)" % (time.strftime("%H:%M:%S"), ip, state))
                print("    -> the VARUNA backend will use http://%s:8080  (restart it if it was already running)" % ip)
            last_ip = ip
            last_log = now
        elif now - last_log >= 30:
            print("[%s] still hearing the phone at %s" % (time.strftime("%H:%M:%S"), ip))
            last_log = now
    print("\nStopped.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
