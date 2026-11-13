@echo off
rem VARUNA GCS desktop updater: a small terminal menu around update-desktop.ps1.
rem The desktop shortcut "Update VARUNA GCS" opens this (see make-update-shortcut.ps1).
title VARUNA GCS - Desktop Updater
cd /d "%~dp0.."

:menu
cls
echo.
echo   ==============================================
echo            VARUNA GCS  -  DESKTOP UPDATER
echo   ==============================================
echo.
powershell -NoProfile -Command "$v=(Get-Content package.json -Raw|ConvertFrom-Json).version; $k='HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; $i=Get-ItemProperty $k -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'VARUNA GCS*'}|Select-Object -First 1; Write-Host ('   Installed app : ' + $(if($i){$i.DisplayVersion}else{'not installed'})); Write-Host ('   Code version  : ' + $v); $c=(git status --porcelain 2>$null|Measure-Object).Count; Write-Host ('   Changed files : ' + $c)"
echo.
echo   [1]  Update the app to a new version
echo   [2]  Rebuild and reinstall the same version
echo   [3]  Update, then open the app
echo   [Q]  Quit
echo.
choice /c 123q /n /m "   Choose 1, 2, 3 or Q: "
if errorlevel 4 goto :eof
if errorlevel 3 (set "ARGS=-Launch" & goto run)
if errorlevel 2 (set "ARGS=-NoBump" & goto run)
set "ARGS="

:run
cls
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-desktop.ps1" %ARGS%
echo.
echo   Press any key to go back to the menu . . .
pause >nul
goto menu
