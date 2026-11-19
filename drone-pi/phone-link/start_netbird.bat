@echo off
rem VARUNA drone backend over NetBird, with the phone on the drone.
rem
rem   1. On the phone: open VARUNA Cam (2.6+), type THIS laptop's NetBird address
rem      (100.x) in "Laptop NetBird address", tap Save, tap Start streaming.
rem   2. Run this. It listens for the phone announcing itself over NetBird, writes
rem      its address to phone_ip.txt, then starts the backend pointed at it.
rem
rem The phone and laptop do NOT need the same Wi-Fi: both just need NetBird on.
setlocal
cd /d "%~dp0"

set "PY=py"
where py >nul 2>nul || set "PY=python"
set "IPFILE=%~dp0phone_ip.txt"

echo Starting the NetBird listener (hears the drone phone)...
start "VARUNA NetBird link" %PY% "%~dp0netbird_link.py" "%IPFILE%"

echo.
echo Waiting for the phone to announce itself over NetBird...
echo   (open VARUNA Cam on the phone, set this laptop's NetBird address, tap Start)
set "PHONE="
for /l %%i in (1,1,60) do (
  if exist "%IPFILE%" (
    for /f "tokens=1" %%a in (%IPFILE%) do set "PHONE=%%a"
  )
  if not "%PHONE%"=="" goto :got
  timeout /t 1 >nul
)

:got
if "%PHONE%"=="" (
  echo.
  echo No announce yet. You can start the backend by hand once the phone is streaming:
  echo     start_laptop_backend.bat
  echo (the listener window keeps running; it will fill phone_ip.txt when it hears the phone^)
  pause
  exit /b 1
)

echo.
echo Drone phone at %PHONE%. Starting the VARUNA backend...
echo.
call "%~dp0start_laptop_backend.bat" %PHONE%
