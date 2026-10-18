@echo off
rem Builds "VARUNA Drone Pi Tool.exe" (one file, no Python needed on the PC that runs it).
rem The drone backend from ..\drone-pi is bundled inside, so rebuild after changing it.
cd /d "%~dp0"
python -m pip install --quiet paramiko pyinstaller || goto :error
python -m PyInstaller --noconfirm --clean --onefile --console ^
  --name "VARUNA Drone Pi Tool" ^
  --icon "..\build\icon.ico" ^
  --add-data "..\drone-pi\main.py;drone-pi" ^
  --add-data "..\drone-pi\config.py;drone-pi" ^
  --add-data "..\drone-pi\mav_link.py;drone-pi" ^
  --add-data "..\drone-pi\mission.py;drone-pi" ^
  --add-data "..\drone-pi\camera.py;drone-pi" ^
  --add-data "..\drone-pi\system_info.py;drone-pi" ^
  --add-data "..\drone-pi\control.py;drone-pi" ^
  --add-data "..\drone-pi\requirements.txt;drone-pi" ^
  --add-data "..\drone-pi\README.md;drone-pi" ^
  --add-data "..\drone-pi\drone_config.example.json;drone-pi" ^
  --add-data "..\drone-pi\test_e2e.py;drone-pi" ^
  varuna_drone_tool.py || goto :error
"dist\VARUNA Drone Pi Tool.exe" --self-test || goto :error
echo.
echo Built: %~dp0dist\VARUNA Drone Pi Tool.exe
exit /b 0
:error
echo BUILD FAILED
exit /b 1
