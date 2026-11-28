@echo off
rem VARUNA - start the boat AND the drone on this laptop with one double-click.
rem
rem   Boat : boat-pi\start_boat.bat              (VARUNA Boat Link phone, Tailscale or Wi-Fi) -> app port 8001
rem   Drone: drone-pi\phone-link\start_laptop_backend.bat (VARUNA Cam phone, Tailscale or Wi-Fi) -> app port 8000
rem
rem Each opens in its own window - keep both open while you work; close a
rem window to stop that one. A part that is already running is left alone.
rem
rem   START_VARUNA.bat          both
rem   START_VARUNA.bat boat     only the boat
rem   START_VARUNA.bat drone    only the drone
setlocal
cd /d "%~dp0"
set "WHAT=%~1"
if "%WHAT%"=="" set "WHAT=both"

echo ============================================
echo   VARUNA - starting %WHAT%
echo ============================================
echo  Before you start:
echo   Tailscale  : Connected on this laptop and on both phones
echo   Boat phone : VARUNA Boat Link open, boat brain on USB  (Tailscale name varuna-boat)
echo   Drone phone: VARUNA Cam open                           (Tailscale name varuna-drone-cam)
echo.

if /i "%WHAT%"=="drone" goto drone

:boat
netstat -ano | findstr /r /c:":8001 .*LISTENING" >nul
if not errorlevel 1 (
  echo [boat]  already running on port 8001 - not starting a second one.
) else (
  echo [boat]  starting in a new window...
  start "VARUNA boat" /d "%~dp0boat-pi" cmd /k start_boat.bat
)
if /i "%WHAT%"=="boat" goto done

:drone
netstat -ano | findstr /r /c:":8000 .*LISTENING" >nul
if not errorlevel 1 (
  echo [drone] already running on port 8000 - not starting a second one.
) else (
  echo [drone] starting in a new window...
  start "VARUNA drone" /d "%~dp0drone-pi\phone-link" cmd /k start_laptop_backend.bat
)

:done
echo.
echo Done. Open the VARUNA app: the Boat tab uses port 8001, the Live tab port 8000.
echo This window closes in 10 seconds.
timeout /t 10 >nul
