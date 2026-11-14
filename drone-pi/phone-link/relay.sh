#!/data/data/com.termux/files/usr/bin/bash
# VARUNA phone relay: keeps the phone awake and passes the drone telemetry to the laptop.
termux-wake-lock
cd ~ && exec python relay.py "$@"
