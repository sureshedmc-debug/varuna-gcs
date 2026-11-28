#!/bin/sh
# VARUNA - one-time code update from the SD card's boot partition.
#
# update_sd_card.ps1 (on the laptop) puts the backend files in
# <boot>/varuna-update/files/ and adds systemd.run=<this script> to
# cmdline.txt. On the next power-on the Pi runs this ONCE, early in boot,
# as root, then reboots normally:
#   1. puts cmdline.txt back first (so it can never loop)
#   2. copies the files INTO /home/pi/varuna-drone (never creates folders)
#   3. installs + enables varuna-drone.service
#   4. checks the venv, imports and tools, writes update.log next to itself
# The laptop reads update.log when the card comes back (-Result).

BOOT=/boot/firmware
[ -f "$BOOT/cmdline.txt" ] || BOOT=/boot
UPD="$BOOT/varuna-update"
LOG="$UPD/update.log"
APP=/home/pi/varuna-drone
SVC=varuna-drone.service

exec >"$LOG" 2>&1
echo "VARUNA SD update - $(date)  boot=$BOOT"

# 1. never run twice: restore the original kernel command line first
if [ -f "$BOOT/cmdline.txt.before-varuna-update" ]; then
  cp "$BOOT/cmdline.txt.before-varuna-update" "$BOOT/cmdline.txt"
else
  sed -i -e 's| systemd\.run[_a-z]*=[^ ]*||g' -e 's| systemd\.unit=kernel-command-line\.target||g' "$BOOT/cmdline.txt"
fi
sync
echo "cmdline.txt restored: $(cat "$BOOT/cmdline.txt")"

if [ ! -d "$APP" ]; then
  echo "RESULT: FAIL - $APP is not on this card (run the drone installer first). Nothing copied."
  sync; exit 0
fi
OWNER=$(stat -c %U:%G "$APP")

# 2. copy in place (CR stripped: the laptop checkout may have CRLF)
n=0
for f in "$UPD"/files/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  if [ -e "$APP/$name" ]; then chmod u+w "$APP/$name"; fi
  sed 's/\r$//' "$f" > "$APP/$name.new" && mv -f "$APP/$name.new" "$APP/$name"
  chown "$OWNER" "$APP/$name"
  echo "copied $name ($(wc -c < "$APP/$name") bytes)"
  n=$((n + 1))
done
echo "$n files copied into $APP (owner $OWNER)"

# 3. the service: restart within 1 s, start on boot
if [ -f "$APP/$SVC" ]; then
  install -m 644 "$APP/$SVC" "/etc/systemd/system/$SVC"
  mkdir -p /etc/systemd/system/multi-user.target.wants 2>/dev/null
  ln -sf "/etc/systemd/system/$SVC" "/etc/systemd/system/multi-user.target.wants/$SVC"
  echo "service installed and enabled"
fi

# 4. checks
OK=1
PY="$APP/venv/bin/python"
if [ -x "$PY" ]; then
  echo "venv: $($PY --version 2>&1)"
  if (cd "$APP" && $PY -m py_compile *.py); then echo "python files compile: ok"; else echo "python files compile: FAIL"; OK=0; fi
  if $PY -c "import fastapi, uvicorn, pymavlink, serial, psutil" 2>/dev/null; then
    echo "packages fastapi/uvicorn/pymavlink/pyserial/psutil: ok"
  else
    echo "packages: MISSING - on the Pi run: cd $APP && venv/bin/pip install -r requirements.txt"; OK=0
  fi
else
  echo "venv: MISSING ($PY) - run the drone installer's setup step"; OK=0
fi
command -v ffmpeg >/dev/null && echo "ffmpeg: ok" || { echo "ffmpeg: MISSING (sudo apt install -y ffmpeg)"; OK=0; }
command -v gst-launch-1.0 >/dev/null && echo "gstreamer: ok (v4l2h264enc path)" || echo "gstreamer: not installed (ffmpeg h264_v4l2m2m is used instead)"
command -v tailscale >/dev/null && echo "tailscale: installed" || echo "tailscale: NOT installed (curl -fsSL https://tailscale.com/install.sh | sh)"
grep -q '^enable_uart=1' "$BOOT/config.txt" && echo "UART (TELEM2): enabled" || echo "UART: enable_uart=1 missing in config.txt"
ls /dev/video* 2>/dev/null | head -3

if [ $OK = 1 ]; then echo "RESULT: OK - rebooting into the updated backend"; else echo "RESULT: COPIED, but see the lines above"; fi
sync
exit 0
