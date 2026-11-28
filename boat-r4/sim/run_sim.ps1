# Runs the UNO R4 boat brain in the Android emulator, with a simulated air boat
# and a simulated phone (GPS + compass), on tcp://127.0.0.1:5770 of this laptop.
# The SAME brain.cpp as the board; nothing to install (uses the Android NDK and
# the "varuna_test" emulator already on this laptop).
#
#   powershell -ExecutionPolicy Bypass -File boat-r4\sim\run_sim.ps1
#
# Then, in another window:
#   py boat-r4\sim\test_brain_e2e.py --port 5770 --adb      (44 checks through the laptop's own link code)
# or a scratch copy of the boat program on a spare port (never 8001 - that is the real boat):
#   py boat_extras.py --port 8091 --connection tcp:127.0.0.1:5770 --baud 115200
#   py boat-r4\sim\test_backend_api.py --base http://127.0.0.1:8091
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$ndk = Get-ChildItem (Join-Path $sdk 'ndk') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$clang = Join-Path $ndk.FullName 'toolchains\llvm\prebuilt\windows-x86_64\bin\clang++.exe'
$out = Join-Path $env:TEMP 'brainsim'
New-Item -ItemType Directory -Force $out | Out-Null

Write-Host "Building the brain simulator with $($ndk.Name)..."
& $clang --target=x86_64-linux-android30 -O2 -Wall -std=c++17 -static-libstdc++ `
    (Join-Path $here 'brain_sim.cpp') (Join-Path $root 'varuna_boat_brain\brain.cpp') -o (Join-Path $out 'brain_sim')
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$devices = & $adb devices | Select-String 'emulator-\d+\s+device'
if (-not $devices) {
    Write-Host 'Starting the emulator (varuna_test)...'
    Start-Process (Join-Path $sdk 'emulator\emulator.exe') -ArgumentList '-avd varuna_test -no-window -no-audio -no-snapshot-save -no-boot-anim' -WindowStyle Hidden
    & $adb wait-for-device
    do { Start-Sleep 2 } until ((& $adb shell getprop sys.boot_completed) -match '1')
}
& $adb shell pkill -f brain_sim 2>$null
& $adb push (Join-Path $out 'brain_sim') /data/local/tmp/brain_sim | Out-Null
& $adb shell 'chmod 755 /data/local/tmp/brain_sim; rm -f /data/local/tmp/brain_eeprom.bin /data/local/tmp/brain_sim.ctl'
& $adb forward tcp:5770 tcp:5760 | Out-Null
Write-Host 'Brain simulator on tcp:127.0.0.1:5770 (Ctrl+C stops it)'
& $adb shell /data/local/tmp/brain_sim 5760
