"""
VARUNA Boat Pi Tool: a terminal app for the boat's Raspberry Pi, over SSH.

Run it on the Windows laptop. It asks for the boat Pi's address and password
once, then offers:
  1. Full setup (first time): system packages, the boat backend (bundled in
     this app), Python libraries, Pixhawk link, serial port, the USB camera and
     the turbidity sensor (I2C), auto-start service, optional NetBird, then
     checks it all works.
  2. Update the boat code: copies the latest backend and restarts it.
  3. Status: service, Pixhawk link, camera, water sensor, NetBird, recent log.
  4. Live log of the boat service.
  5. Restart the boat service.
  6. Open an SSH terminal on the Pi.
  7. Reboot the Pi.
  8. Auto-start on boot: check & fix.
  9. Camera test: take a picture with the boat camera and open it here.
 10. Turbidity sensor check: live reading, volts and the ADC on I2C.
 11. Calibrate the turbidity sensor in clear water.
 12. Find the Pixhawk: what the boat tried on each port and speed.

Works on 64-bit and 32-bit Raspberry Pi OS (Pi Zero, Pi 3/4/5). On 32-bit,
FastAPI and pydantic come from the OS packages, because building pydantic
from source on a Pi Zero takes hours.

Safe to run again and again: setup and update keep the boat's settings and
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

VERSION = "1.3.0"
APP_DIR_NAME = "varuna-boat"
SERVICE = "varuna-boat"
HTTP_PORT = 8000
PAYLOAD_FILES = [
    "main.py", "config.py", "mav_link.py", "mission.py", "sim_vehicle.py",
    "camera.py", "camera_model.py", "vision.py", "turbidity.py", "sim_world.py",
    "requirements.txt", "README.md", "boat_config.example.json", "test_e2e.py",
]
APT_PACKAGES = "python3-venv python3-dev python3-pip libxml2-dev libxslt1-dev curl i2c-tools"
# 32-bit Pis: the web framework comes from the OS (no compiling pydantic on a Pi Zero).
APT_PACKAGES_32 = ("python3-fastapi python3-uvicorn python3-pydantic python3-psutil python3-serial "
                   "python3-smbus2 python3-websockets python3-lxml")
# The boat camera is a USB webcam: ffmpeg passes its MJPEG through to the app,
# v4l-utils lists the camera and what it can send.
CAMERA_PACKAGES = "ffmpeg v4l-utils"


def is_32bit(ctx):
    """32-bit userland. A Pi 4/5 running 32-bit Raspberry Pi OS boots a 64-bit
    kernel (uname says aarch64), so the package architecture decides."""
    if ctx.get("dpkg_arch"):
        return ctx["dpkg_arch"] in ("armhf", "armel")
    return ctx.get("arch") in ("armv6l", "armv7l")

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
        self.path = base / f"boat-install-{datetime.now():%Y%m%d-%H%M%S}.log"
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
    """The boat backend files: bundled in the .exe, or ../boat-pi when run as a script."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "boat-pi"
    return Path(__file__).resolve().parent.parent / "boat-pi"


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
        known = Path(os.environ.get("APPDATA") or Path.home()) / "VARUNA" / "boat_known_hosts"
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
echo "DPKG=$(dpkg --print-architecture 2>/dev/null)"
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
    ctx.update(arch=info.get("ARCH", "?"), dpkg_arch=info.get("DPKG", "").strip(), os=info.get("OS", "?"),
               model=info.get("MODEL", "unknown"),
               home=info.get("HOME", f"/home/{pi.user}"), user=info.get("USER", pi.user))
    say(f"  Board: {ctx['model']}   OS: {ctx['os']}   CPU: {ctx['arch']}" + ("   (32-bit OS)" if is_32bit(ctx) else ""))
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
{f"apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends {APT_PACKAGES_32} || echo 'Some OS Python packages are missing — the pip fallback will be used.'" if is_32bit(ctx) else ""}
apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends {CAMERA_PACKAGES}
""", sudo=True, timeout=2400, stream=True)
    ok("System packages installed" + (" (32-bit: web framework from the OS packages)" if is_32bit(ctx) else ""))


def step_copy(pi, ctx):
    app = f"{ctx['home']}/{APP_DIR_NAME}"
    ctx["app"] = app
    pi.run(f"systemctl stop {SERVICE} 2>/dev/null || true", sudo=True, check=False, timeout=60)
    blob = build_tarball()
    pi.run(f'set -e; mkdir -p {shlex.quote(app)}; tar -xzf - -C {shlex.quote(app)}', stdin_data=blob, timeout=300)
    _, out = pi.run(f"ls {shlex.quote(app)}", check=False)
    if "main.py" not in out:
        raise InstallError("The backend files did not arrive on the Pi.")
    ok(f"Boat backend copied to {app}")


IMPORT_CHECK = (
    "import fastapi, uvicorn, pymavlink, psutil, smbus2; "
    "v = tuple(int(x) for x in fastapi.__version__.split('.')[:2]); "
    "print('IMPORT_OK' if v >= (0, 85) else 'FASTAPI_OLD ' + fastapi.__version__)"
)


def step_venv(pi, ctx):
    app = shlex.quote(ctx["app"])
    if is_32bit(ctx):
        _install_libs_32(pi, ctx, app)
    else:
        say("  Installing the Python libraries (FastAPI, uvicorn, pymavlink, psutil, smbus2).")
        say("  On a Pi 3 this can take 5–20 minutes — please keep the Pi powered.", "dim")
        pi.run(f"""
set -e
cd {app}
if [ ! -x venv/bin/python ]; then python3 -m venv venv; fi
venv/bin/python -m pip install --upgrade pip wheel --disable-pip-version-check
venv/bin/python -m pip install -r requirements.txt --disable-pip-version-check
""", timeout=3600, stream=True)
    _, out = pi.run(f'cd {app} && venv/bin/python -c {shlex.quote(IMPORT_CHECK)}', check=False)
    if "IMPORT_OK" not in out:
        raise InstallError("The libraries installed, but the backend cannot use them:\n" + out[-600:])
    ok("Python libraries installed and working")


def _install_libs_32(pi, ctx, app):
    """32-bit (Pi Zero / armhf): FastAPI, uvicorn and pydantic from the OS
    packages, shared into the venv; only pure-Python extras come from pip.
    If the OS's FastAPI is too old for this backend, fall back to pip with the
    Raspberry Pi pre-built wheels (piwheels)."""
    say("  32-bit Raspberry Pi OS: using the system's FastAPI/pydantic packages (no compiling on the Pi).")
    _, ver = pi.run("python3 -c \"import fastapi; print('FASTAPI', fastapi.__version__)\" 2>&1 || true", check=False)
    m = re.search(r"FASTAPI (\d+)\.(\d+)", ver)
    if m and (int(m.group(1)), int(m.group(2))) >= (0, 85):
        pi.run(f"""
set -e
cd {app}
if [ -x venv/bin/python ] && ! grep -q 'include-system-site-packages = true' venv/pyvenv.cfg 2>/dev/null; then rm -rf venv; fi
if [ ! -x venv/bin/python ]; then python3 -m venv --system-site-packages venv; fi
venv/bin/python -m pip install --disable-pip-version-check --no-deps "pymavlink>=2.4.41"
venv/bin/python -m pip install --disable-pip-version-check "smbus2>=0.4" "pyserial>=3.5"
""", timeout=3600, stream=True)
        return
    warn(f"The OS's FastAPI is too old ({m.group(1) + '.' + m.group(2) if m else 'not installed'}); "
         "trying the pre-built Raspberry Pi wheels instead (can take a while).")
    code, _ = pi.run(f"""
set -e
cd {app}
rm -rf venv
python3 -m venv venv
venv/bin/python -m pip install --disable-pip-version-check --extra-index-url https://www.piwheels.org/simple   "fastapi>=0.85" "uvicorn>=0.17" websockets "pymavlink>=2.4.41" "pyserial>=3.5" "psutil>=5.9" "smbus2>=0.4"
""", timeout=7200, stream=True, check=False)
    if code != 0:
        raise InstallError("Could not install FastAPI on this 32-bit Pi. Run: sudo apt install python3-fastapi "
                           "python3-uvicorn python3-pydantic (or flash a current Raspberry Pi OS), then Full setup again.")


def step_config(pi, ctx):
    link = ctx["link"]
    _patch_config(pi, ctx, {"mav_connection": link["device"], "mav_baud": link["baud"], "http_port": HTTP_PORT})
    ok(f"Pixhawk link set to {link['device']} at {link['baud']} baud (boat_config.json)")


def _patch_config(pi, ctx, patch):
    """Merge `patch` into the boat's boat_config.json, keeping everything else."""
    app = shlex.quote(ctx["app"])
    pi.run(f"""
set -e
cd {app}
venv/bin/python - <<'PYEOF'
import json, pathlib
p = pathlib.Path("boat_config.json")
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


def step_uart(pi, ctx):
    # ModemManager (installed on many Pi images) grabs every new ttyACM port to
    # probe it for a modem — exactly where a USB Pixhawk appears.
    _, mm = pi.run("if systemctl is-active --quiet ModemManager 2>/dev/null; then "
                   "systemctl disable --now ModemManager >/dev/null 2>&1 && echo MM_OFF; fi; true",
                   sudo=True, check=False, timeout=60)
    if "MM_OFF" in mm:
        ok("Switched off ModemManager (it blocks USB flight controllers)")
    if ctx["link"]["kind"] == "usb":
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


def step_camera_sensor(pi, ctx):
    """Turn on I2C (for the turbidity sensor's ADS1115), give the service user
    access to the camera, I2C and serial port, and report what is connected:
    the USB camera (and whether it sends MJPEG) and the ADC."""
    user = shlex.quote(ctx["user"])
    _, out = pi.run(f"""
set +e
R={ROOT}
CFG="$R/boot/firmware/config.txt"; [ -f "$CFG" ] || CFG="$R/boot/config.txt"
before=$(md5sum < "$CFG" 2>/dev/null)
if [ -f "$CFG" ]; then
  grep -q '^dtparam=i2c_arm=on' "$CFG" || echo 'dtparam=i2c_arm=on' >> "$CFG"
fi
command -v raspi-config >/dev/null 2>&1 && raspi-config nonint do_i2c 0 >/dev/null 2>&1
grep -qs '^i2c-dev' "$R/etc/modules" || echo 'i2c-dev' >> "$R/etc/modules"
modprobe i2c-dev >/dev/null 2>&1
usermod -aG video,i2c,dialout {user} >/dev/null 2>&1
after=$(md5sum < "$CFG" 2>/dev/null)
[ "$before" = "$after" ] || echo BOOT_CHANGED
command -v ffmpeg >/dev/null 2>&1 || echo NO_FFMPEG
DEV=""
for p in /dev/v4l/by-id/*-video-index0; do [ -e "$p" ] && DEV=$(readlink -f "$p") && break; done
if [ -n "$DEV" ]; then
  echo "USBCAM=$DEV"
  echo "USBNAME=$(v4l2-ctl -d "$DEV" --info 2>/dev/null | grep -m1 'Card type' | cut -d: -f2- | xargs)"
  FMTS=$(v4l2-ctl -d "$DEV" --list-formats-ext 2>/dev/null)
  echo "$FMTS" | grep -q MJPG && echo MJPEG_YES || echo MJPEG_NO
  echo "$FMTS" | awk '/MJPG/{{m=1;next}} /]:/{{m=0}} m && /Size/{{print "SIZE=" $3}}' | head -30
else
  echo NO_USBCAM
fi
if command -v i2cdetect >/dev/null 2>&1 && [ -e /dev/i2c-1 ]; then i2cdetect -y 1 2>/dev/null | grep -q ' 48' && echo ADS_FOUND || echo ADS_MISSING; else echo I2C_OFF; fi
""", sudo=True, check=False, timeout=120)
    if "BOOT_CHANGED" in out:
        ctx["reboot"] = True
        ok("I2C enabled in the Pi's boot settings — needs a reboot")
    _report_usb_camera(pi, ctx, out)
    if "ADS_FOUND" in out:
        ok("Turbidity sensor ADC (ADS1115 at 0x48) found on I2C")
    elif "ADS_MISSING" in out:
        warn("No ADS1115 at 0x48 on I2C: wire VDD→3.3 V (pin 1), GND→pin 6, SDA→pin 3, SCL→pin 5; "
             "sensor signal → 10 kΩ → A0, A0 → 20 kΩ → GND.")
    else:
        warn("I2C isn't active yet — it will be after the reboot.")


def _report_usb_camera(pi, ctx, out):
    """What the camera check found; tells the boat to use the USB camera directly."""
    info = dict(line.split("=", 1) for line in out.splitlines() if line.startswith(("USBCAM=", "USBNAME=")))
    sizes = [line[5:].strip() for line in out.splitlines() if line.startswith("SIZE=")]
    if "NO_FFMPEG" in out:
        warn("ffmpeg isn't installed, so the boat camera can't stream. Run 1) Full setup again "
             "(it installs ffmpeg), or on the Pi: sudo apt install ffmpeg v4l-utils")
    if "USBCAM" not in info:
        warn("No USB camera found. Plug it into the Pi — on a Pi Zero, the micro-USB port marked USB "
             "(not PWR) through an OTG adapter — then run 9) Camera test.")
        return
    ok(f"USB camera found: {info.get('USBNAME') or 'USB camera'} ({info['USBCAM']})")
    if "MJPEG_YES" in out:
        size = "640x360" if "640x360" in sizes else "640x480" if "640x480" in sizes else None
        if size:
            ok(f"It sends MJPEG at {size}: frames go straight to the app, no encoding on the Pi (lightest for a Pi Zero)")
        else:
            warn(f"It sends MJPEG, but not at 640x360 or 640x480 (it offers {', '.join(sizes[:6]) or 'no sizes'}); "
                 "the Pi will have to resize and encode, which is heavy on a Pi Zero.")
    else:
        warn("This camera only sends raw video, so the Pi has to encode every frame — heavy on a Pi Zero and it "
             "may lag. A webcam with MJPEG output (most do) is recommended.")
    # Straight to the USB camera: "auto" would first look for a camera module,
    # which takes seconds of a Pi Zero's CPU every time the camera restarts.
    _patch_config(pi, ctx, {"camera_source": "usb"})
    say("  Set the webcam's horizontal field of view (from its spec sheet) in the app: Boat Vision → Settings.", "dim")


def step_service(pi, ctx):
    # Starts at boot without waiting for Wi-Fi (at the lake there may be none;
    # the backend serves on every interface as soon as one comes up), and
    # never gives up restarting after crashes.
    unit = f"""[Unit]
Description=VARUNA boat backend (FastAPI + pymavlink)
After=network.target
StartLimitIntervalSec=0

[Service]
User={ctx['user']}
WorkingDirectory={ctx['app']}
ExecStart={ctx['app']}/venv/bin/python main.py
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
# On a Pi Zero the boat must win the single CPU core over background jobs.
Nice=-5

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
        raise InstallError(f"The boat service was installed but could not be enabled for boot (systemctl says: {state.strip() or 'nothing'}).")
    ok("Boat service installed and enabled — it starts automatically every time the Pi boots")


def step_lite(pi, ctx):
    """Pi Zero: the boat runs its lighter settings by itself (camera 10 fps,
    telemetry 2x a second); a desktop is the one thing that would still make it
    lag, so offer to boot to the console instead."""
    if "Pi Zero" not in ctx.get("model", ""):
        ok("Not a Pi Zero — full camera and telemetry rates")
        return
    ok("Pi Zero: the boat uses its lite settings (camera 10 fps, quality 70, telemetry 2x/s)")
    _, target = pi.run("systemctl get-default 2>/dev/null || true", check=False)
    if "graphical" not in target:
        ok("No desktop running — all of the Pi Zero is free for the boat")
        return
    warn("This Pi Zero starts a desktop. It takes a large share of the CPU and memory, and makes the boat lag.")
    if ask_yes("Switch to console boot (no desktop)? It takes effect after a reboot", True):
        pi.run("systemctl set-default multi-user.target", sudo=True, timeout=60)
        ctx["reboot"] = True
        ok("The Pi will boot without the desktop from the next reboot")
    else:
        warn("Desktop kept. For a lag-free boat, use Raspberry Pi OS Lite or switch later with: "
             "sudo systemctl set-default multi-user.target")


def step_netbird(pi, ctx):
    key = ctx.get("netbird_key")
    if not key:
        _, out = pi.run("command -v netbird >/dev/null 2>&1 && netbird status 2>/dev/null | grep -i 'NetBird IP' || true", check=False)
        ip = _netbird_ip(out)
        if ip:
            ctx["netbird_ip"] = ip
            ok(f"NetBird already connected: {ip}")
        else:
            warn("NetBird skipped (no setup key). The app can still reach the boat on the same Wi-Fi.")
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


def step_verify(pi, ctx, label="Checking the boat backend"):
    say(f"  {label}…")
    ping = health = None
    for _ in range(30):
        _, out = pi.run(f"curl -s -m 3 http://127.0.0.1:{HTTP_PORT}/api/ping || true", check=False)
        if '"vehicle":"boat"' in out.replace(" ", ""):
            ping = out
            break
        time.sleep(2)
    if not ping:
        _, logs = pi.run(f"journalctl -u {SERVICE} -n 25 --no-pager 2>/dev/null || true", sudo=True, check=False)
        raise InstallError("The boat service did not start.\n" + logs[-1500:])
    ok(f"Boat backend is running on port {HTTP_PORT}")
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
        ok(f"Pixhawk connected on {health.get('mav_connection')} ✔")
        ctx["pixhawk"] = True
    else:
        why = (health or {}).get("link_error") or "no heartbeat yet"
        if ctx.get("reboot"):
            warn(f"Pixhawk not connected yet ({why}) — expected before the reboot.")
        else:
            warn(f"Pixhawk not connected ({why}). Check the TELEM2 wiring, the Pixhawk power and SERIAL2_PROTOCOL=2 / SERIAL2_BAUD=57.")
    _report_camera_water(pi, ctx, wait=True)
    _, out = pi.run("hostname -I 2>/dev/null || true", check=False)
    ips = [ip for ip in out.split() if re.match(r"^\d+\.\d+\.\d+\.\d+$", ip)]
    ctx["lan_ip"] = next((ip for ip in ips if not ip.startswith("100.")), ips[0] if ips else pi.host)


def _api(pi, path, method="GET", timeout=6):
    flag = "-X POST " if method == "POST" else ""
    _, out = pi.run(f"curl -s -m {timeout} {flag}http://127.0.0.1:{HTTP_PORT}{path} || true", check=False, timeout=timeout + 20)
    try:
        return json.loads(out)
    except ValueError:
        return None


def _report_camera_water(pi, ctx, wait=False):
    cam = None
    for _ in range(8 if wait else 1):
        cam = _api(pi, "/api/camera/status")
        if cam and cam.get("camera_connected"):
            break
        if wait:
            time.sleep(2)
    if cam and cam.get("camera_connected"):
        ok(f"Boat camera streaming: {cam.get('resolution')} at {cam.get('measured_fps')} fps ({cam.get('pipeline')})")
    else:
        why = (cam or {}).get("last_error") or (cam or {}).get("status_text") or "no frames yet"
        (warn if not ctx.get("reboot") else say)(f"  Boat camera not streaming yet: {why}" + (" (expected before the reboot)" if ctx.get("reboot") else ""))
    w = _api(pi, "/api/water/status")
    if w and w.get("connected"):
        ok(f"Turbidity sensor: {w.get('ntu')} NTU ({w.get('quality')}), {w.get('volts')} V"
           + ("" if w.get("calibrated") else " — not calibrated yet (menu 11)"))
    elif w:
        warn(f"Turbidity sensor not reading: {w.get('error') or 'no data'}")


# ----------------------------------------------------------------------------- app
def banner():
    if os.name == "nt":
        os.system("title VARUNA Boat Pi Tool")
    say("")
    say("═" * 64, "m")
    say(f"  VARUNA Boat Pi Tool {VERSION}", "b")
    say("  Set up, update and manage the boat's Raspberry Pi over SSH.", "dim")
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
        host, port = parse_host(ask("Boat Pi IP address or hostname (e.g. 192.168.1.50 or raspberrypi.local)"))
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
    """Who/where we are on the Pi, whether sudo needs the password, and whether the boat is installed."""
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
    say("In the VARUNA app:  System → Boat connection → enter", "b")
    say(f"      http://{address}:{HTTP_PORT}", "c")
    if ctx.get("netbird_ip") and ctx.get("lan_ip"):
        say(f"  (on the same Wi-Fi you can also use http://{ctx['lan_ip']}:{HTTP_PORT})", "dim")
    say("then press  Test connection  →  Save & reconnect.")


def action_setup(pi, ctx):
    say("")
    say("How is the Pixhawk connected to the Pi?")
    say("  1) TELEM2 → Pi GPIO serial pins (TX/RX/GND)")
    say("  2) USB cable")
    say("  3) Not sure / find it automatically   [recommended]")
    choice = ask("Choose 1, 2 or 3", "3")
    # Whatever is chosen, the boat backend also tries the other ports and
    # TELEM2 speeds if the Pixhawk doesn't answer there, and saves the one that works.
    ctx["link"] = {"1": {"kind": "uart", "device": "/dev/serial0", "baud": 57600,
                         "label": "TELEM2 → GPIO serial (/dev/serial0, 57600)"},
                   "2": {"kind": "usb", "device": "/dev/ttyACM0", "baud": 115200,
                         "label": "USB (/dev/ttyACM0, 115200)"}}.get(
        choice, {"kind": "auto", "device": "/dev/serial0", "baud": 57600,
                 "label": "find it automatically (USB or TELEM2, any speed)"})
    say("")
    say("NetBird lets the VARUNA app reach the boat from anywhere (optional).", "dim")
    say("Paste a setup key from app.netbird.io → Setup Keys, or press Enter to skip.", "dim")
    ctx["netbird_key"] = ask("NetBird setup key", "", secret=True)
    say("")
    say(f"  Pixhawk:  {ctx['link']['label']}")
    say(f"  NetBird:  {'join with the setup key' if ctx['netbird_key'] else 'skip'}")
    say("  Takes 10–30 minutes on a Pi 3 (mostly downloading libraries).", "dim")
    if not ask_yes("Start the full setup?", True):
        return
    started = time.time()
    run_steps(pi, [
        ("Checking the Pi", lambda: step_preflight(pi, ctx)),
        ("Installing system packages", lambda: step_apt(pi, ctx)),
        ("Copying the boat backend", lambda: step_copy(pi, ctx)),
        ("Installing Python libraries", lambda: step_venv(pi, ctx)),
        ("Writing the Pixhawk link settings", lambda: step_config(pi, ctx)),
        ("Setting up the serial port for the Pixhawk", lambda: step_uart(pi, ctx)),
        ("Setting up the camera and the turbidity sensor", lambda: step_camera_sensor(pi, ctx)),
        ("Installing the boat service", lambda: step_service(pi, ctx)),
        ("Pi Zero tune-up", lambda: step_lite(pi, ctx)),
        ("NetBird", lambda: step_netbird(pi, ctx)),
        ("Checking everything works", lambda: step_verify(pi, ctx)),
        ("Finishing", lambda: step_reboot(pi, ctx)),
    ])
    ctx["installed"] = True
    mins = int((time.time() - started) // 60)
    say("")
    say("═" * 64, "g")
    say(f"  ✔ The boat Pi is ready  ({mins} min)", "g")
    say("═" * 64, "g")
    print_address(ctx)
    if not ctx.get("pixhawk"):
        say("")
        say("Pixhawk not detected yet. The boat keeps searching every USB port and TELEM2 speed;", "y")
        say("menu 3) Status shows what it found on each. On the Pixhawk set FRAME_CLASS=2 (boat)", "y")
        say("and, for TELEM2, SERIAL2_PROTOCOL=2.", "y")


def action_update(pi, ctx):
    if not ctx.get("installed"):
        warn("The boat backend isn't installed on this Pi yet — run 1) Full setup first.")
        return

    def libs():
        _, out = pi.run("uname -m; dpkg --print-architecture 2>/dev/null || true", check=False)
        lines = out.strip().splitlines()
        ctx["arch"] = lines[0].strip() if lines else ctx.get("arch")
        ctx["dpkg_arch"] = lines[1].strip() if len(lines) > 1 else ctx.get("dpkg_arch", "")
        app = shlex.quote(ctx["app"])
        # The USB camera's tools (ffmpeg, v4l-utils), for Pis set up before the boat switched to a USB camera.
        pi.run(f"DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends "
               f"{CAMERA_PACKAGES} >/dev/null", sudo=True, timeout=1800, check=False)
        if is_32bit(ctx):
            pi.run(f"apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends {APT_PACKAGES_32} i2c-tools >/dev/null",
                   sudo=True, timeout=1800, check=False)
            _install_libs_32(pi, ctx, app)
        else:
            pi.run(f"cd {app} && venv/bin/python -m pip install -r requirements.txt --disable-pip-version-check -q",
                   timeout=3600, stream=True)
        _, out = pi.run(f'cd {app} && venv/bin/python -c {shlex.quote(IMPORT_CHECK)}', check=False)
        if "IMPORT_OK" not in out:
            raise InstallError("The backend cannot use its libraries:\n" + out[-600:])
        ok("Libraries up to date")

    run_steps(pi, [
        ("Copying the latest boat backend", lambda: step_copy(pi, ctx)),
        ("Checking the Python libraries", libs),
        ("Camera and turbidity sensor", lambda: step_camera_sensor(pi, ctx)),
        ("Updating and restarting the boat service", lambda: step_service(pi, ctx)),
        ("Pi Zero tune-up", lambda: step_lite(pi, ctx)),
        ("Checking it works", lambda: step_verify(pi, ctx)),
        ("Finishing", lambda: step_reboot(pi, ctx)),
    ])
    say("")
    ok("Boat code updated.")


def action_status(pi, ctx):
    _, active = pi.run(f"systemctl is-active {SERVICE} 2>/dev/null || true", check=False)
    state = (active.strip().splitlines() or ["unknown"])[-1]
    (ok if state == "active" else warn)(f"Boat service: {state}")
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
            ok(f"Pixhawk connected on {h.get('mav_connection')} — GPS fix {h.get('gps_fix')}, {h.get('satellites')} satellites")
        else:
            warn(f"Pixhawk not connected: {h.get('link_error') or 'no heartbeat'}")
    except ValueError:
        warn(f"Backend not answering on port {HTTP_PORT}.")
    _report_camera_water(pi, ctx)
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
    say("  Showing the boat service log live — press Ctrl+C to go back to the menu.", "dim")
    try:
        pi.run(f"journalctl -u {SERVICE} -f -n 30 -o cat", sudo=True, stream=True, check=False, timeout=24 * 3600)
    except KeyboardInterrupt:
        say("")
    finally:
        pi.close()  # also stops the still-running journalctl on the Pi


def action_restart(pi, ctx):
    pi.run(f"systemctl restart {SERVICE}", sudo=True, timeout=120)
    ok("Boat service restarted")
    step_verify(pi, ctx)


def action_shell(pi, ctx):
    ssh = shutil.which("ssh") or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "OpenSSH", "ssh.exe")
    if not os.path.exists(ssh):
        warn("Windows' SSH client isn't installed (Settings → Apps → Optional features → OpenSSH Client).")
        return
    say("  Opening a terminal on the Pi. Type your password when asked; type  exit  to come back here.", "dim")
    say(f"  The boat code is in  {ctx['app']}  (restart it with: sudo systemctl restart {SERVICE})", "dim")
    say("")
    subprocess.call([ssh, "-p", str(pi.port), "-o", "ServerAliveInterval=30", f"{pi.user}@{pi.host}"])
    say("")
    ok("Back from the Pi terminal")


def action_autostart(pi, ctx):
    """Check that the backend starts on every boot, and repair it if not."""
    if not ctx.get("installed"):
        warn("The boat backend isn't installed on this Pi yet — run 1) Full setup first.")
        return
    step_service(pi, ctx)
    step_verify(pi, ctx)
    if ask_yes("  Reboot the Pi now to prove it comes back up by itself?", False):
        _reboot_and_wait(pi, ctx)


def action_reboot(pi, ctx):
    if not ask_yes("  Reboot the boat Pi now?", False):
        return
    _reboot_and_wait(pi, ctx)


def step_reboot(pi, ctx):
    if not ctx.get("reboot"):
        return
    if not ask_yes("  The serial port / camera / I2C changes need a reboot of the Pi. Reboot now?", True):
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
        warn("The Pi did not come back within 3 minutes. Check it later — the boat service starts by itself.")
        return
    ctx["reboot"] = False
    ok("Pi is back up")
    if ctx.get("installed"):
        step_verify(pi, ctx, "Checking the boat after the reboot")


def action_camera_test(pi, ctx):
    """Take a picture with the boat camera and open it on this PC."""
    if not ctx.get("installed"):
        warn("The boat backend isn't installed on this Pi yet — run 1) Full setup first.")
        return
    cam = _api(pi, "/api/camera/status")
    if cam is None:
        raise InstallError("The boat backend is not answering — try 5) Restart the boat service.")
    if not cam.get("camera_connected"):
        raise InstallError(f"The camera is not streaming: {cam.get('last_error') or cam.get('status_text')}")
    _, b64 = pi.run(f"curl -s -m 8 http://127.0.0.1:{HTTP_PORT}/api/camera/snapshot | base64 -w0", check=False, timeout=60)
    import base64
    try:
        jpeg = base64.b64decode(b64.strip().splitlines()[-1])
    except (ValueError, IndexError):
        jpeg = b""
    if jpeg[:2] != b"\xff\xd8":
        raise InstallError("Could not get a picture from the camera.")
    folder = Path(os.environ.get("USERPROFILE") or Path.home()) / "Pictures"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"varuna-boat-camera-{datetime.now():%Y%m%d-%H%M%S}.jpg"
    path.write_bytes(jpeg)
    ok(f"Camera: {cam.get('resolution')} at {cam.get('measured_fps')} fps ({cam.get('pipeline')})")
    ok(f"Picture saved: {path}")
    say("  Check the ramp fills the bottom of the picture and the horizon sits near the top "
        "(tilt about 15° down). Fine-tune in the app: Boat Vision → Settings.", "dim")
    try:
        os.startfile(str(path))   # opens it in the Photos app
    except (AttributeError, OSError):
        pass


def action_turbidity(pi, ctx):
    """Live turbidity readings and the ADC on I2C."""
    _, out = pi.run("if [ -e /dev/i2c-1 ]; then i2cdetect -y 1 2>/dev/null; else echo I2C_OFF; fi", sudo=True, check=False)
    if "I2C_OFF" in out:
        warn("I2C is off — run 1) Full setup (or raspi-config → Interface Options → I2C) and reboot.")
    elif " 48" in out:
        ok("ADS1115 found at 0x48 on I2C bus 1")
    else:
        warn("No ADS1115 at 0x48 on I2C bus 1 — check the wiring (VDD 3.3 V, GND, SDA pin 3, SCL pin 5).")
    say("  Five readings, one per second (put the probe in the water):")
    for _ in range(5):
        w = _api(pi, "/api/water/status")
        if not w:
            warn("The boat backend is not answering.")
            return
        if w.get("connected"):
            say(f"    {w.get('ntu'):>7} NTU   {w.get('volts')} V   {w.get('quality')}", "c")
        else:
            say(f"    not reading: {w.get('error')}", "y")
        time.sleep(1)
    w = _api(pi, "/api/water/status") or {}
    say("  " + (f"Calibrated in clear water at {w.get('clear_volts')} V." if w.get("calibrated")
                else "Not calibrated: use 11) with the probe in clear water."), "dim")


def action_calibrate(pi, ctx):
    say("Put the turbidity probe in clean, clear water (bottled water works) and wait 10 seconds.")
    if not ask_yes("Is the probe in clear water now?", True):
        return
    w = _api(pi, "/api/water/status")
    if not w or not w.get("connected"):
        raise InstallError(f"The sensor isn't reading: {(w or {}).get('error') or 'no answer from the backend'}")
    _, out = pi.run(f"curl -s -m 8 -X POST -H 'Content-Type: application/json' -d '{{\"action\":\"clear\"}}' "
                    f"http://127.0.0.1:{HTTP_PORT}/api/water/calibrate || true", check=False)
    try:
        res = json.loads(out)
    except ValueError:
        res = {}
    (ok if res.get("success") else warn)(res.get("message") or "No answer from the backend.")


def action_find_pixhawk(pi, ctx):
    """The boat searches every USB port and TELEM2 speed by itself; show what it found."""
    h = _api(pi, "/api/health")
    if not h:
        raise InstallError("The boat backend is not answering — try 5) Restart the boat service.")
    if h.get("pixhawk_connected"):
        ok(f"Pixhawk connected on {h.get('mav_connection')} at {h.get('mav_baud')} baud")
        return
    warn("Pixhawk not connected. What the boat tried:")
    for part in (h.get("link_error") or "nothing yet").split("; "):
        say(f"    {part}", "y")
    _, mm = pi.run("systemctl is-active ModemManager 2>/dev/null || true", check=False)
    if mm.strip().endswith("active") and "inactive" not in mm:
        if ask_yes("  ModemManager is running and can block a USB Pixhawk. Switch it off?", True):
            pi.run("systemctl disable --now ModemManager", sudo=True, check=False)
            ok("ModemManager switched off")


MENU = [
    ("1", "Full setup (first time — installs everything)", action_setup),
    ("2", "Update the boat code on the Pi", action_update),
    ("3", "Status (service, Pixhawk, NetBird, recent log)", action_status),
    ("4", "Live log", action_live_log),
    ("5", "Restart the boat service", action_restart),
    ("6", "Open an SSH terminal on the Pi", action_shell),
    ("7", "Reboot the Pi", action_reboot),
    ("8", "Auto-start on boot: check & fix", action_autostart),
    ("9", "Camera test: take a picture and open it here", action_camera_test),
    ("10", "Turbidity sensor check (live readings)", action_turbidity),
    ("11", "Calibrate the turbidity sensor in clear water", action_calibrate),
    ("12", "Find the Pixhawk (what the boat tried)", action_find_pixhawk),
    ("0", "Exit", None),
]


def run_app():
    banner()
    pi, ctx = open_session()
    while True:
        say("")
        say(f"── {pi.user}@{pi.host}  ·  boat backend {'installed' if ctx.get('installed') else 'not installed yet'} ──", "m")
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
    if "--self-test" in sys.argv:  # build check: is the boat backend bundled and complete?
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
