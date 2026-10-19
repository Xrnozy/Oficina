# officeChain tray UI: the logo/icon, the right-click menu and the "Quick request" popup.
# Dot-sourced by office-tray.ps1; kept free of side effects so it can be loaded and rendered on its own.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# ---------------------------------------------------------------------------------------------
# A flat, themed menu renderer (rounded hover, hairline separators) and Windows 11 corner/dark-mode hints.
# C# 5 only: Windows PowerShell 5.1 compiles with the old csc.
$csharp = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace OfficeChain {
    public class TrayPalette {
        public Color Back, Border, Fore, Muted, Hover, Sep, Danger;
    }

    public class TrayRenderer : ToolStripProfessionalRenderer {
        public TrayPalette P;
        public TrayRenderer(TrayPalette p) : base() { P = p; RoundedEdges = false; }

        static GraphicsPath Round(Rectangle r, int radius) {
            int d = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) {
            using (SolidBrush b = new SolidBrush(P.Back)) e.Graphics.FillRectangle(b, e.AffectedBounds);
        }
        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) {
            using (Pen p = new Pen(P.Border)) e.Graphics.DrawRectangle(p, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
        }
        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
        // the base class greys the image of a disabled item; the header and status rows are disabled only so they cannot be clicked
        protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e) {
            if (e.Image == null) return;
            e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            e.Graphics.DrawImage(e.Image, e.ImageRectangle);
        }
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
            ToolStripItem item = e.Item;
            if (!item.Selected || !item.Enabled) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle r = new Rectangle(6, 1, item.Width - 13, item.Height - 3);
            Color c = (item.Tag as string) == "danger" ? Color.FromArgb(38, P.Danger) : P.Hover;
            using (GraphicsPath path = Round(r, 6))
            using (SolidBrush b = new SolidBrush(c)) e.Graphics.FillPath(b, path);
        }
        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
            using (Pen p = new Pen(P.Sep)) e.Graphics.DrawLine(p, 14, e.Item.Height / 2, e.Item.Width - 14, e.Item.Height / 2);
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
            string tag = e.Item.Tag as string;
            Color c = P.Fore;
            if (tag == "muted") c = P.Muted;
            else if (tag == "danger" && e.Item.Selected) c = P.Danger;
            else if (!e.Item.Enabled && tag != "header") c = P.Muted;
            TextFormatFlags f = TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;
            if (e.Text == e.Item.Text) { } else f = TextFormatFlags.VerticalCenter | TextFormatFlags.Right | TextFormatFlags.NoPrefix;   // the shortcut hint sits on the right, muted
            if (e.Text != e.Item.Text) c = P.Muted;
            TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, c, f);
        }
    }

    public static class Dwm {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
        // Windows 11: rounded corners (33 = 2) and a dark title/frame (20); silently ignored where unsupported.
        public static void Apply(IntPtr hwnd, bool dark) {
            try {
                int round = 2; DwmSetWindowAttribute(hwnd, 33, ref round, 4);
                int d = dark ? 1 : 0; DwmSetWindowAttribute(hwnd, 20, ref d, 4);
            } catch (Exception) { }
        }
    }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'OfficeChain.TrayRenderer').Type) {
    Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $csharp
}

# ---------------------------------------------------------------------------------------------
# Theme: follow the Windows app theme
function Get-TrayTheme {
    $light = $true
    try {
        $v = Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop
        $light = ($v -ne 0)
    } catch { }
    $c = { param($r, $g, $b) [System.Drawing.Color]::FromArgb($r, $g, $b) }
    if ($light) {
        return @{ Dark = $false; Back = (& $c 255 255 255); Field = (& $c 247 247 247); Border = (& $c 224 224 224); Fore = (& $c 17 17 17); Muted = (& $c 120 120 120)
                  Hover = (& $c 240 240 240); Sep = (& $c 232 232 232); Danger = (& $c 220 38 38); Ok = (& $c 22 128 60); Btn = (& $c 17 17 17); BtnFore = (& $c 255 255 255) }
    }
    return @{ Dark = $true; Back = (& $c 24 26 31); Field = (& $c 32 35 41); Border = (& $c 58 63 72); Fore = (& $c 235 235 235); Muted = (& $c 140 145 154)
              Hover = (& $c 42 46 54); Sep = (& $c 46 50 58); Danger = (& $c 248 113 113); Ok = (& $c 74 222 128); Btn = (& $c 240 240 240); BtnFore = (& $c 17 17 17) }
}

function New-TrayPalette($t) {
    $p = New-Object OfficeChain.TrayPalette
    $p.Back = $t.Back; $p.Border = $t.Border; $p.Fore = $t.Fore; $p.Muted = $t.Muted; $p.Hover = $t.Hover; $p.Sep = $t.Sep; $p.Danger = $t.Danger
    return $p
}

# ---------------------------------------------------------------------------------------------
# The logo: four rounded squares on a white tile, drawn at 32px so it stays crisp at high DPI. Same colours as
# the sidebar logo and the favicon.
function New-LogoBitmap([int]$size = 32, [bool]$tile = $true, $ink = $null) {
    if ($null -eq $ink) { $ink = [System.Drawing.Color]::FromArgb(17, 17, 17) }
    $bmp = New-Object System.Drawing.Bitmap 32, 32
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
    if ($tile) {
        $tp = New-Object System.Drawing.Drawing2D.GraphicsPath
        Add-Round $tp 0.5 0.5 31 7
        $g.FillPath([System.Drawing.Brushes]::White, $tp)
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(205, 205, 205)), 1
        $g.DrawPath($pen, $tp); $pen.Dispose(); $tp.Dispose()
    }
    Fill-Round $ink 6 6 9 2.5
    Fill-Round ([System.Drawing.Color]::FromArgb(205, 232, 130))   17 6  9 2.5
    Fill-Round ([System.Drawing.Color]::FromArgb(176, 150, 240))   6  17 9 2.5
    Fill-Round ([System.Drawing.Color]::FromArgb(150, $ink.R, $ink.G, $ink.B)) 17 17 9 2.5
    $g.Dispose()
    if ($size -eq 32) { return $bmp }
    $small = New-Object System.Drawing.Bitmap $size, $size
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = 'HighQualityBicubic'; $sg.DrawImage($bmp, 0, 0, $size, $size); $sg.Dispose(); $bmp.Dispose()
    return $small
}

function New-TrayIcon {
    $bmp = New-LogoBitmap 32
    $h = $bmp.GetHicon()
    $ico = [System.Drawing.Icon]::FromHandle($h).Clone()      # own copy, so the native handle can be released
    if (-not ([System.Management.Automation.PSTypeName]'Win32.Native').Type) {
        Add-Type -Namespace Win32 -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr h);'
    }
    [Win32.Native]::DestroyIcon($h) | Out-Null
    $bmp.Dispose()
    return $ico
}

function New-GlyphImage([int]$code, $color) {
    # Segoe MDL2 Assets ships with Windows 10 and 11
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $font = New-Object System.Drawing.Font('Segoe MDL2 Assets', 10.5)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.DrawString([string][char]$code, $font, $brush, -1, 0)
    $g.Dispose(); $brush.Dispose(); $font.Dispose()
    return $bmp
}

# ---------------------------------------------------------------------------------------------
# Talking to the daemon
$script:ApiPort = 4780
function Get-ApiBase { return "http://127.0.0.1:$($script:ApiPort)" }

function Invoke-OfficeApi([string]$Method, [string]$Path, $Body = $null, [int]$Timeout = 3) {
    $a = @{ Uri = ((Get-ApiBase) + $Path); Method = $Method; TimeoutSec = $Timeout; ErrorAction = 'Stop' }
    if ($null -ne $Body) {
        $a.ContentType = 'application/json; charset=utf-8'
        $a.Body = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress -Depth 6))
    }
    # Windows PowerShell 5.1 hands a JSON array back as ONE object; piping unrolls it into its elements
    return (Invoke-RestMethod @a | ForEach-Object { $_ })
}

# A short, human reason for a failed call.
function Get-ApiError($err) {
    $msg = $null
    try { if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $msg = ($err.ErrorDetails.Message | ConvertFrom-Json).error } } catch { }
    if ($msg) { return [string]$msg }
    $text = [string]$err.Exception.Message
    if ($text -match '(404)') { return "The daemon is older than this feature. Quit officeChain from the tray and start it again." }
    if ($text -match 'Unable to connect|refused|timed out|actively refused') { return "officeChain isn't running yet. Wait a moment and try again." }
    return $text
}

function Get-QueueCount {
    try { return @(Invoke-OfficeApi 'GET' '/api/queue' $null 2).Count } catch { return -1 }
}

# ---------------------------------------------------------------------------------------------
# Right-click menu
function Add-TrayItem($menu, [string]$text, [string]$tag = '', [int]$glyph = 0, [string]$hint = '') {
    $it = New-Object System.Windows.Forms.ToolStripMenuItem
    $it.Text = $text
    $it.Tag = $tag
    $it.AutoSize = $false
    $it.Size = New-Object System.Drawing.Size 262, 34
    $it.Padding = New-Object System.Windows.Forms.Padding 6, 0, 8, 0
    $it.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
    $it.ImageScaling = 'None'
    if ($glyph -gt 0) { $it.Name = "glyph:$glyph" }
    if ($hint) { $it.ShortcutKeyDisplayString = $hint }
    [void]$menu.Items.Add($it)
    return $it
}

function Add-TraySeparator($menu) {
    $s = New-Object System.Windows.Forms.ToolStripSeparator
    $s.AutoSize = $false
    $s.Size = New-Object System.Drawing.Size 262, 9
    [void]$menu.Items.Add($s)
}

# The whole menu: header with the logo, a status line, the actions, and Quit.
function New-TrayMenu {
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $menu.ShowImageMargin = $true
    $menu.ShowCheckMargin = $false
    $menu.Padding = New-Object System.Windows.Forms.Padding 0, 6, 0, 6
    $head = Add-TrayItem $menu 'officeChain' 'header'
    $head.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10.5)
    $head.Enabled = $false
    $head.Image = New-LogoBitmap 16 $false
    $status = Add-TrayItem $menu 'Starting...' 'muted'
    $status.Enabled = $false
    $status.Padding = New-Object System.Windows.Forms.Padding 32, 0, 8, 0
    $status.Size = New-Object System.Drawing.Size 262, 26
    Add-TraySeparator $menu
    $new = Add-TrayItem $menu 'New request...' 'accent' 0xE710 'click the icon'
    $open = Add-TrayItem $menu 'Open officeChain' '' 0xE8A7
    $queue = Add-TrayItem $menu 'Queue' '' 0xE8FD
    Add-TraySeparator $menu
    $quit = Add-TrayItem $menu 'Quit officeChain' 'danger' 0xE7E8
    return @{ Menu = $menu; Status = $status; New = $new; Open = $open; Queue = $queue; Quit = $quit }
}

# Re-skin for the current Windows theme; run each time the menu opens so a theme switch is picked up.
function Update-TrayMenuTheme($menu) {
    $t = Get-TrayTheme
    $menu.Renderer = New-Object OfficeChain.TrayRenderer (New-TrayPalette $t)
    $menu.BackColor = $t.Back
    $menu.DropShadowEnabled = $true
    foreach ($it in $menu.Items) {
        if ($it.Tag -eq 'header') {
            if ($it.Image) { $it.Image.Dispose() }
            $it.Image = New-LogoBitmap 16 $false $t.Fore
        }
        if ($it -is [System.Windows.Forms.ToolStripMenuItem] -and $it.Name -like 'glyph:*') {
            $code = [int]($it.Name.Substring(6))
            $col = if ($it.Tag -eq 'danger') { $t.Danger } else { $t.Fore }
            if ($it.Image) { $it.Image.Dispose() }
            $it.Image = New-GlyphImage $code $col
        }
    }
    try { [OfficeChain.Dwm]::Apply($menu.Handle, $t.Dark) } catch { }
}

# ---------------------------------------------------------------------------------------------
# Quick request popup: type a prompt, it joins the queue of the chosen office.
# Shared by the popup's event handlers. They run as closures, which get their own $script: scope, so state lives in
# one hashtable that every closure captures by reference.
$script:Quick = @{ Form = $null; HiddenAt = [DateTime]::MinValue; Draft = ''; LastOfficeId = $null }
$script:SettingsFile = Join-Path $env:LOCALAPPDATA 'officeChain\tray.json'

function Read-TraySettings { try { return Get-Content $script:SettingsFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return $null } }
function Save-TraySettings([string]$officeId) {
    try {
        $dir = Split-Path $script:SettingsFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        (@{ lastOfficeId = $officeId } | ConvertTo-Json -Compress) | Set-Content -Path $script:SettingsFile -Encoding UTF8
    } catch { }
}

function Show-QuickRequest([scriptblock]$OnOpenApp, [scriptblock]$OnQueued) {
    # clicking the tray icon while the popup is open first deactivates (hides) it; treat that click as "close"
    $q = $script:Quick
    if (((Get-Date) - $q.HiddenAt).TotalMilliseconds -lt 450) { return }
    if ($q.Form -and -not $q.Form.IsDisposed) {
        $q.Form.Show(); $q.Form.Activate(); return
    }
    $t = Get-TrayTheme
    $W = 460
    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'; $form.ShowInTaskbar = $false
    $form.TopMost = $true; $form.KeyPreview = $true; $form.BackColor = $t.Back; $form.ForeColor = $t.Fore
    $form.Size = New-Object System.Drawing.Size $W, 392
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Location = New-Object System.Drawing.Point ($wa.Right - $W - 14), ($wa.Bottom - 392 - 14)

    $mk = {
        param($text, $x, $y, $w, $h, $font, $color)
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $text; $l.Location = New-Object System.Drawing.Point $x, $y; $l.Size = New-Object System.Drawing.Size $w, $h
        $l.Font = $font; $l.ForeColor = $color; $l.BackColor = [System.Drawing.Color]::Transparent
        $form.Controls.Add($l); return $l
    }
    $cap = New-Object System.Drawing.Font('Segoe UI Semibold', 7.5)
    [void](& $mk 'Quick request' 18 16 300 26 (New-Object System.Drawing.Font('Segoe UI Semibold', 13)) $t.Fore)
    $close = & $mk ([string][char]0xE711) ($W - 40) 16 22 22 (New-Object System.Drawing.Font('Segoe MDL2 Assets', 9)) $t.Muted
    $close.Cursor = [System.Windows.Forms.Cursors]::Hand; $close.TextAlign = 'MiddleCenter'
    $close.Add_Click({ $form.Hide() }.GetNewClosure())
    $sub = & $mk '' 18 46 ($W - 36) 34 (New-Object System.Drawing.Font('Segoe UI', 9)) $t.Muted

    [void](& $mk 'OFFICE' 18 92 200 14 $cap $t.Muted)
    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.DropDownStyle = 'DropDownList'; $combo.FlatStyle = 'Flat'
    $combo.Location = New-Object System.Drawing.Point 18, 110; $combo.Size = New-Object System.Drawing.Size ($W - 36), 28
    $combo.BackColor = $t.Field; $combo.ForeColor = $t.Fore; $combo.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $form.Controls.Add($combo)

    [void](& $mk 'REQUEST' 18 150 200 14 $cap $t.Muted)
    $box = New-Object System.Windows.Forms.Panel
    $box.Location = New-Object System.Drawing.Point 18, 168; $box.Size = New-Object System.Drawing.Size ($W - 36), 122; $box.BackColor = $t.Field
    $form.Controls.Add($box)
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Multiline = $true; $tb.BorderStyle = 'None'; $tb.AcceptsReturn = $true; $tb.ScrollBars = 'None'; $tb.MaxLength = 8000
    $tb.Location = New-Object System.Drawing.Point 12, 10; $tb.Size = New-Object System.Drawing.Size ($W - 36 - 24), 102
    $tb.BackColor = $t.Field; $tb.ForeColor = $t.Fore; $tb.Font = New-Object System.Drawing.Font('Segoe UI', 10.5)
    $box.Controls.Add($tb)
    $cue = New-Object System.Windows.Forms.Label
    $cue.Text = "What should the team build or fix?`nPress Ctrl+Enter to add it to the queue."
    $cue.Location = New-Object System.Drawing.Point 12, 11; $cue.Size = New-Object System.Drawing.Size ($W - 36 - 24), 44
    $cue.Font = New-Object System.Drawing.Font('Segoe UI', 10.5); $cue.ForeColor = $t.Muted; $cue.BackColor = $t.Field
    $cue.Add_Click({ $tb.Focus() }.GetNewClosure())
    $box.Controls.Add($cue); $cue.BringToFront()
    $count = & $mk '' 18 294 ($W - 36) 14 (New-Object System.Drawing.Font('Segoe UI', 8)) $t.Muted
    $count.TextAlign = 'MiddleRight'
    $status = & $mk '' 18 312 ($W - 36) 18 (New-Object System.Drawing.Font('Segoe UI', 9)) $t.Muted

    $mkBtn = {
        param($text, $x, $w, $primary)
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $text; $b.FlatStyle = 'Flat'; $b.Cursor = [System.Windows.Forms.Cursors]::Hand
        $b.Location = New-Object System.Drawing.Point $x, 340; $b.Size = New-Object System.Drawing.Size $w, 36
        $b.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9.5)
        $b.FlatAppearance.BorderSize = 1
        if ($primary) { $b.BackColor = $t.Btn; $b.ForeColor = $t.BtnFore; $b.FlatAppearance.BorderColor = $t.Btn }
        else { $b.BackColor = $t.Back; $b.ForeColor = $t.Fore; $b.FlatAppearance.BorderColor = $t.Border }
        $form.Controls.Add($b); return $b
    }
    $add = & $mkBtn 'Add to queue' ($W - 18 - 140) 140 $true
    $cancel = & $mkBtn 'Cancel' ($W - 18 - 140 - 8 - 84) 84 $false
    $openApp = & $mk 'Open officeChain' 18 349 150 18 (New-Object System.Drawing.Font('Segoe UI', 9)) $t.Muted
    $openApp.Cursor = [System.Windows.Forms.Cursors]::Hand
    $openApp.Add_Click({ $form.Hide(); if ($OnOpenApp) { & $OnOpenApp } }.GetNewClosure())
    $openApp.Add_MouseEnter({ $openApp.ForeColor = $t.Fore }.GetNewClosure()); $openApp.Add_MouseLeave({ $openApp.ForeColor = $t.Muted }.GetNewClosure())

    # ---- offices
    $offices = @(); $autos = @()
    try { $offices = @(Invoke-OfficeApi 'GET' '/api/workspaces' $null 2) } catch { }
    foreach ($o in $offices) { [void]$combo.Items.Add([string]$o.name); $autos += [bool]($o.settings.autoStartQueue) }
    $saved = Read-TraySettings
    $want = if ($q.LastOfficeId) { $q.LastOfficeId } elseif ($saved) { $saved.lastOfficeId } else { $null }
    $idx = 0
    for ($i = 0; $i -lt $offices.Count; $i++) { if ($offices[$i].id -eq $want) { $idx = $i } }
    if ($offices.Count -gt 0) { $combo.SelectedIndex = $idx }
    $setSub = {
        if ($offices.Count -eq 0) { $sub.Text = "officeChain isn't running yet - this will work in a moment."; return }
        if ($autos[$combo.SelectedIndex]) { $sub.Text = "This office starts queued requests by itself when it's idle, one at a time." }
        else { $sub.Text = "It waits in this office's queue. Nothing runs until you press Start on the dashboard." }
    }.GetNewClosure()
    & $setSub
    $combo.Add_SelectedIndexChanged($setSub)

    # ---- behaviour
    $tb.Text = $q.Draft
    $cue.Visible = ($tb.Text.Length -eq 0)
    $tb.Add_TextChanged({
        $cue.Visible = ($tb.Text.Length -eq 0)
        # a scrollbar only once the text no longer fits
        $tb.ScrollBars = if ($tb.GetLineFromCharIndex([Math]::Max(0, $tb.TextLength - 1)) -ge 5) { 'Vertical' } else { 'None' }
        $count.Text = if ($tb.Text.Length -gt 0) { "$($tb.Text.Length) / 8000" } else { '' }
        if ($status.Tag -ne 'sticky') { $status.Text = '' }
    }.GetNewClosure())
    $hideTimer = New-Object System.Windows.Forms.Timer
    $hideTimer.Interval = 900
    $hideTimer.Add_Tick({ $hideTimer.Stop(); $status.Tag = ''; $form.Hide() }.GetNewClosure())
    $submit = {
        $text = $tb.Text.Trim()
        $status.Tag = ''
        if (-not $text) { $status.ForeColor = $t.Danger; $status.Text = 'Type a request first.'; return }
        if ($offices.Count -eq 0 -or $combo.SelectedIndex -lt 0) { $status.ForeColor = $t.Danger; $status.Text = "officeChain isn't running yet."; return }
        $office = $offices[$combo.SelectedIndex]
        $add.Enabled = $false
        try {
            [void](Invoke-OfficeApi 'POST' '/api/queue' @{ text = $text; workspaceId = $office.id; source = 'tray' } 4)
            $q.LastOfficeId = $office.id; Save-TraySettings $office.id
            $q.Draft = ''; $tb.Text = ''
            $status.Tag = 'sticky'; $status.ForeColor = $t.Ok; $status.Text = "Queued in $($office.name)"
            $hideTimer.Start()
            if ($OnQueued) { & $OnQueued $text $office.name }
        } catch {
            $status.ForeColor = $t.Danger; $status.Text = (Get-ApiError $_)
        }
        $add.Enabled = $true
    }.GetNewClosure()
    $add.Add_Click($submit)
    $cancel.Add_Click({ $form.Hide() }.GetNewClosure())
    $tb.Add_KeyDown({ if ($_.Control -and $_.KeyCode -eq 'Return') { $_.SuppressKeyPress = $true; & $submit } }.GetNewClosure())
    $form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $form.Hide() } }.GetNewClosure())
    $form.Add_Deactivate({ if ($form.Visible) { $form.Hide() } }.GetNewClosure())
    $form.Add_VisibleChanged({
        if (-not $form.Visible) { $q.Draft = $tb.Text; $q.HiddenAt = Get-Date }
        else { $form.Activate(); $tb.Focus() }
    }.GetNewClosure())
    $form.Add_Paint({
        $g = $_.Graphics; $g.SmoothingMode = 'AntiAlias'
        $pen = New-Object System.Drawing.Pen $t.Border, 1
        $g.DrawPath($pen, (Get-RoundPath 0 0 ($form.Width - 1) ($form.Height - 1) 12)); $pen.Dispose()
    }.GetNewClosure())
    $form.Region = New-Object System.Drawing.Region (Get-RoundPath 0 0 $form.Width $form.Height 12)
    $q.Form = $form
    $form.Add_Shown({ try { [OfficeChain.Dwm]::Apply($form.Handle, $t.Dark) } catch { } }.GetNewClosure())
    $form.Show(); $form.Activate(); $tb.Focus()
}

function Get-RoundPath([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
    $d = $r * 2
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}
