# Put an "Update VARUNA GCS" shortcut on the Desktop that opens the updater menu
# (scripts/update-desktop.cmd). Run again if the project folder moves.
#   npm run desktop:shortcut

$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Update VARUNA GCS.lnk'

$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($link)
$s.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
$s.Arguments = '/c "' + (Join-Path $root 'scripts\update-desktop.cmd') + '"'
$s.WorkingDirectory = $root
$s.IconLocation = (Join-Path $root 'build\icon.ico') + ',0'
$s.Description = 'Rebuild VARUNA GCS from the latest code and install it'
$s.Save()
Write-Host "Shortcut created: $link"
