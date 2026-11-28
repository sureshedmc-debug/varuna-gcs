@echo off
rem Start the localhost watchdog (hidden). It restarts http://localhost:5173 if it ever stops.
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0localhost-watchdog.ps1"
echo VARUNA localhost watchdog started. Log: %LOCALAPPDATA%\varuna-watchdog\watchdog.log
