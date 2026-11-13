# Rebuild the VARUNA GCS desktop app from the current code and install it on this PC.
#
#   npm run desktop:update              bump the patch version, build, install
#   npm run desktop:update -- -NoBump   rebuild and reinstall the same version
#   npm run desktop:update -- -Launch   also open the app when it is done
#
# If the app is installed for all users (Program Files), Windows asks for
# permission (UAC) once, for the install step.

param(
  [switch]$NoBump,
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host ''; Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }

function Installed {
  $keys = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
  Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'VARUNA GCS*' } |
    Select-Object -First 1
}

$before = Installed
if ($before) { Write-Host "Installed now: $($before.DisplayVersion)" } else { Write-Host 'Not installed yet.' }

if (-not $NoBump) {
  Step 'Bumping the version'
  npm version patch --no-git-tag-version | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'could not bump the version' }
}
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "Building version $version"

Step 'Building the app and the installer (takes a few minutes)'
npm run electron:build
if ($LASTEXITCODE -ne 0) { Fail 'the build failed (see the output above)' }

Step 'Checking the build for leaked dev addresses'
npm run check:clean
if ($LASTEXITCODE -ne 0) { Fail 'check:clean found a problem; not installing' }

$setup = Join-Path $root "release\VARUNA GCS-Setup-$version.exe"
if (-not (Test-Path $setup)) { Fail "installer not found: $setup" }

Step 'Closing the running app'
Get-Process -Name 'VARUNA GCS' -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
Start-Sleep -Milliseconds 800

# Install the same way it is installed now (all users -> needs UAC).
$allUsers = $before -and ($before.PSPath -like '*HKEY_LOCAL_MACHINE*')
Step ($(if ($allUsers) { 'Installing for all users (click Yes on the Windows prompt)' } else { 'Installing for this user' }))
$installArgs = @('/S', $(if ($allUsers) { '/allusers' } else { '/currentuser' }))
try {
  if ($allUsers) { $p = Start-Process -FilePath $setup -ArgumentList $installArgs -Verb RunAs -Wait -PassThru }
  else { $p = Start-Process -FilePath $setup -ArgumentList $installArgs -Wait -PassThru }
} catch {
  Fail 'the install was cancelled (the Windows permission prompt was declined)'
}
if ($p.ExitCode -ne 0) { Fail "the installer exited with code $($p.ExitCode)" }

Step 'Checking the installed version'
$after = Installed
if (-not $after -or $after.DisplayVersion -ne $version) {
  Fail "expected $version installed, found $(if ($after) { $after.DisplayVersion } else { 'nothing' })"
}
Write-Host ''
Write-Host "Done: VARUNA GCS $version is installed." -ForegroundColor Green

if ($Launch) {
  $exe = Join-Path ($(if ($allUsers) { $env:ProgramFiles } else { Join-Path $env:LOCALAPPDATA 'Programs' })) 'VARUNA GCS\VARUNA GCS.exe'
  if (Test-Path $exe) { Start-Process $exe } else { Write-Host "Could not find $exe to open it." }
}
