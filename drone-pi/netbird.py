"""
The phones on NetBird.

Over Wi-Fi a phone is found by shouting on the local network (a broadcast, or
asking every address on it). NetBird has no local network to shout on: each
device gets its own 100.x address and reaches the others straight through, so
the way to find a phone is to ask NetBird which peers it knows.

    peers()      -> [{"ip", "name", "connected"}]  every peer of this machine
    phone_ips()  -> ["100.x.x.x", ...]             peers worth trying, best first
    my_ip()      -> "100.x.x.x" or None            this machine's NetBird address

Nothing here fails loudly: without NetBird installed, or with it logged out,
the lists come back empty and the caller carries on with Wi-Fi as before.
"""

import json
import os
import shutil
import subprocess
import time

CACHE_S = 15.0           # netbird status is a daemon call: don't run it per attempt
TIMEOUT_S = 6.0
# Peers whose name says they are a phone are tried first.
PHONE_WORDS = ("phone", "boat", "drone", "varuna", "android", "cam", "mobile")

_cache = {"t": 0.0, "peers": [], "my_ip": None}


def _exe():
    """The netbird program, or None."""
    found = shutil.which("netbird")
    if found:
        return found
    for path in (r"C:\Program Files\Netbird\netbird.exe",
                 r"C:\Program Files\NetBird\netbird.exe",
                 "/usr/bin/netbird", "/usr/local/bin/netbird", "/opt/homebrew/bin/netbird"):
        if os.path.exists(path):
            return path
    return None


def _ip(value):
    """"100.92.14.8/32" -> "100.92.14.8" (and None for anything else)."""
    ip = str(value or "").split("/")[0].strip()
    parts = ip.split(".")
    if len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        return ip
    return None


def _read():
    exe = _exe()
    if not exe:
        return [], None
    try:
        out = subprocess.run([exe, "status", "--json"], capture_output=True, timeout=TIMEOUT_S,
                             text=True, encoding="utf-8", errors="replace")
        data = json.loads(out.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return [], None
    if not isinstance(data, dict):
        return [], None
    details = ((data.get("peers") or {}).get("details")) or []
    peers = []
    for p in details:
        if not isinstance(p, dict):
            continue
        ip = _ip(p.get("netbirdIp") or p.get("ip"))
        if not ip:
            continue
        peers.append({
            "ip": ip,
            "name": str(p.get("fqdn") or p.get("name") or "").split(".")[0],
            "connected": str(p.get("status") or "").lower() == "connected",
        })
    return peers, _ip(data.get("netbirdIp"))


def refresh(force=False):
    now = time.time()
    if force or now - _cache["t"] > CACHE_S:
        peers, mine = _read()
        _cache.update(t=now, peers=peers, my_ip=mine)
    return _cache["peers"]


def peers(force=False):
    return list(refresh(force))


def my_ip(force=False):
    refresh(force)
    return _cache["my_ip"]


def connected():
    """True if NetBird is up here (this machine has an address and a peer)."""
    refresh()
    return bool(_cache["my_ip"])


def phone_ips(force=False):
    """Peer addresses to try, likeliest phones first: connected peers whose
    name sounds like one of ours, then the other connected peers, then the
    rest. An address in VARUNA_NETBIRD_PHONES always comes first."""
    out = []
    for ip in str(os.environ.get("VARUNA_NETBIRD_PHONES", "")).replace(",", " ").split():
        clean = _ip(ip)
        if clean and clean not in out:
            out.append(clean)
    ours, others, down = [], [], []
    for p in refresh(force):
        name = p["name"].lower()
        bucket = down if not p["connected"] else (ours if any(w in name for w in PHONE_WORDS) else others)
        bucket.append(p["ip"])
    for ip in ours + others + down:
        if ip not in out:
            out.append(ip)
    return out


def describe():
    """One line for the operator about what NetBird can see."""
    refresh()
    if not _exe():
        return "NetBird is not installed on this computer."
    if not _cache["my_ip"]:
        return "NetBird is not connected here (run: netbird up)."
    live = [p for p in _cache["peers"] if p["connected"]]
    return (f"NetBird {_cache['my_ip']}: {len(live)} of {len(_cache['peers'])} peers connected"
            + (" — " + ", ".join(f"{p['name']} {p['ip']}" for p in live[:4]) if live else ""))


if __name__ == "__main__":
    print(describe())
    for p in peers(force=True):
        print(f"  {'up  ' if p['connected'] else 'down'} {p['ip']:16} {p['name']}")
