"""
VARUNA phone relay: passes the drone's MAVLink between the ESP32 on the phone's
hotspot and the VARUNA backend reached over NetBird.

    Pixhawk TELEM2 --UART--> ESP32 (DroneBridge) --hotspot Wi-Fi, UDP--> phone:14550
    phone:14551 <--NetBird, UDP-- laptop backend (--connection udpout:<phone NetBird IP>:14551)

Why it is needed: NetBird gives only the phone itself an address on the private
network. The ESP32 sits behind the phone's hotspot, which Android does not route
to NetBird, so the laptop can't reach it directly. This script, running on the
phone (Termux), is the bridge.

Plain Python 3 standard library, nothing to install:

    python relay.py                      # finds the ESP32 on the hotspot by itself
    python relay.py --esp 192.168.43.50  # or: the ESP32 has this fixed address

DroneBridge in Wi-Fi client mode sends nothing until a ground station sends it
a packet first; it then answers to where that packet came from. So the relay
"pokes" it with a GCS heartbeat: at --esp, or, without --esp, at every address
of the phone's hotspot network (found with "ip addr") until the ESP32 answers.
The ESP32 side is then learned from the MAVLink arriving on --fc-port, the
backend side from the first packet on --gcs-port (the backend sends a heartbeat
every second, so it shows up at once). Any number of ground stations may connect
to --gcs-port (the VARUNA backend, Mission Planner, QGroundControl); each gets
everything the drone sends, and everything they send goes to the drone.
"""

import argparse
import ipaddress
import select
import socket
import struct
import subprocess
import sys
import time

PEER_TIMEOUT_S = 15     # a ground station silent this long is dropped
STATUS_S = 10           # print a status line this often
POKE_S = 2              # poke the ESP32 this often until it answers
# Interfaces that are never the hotspot: loopback, mobile data, VPNs (NetBird is wt0).
NOT_HOTSPOT = ("lo", "rmnet", "ccmni", "clat", "v4-", "tun", "wt", "dummy", "ip6", "sit", "radio", "p2p")


def hotspot_hosts(ip_output=None):
    """Every other address of the phone's own Wi-Fi/hotspot networks (/24 around
    the phone's address), from "ip -4 -o addr". Empty if that can't be read."""
    if ip_output is None:
        try:
            ip_output = subprocess.run(["ip", "-4", "-o", "addr"], capture_output=True, text=True,
                                       timeout=3).stdout
        except Exception:
            return []
    hosts = []
    for line in ip_output.splitlines():
        parts = line.split()
        if "inet" not in parts or len(parts) < 4:
            continue
        name = parts[1].rstrip(":")
        if name.startswith(NOT_HOTSPOT):
            continue
        try:
            iface = ipaddress.ip_interface(parts[parts.index("inet") + 1])
        except ValueError:
            continue
        if not iface.ip.is_private or iface.ip in ipaddress.ip_network("100.64.0.0/10"):
            continue
        net = ipaddress.ip_network(f"{iface.ip}/{max(iface.network.prefixlen, 24)}", strict=False)
        hosts += [str(h) for h in net.hosts() if h != iface.ip]
    return hosts


def mavlink1_heartbeat(seq):
    """A MAVLink 1 GCS heartbeat (system 250, component 190), used only to make
    DroneBridge register this phone as a UDP client when --esp is given."""
    payload = struct.pack("<IBBBBB", 0, 6, 8, 0, 4, 3)  # custom_mode, GCS, INVALID, 0, ACTIVE, version 3
    head = bytes([len(payload), seq & 0xFF, 250, 190, 0])
    crc = 0xFFFF
    for b in head + payload + bytes([50]):              # 50 = HEARTBEAT crc_extra
        tmp = b ^ (crc & 0xFF)
        tmp = (tmp ^ (tmp << 4)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return b"\xfe" + head + payload + struct.pack("<H", crc)


def is_mavlink(data):
    return bool(data) and data[0] in (0xFE, 0xFD)


def main():
    ap = argparse.ArgumentParser(description="VARUNA phone relay: ESP32 MAVLink <-> NetBird")
    ap.add_argument("--fc-port", type=int, default=14550, help="UDP port the ESP32 sends to (default 14550)")
    ap.add_argument("--gcs-port", type=int, default=14551, help="UDP port the backend connects to (default 14551)")
    ap.add_argument("--esp", default="", help="the ESP32's fixed address, e.g. 192.168.43.50 "
                                              "(default: search the hotspot network)")
    ap.add_argument("--esp-port", type=int, default=14550, help="the ESP32's UDP port (DroneBridge: 14550)")
    ap.add_argument("--quiet", action="store_true", help="no status lines")
    args = ap.parse_args()

    fc = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    fc.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    fc.bind(("0.0.0.0", args.fc_port))
    gcs = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    gcs.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    gcs.bind(("0.0.0.0", args.gcs_port))

    esp_addr = (args.esp, args.esp_port) if args.esp else None   # where drone-bound packets go
    esp_heard = 0.0             # last packet from the ESP32
    peers = {}                  # ground station address -> last heard
    counts = {"up": 0, "down": 0, "up_b": 0, "down_b": 0}
    last_status = last_poke = 0.0
    poke_seq = 0
    print(f"VARUNA relay: ESP32 -> UDP {args.fc_port}, ground stations -> UDP {args.gcs_port}"
          + (f", ESP32 at {args.esp}:{args.esp_port}" if args.esp else ", searching the hotspot for the ESP32"),
          flush=True)
    scan_warned = False

    while True:
        ready, _, _ = select.select([fc, gcs], [], [], 1.0)
        now = time.time()
        for sock in ready:
            try:
                data, addr = sock.recvfrom(65535)
            except OSError:
                continue                    # e.g. ICMP "port unreachable" bounced back
            if sock is fc:
                if not is_mavlink(data):
                    continue
                if esp_addr != addr:
                    print(f"  drone link from {addr[0]}:{addr[1]}", flush=True)
                esp_addr, esp_heard = addr, now
                counts["down"] += 1
                counts["down_b"] += len(data)
                for peer in list(peers):
                    try:
                        gcs.sendto(data, peer)
                    except OSError:
                        pass
            else:
                if addr not in peers:
                    print(f"  ground station {addr[0]}:{addr[1]} connected", flush=True)
                peers[addr] = now
                counts["up"] += 1
                counts["up_b"] += len(data)
                if esp_addr:
                    try:
                        fc.sendto(data, esp_addr)
                    except OSError:
                        pass

        # Nothing from the ESP32 yet (or for a while): poke it so DroneBridge
        # registers this phone as a client and starts sending.
        if now - esp_heard > 3 and now - last_poke >= POKE_S:
            last_poke = now
            poke_seq += 1
            if args.esp:
                targets = [args.esp]
            elif esp_heard:
                targets = [esp_addr[0]] + hotspot_hosts()     # it was there: try it first
            else:
                targets = hotspot_hosts()
            if not targets and not scan_warned:
                scan_warned = True
                print("  can't read the hotspot network (ip addr): start with --esp <ESP32 IP>, or add this "
                      "phone as a UDP client in DroneBridge", flush=True)
            hb = mavlink1_heartbeat(poke_seq)
            for host in dict.fromkeys(targets):
                try:
                    fc.sendto(hb, (host, args.esp_port))
                except OSError:
                    pass

        for peer, seen in list(peers.items()):
            if now - seen > PEER_TIMEOUT_S:
                del peers[peer]
                print(f"  ground station {peer[0]}:{peer[1]} gone", flush=True)

        if not args.quiet and now - last_status >= STATUS_S:
            last_status = now
            drone = (f"drone {esp_addr[0]} ({now - esp_heard:.0f}s ago)" if esp_heard
                     else "drone: nothing yet")
            print(f"[{time.strftime('%H:%M:%S')}] {drone} | ground stations {len(peers)} | "
                  f"to app {counts['down']} pkts {counts['down_b'] // 1024} KB, "
                  f"to drone {counts['up']} pkts {counts['up_b'] // 1024} KB", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
