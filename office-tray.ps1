# Oficina tray agent - hosts a system tray icon, runs the daemon hidden,
# and kills it on Quit. Requires Windows PowerShell (STA).
#   left-click the icon  -> Quick request: type a prompt, it joins the office's queue
#   right-click the icon -> menu (new request, open the app, queue, appearance light/dark, quit)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# single instance: kill any other tray agent first - a hung one would hold
# the mutex forever and a zombie icon can't be quit from the menu anyway.
# Double-clicking therefore always yields one fresh, working tray icon.
$me = $PID
Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -match 'office-tray\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$script:mutex = New-Object System.Threading.Mutex($false, 'Local\OficinaTray')
$script:mutex.WaitOne(0) | Out-Null

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$daemonDir = Join-Path $root 'daemon'
$script:daemonProc = $null
$script:openedBrowser = $false
$script:lastSeq = $null   # last notification seq shown (null = not seeded yet)
$script:notifyTick = 0
$script:queueCount = -1   # -1 = unknown (daemon down)

# the daemon's port comes from daemon/office.yaml (default 4780)
$port = 4780
try {
    $m = [regex]::Match((Get-Content (Join-Path $daemonDir 'office.yaml') -Raw), '(?m)^port:\s*(\d+)')
    if ($m.Success) { $port = [int]$m.Groups[1].Value }
} catch { }
$appUrl = "http://localhost:$port"

. (Join-Path $root 'office-tray-ui.ps1')
$script:ApiPort = $port
Initialize-TrayTheme

# Balloon tips for the three things worth interrupting the owner for:
# a Needs-you decision, a run finishing, a run stopping badly. Everything
# else stays in the event log.
function Update-Notifications {
    try {
        $url = "http://127.0.0.1:$port/api/notifications"
        if ($script:lastSeq -ne $null) { $url += "?after=$($script:lastSeq)" }
        $items = Invoke-RestMethod -Uri $url -TimeoutSec 2 -ErrorAction Stop
        if ($script:lastSeq -eq $null) {
            # first successful poll after launch: don't replay history
            if ($items.Count -gt 0) { $script:lastSeq = ($items | Measure-Object -Property seq -Maximum).Maximum }
            return
        }
        foreach ($n in $items) {
            $script:lastSeq = [Math]::Max($script:lastSeq, $n.seq)
            $ni.ShowBalloonTip(6000, "Oficina - $($n.title)", $n.body, 'Info')
        }
    } catch { }
}

# Fast non-blocking health probe - a TCP connect to the daemon port. Runs on
# the WinForms UI thread every second, so it must never block: a refused or
# instant localhost connect returns in milliseconds. (Invoke-WebRequest used
# to hang the thread for up to 2s per tick, making the icon unclickable.)
function Test-Daemon {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($ar)
        return $true
    } catch { return $false }
    finally { $client.Close() }
}

function Start-Daemon {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/d /c npm run start'
    $psi.WorkingDirectory = $daemonDir
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    $psi.WindowStyle = 'Hidden'
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    $script:daemonProc = [System.Diagnostics.Process]::Start($psi)
}

function Stop-Daemon {
    if ($script:daemonProc -and -not $script:daemonProc.HasExited) {
        & taskkill /PID $script:daemonProc.Id /T /F 2>$null | Out-Null
    }
    # safety net: whatever is listening on the daemon port goes too
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

$icon = New-TrayIcon
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = 'Oficina'
$ni.Visible = $true

# ---- right-click menu -------------------------------------------------------------------------
$dot = [string][char]0xB7
$parts = New-TrayMenu
$menu = $parts.Menu; $miStatus = $parts.Status; $miNew = $parts.New; $miOpen = $parts.Open; $miQueue = $parts.Queue; $miQuit = $parts.Quit

$parts.ThemeAuto.Add_Click({ Set-TrayThemeMode 'auto' })
$parts.ThemeLight.Add_Click({ Set-TrayThemeMode 'light' })
$parts.ThemeDark.Add_Click({ Set-TrayThemeMode 'dark' })

$openQuick = { Show-QuickRequest { Start-Process $appUrl } { Update-QueueState } }
$miNew.Add_Click({ & $openQuick })
$miOpen.Add_Click({ Start-Process $appUrl })
$miQueue.Add_Click({ Start-Process $appUrl })
$miQuit.Add_Click({
    try { Stop-Daemon } catch {}
    $ni.Visible = $false
    $ni.Dispose()
    # hard exit - Application.Exit() can no-op if the message loop is wedged,
    # which is exactly when you need Quit to work
    [Environment]::Exit(0)
})
$menu.Add_Opening({ Update-TrayMenuTheme $menu; Update-QueueState })
$ni.ContextMenuStrip = $menu
$ni.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { & $openQuick } })

# status line + queue count + tooltip, from what the daemon last said
function Update-QueueState {
    $up = Test-Daemon
    if ($up) { $script:queueCount = Get-QueueCount } else { $script:queueCount = -1 }
    if (-not $up) {
        $miStatus.Text = 'Stopped'
        $miQueue.Text = 'Queue'
        $ni.Text = 'Oficina (stopped)'
        return
    }
    if ($script:queueCount -gt 0) {
        $miStatus.Text = "Running  $dot  $($script:queueCount) queued"
        $miQueue.Text = "Queue  ($($script:queueCount) waiting)"
        $ni.Text = "Oficina - $($script:queueCount) queued"
    } else {
        $miStatus.Text = "Running  $dot  queue is empty"
        $miQueue.Text = 'Queue'
        $ni.Text = 'Oficina (running)'
    }
}

$already = Test-Daemon
if ($already) {
    $miStatus.Text = 'Running'
    $ni.Text = 'Oficina (running)'
    $ni.ShowBalloonTip(2500, 'Oficina', 'Daemon already running - click the icon to queue a request.', 'Info')
} else {
    Start-Daemon
    $ni.ShowBalloonTip(2500, 'Oficina', 'Daemon starting...', 'Info')
}

# poll health once a second: update status line + open the browser when ready
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    if (Test-Daemon) {
        if (-not $script:openedBrowser) {
            $script:openedBrowser = $true
            Start-Process $appUrl
        }
        $script:notifyTick++
        if ($script:notifyTick % 5 -eq 0) { Update-Notifications; Update-QueueState }
        elseif ($miStatus.Text -eq 'Stopped' -or $miStatus.Text -eq 'Starting...') { Update-QueueState }
    } elseif ($miStatus.Text -ne 'Stopped') {
        $miStatus.Text = 'Stopped'
        $miQueue.Text = 'Queue'
        $ni.Text = 'Oficina (stopped)'
    }
})
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $ni.Visible = $false
    $ni.Dispose()
}
