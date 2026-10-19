# officeChain tray agent - hosts a system tray icon, runs the daemon hidden,
# and kills it on Quit. Requires Windows PowerShell (STA).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# single instance: kill any other tray agent first - a hung one would hold
# the mutex forever and a zombie icon can't be quit from the menu anyway.
# Double-clicking therefore always yields one fresh, working tray icon.
$me = $PID
Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -match 'office-tray\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$script:mutex = New-Object System.Threading.Mutex($false, 'Local\officeChainTray')
$script:mutex.WaitOne(0) | Out-Null

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$daemonDir = Join-Path $root 'daemon'
$script:daemonProc = $null
$script:openedBrowser = $false
$script:lastSeq = $null   # last notification seq shown (null = not seeded yet)
$script:notifyTick = 0

# Balloon tips for the three things worth interrupting the owner for:
# a Needs-you decision, a run finishing, a run stopping badly. Everything
# else stays in the event log.
function Update-Notifications {
    try {
        $url = 'http://127.0.0.1:4780/api/notifications'
        if ($script:lastSeq -ne $null) { $url += "?after=$($script:lastSeq)" }
        $items = Invoke-RestMethod -Uri $url -TimeoutSec 2 -ErrorAction Stop
        if ($script:lastSeq -eq $null) {
            # first successful poll after launch: don't replay history
            if ($items.Count -gt 0) { $script:lastSeq = ($items | Measure-Object -Property seq -Maximum).Maximum }
            return
        }
        foreach ($n in $items) {
            $script:lastSeq = [Math]::Max($script:lastSeq, $n.seq)
            $ni.ShowBalloonTip(6000, "officeChain - $($n.title)", $n.body, 'Info')
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
        $ar = $client.BeginConnect('127.0.0.1', 4780, $null, $null)
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
    Get-NetTCPConnection -LocalPort 4780 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

# Tray icon: the app logo (four rounded squares) on a white tile, drawn at 32px so it stays crisp
# at high DPI; Windows scales it down to the tray size. Same colours as the sidebar logo and favicon.
function New-TrayIcon {
    $size = 32
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    function Add-Round($path, $x, $y, $w, $r) {
        $d = $r * 2
        $path.AddArc($x, $y, $d, $d, 180, 90); $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
        $path.AddArc($x + $w - $d, $y + $w - $d, $d, $d, 0, 90); $path.AddArc($x, $y + $w - $d, $d, $d, 90, 90)
        $path.CloseFigure()
    }
    function Fill-Round($color, $x, $y, $w, $r) {
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        Add-Round $p $x $y $w $r
        $b = New-Object System.Drawing.SolidBrush $color
        $g.FillPath($b, $p); $b.Dispose(); $p.Dispose()
    }
    # tile
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-Round $tile 0.5 0.5 31 7
    $g.FillPath([System.Drawing.Brushes]::White, $tile)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(205, 205, 205)), 1
    $g.DrawPath($pen, $tile); $pen.Dispose(); $tile.Dispose()
    # logo squares: ink, lime, lilac, faded ink
    Fill-Round ([System.Drawing.Color]::FromArgb(17, 17, 17))    6  6  9 2.5
    Fill-Round ([System.Drawing.Color]::FromArgb(205, 232, 130)) 17 6  9 2.5
    Fill-Round ([System.Drawing.Color]::FromArgb(176, 150, 240)) 6  17 9 2.5
    Fill-Round ([System.Drawing.Color]::FromArgb(150, 17, 17, 17)) 17 17 9 2.5
    $g.Dispose()
    $h = $bmp.GetHicon()
    $ico = [System.Drawing.Icon]::FromHandle($h).Clone()      # own copy, so the native handle can be released
    Add-Type -Namespace Win32 -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr h);'
    [Win32.Native]::DestroyIcon($h) | Out-Null
    $bmp.Dispose()
    return $ico
}
$icon = New-TrayIcon

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = 'officeChain'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('Open officeChain')
$miOpen.Add_Click({ Start-Process 'http://localhost:4780' })
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$menu.Items.Add('-') | Out-Null
$miStatus = $menu.Items.Add('daemon: starting...')
$miStatus.Enabled = $false
$menu.Items.Add('-') | Out-Null
$miQuit = $menu.Items.Add('Quit officeChain')
$miQuit.Add_Click({
    try { Stop-Daemon } catch {}
    $ni.Visible = $false
    $ni.Dispose()
    # hard exit - Application.Exit() can no-op if the message loop is wedged,
    # which is exactly when you need Quit to work
    [Environment]::Exit(0)
})
$ni.ContextMenuStrip = $menu
$ni.add_DoubleClick({ Start-Process 'http://localhost:4780' })

$already = Test-Daemon
if ($already) {
    $ni.Text = 'officeChain (running)'
    $miStatus.Text = 'daemon: running on :4780'
    $ni.ShowBalloonTip(2500, 'officeChain', 'Daemon already running - tray icon attached.', 'Info')
} else {
    Start-Daemon
    $ni.ShowBalloonTip(2500, 'officeChain', 'Daemon starting...', 'Info')
}

# poll health once a second: update status line + open the browser when ready
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    if (Test-Daemon) {
        if ($miStatus.Text -ne 'daemon: running on :4780') {
            $miStatus.Text = 'daemon: running on :4780'
            $ni.Text = 'officeChain (running)'
        }
        if (-not $script:openedBrowser) {
            $script:openedBrowser = $true
            Start-Process 'http://localhost:4780'
        }
        $script:notifyTick++
        if ($script:notifyTick % 5 -eq 0) { Update-Notifications }
    } elseif ($miStatus.Text -ne 'daemon: down') {
        $miStatus.Text = 'daemon: down'
        $ni.Text = 'officeChain (down)'
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
