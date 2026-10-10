@echo off
rem Builds "VARUNA Boat Pi Tool.exe" (one file, no Python needed on the PC that runs it).
rem The boat backend from ..\boat-pi is bundled inside, so rebuild after changing it.
cd /d "%~dp0"
python -m pip install --quiet paramiko pyinstaller || goto :error
python -m PyInstaller --noconfirm --clean --onefile --console ^
  --name "VARUNA Boat Pi Tool" ^
  --icon "..\build\icon.ico" ^
  --add-data "..\boat-pi\main.py;boat-pi" ^
  --add-data "..\boat-pi\config.py;boat-pi" ^
  --add-data "..\boat-pi\mav_link.py;boat-pi" ^
  --add-data "..\boat-pi\mission.py;boat-pi" ^
  --add-data "..\boat-pi\sim_vehicle.py;boat-pi" ^
  --add-data "..\boat-pi\camera.py;boat-pi" ^
  --add-data "..\boat-pi\camera_model.py;boat-pi" ^
  --add-data "..\boat-pi\vision.py;boat-pi" ^
  --add-data "..\boat-pi\turbidity.py;boat-pi" ^
  --add-data "..\boat-pi\sim_world.py;boat-pi" ^
  --add-data "..\boat-pi\requirements.txt;boat-pi" ^
  --add-data "..\boat-pi\README.md;boat-pi" ^
  --add-data "..\boat-pi\boat_config.example.json;boat-pi" ^
  --add-data "..\boat-pi\test_e2e.py;boat-pi" ^
  varuna_boat_tool.py || goto :error
"dist\VARUNA Boat Pi Tool.exe" --self-test || goto :error
echo.
echo Built: %~dp0dist\VARUNA Boat Pi Tool.exe
exit /b 0
:error
echo BUILD FAILED
exit /b 1
