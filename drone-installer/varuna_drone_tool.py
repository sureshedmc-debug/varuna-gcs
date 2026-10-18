"""
VARUNA Drone Pi Tool: a terminal app for the drone's Raspberry Pi, over SSH.

Run it on the Windows laptop. It asks for the drone Pi's address and password
once, then offers:
  1. Full setup (first time): system packages (incl. ffmpeg for the camera),
     the drone backend (bundled in this app), Python libraries, Pixhawk link,
     serial port, camera, auto-start service, optional NetBird, then checks
     the Pixhawk and the 720p / 30 fps video all work.
  2. Update the drone code: copies the latest backend and restarts it.
  3. Status: service, Pixhawk link, camera, NetBird address, recent log.
  4. Live log of the drone service.
  5. Restart the drone service.
  6. Open an SSH terminal on the Pi.
  7. Reboot the Pi.
  8. Auto-start on boot: check & fix.
  9. Camera test: grab a picture from the drone camera and open it here.
 10. Put the VARUNA web app on the Pi (optional; served at http://<pi>:8000).
 11. Find the Pixhawk: tries every USB port and TELEM2 speed, fixes common
     blockers (ModemManager, serial console), saves the link that works.
 12. Keyboard flight (the app's Control tab): its limits, and the Pixhawk
     failsafes that matter for it, with a fix for the GCS failsafe.
 13. Camera: auto-detect (USB webcam, else the Pi camera module), USB webcam
     only or camera module only; sets the camera up and shows which one runs.

Safe to run again and again: setup and update keep the drone's settings and
mission data. The password is only kept in memory and never written to disk.
"""

import getpass
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import time
from datetime import datetime
from pathlib import Path

import paramiko

VERSION = "1.2.0"
APP_DIR_NAME = "varuna-drone"
SERVICE = "varuna-drone"
HTTP_PORT = 8000
CAMERA_LABEL = {"usb": "USB webcam", "csi": "Pi camera module",
                "auto": "auto-detect (USB webcam if plugged in, else the Pi camera module)",
                "test": "test picture", "off": "off"}
PAYLOAD_FILES = [
    "main.py", "config.py", "mav_link.py", "mission.py", "camera.py", "system_info.py", "control.py",
    "requirements.txt", "README.md", "drone_config.example.json", "test_e2e.py",
]
APT_PACKAGES = "python3-venv python3-dev python3-pip libxml2-dev libxslt1-dev curl ffmpeg v4l-utils"

# Test hook only: the installer's own test harness points system paths at a
# sandbox. Real Pis leave it empty, so paths are the normal /etc, /boot, …
ROOT = '"${VARUNA_ROOT:-}"'


# ----------------------------------------------------------------------------- console
def _enable_ansi():
    if os.name == "nt":
        os.system("")  # turns on VT100 colour handling in Windows consoles
    # Box/tick characters must never crash an old console or a redirected output.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


_enable_ansi()
C = {"b": "\033[1m", "dim": "\033[2m", "r": "\033[31m", "g": "\033[32m", "y": "\033[33m",
     "c": "\033[36m", "m": "\033[35m", "x": "\033[0m"}


def say(text="", color=None, end="\n"):
    s = f"{C[color]}{text}{C['x']}" if color else text
    print(s, end=end, flush=True)
    LOG.write(re.sub(r"\033\[[0-9;]*m", "", text) + ("\n" if end == "\n" else ""))


def step_title(n, total, text):
    say("")
    say(f"[{n}/{total}] {text}", "c")


def ok(text):
    say(f"  ✔ {text}", "g")


def warn(text):
    say(f"  ! {text}", "y")


def fail(text):
    say(f"  ✖ {text}", "r")


def ask(prompt, default=None, secret=False):
    hint = f" [{default}]" if default not in (None, "") else ""
    while True:
        label = f"{C['b']}{prompt}{hint}: {C['x']}"
        try:
            value = getpass.getpass(label) if secret else input(label)
        except EOFError:
            raise KeyboardInterrupt  # input closed: stop instead of asking forever
        value = value.strip()
        if not value and default is not None:
            value = default
        LOG.write(f"{prompt}: {'(hidden)' if secret else value}\n")
        if value or default == "":
            return value


def ask_yes(prompt, default=True):
    d = "Y/n" if default else "y/N"
    while True:
        v = ask(f"{prompt} ({d})", default="").lower()
        if not v:
            return default
        if v in ("y", "yes"):
            return True
        if v in ("n", "no"):
            return False


class Log:
    def __init__(self):
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "VARUNA"
        base.mkdir(parents=True, exist_ok=True)
        self.path = base / f"drone-install-{datetime.now():%Y%m%d-%H%M%S}.log"
        self._f = open(self.path, "w", encoding="utf-8")
        self.secrets = []

    def write(self, text):
        for s in self.secrets:
            if s:
                text = text.replace(s, "********")
        self._f.write(text)
        self._f.flush()


LOG = Log()


class InstallError(Exception):
    pass


# ----------------------------------------------------------------------------- payload
def payload_dir():
    """The drone backend files: bundled in the .exe, or ../drone-pi when run as a script."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "drone-pi"
    return Path(__file__).resolve().parent.parent / "drone-pi"


def build_tarball():
    src = payload_dir()
    missing = [f for f in PAYLOAD_FILES if not (src / f).exists()]
    if missing:
        raise InstallError(f"The installer is missing files: {', '.join(missing)}")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in PAYLOAD_FILES:
            data = (src / name).read_bytes().replace(b"\r\n", b"\n")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# ----------------------------------------------------------------------------- ssh
class Pi:
    def __init__(self, host, port, user, password):
        self.host, self.port, self.user, self.password = host, port, user, password
        self.client = None
        self.sudo_needs_password = True

    def connect(self, quiet=False, _attempt=1):
        client = paramiko.SSHClient()
        known = Path(os.environ.get("APPDATA") or Path.home()) / "VARUNA" / "drone_known_hosts"
        known.parent.mkdir(parents=True, exist_ok=True)
        if known.exists():
            client.load_host_keys(str(known))
        client.set_missing_host_key_policy(_TrustOnFirstUse(known, self.host, self.port, quiet))
        try:
            client.connect(self.host, port=self.port, username=self.user, password=self.password,
                           timeout=12, banner_timeout=20, auth_timeout=20,
                           look_for_keys=False, allow_agent=False)
        except paramiko.BadHostKeyException:
            if not ask_yes("  The Pi's identity changed since last time (normal after re-flashing the SD card). Trust the new one?", False):
                raise InstallError("Stopped: the Pi's SSH identity changed and was not trusted.")
            _forget_host(known, self.host, self.port)
            return self.connect(quiet, _attempt)
        except paramiko.AuthenticationException:
            raise InstallError("Wrong username or password.")
        except paramiko.SSHException as exc:
            # A Pi that has just rebooted (or a Wi-Fi blip) can drop the very first
            # handshake ("No existing session", banner errors): try again quietly.
            if _attempt < 3:
                client.close()
                time.sleep(2 * _attempt)
                return self.connect(quiet, _attempt + 1)
            raise InstallError(f"SSH problem talking to {self.host}: {exc}")
        except (socket.timeout, TimeoutError):
            raise InstallError(f"No answer from {self.host}:{self.port}. Is the Pi on, on the same network, and is SSH enabled?")
        except (socket.gaierror, OSError) as exc:
            raise InstallError(f"Cannot reach {self.host}:{self.port} ({exc}). Check the address and that SSH is enabled on the Pi.")
        transport = client.get_transport()
        transport.set_keepalive(15)
        self.client = client

    def close(self):
        if self.client:
            self.client.close()
            self.client = None

    def run(self, script, sudo=False, timeout=600, stream=False, stdin_data=None, check=True, env=None):
        """Run a bash script on the Pi. Returns (exit_code, output)."""
        if self.client is None:
            self.connect(quiet=True)
        prefix = ""
        if env:
            prefix = " ".join(f"{k}={shlex.quote(str(v))}" for k, v in env.items()) + " "
        cmd = f"{prefix}bash -c {shlex.quote(script)}"
        if sudo:
            # -k: always ask, so the password we send is always consumed by
            # sudo and can never leak into the command's own input.
            cmd = f"sudo -k -S -p '' {prefix}bash -c {shlex.quote(script)}" if self.sudo_needs_password \
                else f"sudo -n {prefix}bash -c {shlex.quote(script)}"
        try:
            chan = self.client.get_transport().open_session()
        except (paramiko.SSHException, OSError, AttributeError):
            # Stale connection (Pi rebooted, Wi-Fi blip): reconnect once.
            self.close()
            self.connect(quiet=True)
            try:
                chan = self.client.get_transport().open_session()
            except (paramiko.SSHException, OSError) as exc:
                raise InstallError(f"The Pi refused a new SSH session ({exc}).")
        chan.settimeout(5.0)
        chan.set_combine_stderr(True)
        chan.exec_command(cmd)
        if sudo and self.sudo_needs_password:
            chan.sendall((self.password + "\n").encode())
        if stdin_data is not None:
            view = memoryview(stdin_data)
            for i in range(0, len(view), 32768):
                chan.sendall(view[i:i + 32768])
        chan.shutdown_write()
        out = []
        pending = b""
        deadline = time.time() + timeout
        last_beat = time.time()
        while True:
            if chan.recv_ready():
                data = chan.recv(65536)
                if data:
                    pending += data
                    *lines, pending = pending.split(b"\n")
                    for raw in lines:
                        line = raw.decode("utf-8", "replace").rstrip("\r")
                        out.append(line)
                        LOG.write("    | " + line + "\n")
                        if stream:
                            print(f"{C['dim']}    {line[:150]}{C['x']}", flush=True)
                    last_beat = time.time()
                    continue
            if chan.exit_status_ready() and not chan.recv_ready():
                break
            if time.time() > deadline:
                chan.close()
                raise InstallError(f"Timed out after {timeout // 60} min.")
            if not stream and time.time() - last_beat > 20:
                print(f"{C['dim']}    … still working{C['x']}", flush=True)
                last_beat = time.time()
            time.sleep(0.05)
        if pending:
            line = pending.decode("utf-8", "replace").rstrip("\r")
            out.append(line)
            LOG.write("    | " + line + "\n")
            if stream:
                print(f"{C['dim']}    {line[:150]}{C['x']}", flush=True)
        code = chan.recv_exit_status()
        chan.close()
        text = "\n".join(out)
        if check and code != 0:
            tail = "\n".join(out[-12:])
            raise InstallError(f"Command failed on the Pi (exit {code}).\n{tail}")
        return code, text


class _TrustOnFirstUse(paramiko.MissingHostKeyPolicy):
    def __init__(self, path, host, port, quiet):
        self.path, self.host, self.port, self.quiet = path, host, port, quiet

    def missing_host_key(self, client, hostname, key):
        fp = "SHA256:" + __import__("base64").b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
        if not self.quiet:
            say(f"  First connection to this Pi. Its SSH fingerprint is {fp}", "dim")
        name = hostname if self.port == 22 else f"[{self.host}]:{self.port}"
        client.get_host_keys().add(name, key.get_name(), key)
        client.save_host_keys(str(self.path))


def _forget_host(path, host, port):
    name = host if port == 22 else f"[{host}]:{port}"
    try:
        keys = paramiko.HostKeys(str(path))
        if name in keys:
            del keys[name]
        keys.save(str(path))
    except (OSError, KeyError):
        pass


# ----------------------------------------------------------------------------- steps
def step_preflight(pi, ctx):
    _, out = pi.run(r"""
set +e
echo "ARCH=$(uname -m)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "OS=$PRETTY_NAME"; else echo "OS=unknown"; fi
if [ -r /proc/device-tree/model ]; then echo "MODEL=$(tr -d '\0' < /proc/device-tree/model)"; else echo "MODEL=unknown"; fi
echo "HOME=$HOME"
echo "USER=$(whoami)"
if command -v python3 >/dev/null 2>&1; then echo "PY=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"; else echo "PY=none"; fi
echo "FREE_MB=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')"
NET=down
for u in https://pypi.org/simple/pip/ https://www.piwheels.org/simple/pip/ http://deb.debian.org/debian/; do
  if curl -fsS -m 15 "$u" >/dev/null 2>&1; then NET=ok; break; fi
done
echo "NET=$NET"
if sudo -n true 2>/dev/null; then echo SUDO=nopass; else echo SUDO=pass; fi
""", check=False)
    info = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    ctx.update(arch=info.get("ARCH", "?"), os=info.get("OS", "?"), model=info.get("MODEL", "unknown"),
               home=info.get("HOME", f"/home/{pi.user}"), user=info.get("USER", pi.user))
    say(f"  Board: {ctx['model']}   OS: {ctx['os']}   CPU: {ctx['arch']}")
    py = info.get("PY", "none")
    if py == "none":
        raise InstallError("Python 3 is not installed on the Pi. Use Raspberry Pi OS (Lite 64-bit recommended).")
    major, minor = (int(x) for x in py.split("."))
    if (major, minor) < (3, 9):
        raise InstallError(f"The Pi has Python {py}; 3.9 or newer is needed. Flash a current Raspberry Pi OS.")
    ok(f"Python {py}")
    free = int(info.get("FREE_MB", "0") or 0)
    if free and free < 600:
        raise InstallError(f"Only {free} MB free on the SD card; at least 600 MB is needed.")
    ok(f"{free} MB free on the SD card")
    if info.get("NET") != "ok":
        warn("The Pi doesn't seem to reach the internet (needed to download the libraries).")
        if not ask_yes("  Continue anyway?", False):
            raise InstallError("The Pi has no internet access. Connect it to Wi-Fi/Ethernet with internet and try again.")
    else:
        ok("Internet access")
    pi.sudo_needs_password = info.get("SUDO") != "nopass"
    if pi.sudo_needs_password:
        code, _ = pi.run("true", sudo=True, check=False, timeout=30)
        if code != 0:
            raise InstallError(f"The user '{pi.user}' cannot use sudo with this password. Use an admin account (the one created when flashing the SD card).")
    ok("Administrator (sudo) access")
    if ctx["arch"] not in ("aarch64", "armv7l", "armv6l"):
        warn(f"This doesn't look like a Raspberry Pi ({ctx['arch']}); continuing anyway.")


def step_apt(pi, ctx):
    say("  Updating the package list and installing system packages (can take a few minutes)…")
    pi.run(f"""
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update -y
apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends {APT_PACKAGES}
""", sudo=True, timeout=1800, stream=True)
    ok("System packages installed")


def step_copy(pi, ctx):
    app = f"{ctx['home']}/{APP_DIR_NAME}"
    ctx["app"] = app
    pi.run(f"systemctl stop {SERVICE} 2>/dev/null || true", sudo=True, check=False, timeout=60)
    blob = build_tarball()
    pi.run(f'set -e; mkdir -p {shlex.quote(app)}; tar -xzf - -C {shlex.quote(app)}', stdin_data=blob, timeout=300)
    _, out = pi.run(f"ls {shlex.quote(app)}", check=False)
    if "main.py" not in out:
        raise InstallError("The backend files did not arrive on the Pi.")
    ok(f"Drone backend copied to {app}")


def step_venv(pi, ctx):
    app = shlex.quote(ctx["app"])
    say("  Installing the Python libraries (FastAPI, uvicorn, pymavlink, psutil).")
    say("  On a Pi 3 this can take 5–20 minutes — please keep the Pi powered.", "dim")
    pi.run(f"""
set -e
cd {app}
if [ ! -x venv/bin/python ]; then python3 -m venv venv; fi
venv/bin/python -m pip install --upgrade pip wheel --disable-pip-version-check
venv/bin/python -m pip install -r requirements.txt --disable-pip-version-check
""", timeout=3600, stream=True)
    _, out = pi.run(f'cd {app} && venv/bin/python -c "import fastapi, uvicorn, pymavlink, psutil; print(\'IMPORT_OK\')"', check=False)
    if "IMPORT_OK" not in out:
        raise InstallError("The libraries installed, but the backend cannot import them:\n" + out[-600:])
    ok("Python libraries installed and working")


def _patch_config(pi, ctx, patch):
    """Merge patch into the drone's drone_config.json (kept: everything else)."""
    app = shlex.quote(ctx["app"])
    pi.run(f"""
set -e
cd {app}
venv/bin/python - <<'PYEOF'
import json, pathlib
p = pathlib.Path("drone_config.json")
cfg = {{}}
if p.exists():
    try:
        cfg = json.loads(p.read_text())
    except ValueError:
        cfg = {{}}
cfg.update({json.dumps(patch)})
p.write_text(json.dumps(cfg, indent=2))
print("CONFIG_OK")
PYEOF
""")


def step_config(pi, ctx):
    link, cam = ctx["link"], ctx["camera"]
    _patch_config(pi, ctx, {"mav_connection": "", "link_prefer": link["prefer"], "telem2_baud": 57600,
                            "usb_baud": 115200, "camera_source": cam, "camera_width": 1280,
                            "camera_height": 720, "camera_fps": 30, "http_port": HTTP_PORT})
    ok(f"Pixhawk link: {link['label']}   ·   camera: {CAMERA_LABEL[cam]} at 1280x720, 30 fps (drone_config.json)")


def step_uart(pi, ctx):
    # ModemManager (installed on many Pi images) grabs every new ttyACM port to
    # probe it for a modem — exactly where a USB Pixhawk appears.
    _, mm = pi.run("if systemctl is-active --quiet ModemManager 2>/dev/null; then "
                   "systemctl disable --now ModemManager >/dev/null 2>&1 && echo MM_OFF; fi; true",
                   sudo=True, check=False, timeout=60)
    if "MM_OFF" in mm:
        ok("Switched off ModemManager (it blocks USB flight controllers)")
    if ctx["link"]["prefer"] == "usb":
        pi.run(f"usermod -aG dialout {shlex.quote(ctx['user'])}", sudo=True, check=False)
        ok("USB link: serial port access granted (no UART changes needed)")
        return
    has_bt = any(m in ctx["model"] for m in ("Pi 3", "Pi 4", "Zero 2", "Zero W"))
    _, out = pi.run(f"""
set +e
R={ROOT}
CFG="$R/boot/firmware/config.txt"; [ -f "$CFG" ] || CFG="$R/boot/config.txt"
CMD="$R/boot/firmware/cmdline.txt"; [ -f "$CMD" ] || CMD="$R/boot/cmdline.txt"
before=$(cat "$CFG" "$CMD" 2>/dev/null | md5sum)
if command -v raspi-config >/dev/null 2>&1; then
  raspi-config nonint do_serial_hw 0 >/dev/null 2>&1 || raspi-config nonint do_serial 2 >/dev/null 2>&1
  raspi-config nonint do_serial_cons 1 >/dev/null 2>&1
fi
if [ -f "$CFG" ]; then
  grep -q '^enable_uart=1' "$CFG" || echo 'enable_uart=1' >> "$CFG"
  if [ "{1 if has_bt else 0}" = "1" ]; then
    grep -q '^dtoverlay=disable-bt' "$CFG" || echo 'dtoverlay=disable-bt' >> "$CFG"
    systemctl disable hciuart >/dev/null 2>&1
  fi
else
  echo "NO_BOOT_CONFIG"
fi
if [ -f "$CMD" ]; then sed -i -E 's/console=(serial0|ttyAMA0|ttyS0),[0-9]+ ?//g' "$CMD"; fi
usermod -aG dialout {shlex.quote(ctx['user'])}
after=$(cat "$CFG" "$CMD" 2>/dev/null | md5sum)
[ "$before" = "$after" ] && echo UART_UNCHANGED || echo UART_CHANGED
""", sudo=True)
    if "NO_BOOT_CONFIG" in out:
        warn("Could not find the Pi's boot config — enable the serial port by hand (raspi-config → Interface Options → Serial Port).")
    if "UART_CHANGED" in out:
        ctx["reboot"] = True
        ok("Serial port enabled for the Pixhawk (serial console off" + (", Bluetooth moved off the UART" if has_bt else "") + ") — needs a reboot")
    else:
        ok("Serial port already set up for the Pixhawk")


def step_camera(pi, ctx):
    """Let the service use the camera, set up the camera module and/or check the
    USB webcam (auto: both, so whichever is connected works)."""
    user = shlex.quote(ctx["user"])
    pi.run(f"usermod -aG video {user}", sudo=True, check=False)
    cam = ctx["camera"]
    auto = cam == "auto"
    csi = _setup_csi(pi, ctx, quiet=auto) if cam in ("csi", "auto") else False
    usb = _check_usb(pi, quiet=auto) if cam in ("usb", "auto") else False
    if not auto:
        return
    if usb and csi:
        ok("Both cameras found: the drone uses the USB webcam, and the camera module if the webcam fails or is unplugged")
    elif usb:
        ok("Auto-detect: the drone uses the USB webcam (a Pi camera module would be picked up too)")
    elif csi:
        ok("Auto-detect: the drone uses the Pi camera module (a USB webcam plugged in later takes over)")
    elif ctx.get("reboot"):
        warn("No camera found yet. A Pi camera module only shows up after the reboot; a USB webcam can be plugged in any time.")
    else:
        warn("No camera found. Plug in a USB webcam or connect the Pi camera module (ribbon cable) — "
             "the drone picks up whichever is there by itself.")


def _setup_csi(pi, ctx, quiet=False):
    """Install rpicam-vid and enable the camera module in the boot settings.
    True if a camera module is detected. quiet: don't warn when there is none."""
    _, out = pi.run(f"""
set +e
export DEBIAN_FRONTEND=noninteractive
command -v rpicam-vid >/dev/null 2>&1 || command -v libcamera-vid >/dev/null 2>&1 || \\
  apt-get -o DPkg::Lock::Timeout=600 install -y rpicam-apps-lite >/dev/null 2>&1 || \\
  apt-get -o DPkg::Lock::Timeout=600 install -y libcamera-apps-lite >/dev/null 2>&1
R={ROOT}
CFG="$R/boot/firmware/config.txt"; [ -f "$CFG" ] || CFG="$R/boot/config.txt"
before=$(md5sum < "$CFG" 2>/dev/null)
if [ -f "$CFG" ]; then
  if grep -q '^camera_auto_detect=0' "$CFG"; then sed -i 's/^camera_auto_detect=0/camera_auto_detect=1/' "$CFG"; fi
  grep -q '^camera_auto_detect=1' "$CFG" || echo 'camera_auto_detect=1' >> "$CFG"
fi
after=$(md5sum < "$CFG" 2>/dev/null)
[ "$before" = "$after" ] || echo CAM_CHANGED
HELLO=$(command -v rpicam-hello || command -v libcamera-hello)
[ -n "$HELLO" ] && timeout 20 "$HELLO" --list-cameras 2>&1 | head -12
""", sudo=True, timeout=900)
    if "CAM_CHANGED" in out:
        ctx["reboot"] = True
        ok("Camera module enabled in the Pi's boot settings — needs a reboot")
    if "Available cameras" in out and "No cameras available" not in out:
        ok("Camera module found")
        return True
    if not quiet:
        warn("No camera module detected yet. Check the ribbon cable (blue side to the Ethernet port on a Pi 3), then reboot.")
    return False


def _check_usb(pi, quiet=False):
    """Find the USB webcam and check it can do MJPEG 1280x720 at 30 fps. True if
    one is plugged in. quiet: don't warn when there is none."""
    _, out = pi.run(r"""
set +e
DEV=""
for p in /dev/v4l/by-id/*-video-index0; do [ -e "$p" ] && DEV=$(readlink -f "$p") && break; done
if [ -z "$DEV" ]; then
  for v in /dev/video0 /dev/video1 /dev/video2 /dev/video3; do
    [ -e "$v" ] || continue
    case "$(readlink -f /sys/class/video4linux/${v##*/}/device 2>/dev/null)" in *usb*) DEV=$v; break;; esac
  done
fi
echo "DEV=$DEV"
if [ -n "$DEV" ]; then
  v4l2-ctl -d "$DEV" --info 2>/dev/null | grep -m1 'Card type'
  v4l2-ctl -d "$DEV" --list-formats-ext 2>/dev/null
fi
""", check=False, timeout=60)
    dev = next((line.split("=", 1)[1] for line in out.splitlines() if line.startswith("DEV=")), "")
    if not dev:
        if not quiet:
            warn("No USB camera found. Plug the webcam into the Pi — the drone service picks it up by itself, no restart needed.")
        return False
    name = next((line.split(":", 1)[1].strip() for line in out.splitlines() if "Card type" in line), dev)
    ok(f"USB camera found: {name} ({dev})")
    mjpg_720_30 = False
    fmt = None
    size = None
    for line in out.splitlines():
        m = re.search(r"'(\w+)'", line)
        if "]: '" in line and m:
            fmt = m.group(1)
        sm = re.search(r"Size: Discrete (\d+)x(\d+)", line)
        if sm:
            size = (int(sm.group(1)), int(sm.group(2)))
        fm = re.search(r"\(([\d.]+) fps\)", line)
        if fm and fmt == "MJPG" and size == (1280, 720) and float(fm.group(1)) >= 29.9:
            mjpg_720_30 = True
    if mjpg_720_30:
        ok("The camera does 1280x720 at 30 fps in MJPEG — the Pi just passes the frames through (light on a Pi 3)")
    else:
        warn("This camera doesn't offer MJPEG at 1280x720 / 30 fps. The drone will fall back to encoding on the Pi "
             "(heavier, maybe fewer fps) or to 640x480. A webcam with MJPEG 720p30 is recommended.")
    return True


def step_service(pi, ctx):
    # Starts at boot without waiting for Wi-Fi (at the lake there may be none;
    # the backend serves on every interface as soon as one comes up), and
    # never gives up restarting after crashes.
    unit = f"""[Unit]
Description=VARUNA drone backend (FastAPI + pymavlink)
After=network.target
StartLimitIntervalSec=0

[Service]
User={ctx['user']}
WorkingDirectory={ctx['app']}
ExecStart={ctx['app']}/venv/bin/python main.py
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
"""
    pi.run(f"""
set -e
R={ROOT}
mkdir -p "$R/etc/systemd/system"
cat > "$R/etc/systemd/system/{SERVICE}.service" <<'UNITEOF'
{unit}UNITEOF
systemctl daemon-reload
systemctl enable {SERVICE} >/dev/null 2>&1
systemctl restart {SERVICE}
""", sudo=True, timeout=120)
    _, state = pi.run(f"systemctl is-enabled {SERVICE} 2>/dev/null || true", check=False)
    if "enabled" not in state.split():
        raise InstallError(f"The drone service was installed but could not be enabled for boot (systemctl says: {state.strip() or 'nothing'}).")
    ok("Drone service installed and enabled — it starts automatically every time the Pi boots")


def step_netbird(pi, ctx):
    key = ctx.get("netbird_key")
    if not key:
        _, out = pi.run("command -v netbird >/dev/null 2>&1 && netbird status 2>/dev/null | grep -i 'NetBird IP' || true", check=False)
        ip = _netbird_ip(out)
        if ip:
            ctx["netbird_ip"] = ip
            ok(f"NetBird already connected: {ip}")
        else:
            warn("NetBird skipped (no setup key). The app can still reach the drone on the same Wi-Fi.")
        return
    LOG.secrets.append(key)
    pi.run("""
set -e
if ! command -v netbird >/dev/null 2>&1; then
  curl -fsSL https://pkgs.netbird.io/install.sh | sh
fi
systemctl enable netbird >/dev/null 2>&1 || true
systemctl start netbird >/dev/null 2>&1 || true
""", sudo=True, timeout=900, stream=True)
    pi.run(f"netbird up --setup-key {shlex.quote(key)}", sudo=True, timeout=180, stream=False)
    ip = None
    for _ in range(15):
        _, out = pi.run("netbird status 2>/dev/null | grep -i 'NetBird IP' || true", sudo=True, check=False)
        ip = _netbird_ip(out)
        if ip:
            break
        time.sleep(2)
    if ip:
        ctx["netbird_ip"] = ip
        ok(f"Joined NetBird: {ip}")
    else:
        warn("NetBird installed, but no NetBird IP yet — check `netbird status` on the Pi.")


def _netbird_ip(text):
    m = re.search(r"NetBird IP:\s*(\d+\.\d+\.\d+\.\d+)", text or "", re.I)
    return m.group(1) if m else None


def step_verify(pi, ctx, label="Checking the drone backend"):
    say(f"  {label}…")
    ping = health = None
    for _ in range(30):
        _, out = pi.run(f"curl -s -m 3 http://127.0.0.1:{HTTP_PORT}/api/ping || true", check=False)
        if '"vehicle":"drone"' in out.replace(" ", ""):
            ping = out
            break
        time.sleep(2)
    if not ping:
        _, logs = pi.run(f"journalctl -u {SERVICE} -n 25 --no-pager 2>/dev/null || true", sudo=True, check=False)
        raise InstallError("The drone service did not start.\n" + logs[-1500:])
    ok(f"Drone backend is running on port {HTTP_PORT}")
    # The backend tries each USB port and TELEM2 speed for a few seconds in turn,
    # so finding the Pixhawk can take up to about a minute.
    say("  Looking for the Pixhawk (up to a minute)…", "dim")
    for _ in range(35):
        _, out = pi.run(f"curl -s -m 3 http://127.0.0.1:{HTTP_PORT}/api/health || true", check=False)
        try:
            health = json.loads(out)
        except ValueError:
            health = None
        if health and health.get("pixhawk_connected"):
            break
        time.sleep(2)
    if health and health.get("pixhawk_connected"):
        ok(f"Pixhawk connected via {(health.get('link') or '?').upper()} ✔")
        ctx["pixhawk"] = True
    else:
        why = (health or {}).get("link_error") or "no heartbeat yet"
        if ctx.get("reboot"):
            warn(f"Pixhawk not connected yet ({why}) — expected before the reboot.")
        else:
            warn(f"Pixhawk not connected ({why}). Check the cable, the Pixhawk power and, for TELEM2, SERIAL2_PROTOCOL=2 / SERIAL2_BAUD=57.")
    cam = None
    for _ in range(12):
        _, out = pi.run(f"curl -s -m 3 http://127.0.0.1:{HTTP_PORT}/api/camera/status || true", check=False)
        try:
            cam = json.loads(out)
        except ValueError:
            cam = None
        if cam and cam.get("camera_connected") and cam.get("measured_fps", 0) > 0 and cam.get("frames_captured", 0) > 60:
            break
        time.sleep(2)
    if cam and cam.get("camera_connected"):
        fps, res = cam.get("measured_fps", 0), cam.get("resolution")
        (ok if res == "1280x720" and fps >= 24 else warn)(
            f"Camera streaming: {CAMERA_LABEL.get(cam.get('source'), cam.get('source'))}, {res} at {fps} fps "
            f"via {cam.get('pipeline')}")
        ctx["camera_ok"] = True
    else:
        why = (cam or {}).get("last_error") or (cam or {}).get("status_text") or "no frames yet"
        if ctx.get("reboot"):
            warn(f"Camera not streaming yet ({why}) — expected before the reboot.")
        else:
            warn(f"Camera not streaming: {why}")
    _, out = pi.run("hostname -I 2>/dev/null || true", check=False)
    ips = [ip for ip in out.split() if re.match(r"^\d+\.\d+\.\d+\.\d+$", ip)]
    ctx["lan_ip"] = next((ip for ip in ips if not ip.startswith("100.")), ips[0] if ips else pi.host)


# ----------------------------------------------------------------------------- app
def banner():
    if os.name == "nt":
        os.system("title VARUNA Drone Pi Tool")
    say("")
    say("═" * 64, "m")
    say(f"  VARUNA Drone Pi Tool {VERSION}", "b")
    say("  Set up, update and manage the drone's Raspberry Pi over SSH.", "dim")
    say("═" * 64, "m")
    say("")


def parse_host(raw):
    host, port = raw.strip(), 22
    m = re.match(r"^(.*):(\d+)$", host)
    if m and host.count(":") == 1:
        host, port = m.group(1), int(m.group(2))
    return host, port


def open_session():
    """Ask for the Pi's address and login, connect, and probe it. Loops until it works."""
    say("The Pi must be powered, on the same network as this laptop (or NetBird), with SSH enabled.", "dim")
    while True:
        host, port = parse_host(ask("Drone Pi IP address or hostname (e.g. 192.168.1.50 or raspberrypi.local)"))
        if re.fullmatch(r"[\d.]+", host) and host.count(".") != 3:
            fail(f"'{host}' isn't a complete IP address — it needs four numbers, like 192.168.1.18.")
            continue
        user = ask("Pi username", "pi")
        if user != user.lower():
            say(f"  Raspberry Pi usernames are lower-case — using '{user.lower()}'.", "dim")
            user = user.lower()
        password = ask(f"Password for {user}", secret=True)
        LOG.secrets.append(password)
        pi = Pi(host, port, user, password)
        say(f"  Connecting to {user}@{host}:{port}…")
        try:
            pi.connect()
            ctx = {}
            probe(pi, ctx)
            ok(f"Connected to {ctx['model'] if ctx['model'] != 'unknown' else host}")
            return pi, ctx
        except (InstallError, paramiko.SSHException, OSError, EOFError) as exc:
            fail(str(exc).splitlines()[0] if str(exc) else type(exc).__name__)
            pi.close()
            if not ask_yes("Try again?", True):
                raise KeyboardInterrupt


def probe(pi, ctx):
    """Who/where we are on the Pi, whether sudo needs the password, and whether the drone is installed."""
    _, out = pi.run(r"""
set +e
echo "HOME=$HOME"
echo "USER=$(whoami)"
if [ -r /proc/device-tree/model ]; then echo "MODEL=$(tr -d '\0' < /proc/device-tree/model)"; else echo "MODEL=unknown"; fi
if sudo -n true 2>/dev/null; then echo SUDO=nopass; else echo SUDO=pass; fi
[ -x "$HOME/APPDIR/venv/bin/python" ] && echo INSTALLED=yes || echo INSTALLED=no
""".replace("APPDIR", APP_DIR_NAME), check=False, timeout=60)
    info = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    ctx.update(home=info.get("HOME", f"/home/{pi.user}"), user=info.get("USER", pi.user),
               model=info.get("MODEL", "unknown"), installed=info.get("INSTALLED") == "yes")
    ctx["app"] = f"{ctx['home']}/{APP_DIR_NAME}"
    pi.sudo_needs_password = info.get("SUDO") != "nopass"


def run_steps(pi, steps):
    """Run titled steps; on a failure offer to retry the step. Raises InstallError to stop."""
    for i, (title, fn) in enumerate(steps, 1):
        step_title(i, len(steps), title)
        while True:
            try:
                fn()
                break
            except InstallError as exc:
                lines = str(exc).splitlines()
                fail(lines[0])
                for line in lines[1:]:
                    say(f"    {line}", "dim")
                if not ask_yes("  Retry this step?", True):
                    raise
                pi.close()
            except (paramiko.SSHException, EOFError, OSError) as exc:
                fail(f"Lost the connection to the Pi ({exc}).")
                pi.close()
                if not ask_yes("  Reconnect and retry this step?", True):
                    raise InstallError("Stopped after losing the connection.")


def print_address(ctx):
    address = ctx.get("netbird_ip") or ctx.get("lan_ip")
    if not address:
        return
    say("")
    say("In the VARUNA app:  System → Connection → enter", "b")
    say(f"      http://{address}:{HTTP_PORT}", "c")
    if ctx.get("netbird_ip") and ctx.get("lan_ip"):
        say(f"  (on the same Wi-Fi you can also use http://{ctx['lan_ip']}:{HTTP_PORT})", "dim")
    say("then press  Test connection  →  Save & reconnect.")


def ask_camera(current="auto"):
    say("Which camera is on the drone?")
    say("  1) Find it automatically: USB webcam if plugged in, else the Pi camera module   [recommended]")
    say("  2) USB webcam only   (best: one with MJPEG 1280x720 at 30 fps)")
    say("  3) Raspberry Pi camera module only (ribbon cable)")
    default = {"usb": "2", "csi": "3"}.get(current, "1")
    return {"2": "usb", "3": "csi"}.get(ask("Choose 1, 2 or 3", default).strip(), "auto")


def action_setup(pi, ctx):
    say("")
    say("How is the Pixhawk connected to the Pi?")
    say("  1) TELEM2 → Pi GPIO serial pins (TX/RX/GND)")
    say("  2) USB cable")
    say("  3) Not sure / find it automatically   [recommended]")
    choice = ask("Choose 1, 2 or 3", "3")
    ctx["link"] = {"2": {"prefer": "usb", "label": "USB (/dev/ttyACM0, 115200)"},
                   "3": {"prefer": "auto", "label": "auto: USB if plugged in, else TELEM2"}}.get(
        choice, {"prefer": "telem2", "label": "TELEM2 → GPIO serial (/dev/serial0, 57600)"})
    say("")
    ctx["camera"] = ask_camera("auto")
    say("")
    say("NetBird lets the VARUNA app reach the drone from anywhere (optional).", "dim")
    say("Paste a setup key from app.netbird.io → Setup Keys, or press Enter to skip.", "dim")
    ctx["netbird_key"] = ask("NetBird setup key", "", secret=True)
    say("")
    say(f"  Pixhawk:  {ctx['link']['label']}")
    say(f"  Camera:   {CAMERA_LABEL[ctx['camera']]} — 1280x720 at 30 fps")
    say(f"  NetBird:  {'join with the setup key' if ctx['netbird_key'] else 'skip'}")
    say("  Takes 10–30 minutes on a Pi 3 (mostly downloading libraries).", "dim")
    if not ask_yes("Start the full setup?", True):
        return
    started = time.time()
    run_steps(pi, [
        ("Checking the Pi", lambda: step_preflight(pi, ctx)),
        ("Installing system packages (incl. ffmpeg for the camera)", lambda: step_apt(pi, ctx)),
        ("Copying the drone backend", lambda: step_copy(pi, ctx)),
        ("Installing Python libraries", lambda: step_venv(pi, ctx)),
        ("Writing the Pixhawk and camera settings", lambda: step_config(pi, ctx)),
        ("Setting up the serial port for the Pixhawk", lambda: step_uart(pi, ctx)),
        ("Setting up the camera", lambda: step_camera(pi, ctx)),
        ("Installing the drone service", lambda: step_service(pi, ctx)),
        ("NetBird", lambda: step_netbird(pi, ctx)),
        ("Checking everything works", lambda: step_verify(pi, ctx)),
        ("Finishing", lambda: step_reboot(pi, ctx)),
    ])
    ctx["installed"] = True
    mins = int((time.time() - started) // 60)
    say("")
    say("═" * 64, "g")
    say(f"  ✔ The drone Pi is ready  ({mins} min)", "g")
    say("═" * 64, "g")
    print_address(ctx)
    if not ctx.get("pixhawk"):
        say("")
        say("Pixhawk not detected yet — use menu 11) Find the Pixhawk: it tries every port and speed,", "y")
        say("fixes what it can and tells you exactly what to check if nothing answers.", "y")
    if not ctx.get("camera_ok"):
        say("")
        say("Camera not streaming yet: plug it in (or check the ribbon cable) — use menu 9) to test it.", "y")


def action_update(pi, ctx):
    if not ctx.get("installed"):
        warn("The drone backend isn't installed on this Pi yet — run 1) Full setup first.")
        return

    def libs():
        app = shlex.quote(ctx["app"])
        pi.run(f"cd {app} && venv/bin/python -m pip install -r requirements.txt --disable-pip-version-check -q",
               timeout=3600, stream=True)
        ok("Libraries up to date")

    def restart():
        pi.run(f"systemctl restart {SERVICE}", sudo=True, timeout=120)
        ok("Drone service restarted")

    run_steps(pi, [
        ("Copying the latest drone backend", lambda: step_copy(pi, ctx)),
        ("Checking the Python libraries", libs),
        ("Restarting the drone service", restart),
        ("Checking it works", lambda: step_verify(pi, ctx)),
    ])
    say("")
    ok("Drone code updated.")


def action_status(pi, ctx):
    _, active = pi.run(f"systemctl is-active {SERVICE} 2>/dev/null || true", check=False)
    state = (active.strip().splitlines() or ["unknown"])[-1]
    (ok if state == "active" else warn)(f"Drone service: {state}")
    _, enabled = pi.run(f"systemctl is-enabled {SERVICE} 2>/dev/null || true", check=False)
    if "enabled" in enabled.split():
        ok("Starts automatically when the Pi boots")
    else:
        warn("NOT set to start on boot — use menu 8) Auto-start on boot to fix it")
    _, out = pi.run(f"curl -s -m 4 http://127.0.0.1:{HTTP_PORT}/api/health || true", check=False)
    try:
        h = json.loads(out)
        ok(f"Backend answering on port {HTTP_PORT} (version {h.get('version', '?')}, up {int(h.get('uptime_s', 0)) // 60} min)")
        if h.get("pixhawk_connected"):
            ok(f"Pixhawk connected — GPS fix {h.get('gps_fix')}, {h.get('satellites')} satellites")
        else:
            warn(f"Pixhawk not connected: {h.get('link_error') or 'no heartbeat'}")
    except ValueError:
        warn(f"Backend not answering on port {HTTP_PORT}.")
    _, out = pi.run(f"curl -s -m 4 http://127.0.0.1:{HTTP_PORT}/api/camera/status || true", check=False)
    try:
        cam = json.loads(out)
        if cam.get("camera_connected"):
            ok(f"Camera streaming: {cam.get('resolution')} at {cam.get('measured_fps')} fps ({cam.get('pipeline')})")
        else:
            warn(f"Camera not streaming: {cam.get('last_error') or cam.get('status_text')}")
    except ValueError:
        pass
    _, out = pi.run("command -v netbird >/dev/null 2>&1 && netbird status 2>/dev/null | grep -i 'NetBird IP' || true", check=False)
    ip = _netbird_ip(out)
    ctx["netbird_ip"] = ip or ctx.get("netbird_ip")
    say(f"  NetBird: {ip or 'not connected'}")
    _, out = pi.run("hostname -I 2>/dev/null || true", check=False)
    ips = [x for x in out.split() if re.match(r"^\d+\.\d+\.\d+\.\d+$", x) and not x.startswith("100.")]
    if ips:
        ctx["lan_ip"] = ips[0]
        say(f"  Wi-Fi/LAN IP: {ips[0]}")
    say("")
    say("  Last log lines:", "b")
    _, logs = pi.run(f"journalctl -u {SERVICE} -n 15 --no-pager -o cat 2>/dev/null || true", sudo=True, check=False)
    for line in (logs.strip().splitlines() or ["(no log yet)"])[-15:]:
        say(f"    {line[:150]}", "dim")
    print_address(ctx)


def action_live_log(pi, ctx):
    say("  Showing the drone service log live — press Ctrl+C to go back to the menu.", "dim")
    try:
        pi.run(f"journalctl -u {SERVICE} -f -n 30 -o cat", sudo=True, stream=True, check=False, timeout=24 * 3600)
    except KeyboardInterrupt:
        say("")
    finally:
        pi.close()  # also stops the still-running journalctl on the Pi


def action_restart(pi, ctx):
    pi.run(f"systemctl restart {SERVICE}", sudo=True, timeout=120)
    ok("Drone service restarted")
    step_verify(pi, ctx)


def action_shell(pi, ctx):
    ssh = shutil.which("ssh") or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "OpenSSH", "ssh.exe")
    if not os.path.exists(ssh):
        warn("Windows' SSH client isn't installed (Settings → Apps → Optional features → OpenSSH Client).")
        return
    say("  Opening a terminal on the Pi. Type your password when asked; type  exit  to come back here.", "dim")
    say(f"  The drone code is in  {ctx['app']}  (restart it with: sudo systemctl restart {SERVICE})", "dim")
    say("")
    subprocess.call([ssh, "-p", str(pi.port), "-o", "ServerAliveInterval=30", f"{pi.user}@{pi.host}"])
    say("")
    ok("Back from the Pi terminal")


def action_autostart(pi, ctx):
    """Check that the backend starts on every boot, and repair it if not."""
    if not ctx.get("installed"):
        warn("The drone backend isn't installed on this Pi yet — run 1) Full setup first.")
        return
    step_service(pi, ctx)
    step_verify(pi, ctx)
    if ask_yes("  Reboot the Pi now to prove it comes back up by itself?", False):
        _reboot_and_wait(pi, ctx)


def action_reboot(pi, ctx):
    if not ask_yes("  Reboot the drone Pi now?", False):
        return
    _reboot_and_wait(pi, ctx)


def step_reboot(pi, ctx):
    if not ctx.get("reboot"):
        return
    if not ask_yes("  The serial port or camera module change needs a reboot of the Pi. Reboot now?", True):
        warn("Remember to reboot the Pi before the first mission (menu 7, or sudo reboot).")
        return
    _reboot_and_wait(pi, ctx)


def _reboot_and_wait(pi, ctx):
    try:
        pi.run("systemctl --no-block reboot", sudo=True, check=False, timeout=30)
    except (InstallError, paramiko.SSHException, OSError, EOFError):
        pass  # the connection dropping here is the reboot itself
    pi.close()
    say("  Rebooting the Pi… (about a minute)")
    time.sleep(10)
    for _ in range(36):
        try:
            pi.connect(quiet=True)
            break
        except InstallError:
            time.sleep(5)
    else:
        warn("The Pi did not come back within 3 minutes. Check it later — the drone service starts by itself.")
        return
    ctx["reboot"] = False
    ok("Pi is back up")
    if ctx.get("installed"):
        step_verify(pi, ctx, "Checking the drone after the reboot")


def action_camera_test(pi, ctx):
    """Grab a picture from the drone camera and open it on this PC."""
    if not ctx.get("installed"):
        warn("The drone backend isn't installed on this Pi yet — run 1) Full setup first.")
        return
    _, out = pi.run(f"curl -s -m 4 http://127.0.0.1:{HTTP_PORT}/api/camera/status || true", check=False)
    try:
        cam = json.loads(out)
    except ValueError:
        raise InstallError("The drone backend is not answering — try 5) Restart the drone service.")
    if not cam.get("camera_connected"):
        raise InstallError(f"The camera is not streaming: {cam.get('last_error') or cam.get('status_text')}")
    code, b64 = pi.run(f"curl -s -m 8 http://127.0.0.1:{HTTP_PORT}/api/camera/snapshot | base64 -w0", check=False, timeout=60)
    import base64
    try:
        jpeg = base64.b64decode(b64.strip().splitlines()[-1])
    except (ValueError, IndexError):
        jpeg = b""
    if jpeg[:2] != b"\xff\xd8":
        raise InstallError("Could not get a picture from the camera.")
    folder = Path(os.environ.get("USERPROFILE") or Path.home()) / "Pictures"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"varuna-drone-camera-{datetime.now():%Y%m%d-%H%M%S}.jpg"
    path.write_bytes(jpeg)
    ok(f"Camera: {cam.get('resolution')} at {cam.get('measured_fps')} fps ({cam.get('pipeline')})")
    ok(f"Picture saved: {path}")
    try:
        os.startfile(str(path))   # opens it in the Photos app
    except (AttributeError, OSError):
        pass


def action_camera(pi, ctx):
    """Choose the drone camera (auto-detect / USB webcam / camera module), set it
    up, restart the service and show which camera is streaming."""
    if not ctx.get("installed"):
        warn("The drone backend isn't installed on this Pi yet — run 1) Full setup first.")
        return
    cam = _drone_api(pi, "/api/camera/status") or {}
    current = cam.get("camera_source") or _config_value(pi, ctx, "camera_source") or "auto"
    say(f"Now: {CAMERA_LABEL.get(current, current)}"
        + (f"   ·   streaming from the {CAMERA_LABEL.get(cam.get('source'), cam.get('source'))}"
           if cam.get("camera_connected") else ""))
    avail = cam.get("available") or {}
    if avail:
        say(f"  The Pi sees: USB webcam {'✔ ' + avail['usb'] if avail.get('usb') else '✘'}"
            f"   ·   camera module {'✔' if avail.get('csi') else '✘ (or not checked yet)'}", "dim")
    say("")
    ctx["camera"] = ask_camera(current)
    _patch_config(pi, ctx, {"camera_source": ctx["camera"]})
    ok(f"Camera set to: {CAMERA_LABEL[ctx['camera']]} (drone_config.json)")
    step_camera(pi, ctx)
    if ctx.get("reboot"):
        step_reboot(pi, ctx)
        if ctx.get("reboot"):
            return
    else:
        pi.run(f"systemctl restart {SERVICE}", sudo=True, timeout=120)
        step_verify(pi, ctx, "Checking the camera")


def _config_value(pi, ctx, key):
    app = shlex.quote(ctx["app"])
    _, out = pi.run(f"cat {app}/drone_config.json 2>/dev/null || true", check=False)
    try:
        return json.loads(out).get(key)
    except ValueError:
        return None


def _find_web_dist():
    here = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    for cand in (here / "dist", here.parent / "dist", Path.cwd() / "dist"):
        if (cand / "index.html").is_file():
            return cand
    return None


def action_webapp(pi, ctx):
    """Copy the built VARUNA web app (dist/) to the Pi, served at http://<pi>:8000."""
    if not ctx.get("installed"):
        warn("The drone backend isn't installed on this Pi yet — run 1) Full setup first.")
        return
    dist = _find_web_dist()
    if dist is None:
        say("  Couldn't find the VARUNA web app (a 'dist' folder with index.html) next to this tool.", "dim")
        raw = ask("Path to the dist folder (Enter to cancel)", "")
        if not raw:
            return
        dist = Path(raw.strip('"'))
        if not (dist / "index.html").is_file():
            raise InstallError(f"{dist} doesn't contain index.html — build the app first (npm run build).")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(str(dist), arcname=".")
    blob = buf.getvalue()
    say(f"  Uploading {len(blob) // 1048576} MB from {dist}…")
    web = shlex.quote(ctx["app"] + "/web")
    pi.run(f"set -e; rm -rf {web}; mkdir -p {web}; tar -xzf - -C {web}", stdin_data=blob, timeout=1800)
    pi.run(f"systemctl restart {SERVICE}", sudo=True, timeout=120)
    step_verify(pi, ctx)
    ok(f"Web app installed — open http://{ctx.get('lan_ip') or pi.host}:{HTTP_PORT} in a browser")


def _drone_api(pi, path, method="GET", timeout=6):
    flag = "-X POST " if method == "POST" else ""
    _, out = pi.run(f"curl -s -m {timeout} {flag}http://127.0.0.1:{HTTP_PORT}{path} || true",
                    check=False, timeout=timeout + 20)
    try:
        return json.loads(out)
    except ValueError:
        return None


def action_keyboard(pi, ctx):
    """Keyboard flight from the app's Control tab: the drone Pi's limits and the
    Pixhawk failsafes behind it."""
    if not ctx.get("installed"):
        warn("The drone backend isn't installed on this Pi yet — run 1) Full setup first.")
        return
    conf = _drone_api(pi, "/api/config")
    if not conf:
        raise InstallError("The drone backend is not answering — try 5) Restart the drone service.")
    settings = conf.get("settings", conf)
    if "kb_speed_mps" not in settings:
        warn("This drone code has no keyboard flight yet — run 2) Update the drone code first.")
        return

    def val(k):
        v = settings.get(k)
        return v.get("value") if isinstance(v, dict) else v
    say("Keyboard flight limits on the drone Pi (change them in the app: System → Live tuning, or the Control tab):")
    say(f"    speed {val('kb_speed_mps')} m/s · climb {val('kb_climb_mps')} m/s · turn {val('kb_yaw_dps')}°/s", "c")
    say(f"    never below {val('kb_min_alt_m')} m by keyboard · never above {val('max_altitude_m')} m · "
        f"within {val('max_distance_m')} m of home", "c")
    lost = val("kb_lost_action")
    say(f"    app silent for {val('kb_lost_s')} s while flying by keyboard → "
        f"{ {'rtl': 'return home', 'land': 'land', 'hover': 'hover'}.get(lost, lost) }", "c")
    fs = _drone_api(pi, "/api/pixhawk/safety", timeout=40)
    if not fs or fs.get("success") is False:
        warn("Couldn't read the Pixhawk's failsafe settings"
             + (f": {fs.get('message')}" if fs and fs.get("message") else " — is the Pixhawk connected? (3) Status)"))
    elif fs.get("ok"):
        ok("Pixhawk failsafes on: GCS failsafe (Pi stops → return home), radio failsafe, geofence")
    else:
        for note in fs.get("notes") or []:
            warn(note)
        if not (fs.get("values") or {}).get("FS_GCS_ENABLE") and \
                ask_yes("Turn on the GCS failsafe (FS_GCS_ENABLE = 1: if the drone's Pi stops, it returns home)?", True):
            res = _drone_api(pi, "/api/pixhawk/safety/fix", method="POST", timeout=40) or {}
            (ok if res.get("success") else warn)(res.get("message") or "No answer from the drone backend.")
        say("  A geofence (FENCE_ENABLE) is set in Mission Planner / QGroundControl: draw it around the lake.", "dim")
    say("")
    say("  In the VARUNA app → Control tab (the drone must be in the air: ARM, TAKEOFF, then G):", "dim")
    say("  W / S forward / back   A / D left / right   ↑ / ↓ climb / descend   ← / → turn", "dim")
    say("  Shift = slow   G = take control (GUIDED)   Space = BRAKE   Esc = release (BRAKE, hover)", "dim")
    say("  Keep the RC transmitter at hand: its mode switch takes over at any time.", "dim")


def action_find_pixhawk(pi, ctx):
    """Probe every USB port and TELEM2 at every baud, fix common Linux blockers,
    save the working link and restart the drone service."""
    if not ctx.get("installed"):
        warn("The drone backend isn't installed on this Pi yet — run 1) Full setup first.")
        return
    app = shlex.quote(ctx["app"])
    say("  Checking the Pi for things that block a Pixhawk…")
    _, out = pi.run(r"""
set +e
R="${VARUNA_ROOT:-}"
CFG="$R/boot/firmware/config.txt"; [ -f "$CFG" ] || CFG="$R/boot/config.txt"
CMD="$R/boot/firmware/cmdline.txt"; [ -f "$CMD" ] || CMD="$R/boot/cmdline.txt"
FIXED=""
if systemctl is-active --quiet ModemManager 2>/dev/null; then
  systemctl disable --now ModemManager >/dev/null 2>&1 && FIXED="$FIXED ModemManager"
fi
for g in serial-getty@ttyAMA0.service serial-getty@serial0.service serial-getty@ttyS0.service; do
  if systemctl is-active --quiet "$g" 2>/dev/null; then systemctl disable --now "$g" >/dev/null 2>&1 && FIXED="$FIXED $g"; fi
done
echo "FIXED=$FIXED"
echo "SERIAL0=$(readlink -f /dev/serial0 2>/dev/null)"
echo "UART=$(grep -cE '^enable_uart=1' "$CFG" 2>/dev/null)"
echo "CONSOLE=$(grep -oE 'console=(serial0|ttyAMA0|ttyS0)[^ ]*' "$CMD" 2>/dev/null)"
echo "USB=$(ls /dev/ttyACM* 2>/dev/null | tr '\n' ' ')"
""", sudo=True, check=False, timeout=60)
    facts = dict(line.split("=", 1) for line in out.splitlines() if "=" in line and line.split("=", 1)[0].isupper())
    if facts.get("FIXED", "").strip():
        ok(f"Switched off something that was grabbing the Pixhawk's port: {facts['FIXED'].strip()}")
    say(f"  TELEM2 port /dev/serial0 → {facts.get('SERIAL0') or 'missing'}   ·   "
        f"USB flight controller: {facts.get('USB', '').strip() or 'none plugged in'}", "dim")
    if facts.get("CONSOLE"):
        warn(f"A login console is still on the serial port ({facts['CONSOLE']}) — reboot (menu 7) to clear it.")
    say("  Stopping the drone service and listening on every port and speed (about 40 s)…")
    pi.run(f"systemctl stop {SERVICE}", sudo=True, check=False, timeout=60)
    try:
        _, out = pi.run(f"cd {app} && venv/bin/python -c {shlex.quote(PROBE_SCRIPT)}", timeout=180, check=False)
        found = None
        for line in out.splitlines():
            parts = line.split()
            if parts[:1] == ["RESULT"] and len(parts) >= 5:
                kind = {"missing": "not present", "silent": "nothing received", "garbage": "data, but not MAVLink",
                        "cannot-open": "can't open"}.get(parts[4], parts[4])
                say(f"    {parts[1]:6s} {parts[2]:14s} {parts[3]:>7s} baud: {kind}", "dim")
            elif parts[:1] == ["FOUND"] and len(parts) >= 6:
                found = {"link": parts[1], "device": parts[2], "baud": int(parts[3]),
                         "autopilot": parts[4], "type": parts[5]}
        if found:
            fw = {"3": "ArduPilot", "12": "PX4"}.get(found["autopilot"], f"autopilot {found['autopilot']}")
            ok(f"Pixhawk found on {found['link'].upper()} ({found['device']}, {found['baud']} baud) — {fw}")
            if found["autopilot"] != "3":
                warn("This flight controller isn't running ArduPilot — the VARUNA drone code is made for ArduCopter.")
            patch = {"link_prefer": found["link"], "mav_connection": ""}
            if found["link"] == "telem2":
                patch["telem2_baud"] = found["baud"]
            else:
                patch["usb_device"] = found["device"]
            save = ("import json, pathlib\n"
                    "p = pathlib.Path('drone_config.json')\n"
                    "cfg = json.loads(p.read_text()) if p.exists() else {}\n"
                    f"cfg.update({json.dumps(patch)})\n"
                    "p.write_text(json.dumps(cfg, indent=2))\n")
            pi.run(f"cd {app} && venv/bin/python -c {shlex.quote(save)}")
            ok("Saved as the drone's Pixhawk link")
        else:
            warn("No Pixhawk answered on any port or speed.")
            if "garbage" in out:
                say("    Data arrives on TELEM2 but it isn't MAVLink: on the Pixhawk set SERIAL2_PROTOCOL = 2 (MAVLink2)", "y")
                say("    and SERIAL2_BAUD = 57 (or any speed listed above), then reboot the Pixhawk.", "y")
            else:
                say("    Nothing at all came from the Pixhawk. Check:", "y")
                say("     • the Pixhawk is powered (battery, or its own USB power),", "y")
                say("     • TELEM2 TX → Pi pin 10 (RXD) and TELEM2 RX → Pi pin 8 (TXD) — not swapped,", "y")
                say("     • TELEM2 GND → Pi pin 6 (GND),", "y")
                say("     • or simply plug the Pixhawk into a Pi USB port and run this again.", "y")
    finally:
        pi.run(f"systemctl start {SERVICE}", sudo=True, check=False, timeout=60)
    step_verify(pi, ctx)


PROBE_SCRIPT = """
import glob, os, time
from pymavlink import mavutil
cands = []
for p in sorted(glob.glob('/dev/serial/by-id/*')) + sorted(glob.glob('/dev/ttyACM*')):
    r = os.path.realpath(p)
    if 'ttyACM' in r and all(c[1] != r for c in cands):
        cands.append(('usb', r, 115200))
for b in (57600, 115200, 921600, 230400, 460800, 500000, 1500000):
    cands.append(('telem2', '/dev/serial0', b))
for name, dev, baud in cands:
    if not os.path.exists(dev):
        print('RESULT', name, dev, baud, 'missing', flush=True)
        continue
    try:
        m = mavutil.mavlink_connection(dev, baud=baud, source_system=255, source_component=190)
    except Exception as e:
        print('RESULT', name, dev, baud, 'cannot-open', flush=True)
        continue
    end, bad, hb = time.time() + 4, 0, None
    while time.time() < end and hb is None:
        msg = m.recv_match(blocking=True, timeout=0.5)
        if msg is None:
            continue
        if msg.get_type() == 'BAD_DATA':
            bad += len(getattr(msg, 'data', b'') or b'')
        elif msg.get_type() == 'HEARTBEAT' and msg.type != 6 and msg.autopilot != 8:
            hb = msg
    m.close()
    if hb:
        print('FOUND', name, dev, baud, hb.autopilot, hb.type, flush=True)
        break
    print('RESULT', name, dev, baud, 'garbage' if bad > 20 else 'silent', bad, flush=True)
"""


MENU = [
    ("1", "Full setup (first time — installs everything)", action_setup),
    ("2", "Update the drone code on the Pi", action_update),
    ("3", "Status (service, Pixhawk, camera, NetBird, recent log)", action_status),
    ("4", "Live log", action_live_log),
    ("5", "Restart the drone service", action_restart),
    ("6", "Open an SSH terminal on the Pi", action_shell),
    ("7", "Reboot the Pi", action_reboot),
    ("8", "Auto-start on boot: check & fix", action_autostart),
    ("9", "Camera test: take a picture and open it here", action_camera_test),
    ("10", "Put the VARUNA web app on the Pi (optional)", action_webapp),
    ("11", "Find the Pixhawk (fix the link automatically)", action_find_pixhawk),
    ("12", "Keyboard flight: limits and Pixhawk failsafes", action_keyboard),
    ("13", "Camera: auto-detect, USB webcam or Pi camera module", action_camera),
    ("0", "Exit", None),
]


def run_app():
    banner()
    pi, ctx = open_session()
    while True:
        say("")
        say(f"── {pi.user}@{pi.host}  ·  drone backend {'installed' if ctx.get('installed') else 'not installed yet'} ──", "m")
        for key, label, _ in MENU:
            say(f"  {key}) {label}")
        choice = ask("Choose", "1" if not ctx.get("installed") else "3")
        action = next((fn for key, _, fn in MENU if key == choice), "missing")
        if action is None:
            break
        if action == "missing":
            warn("Pick one of the numbers above.")
            continue
        try:
            action(pi, ctx)
        except InstallError as exc:
            lines = str(exc).splitlines()
            fail(lines[0])
            for line in lines[1:]:
                say(f"    {line}", "dim")
            say("Nothing is broken — fix the problem and try again; setup picks up where it left off.", "dim")
        except (paramiko.SSHException, EOFError, OSError) as exc:
            fail(f"Lost the connection to the Pi ({exc}). It reconnects on the next action.")
        pi.close()
    pi.close()


def main():
    if "--self-test" in sys.argv:  # build check: is the drone backend bundled and complete?
        blob = build_tarball()
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
            names = tar.getnames()
        print(f"SELF-TEST OK: {len(names)} files bundled ({', '.join(names)}), paramiko {paramiko.__version__}")
        return 0
    code = 0
    try:
        run_app()
    except KeyboardInterrupt:
        say("\nBye.", "y")
    except Exception as exc:  # last resort: never close the window on a traceback
        import traceback
        LOG.write(traceback.format_exc())
        fail(f"Unexpected error: {exc}")
        say(f"Details are in the log: {LOG.path}", "dim")
        code = 1
    say(f"Log of this session: {LOG.path}", "dim")
    if not os.environ.get("VARUNA_INSTALLER_NO_PAUSE"):
        try:
            input("\nPress Enter to close…")
        except (EOFError, KeyboardInterrupt):
            pass
    return code


if __name__ == "__main__":
    sys.exit(main())
