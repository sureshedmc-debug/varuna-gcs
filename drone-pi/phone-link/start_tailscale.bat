@echo off
rem VARUNA drone backend over Tailscale, with the phone on the drone.
rem
rem   1. Tailscale ON on this laptop and on the drone phone (same account).
rem      In the Tailscale admin console name the phone "varuna-drone-cam".
rem   2. On the phone: open VARUNA Cam and tap Start streaming.
rem   3. Run this. It finds the phone by its Tailscale name, writes its address to
rem      phone_ip.txt, then starts the backend pointed at it.
rem
rem If the name isn't found it also listens for the phone announcing itself
rem (set this laptop's Tailscale name/address in VARUNA Cam as a backup).
rem The phone and laptop do NOT need the same Wi-Fi: both just need Tailscale on.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PY=py"
where py >nul 2>nul || set "PY=python"
set "IPFILE=%~dp0phone_ip.txt"
set "PHONES="

echo Looking for the drone phone on Tailscale (varuna-drone-cam)...
for /f "usebackq delims=" %%a in (`"%PY%" "%~dp0find_phone_tailscale.py" "%IPFILE%"`) do set "PHONES=%%a"
if not "%PHONES%"=="" goto :got

echo Not found by name. Starting the Tailscale listener (hears the phone announce itself)...
start "VARUNA Tailscale link" %PY% "%~dp0tailnet_link.py" "%IPFILE%"
echo.
echo Waiting for the phone...
echo   (Tailscale ON on the phone, VARUNA Cam open and streaming)
for /l %%i in (1,1,60) do (
  if exist "%IPFILE%" (
    for /f "usebackq tokens=1" %%a in ("%IPFILE%") do set "PHONES=%%a"
  )
  if not "!PHONES!"=="" goto :got
  timeout /t 1 >nul
)

if "%PHONES%"=="" (
  echo.
  echo No phone yet. Check Tailscale shows the phone Connected, then run this again,
  echo or start the backend by hand once the phone is streaming:
  echo     start_laptop_backend.bat 100.x.x.x
  pause
  exit /b 1
)

:got
echo.
echo Drone phone at %PHONES%. Starting the VARUNA backend...
echo.
call "%~dp0start_laptop_backend.bat" %PHONES%
