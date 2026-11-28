#!/usr/bin/env python3
"""Find the drone phone (VARUNA Cam 2.5+) on the SAME Wi-Fi, and write it down.

On one Wi-Fi the laptop can just ask out loud: it broadcasts "VARUNA_CAM?" on
UDP 47800 and the phone answers "I'm here at 192.168.x.y". This writes that
address into phone_ip.txt (the file start_laptop_backend.bat reads), so the
backend starts pointed straight at the phone with no IP to type and no VPN.

This is the Wi-Fi twin of find_phone_tailscale.py (the phone by its Tailscale
name) and tailnet_link.py (the phone announcing itself across Tailscale); this
one actively asks on the local network when both are on one Wi-Fi.

    py find_phone_wifi.py                 # writes phone_ip.txt next to this script
    py find_phone_wifi.py C:\\path\\phone_ip.txt

It prints the phone's IP on success (and exits 0), or nothing (exit 1) if no
VARUNA Cam answered - start the camera on the phone and make sure both are on
the same Wi-Fi. The running backend keeps looking on its own either way, so a
miss here only means a slightly slower first connect.
"""
import json
import os
import socket
import sys
import time

DISCOVERY_PORT = 47800   # the port VARUNA Cam answers "VARUNA_CAM?" on


def ip_file_path():
    if len(sys.argv) > 1:
        return os.path.abspath(sys.argv[1])
    env = os.environ.get("VARUNA_PHONE_IP_FILE")
    if env:
        return os.path.abspath(env)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "phone_ip.txt")


def local_networks():
    """The /24 networks this computer is on now ("192.168.1"), main one first."""
    ips = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))     # sends nothing; just picks the main interface
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        ips += socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    nets = []
    for ip in ips:
        if ip.startswith("127.") or ":" in ip:
            continue
        net = ip.rsplit(".", 1)[0]
        if net not in nets:
            nets.append(net)
    return nets


def own_ips():
    ips = set()
    try:
        ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    return ips


def discover(timeout=0.8, sweep=False):
    """VARUNA Cams that answer, as [ip, ...]. Broadcasts to each network, and
    with sweep also asks every address once (finds the phone wherever DHCP put it)."""
    nets = local_networks()
    again = [f"{b}.255" for b in nets] + ["255.255.255.255"]
    once = []
    if sweep:
        own = own_ips()
        once = [f"{b}.{n}" for b in nets for n in range(1, 255)
                if f"{b}.{n}" not in own]
    found = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    except OSError:
        return found
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        if hasattr(socket, "SIO_UDP_CONNRESET"):
            try:
                s.ioctl(socket.SIO_UDP_CONNRESET, False)   # Windows: ignore port-unreachable
            except OSError:
                pass
        s.bind(("0.0.0.0", 0))
        s.settimeout(0.05)

        def send(targets):
            for t in targets:
                try:
                    s.sendto(b"VARUNA_CAM?", (t, DISCOVERY_PORT))
                except OSError:
                    pass

        send(again)
        send(once)
        end = time.time() + timeout
        resend = time.time() + 0.25
        while time.time() < end:
            if time.time() >= resend:
                send(again)
                resend = time.time() + 0.25
            try:
                data, (ip, _port) = s.recvfrom(1024)
            except (socket.timeout, ConnectionResetError):
                continue
            except OSError:
                break
            try:
                info = json.loads(data.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(info, dict) and info.get("varuna_cam"):
                if ip not in found:
                    found.append(ip)
                if not sweep:
                    break
    finally:
        s.close()
    return found


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
        sys.stderr.write("could not write %s: %s\n" % (path, exc))
        return False


def main():
    path = ip_file_path()
    sys.stderr.write("Looking for the drone phone (VARUNA Cam) on this Wi-Fi...\n")
    ips = discover(0.8, sweep=False)          # quick: broadcast only
    if not ips:
        ips = discover(1.2, sweep=True)       # thorough: ask every address (hotspots drop broadcasts)
    if not ips:
        sys.stderr.write("No VARUNA Cam answered. Open it on the phone and check both are on one Wi-Fi.\n")
        return 1
    ip = ips[0]
    write_ip(path, ip)
    sys.stderr.write("Drone phone at %s  ->  http://%s:8080\n" % (ip, ip))
    print(ip)                                 # stdout: the IP alone, for the .bat to read
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
