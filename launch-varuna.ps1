# VARUNA GCS — one-click launcher
# Starts the Vite dev server in the background, waits for it to be ready,
# then opens the Electron window on top of it.
# Double-click the desktop shortcut to run this.

Set-Location -Path $PSScriptRoot

$npmCmd  = "C:\Program Files\nodejs\npm.cmd"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$port    = 5173
$url     = "http://localhost:$port/"

# ── 1. Kill anything already on port 5173 so a stale process never blocks startup ──
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $pid = ($existing | Select-Object -First 1).OwningProcess
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
}

# ── 2. Start the Vite dev server hidden in the background ──
$viteJob = Start-Process -FilePath $npmCmd `
    -ArgumentList "run", "dev" `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -PassThru

# ── 3. Wait up to 45 s for Vite to be ready (retries every 500 ms) ──
$ready    = $false
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -lt 500) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
}

if (-not $ready) {
    [System.Windows.Forms.MessageBox]::Show(
        "Vite dev server did not start within 45 seconds.`nCheck that Node.js and npm are installed correctly.",
        "VARUNA GCS — Launch Failed",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    $viteJob | Stop-Process -Force -ErrorAction SilentlyContinue
    exit 1
}

# ── 4. Open the Electron window on the running Vite server ──
# electron/launch.cjs --local  polls localhost:5173 once more (fast, already up)
# then opens the BrowserWindow.
$electronProc = Start-Process -FilePath $nodeExe `
    -ArgumentList "$PSScriptRoot\electron\launch.cjs", "--local" `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -PassThru

# ── 5. When Electron exits, shut Vite down too ──
$electronProc.WaitForExit()
$viteJob | Stop-Process -Force -ErrorAction SilentlyContinue

# Also clean up any lingering node process on port 5173
$leftover = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($leftover) {
    $pid = ($leftover | Select-Object -First 1).OwningProcess
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}
