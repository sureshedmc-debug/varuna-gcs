# VARUNA - update the drone Pi's code by putting its SD card in this laptop.
#
# Windows can only see the card's small FAT "bootfs" partition, not the Linux
# one where /home/pi/varuna-drone lives. So this:
#   1. copies the backend files to  <bootfs>\varuna-update\files\
#   2. adds sd_update.sh to it and a one-time "systemd.run=" to cmdline.txt
#      (backup: cmdline.txt.before-varuna-update)
# Put the card back in the Pi and power on: the Pi copies the files into
# /home/pi/varuna-drone, installs the service, puts cmdline.txt back and
# reboots by itself (about 1-2 min). Then it runs the new code.
#
#   powershell -ExecutionPolicy Bypass -File update_sd_card.ps1           prepare the card
#   powershell -ExecutionPolicy Bypass -File update_sd_card.ps1 -Result   card back in: show the Pi's log
#   powershell -ExecutionPolicy Bypass -File update_sd_card.ps1 -Undo     cancel before booting the Pi
param([switch]$Result, [switch]$Undo, [switch]$NoEject)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = 'main.py camera.py mav_link.py config.py mission.py control.py fence.py phone_gps.py stabilize.py system_info.py tailscale.py requirements.txt varuna-drone.service'.Split(' ')
$hook = ' systemd.run=/boot/firmware/varuna-update/varuna_update.sh systemd.run_success_action=reboot systemd.run_failure_action=reboot systemd.unit=kernel-command-line.target'

# The Pi card: a FAT32 volume with cmdline.txt + the Pi 3B+ device tree.
$vol = Get-Volume | Where-Object { $_.DriveLetter -and $_.FileSystem -eq 'FAT32' -and
    (Test-Path "$($_.DriveLetter):\cmdline.txt") -and (Test-Path "$($_.DriveLetter):\bcm2710-rpi-3-b-plus.dtb") } | Select-Object -First 1
if (-not $vol) { Write-Host 'No Raspberry Pi SD card found (looking for a bootfs drive with cmdline.txt). Insert it and try again.' -ForegroundColor Red; exit 1 }
$B = "$($vol.DriveLetter):"
$cmd = "$B\cmdline.txt"; $bak = "$B\cmdline.txt.before-varuna-update"; $upd = "$B\varuna-update"
Write-Host "Pi SD card: $B ($($vol.FileSystemLabel))"
function Write-Lf($path, $text) { [IO.File]::WriteAllText($path, ($text -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false)) }

if ($Result) {
    if (Test-Path "$upd\update.log") { Get-Content "$upd\update.log" }
    else { Write-Host 'No update.log yet: the Pi has not run the update from this card.' -ForegroundColor Yellow }
    $c = [IO.File]::ReadAllText($cmd)
    if ($c -match 'systemd\.run') { Write-Host 'cmdline.txt still has the update hook (the Pi has not booted with it yet).' -ForegroundColor Yellow }
    else { Write-Host 'cmdline.txt is back to normal.' }
    exit 0
}

if ($Undo) {
    if (Test-Path $bak) { Copy-Item $bak $cmd -Force; Remove-Item $bak; Write-Host 'cmdline.txt restored; the Pi will boot normally (no update).' }
    else { Write-Host 'Nothing to undo.' }
    exit 0
}

# 1. files
$missing = $files | Where-Object { -not (Test-Path (Join-Path $here $_)) }
if ($missing) { Write-Host "Missing here: $missing" -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force "$upd\files" | Out-Null
Get-ChildItem "$upd\files" -File -Force | Remove-Item -Force
foreach ($f in $files) {   # (some repo files are Hidden/ReadOnly; plain copies on the card)
    [IO.File]::Copy((Join-Path $here $f), "$upd\files\$f", $true)
    [IO.File]::SetAttributes("$upd\files\$f", [IO.FileAttributes]::Archive)
}
Write-Lf "$upd\varuna_update.sh" ([IO.File]::ReadAllText((Join-Path $here 'sd_update.sh')))
if (Test-Path "$upd\update.log") { Remove-Item "$upd\update.log" -Force }
Write-Host "1. Copied $($files.Count) files to $upd\files"

# 2. one-time boot hook (single line, no newline - the Pi's firmware wants one line)
$c = [IO.File]::ReadAllText($cmd).Trim()
if ($c -match 'systemd\.run') {
    Write-Host '2. cmdline.txt already has the update hook (kept as is).'
} else {
    if (-not (Test-Path $bak)) { [IO.File]::WriteAllText($bak, $c, (New-Object Text.ASCIIEncoding)) }
    [IO.File]::WriteAllText($cmd, $c + $hook, (New-Object Text.ASCIIEncoding))
    Write-Host '2. Added the one-time update to cmdline.txt (backup: cmdline.txt.before-varuna-update)'
}
Write-Host "   cmdline.txt: $([IO.File]::ReadAllText($cmd))"

# 3. safely eject so everything is written to the card
if (-not $NoEject) {
    try {
        (New-Object -ComObject Shell.Application).Namespace(17).ParseName($B).InvokeVerb('Eject')
        Write-Host "3. Ejected $B - you can take the card out."
    } catch { Write-Host "3. Eject $B from the taskbar (Safely Remove) before taking the card out." -ForegroundColor Yellow }
}
Write-Host ''
Write-Host 'Next: card into the Pi, power on. It boots, copies the code, reboots by itself (1-2 min), then runs it.'
Write-Host 'To read its log later: put the card back in the laptop and run this with -Result.'
