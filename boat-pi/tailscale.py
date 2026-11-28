"""
The devices on Tailscale (the boat phone, the drone phone, the drone Pi).

Over Wi-Fi a phone is found by shouting on the local network (a broadcast, or
asking every address on it). Tailscale has no local network to shout on: each
device has its own 100.x address and a name (MagicDNS: varuna-boat,
varuna-drone, ...) and reaches the others straight through, so the way to find
a device is to ask Tailscale which peers this machine knows.

    peers()      -> [{"ip", "name", "os", "connected"}]  every peer of this machine
    phone_ips()  -> ["100.x.x.x", ...]                   peers worth trying, best first
    my_ip()      -> "100.x.x.x" or None                  this machine's Tailscale address
    find(name)   -> "100.x.x.x" or None                  a peer by its name (varuna-boat)

Nothing here fails loudly: without Tailscale installed, or logged out, the
lists come back empty and the caller carries on with Wi-Fi as before.
"""

import json
import os
import shutil
import subprocess
import time

CACHE_S = 15.0           # `tailscale status` asks the daemon: don't run it per attempt
TIMEOUT_S = 6.0
# Peers whose name says they are one of ours are tried first.
PHONE_WORDS = ("varuna", "boat", "drone", "phone", "cam", "android", "mobile")

_cache = {"t": 0.0, "peers": [], "my_ip": None, "state": None}


def _exe():
    """The tailscale program, or None."""
    found = shutil.which("tailscale")
    if found:
        return found
    for path in (r"C:\Program Files\Tailscale\tailscale.exe",
                 r"C:\Program Files (x86)\Tailscale\tailscale.exe",
                 "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale",
                 "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        if os.path.exists(path):
            return path
    return None


def _ip(value):
    """"100.92.14.8" -> itself; IPv6, "/32" suffixes and junk -> None / trimmed."""
    ip = str(value or "").split("/")[0].strip()
    parts = ip.split(".")
    if len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        return ip
    return None


def _ipv4(ips):
    for v in ips or []:
        ip = _ip(v)
        if ip:
            return ip
    return None


def _name(node):
    """The machine name as set in the admin console (first label of the MagicDNS name)."""
    dns = str(node.get("DNSName") or "").split(".")[0]
    return dns or str(node.get("HostName") or "")


def _read():
    exe = _exe()
    if not exe:
        return [], None, None
    try:
        out = subprocess.run([exe, "status", "--json"], capture_output=True, timeout=TIMEOUT_S,
                             text=True, encoding="utf-8", errors="replace")
        data = json.loads(out.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return [], None, None
    if not isinstance(data, dict):
        return [], None, None
    peers = []
    for node in (data.get("Peer") or {}).values():
        if not isinstance(node, dict):
            continue
        ip = _ipv4(node.get("TailscaleIPs"))
        if not ip:
            continue
        peers.append({
            "ip": ip,
            "name": _name(node),
            "os": str(node.get("OS") or ""),
            "connected": bool(node.get("Online")),
        })
    me = data.get("Self") or {}
    return peers, _ipv4(me.get("TailscaleIPs")), data.get("BackendState")


def refresh(force=False):
    now = time.time()
    if force or now - _cache["t"] > CACHE_S:
        peers, mine, state = _read()
        _cache.update(t=now, peers=peers, my_ip=mine, state=state)
    return _cache["peers"]


def peers(force=False):
    return list(refresh(force))


def my_ip(force=False):
    refresh(force)
    return _cache["my_ip"]


def connected():
    """True if Tailscale is up here (this machine has an address)."""
    refresh()
    return bool(_cache["my_ip"]) and _cache["state"] in (None, "Running")


def find(name, force=False):
    """A peer's address by its machine name ("varuna-boat"), or None."""
    want = str(name or "").lower().split(".")[0]
    for p in refresh(force):
        if p["name"].lower() == want:
            return p["ip"]
    return None


def phone_ips(force=False):
    """Peer addresses to try, likeliest first: online peers whose name sounds
    like one of ours (or that are Android phones), then the other online
    peers, then the rest. An address in VARUNA_TAILSCALE_PHONES always comes
    first."""
    out = []
    for ip in str(os.environ.get("VARUNA_TAILSCALE_PHONES", "")).replace(",", " ").split():
        clean = _ip(ip)
        if clean and clean not in out:
            out.append(clean)
    ours, others, down = [], [], []
    for p in refresh(force):
        name = p["name"].lower()
        ours_ = any(w in name for w in PHONE_WORDS) or p["os"].lower() == "android"
        bucket = down if not p["connected"] else (ours if ours_ else others)
        bucket.append(p["ip"])
    for ip in ours + others + down:
        if ip not in out:
            out.append(ip)
    return out


def describe():
    """One line for the operator about what Tailscale can see."""
    refresh()
    if not _exe():
        return "Tailscale is not installed on this computer (tailscale.com/download)."
    if not _cache["my_ip"]:
        return "Tailscale is not connected here (open Tailscale and log in)."
    live = [p for p in _cache["peers"] if p["connected"]]
    return (f"Tailscale {_cache['my_ip']}: {len(live)} of {len(_cache['peers'])} devices online"
            + (" - " + ", ".join(f"{p['name']} {p['ip']}" for p in live[:4]) if live else ""))


if __name__ == "__main__":
    print(describe())
    for p in peers(force=True):
        print(f"  {'online ' if p['connected'] else 'offline'} {p['ip']:16} {p['name']:24} {p['os']}")
