#!/bin/bash
# VARUNA boat: make the Pi's Wi-Fi come up every time and stay up. Run as root,
# once (the Boat Pi Tool does it on setup and update):  sudo bash setup_wifi.sh
#
#  1. Realtek USB adapters (RTL8188GU and friends, 0bda:1a2b) start as a fake
#     "DISK" holding their Windows driver and must be switched to Wi-Fi mode.
#     The stock switch runs through a slow systemd service; on a Pi Zero the
#     adapter resets every ~2 s before it gets there, so the switch can take
#     minutes or never happen. A udev rule switches it at once instead.
#  2. NetworkManager: keep retrying every saved network forever (by default it
#     gives up after 4 failed tries) and keep the radio awake (power saving off).
#  3. A watchdog every minute: no Wi-Fi adapter → switch it again; Wi-Fi down
#     for 3 min → restart the radio; down for 6 min → reset the adapter.
set -e
export PATH="$PATH:/usr/sbin:/sbin"

cat > /etc/udev/rules.d/39-varuna-wifi-modeswitch.rules <<'EOF'
# VARUNA: switch Realtek USB Wi-Fi adapters out of their "DISK" mode at once.
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0bda", ATTR{idProduct}=="1a2b", RUN+="/usr/sbin/usb_modeswitch -v 0bda -p 1a2b -K"
EOF
udevadm control --reload-rules

if [ -d /etc/NetworkManager/conf.d ]; then
  cat > /etc/NetworkManager/conf.d/varuna-wifi.conf <<'EOF'
# VARUNA: every Wi-Fi network, now and later.
[connection]
# 2 = power saving off: the radio doesn't doze between packets.
wifi.powersave=2
# 0 = never stop retrying a saved network.
connection.autoconnect-retries=0
EOF
  # Older profiles may carry their own retry count: clear it.
  nmcli -t -f UUID,TYPE connection show | awk -F: '$2=="802-11-wireless"{print $1}' | while read -r u; do
    nmcli connection modify "$u" connection.autoconnect-retries -1 connection.autoconnect yes || true
  done
  nmcli general reload conf 2>/dev/null || true
fi

cat > /usr/local/sbin/varuna-wifi-watchdog <<'EOF'
#!/bin/bash
# VARUNA: keep the boat's Wi-Fi up (run every minute by varuna-wifi-watchdog.timer).
export PATH="$PATH:/usr/sbin:/sbin"
STATE=/run/varuna-wifi-watchdog
dev=$(for d in /sys/class/net/*/wireless; do [ -e "$d" ] && basename "$(dirname "$d")"; done | head -1)
if [ -z "$dev" ]; then
  # No Wi-Fi adapter: still in "DISK" mode? Switch it.
  if grep -qs '^1a2b$' /sys/bus/usb/devices/*/idProduct; then
    logger -t varuna-wifi "Wi-Fi adapter still in DISK mode: switching it"
    usb_modeswitch -v 0bda -p 1a2b -K >/dev/null 2>&1
  fi
  exit 0
fi
if [ "$(nmcli -t -f DEVICE,STATE device | awk -F: -v d="$dev" '$1==d{print $2}')" = "connected" ]; then
  echo 0 > "$STATE"
  exit 0
fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
if [ "$n" -eq 3 ]; then
  logger -t varuna-wifi "Wi-Fi down for 3 min: restarting the radio"
  nmcli radio wifi off; sleep 3; nmcli radio wifi on
elif [ "$n" -ge 6 ] && [ $(( n % 6 )) -eq 0 ]; then
  # Reset the adapter: unplug / replug it in software.
  port=$(basename "$(readlink -f "/sys/class/net/$dev/device/..")")
  logger -t varuna-wifi "Wi-Fi down for $n min: resetting the adapter on USB $port"
  if [ -e "/sys/bus/usb/devices/$port/authorized" ]; then
    echo 0 > "/sys/bus/usb/devices/$port/authorized"; sleep 3; echo 1 > "/sys/bus/usb/devices/$port/authorized"
  fi
fi
EOF
chmod 755 /usr/local/sbin/varuna-wifi-watchdog

cat > /etc/systemd/system/varuna-wifi-watchdog.service <<'EOF'
[Unit]
Description=VARUNA: keep the boat's Wi-Fi up

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/varuna-wifi-watchdog
EOF
cat > /etc/systemd/system/varuna-wifi-watchdog.timer <<'EOF'
[Unit]
Description=VARUNA: check the boat's Wi-Fi every minute

[Timer]
OnBootSec=90
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now varuna-wifi-watchdog.timer >/dev/null 2>&1

echo "OK udev-switch nm-retry-forever powersave-off watchdog"
