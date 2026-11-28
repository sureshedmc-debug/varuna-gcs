#!/usr/bin/env python3
"""Find the drone phone (VARUNA Cam) over Tailscale, and write it down.

Over Tailscale every device has a name. Name the drone phone "varuna-drone-cam"
in the Tailscale admin console and this finds its 100.x address by itself - no
Wi-Fi to share, no IP to type. It writes the address into phone_ip.txt (the
file start_laptop_backend.bat reads) and prints it.

    py find_phone_tailscale.py                 # writes phone_ip.txt next to this script
    py find_phone_tailscale.py C:\\path\\phone_ip.txt

Order: the phone named VARUNA_DRONE_CAM (default "varuna-drone-cam"), then any
other online phone on Tailscale that is NOT the boat phone (varuna-boat) - its
camera must never become the drone's. Prints the addresses, best first, on one
line (exit 0), or nothing (exit 1) when Tailscale is off or no phone is online.

This is the Tailscale twin of find_phone_wifi.py (same Wi-Fi) and
tailnet_link.py (the phone announcing itself).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))          # drone-pi/tailscale.py
import tailscale  # noqa: E402

CAM_NAME = os.environ.get("VARUNA_DRONE_CAM", "varuna-drone-cam").lower()
NOT_DRONE = ("varuna-boat", "boat", "varuna-laptop", "varuna-drone")  # never the drone phone
PHONE_WORDS = ("cam", "phone", "android", "mobile", "drone")


def ip_file_path():
    if len(sys.argv) > 1:
        return os.path.abspath(sys.argv[1])
    env = os.environ.get("VARUNA_PHONE_IP_FILE")
    if env:
        return os.path.abspath(env)
    return os.path.join(HERE, "phone_ip.txt")


def drone_phones(peers):
    """Addresses worth trying as the drone phone, best first."""
    named, likely = [], []
    for p in peers:
        name = p["name"].lower()
        if name == CAM_NAME:
            named.append(p["ip"])
            continue
        if not p["connected"] or any(name == n or name.startswith(n + "-") for n in NOT_DRONE) \
                or "boat" in name:
            continue
        if p["os"].lower() == "android" or any(w in name for w in PHONE_WORDS):
            likely.append(p["ip"])
    return named + [ip for ip in likely if ip not in named]


def main():
    ips = drone_phones(tailscale.peers(force=True))
    if not ips:
        print(tailscale.describe(), file=sys.stderr)
        return 1
    path = ip_file_path()
    try:
        with open(path, "w", encoding="ascii") as f:
            f.write(" ".join(ips) + "\n")
    except OSError as exc:
        print("could not write %s: %s" % (path, exc), file=sys.stderr)
    print(" ".join(ips))                       # stdout: the IPs alone, for the .bat to read
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
