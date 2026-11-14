#!/data/data/com.termux/files/usr/bin/bash
# VARUNA phone relay: keeps the phone awake and passes the drone telemetry to the laptop.
# ESP32 plugged into the phone's USB-C port: USB mode (needs "pkg install termux-api").
# Otherwise: looks for the ESP32 (DroneBridge) on the phone's hotspot.
termux-wake-lock
cd ~ || exit 1

DEV=""
if command -v termux-usb >/dev/null 2>&1; then
  DEV=$(timeout 15 termux-usb -l 2>/dev/null | tr -d '[]" \r\n' | cut -d, -f1)
fi

if [ -n "$DEV" ]; then
  echo "ESP32 on USB ($DEV). If Android asks, allow Termux to use the USB device."
  exec termux-usb -r -e "python $HOME/relay.py $* --usb-fd" "$DEV"
fi

if ! command -v termux-usb >/dev/null 2>&1; then
  echo "(For an ESP32 on USB, first run: pkg install termux-api)"
fi
echo "No USB device: looking for the ESP32 on the hotspot."
exec python relay.py "$@"
