"""Copy the boat's run logs (.tlog) from the boat phone to this laptop.

VARUNA Boat Link 2.3+ records every MAVLink frame between the phone and the ESP32
brain while the brain is plugged in, one file per connection.

    py boat-r4\\sysid\\get_logs.py --phone 192.168.1.23     (the address the app shows)
    py boat-r4\\sysid\\get_logs.py --adb                    (phone on this laptop's USB)

Logs land in boat-r4\\sysid\\logs\\ ; ones already copied are skipped (the one still
being recorded is copied again, it keeps growing).
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = "/sdcard/Android/data/ai.varuna.boatlink/files/logs"


def from_http(phone, out):
    base = f"http://{phone}:8080"
    with urllib.request.urlopen(base + "/logs", timeout=10) as r:
        logs = json.load(r)
    if not logs:
        print("No logs on the phone yet (plug the ESP32 into the phone, then drive).")
    for lg in logs:
        dst = os.path.join(out, lg["name"])
        if os.path.exists(dst) and os.path.getsize(dst) == lg["bytes"] and not lg["recording"]:
            print(f"  have {lg['name']}")
            continue
        print(f"  get  {lg['name']}  {lg['bytes'] / 1e6:.1f} MB{'  (still recording)' if lg['recording'] else ''}")
        with urllib.request.urlopen(f"{base}/logs/{lg['name']}", timeout=60) as r, open(dst + ".part", "wb") as f:
            while True:
                b = r.read(1 << 16)
                if not b:
                    break
                f.write(b)
        os.replace(dst + ".part", dst)


def from_adb(out):
    sdk = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb.exe")
    adb = sdk if os.path.exists(sdk) else "adb"
    names = subprocess.run([adb, "shell", "ls", APP_DIR], capture_output=True, text=True).stdout.split()
    names = [n for n in names if n.endswith(".tlog")]
    if not names:
        print("No logs found on the phone over adb.")
    for n in names:
        print(f"  get  {n}")
        subprocess.run([adb, "pull", f"{APP_DIR}/{n}", os.path.join(out, n)], check=True, capture_output=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phone", help="the boat phone's address (shown in VARUNA Boat Link)")
    ap.add_argument("--adb", action="store_true", help="copy over USB (adb) instead of Wi-Fi")
    ap.add_argument("--out", default=os.path.join(HERE, "logs"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.adb:
        from_adb(a.out)
    elif a.phone:
        from_http(a.phone, a.out)
    else:
        sys.exit("Give --phone <address> or --adb")
    print(f"Logs in {a.out}")


if __name__ == "__main__":
    main()
