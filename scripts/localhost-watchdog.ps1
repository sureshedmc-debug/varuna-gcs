# Keeps the VARUNA app's localhost server (vite, http://localhost:5173) running.
#
# Every 15 s it checks that something is listening on port 5173. If not, it
# starts `npm run dev` again in a minimised window. Only one watchdog runs at
# a time. Stop it with scripts\stop-localhost-watchdog.cmd (the localhost
# server itself keeps running; close its window to stop that).
#
#   scripts\start-localhost-watchdog.cmd     start (runs hidden)
#   scripts\stop-localhost-watchdog.cmd      stop

$ErrorActionPreference = 'Continue'
$Root    = Split-Path -Parent $PSScriptRoot
$Port    = 5173
$CheckS  = 15          # how often to look
$GraceS  = 60          # after a (re)start, give vite this long to come up
$Dir     = Join-Path $env:LOCALAPPDATA 'varuna-watchdog'
$PidFile = Join-Path $Dir 'watchdog.pid'
$LogFile = Join-Path $Dir 'watchdog.log'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# The boat program runs on this laptop (Start VARUNA Boat, port 8001). This
# overrides the old boat-Pi address in .env.local for the server started here.
$env:VITE_DEV_BOAT_TARGET = 'http://127.0.0.1:8001'

function Write-Log($msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    # keep the log small
    if ((Get-Item $LogFile).Length -gt 512KB) {
        Get-Content $LogFile -Tail 2000 | Set-Content $LogFile -Encoding utf8
    }
}

# One watchdog only.
$mutex = New-Object System.Threading.Mutex($false, 'Local\VarunaLocalhostWatchdog')
if (-not $mutex.WaitOne(0)) {
    Write-Log 'Another watchdog is already running - this one exits.'
    exit 0
}
Set-Content -Path $PidFile -Value $PID -Encoding ascii
Write-Log "Watchdog started (pid $PID), watching http://localhost:$Port"

function Test-Up {
    $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    return [bool]$c
}

$lastStart = [datetime]::MinValue
try {
    while ($true) {
        if (-not (Test-Up)) {
            $since = ((Get-Date) - $lastStart).TotalSeconds
            if ($since -ge $GraceS) {
                Write-Log "localhost:$Port is DOWN - starting npm run dev"
                Start-Process -FilePath 'cmd.exe' `
                    -ArgumentList '/d', '/k', 'title VARUNA localhost (watchdog) && npm run dev' `
                    -WorkingDirectory $Root -WindowStyle Minimized
                $lastStart = Get-Date
            }
        }
        Start-Sleep -Seconds $CheckS
    }
}
finally {
    Write-Log 'Watchdog stopped.'
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
}
