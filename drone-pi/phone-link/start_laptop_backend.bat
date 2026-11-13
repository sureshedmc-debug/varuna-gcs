@echo off
rem VARUNA drone backend on this laptop, with the phone on the drone.
rem   Telemetry: Pixhawk -> ESP32 -> phone (relay.py) -> NetBird -> here
rem   Video:     phone IP Webcam -> NetBird -> here
rem Then the VARUNA app connects to http://localhost:8000 as it did to the Pi.
rem
rem   start_laptop_backend.bat              (asks for the phone's NetBird IP the first time)
rem   start_laptop_backend.bat 100.99.1.2   (use and remember this IP)
setlocal
cd /d "%~dp0"
set "PHONE=%~1"
if "%PHONE%"=="" if exist phone_ip.txt set /p PHONE=<phone_ip.txt
if "%PHONE%"=="" set /p "PHONE=Phone's NetBird IP (shown in the NetBird app on the phone, 100.x.x.x): "
if "%PHONE%"=="" (
  echo No phone IP given.
  exit /b 1
)
> phone_ip.txt echo %PHONE%

set "PY=py"
where py >nul 2>nul || set "PY=python"
%PY% -c "import fastapi, uvicorn, pymavlink, serial, psutil" 2>nul || (
  echo Installing the backend's Python packages...
  %PY% -m pip install -r ..\requirements.txt || exit /b 1
)

echo.
echo Phone: %PHONE%  ^|  telemetry udpout:%PHONE%:14551  ^|  video http://%PHONE%:8080/video
echo App:   http://localhost:8000   (Ctrl+C to stop)
echo.
cd ..
%PY% main.py --connection udpout:%PHONE%:14551 --camera-url http://%PHONE%:8080/video
