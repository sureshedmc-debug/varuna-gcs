@echo off
rem Stop the localhost watchdog. The localhost server keeps running; close its window to stop it.
set "PIDFILE=%LOCALAPPDATA%\varuna-watchdog\watchdog.pid"
if not exist "%PIDFILE%" (
  echo The watchdog is not running.
  exit /b 0
)
set /p WPID=<"%PIDFILE%"
taskkill /PID %WPID% /F >nul 2>&1
del "%PIDFILE%" >nul 2>&1
echo %date% %time:~0,8%  Watchdog stopped by the operator.>>"%LOCALAPPDATA%\varuna-watchdog\watchdog.log"
echo VARUNA localhost watchdog stopped.
