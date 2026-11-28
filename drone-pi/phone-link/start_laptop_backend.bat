@echo off
rem VARUNA drone backend on this laptop, with the phone on the drone.
rem   Telemetry: Pixhawk -> ESP32 -> phone (relay.py) -> Tailscale / Wi-Fi -> here
rem   Video:     phone VARUNA Cam app -> Tailscale / Wi-Fi -> here
rem Tailscale (normal): Tailscale ON on this laptop and the phone, and the phone
rem named "varuna-drone-cam" in the admin console - found by itself, anywhere.
rem Wi-Fi: the phone and this laptop on the same Wi-Fi (or the phone's hotspot).
rem Then the VARUNA app connects to http://localhost:8000 as it did to the Pi.
rem
rem   start_laptop_backend.bat              (finds the phone on Tailscale, then Wi-Fi, then asks)
rem   start_laptop_backend.bat 192.168.1.3  (use and remember this IP)
rem   start_laptop_backend.bat 192.168.1.23 192.168.1.40
rem                                         (several drone phones: whichever runs VARUNA Cam is used)
setlocal
cd /d "%~dp0"
set "PHONES=%*"
set "FPY=py"
where py >nul 2>nul || set "FPY=python"
rem No IP given? Ask Tailscale for the phone by name, then ask out loud on this Wi-Fi.
if "%PHONES%"=="" (
  echo Looking for the drone phone on Tailscale ^(varuna-drone-cam^)...
  for /f "usebackq delims=" %%a in (`"%FPY%" "%~dp0find_phone_tailscale.py" "%~dp0phone_ip.txt"`) do set "PHONES=%%a"
)
if "%PHONES%"=="" (
  echo Looking for the drone phone on this Wi-Fi ^(VARUNA Cam must be open^)...
  for /f "usebackq delims=" %%a in (`"%FPY%" "%~dp0find_phone_wifi.py" "%~dp0phone_ip.txt"`) do set "PHONES=%%a"
)
if "%PHONES%"=="" if exist phone_ip.txt set /p PHONES=<phone_ip.txt
if "%PHONES%"=="" set /p "PHONES=Phone's IP (shown in the VARUNA Cam app, e.g. 100.x.x.x or 192.168.1.3): "
if "%PHONES%"=="" (
  echo No phone IP given.
  exit /b 1
)
> phone_ip.txt echo %PHONES%
for /f "tokens=1" %%a in ("%PHONES%") do set "PHONE=%%a"
set "VARUNA_PHONE_IPS=%PHONES%"
rem The backend finds VARUNA Cam by itself (it answers a broadcast) and saves its new address here.
set "VARUNA_PHONE_IP_FILE=%~dp0phone_ip.txt"

set "PY=py"
where py >nul 2>nul || set "PY=python"
%PY% -c "import fastapi, uvicorn, pymavlink, serial, psutil" 2>nul || (
  echo Installing the backend's Python packages...
  %PY% -m pip install -r ..\requirements.txt || exit /b 1
)
rem Video stabilisation (stabilize.py) needs OpenCV and ffmpeg on this computer.
%PY% -c "import cv2, numpy" 2>nul || (
  echo Installing OpenCV for video stabilisation...
  %PY% -m pip install opencv-python-headless numpy || echo Without OpenCV the video is not stabilised.
)
where ffmpeg >nul 2>nul || echo ffmpeg is missing: install it ^(winget install Gyan.FFmpeg^) for H.264 video and stabilisation.

echo.
echo Phones: %PHONES%  ^(starts with %PHONE%, moves to whichever runs VARUNA Cam^)
echo Phone: %PHONE%  ^|  video http://%PHONE%:8080/video  ^|  GPS http://%PHONE%:8080/location/stream  ^|  telemetry udpout:%PHONE%:14551 ^(if the ESP32 relay runs^)
echo App:   http://localhost:8000   (Ctrl+C to stop)
echo.
cd ..
%PY% main.py --connection udpout:%PHONE%:14551 --camera-url http://%PHONE%:8080/video
