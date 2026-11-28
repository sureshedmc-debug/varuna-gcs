@echo off
rem ===========================================================================
rem  VARUNA - deploy the drone backend to the Raspberry Pi 3B+
rem
rem   1. finds the Pi: Tailscale (varuna-drone) first, then the Wi-Fi/LAN
rem      (varuna-drone.local, varuna-pi.local, raspberrypi.local), else asks
rem   2. checks /home/pi/varuna-drone exists on the Pi (never creates folders)
rem   3. copies the backend files INTO that folder with scp, overwriting them
rem   4. installs varuna-drone.service, restarts it, shows its status
rem   5. checks the link: Tailscale direct (not relayed) + the UDP video (5000)
rem      and GPS (5001) really arriving here (ground_station.py --check)
rem
rem  Usage:  deploy_pi.bat              (find the Pi by itself)
rem          deploy_pi.bat 192.168.1.50 (this address)
rem  SSH asks for the Pi's password at each step (or set up a key once:
rem  ssh-keygen, then copy %USERPROFILE%\.ssh\id_ed25519.pub into the Pi's
rem  ~/.ssh/authorized_keys). sudo asks for it once in step 4.
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
title VARUNA - deploy drone Pi
cd /d "%~dp0"

set "PI_USER=pi"
set "PI_DIR=/home/pi/varuna-drone"
set "PI_NAME=varuna-drone"
set "SSH_OPTS=-o ConnectTimeout=6"
set "PI_HOST=%~1"
set "VIA=address given"

rem The backend's files (all in this folder; none in sub-folders).
set "FILES=main.py camera.py mav_link.py config.py mission.py control.py fence.py phone_gps.py stabilize.py system_info.py tailscale.py requirements.txt varuna-drone.service"

where ssh >nul 2>nul || (echo ssh not found. Windows: Settings ^> Apps ^> Optional features ^> OpenSSH Client. & goto :fail)

set "TS="
where tailscale >nul 2>nul && set "TS=tailscale"
if not defined TS if exist "%ProgramFiles%\Tailscale\tailscale.exe" set "TS=%ProgramFiles%\Tailscale\tailscale.exe"

rem ---------------------------------------------------------------- 1. find the Pi
echo.
echo [1/5] Finding the drone Pi...
if defined PI_HOST goto :check_ssh

if defined TS (
  for /f "usebackq delims=" %%i in (`call "%TS%" ip -4 %PI_NAME% 2^>nul`) do if not defined PI_HOST set "PI_HOST=%%i"
)
if defined PI_HOST (
  call :port22 !PI_HOST!
  if !errorlevel! equ 0 ( set "VIA=Tailscale (%PI_NAME%)" & goto :check_ssh )
  echo       Tailscale knows %PI_NAME% ^(!PI_HOST!^) but SSH does not answer there.
  set "PI_HOST="
)
for %%n in (%PI_NAME%.local varuna-pi.local raspberrypi.local) do (
  if not defined PI_HOST (
    call :port22 %%n
    if !errorlevel! equ 0 ( set "PI_HOST=%%n" & set "VIA=Wi-Fi/LAN (%%n)" )
  )
)
if not defined PI_HOST (
  echo       Not found on Tailscale or the local network.
  set /p "PI_HOST=      Type the Pi's IP address: "
)
if not defined PI_HOST goto :fail

:check_ssh
echo       Pi: %PI_HOST%   via %VIA%

rem ---------------------------------------------------------------- 2. folder exists?
echo.
echo [2/5] Checking %PI_DIR% on the Pi (nothing is created)...
ssh %SSH_OPTS% %PI_USER%@%PI_HOST% "test -d %PI_DIR% && chmod u+w %PI_DIR%/*.py %PI_DIR%/*.txt %PI_DIR%/*.service 2>/dev/null; test -d %PI_DIR%"
if errorlevel 1 (
  echo       %PI_DIR% is not on the Pi, or SSH failed. Set the Pi up first ^(drone installer^).
  goto :fail
)

rem ---------------------------------------------------------------- 3. copy in place
echo.
echo [3/5] Copying the backend into %PI_DIR% ...
set "SEND="
for %%f in (%FILES%) do if exist "%%f" set "SEND=!SEND! %%f"
echo      !SEND!
scp %SSH_OPTS% !SEND! %PI_USER%@%PI_HOST%:%PI_DIR%/
if errorlevel 1 ( echo       scp failed. & goto :fail )

rem ---------------------------------------------------------------- 4. service
echo.
echo [4/5] Installing and restarting varuna-drone.service (sudo asks for the Pi's password)...
rem (sed: a Windows checkout may have given the unit CRLF line ends, which systemd can't read)
ssh -t %SSH_OPTS% %PI_USER%@%PI_HOST% "sed -i 's/\r$//' %PI_DIR%/varuna-drone.service && sudo install -m 644 %PI_DIR%/varuna-drone.service /etc/systemd/system/varuna-drone.service && sudo systemctl daemon-reload && sudo systemctl enable varuna-drone >/dev/null 2>&1; sudo systemctl restart varuna-drone && sleep 4 && systemctl --no-pager --lines=12 status varuna-drone; command -v gst-launch-1.0 >/dev/null || echo 'NOTE: GStreamer is not installed, so the USB webcam uses ffmpeg h264_v4l2m2m (same hardware encoder). For v4l2h264enc: sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad'"
if errorlevel 1 ( echo       The service did not restart cleanly - see above. & goto :fail )

rem ---------------------------------------------------------------- 5. verify links
echo.
echo [5/5] Checking the link...
if defined TS (
  echo       Tailscale path to %PI_NAME%. Direct = "via IP:port", relayed = "via DERP" - slower, check the Wi-Fi/NAT:
  call "%TS%" ping -c 5 %PI_NAME%
)
where py >nul 2>nul
if errorlevel 1 (
  echo       Python launcher py not found: skipped the UDP check.
) else (
  echo       UDP video 5000 + GPS 5001 from the Pi:
  py -3 "%~dp0ground_station.py" --pi %PI_HOST% --check 10
  if errorlevel 1 echo       Not everything arrived - see above. Video needs the camera; GPS needs a Pixhawk fix.
)

echo.
echo Done. Start detection:  py -3 "%~dp0ground_station.py" --pi %PI_HOST% --show
pause
exit /b 0

:port22
rem errorlevel 0 if TCP 22 on %1 answers within 2 s
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try { if ($c.ConnectAsync('%~1',22).Wait(2000)) { exit 0 } else { exit 1 } } catch { exit 1 } finally { $c.Close() }" >nul 2>nul
exit /b %errorlevel%

:fail
echo.
echo Deploy did not finish.
pause
exit /b 1
