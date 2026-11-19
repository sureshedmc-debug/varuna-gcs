@echo off
rem VARUNA boat backend on THIS laptop. The boat carries a phone running the
rem VARUNA Boat Link app (boat-phone/):
rem   Pixhawk --USB OTG--> phone --NetBird (or Wi-Fi)--> TCP 5760 --> this program
rem
rem NetBird: join BOTH this laptop and the boat's phone to your NetBird network
rem (the phone needs the NetBird app, signed in, Connected). Then they reach each
rem other anywhere, over mobile data - no shared Wi-Fi and no hotspot needed.
rem This program asks every NetBird peer by itself; to pin one address, put it in
rem the file boat-pi/boat_phone_ip.txt, or set VARUNA_BOAT_PHONE.
rem   phone GPS --> Pixhawk (GPS_INPUT)      phone camera --> port 8080 --> this program
rem The app finds the boat at http://localhost:8001 (desktop app: Settings > boat address).
rem Driving: FS-i6 transmitter into the Pixhawk (CH3 throttle, CH4 rudder, SwD MANUAL/ACRO,
rem SwA scoop). Missions, go-to points, live collect from the drone's finds, camera
rem homing and the smooth scoop all run here.
rem
rem It finds the phone by itself, restarts the boat program if it crashes or
rem hangs, finds the phone again if its address changes, and keeps the laptop
rem awake while open. To give the phone's address instead:
rem   start_boat.bat 192.168.137.50:5760
setlocal
title VARUNA boat (keep this window open)
cd /d "%~dp0"
echo VARUNA boat - keep this window open while using the boat.
echo  - laptop Mobile hotspot ON, the boat phone joined to it
echo  - VARUNA Boat Link open on the phone, Pixhawk plugged into the phone (OTG)
echo  (close this window to stop)
echo.
py find_boat.py --run %1
echo.
echo The boat link stopped. Press any key to close.
pause >nul
