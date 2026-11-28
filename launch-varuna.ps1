# VARUNA GCS — one-click launcher (the desktop shortcut runs this via launch-varuna.vbs)
# Opens VARUNA in its own desktop window on the OPTIMISED build: no Chrome, no
# Vite dev server (its debug React and live reloading caused the jerks and
# pauses). The build is only redone when the app's code has changed since the
# last one, so a normal start takes a few seconds.

Set-Location -Path $PSScriptRoot

$npmCmd  = "C:\Program Files\nodejs\npm.cmd"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$dist    = Join-Path $PSScriptRoot "dist\index.html"

Add-Type -AssemblyName System.Windows.Forms

# ── 1. Rebuild only when src/, public/, index.html, vite.config.js or .env.local is newer than the last build ──
function Get-Newest($paths) {
    $newest = [datetime]::MinValue
    foreach ($p in $paths) {
        $full = Join-Path $PSScriptRoot $p
        if (-not (Test-Path $full)) { continue }
        $item = Get-Item -Force $full
        if ($item.PSIsContainer) {
            $f = Get-ChildItem -Force -Recurse -File $full -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($f -and $f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime }
        } elseif ($item.LastWriteTime -gt $newest) { $newest = $item.LastWriteTime }
    }
    return $newest
}

$needBuild = -not (Test-Path $dist)
if (-not $needBuild) {
    $built = (Get-Item -Force $dist).LastWriteTime
    $needBuild = (Get-Newest @("src", "public", "index.html", "vite.config.js", ".env.local")) -gt $built
}
if ($needBuild) {
    $build = Start-Process -FilePath $npmCmd -ArgumentList "run", "build" `
        -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -Wait
    if ($build.ExitCode -ne 0 -or -not (Test-Path $dist)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Building the app failed. Run 'npm run build' in the project folder to see why.",
            "VARUNA GCS — Launch Failed",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        exit 1
    }
}

# ── 2. Open the desktop window on the build (electron/launch.cjs, no flags = serves dist/) ──
Start-Process -FilePath $nodeExe -ArgumentList "`"$PSScriptRoot\electron\launch.cjs`"" `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
