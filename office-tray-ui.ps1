# Oficina tray UI: the logo/icon, the right-click menu and the "Quick request" popup.
# Dot-sourced by office-tray.ps1; kept free of side effects so it can be loaded and rendered on its own.
#
# The look is the website's: the same colour tokens (ui/src/index.css), 8px inputs, pill buttons, mono uppercase field
# labels and the sidebar's brand header. Everything is sized in pixels times the screen scale, so it is crisp at any DPI.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# ---------------------------------------------------------------------------------------------
# Controls drawn by hand so they match the website. C# 5 only: Windows PowerShell 5.1 compiles with the old csc.
$csharp = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Oficina {
    // The website's tokens (ui/src/index.css), light or dark.
    public class TrayPalette {
        public Color Canvas, Surface, Raised, Sunken, Line, LineStrong, Fg, Fg2, Fg3, Fg4, Ok, Bad, Warn, Info;
        public bool Dark;
    }

    public static class Ui {
        public static double Scale = 1.0;
        static string sans, semi, mono;
        static Dictionary<string, Font> fonts = new Dictionary<string, Font>();

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        // Opt in to real pixels (no blurry bitmap scaling) and read the screen scale. Call before any window exists.
        public static void InitDpi() {
            try { SetProcessDPIAware(); } catch (Exception) { }
            try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) { Scale = g.DpiX / 96.0; } } catch (Exception) { Scale = 1.0; }
        }
        public static int S(double px) { return (int)Math.Round(px * Scale); }

        static bool Has(string family) {
            using (InstalledFontCollection c = new InstalledFontCollection()) {
                foreach (FontFamily f in c.Families) if (f.Name == family) return true;
            }
            return false;
        }
        // Geist (the website's font) is a web font and cannot be loaded by GDI+, so the closest Windows faces are used.
        public static string Sans { get { if (sans == null) sans = Has("Segoe UI Variable Text") ? "Segoe UI Variable Text" : "Segoe UI"; return sans; } }
        public static string Semi { get { if (semi == null) semi = Has("Segoe UI Variable Text Semibold") ? "Segoe UI Variable Text Semibold" : "Segoe UI Semibold"; return semi; } }
        public static string Mono { get { if (mono == null) mono = Has("Cascadia Mono") ? "Cascadia Mono" : "Consolas"; return mono; } }

        public static Font F(string family, double px) {
            string key = family + "|" + px + "|" + Scale;
            Font f;
            if (!fonts.TryGetValue(key, out f)) { f = new Font(family, (float)(px * Scale), FontStyle.Regular, GraphicsUnit.Pixel); fonts[key] = f; }
            return f;
        }
        public static Color A(Color c, int alpha) { return Color.FromArgb(Math.Max(0, Math.Min(255, alpha)), c.R, c.G, c.B); }
        public static Color Mix(Color top, Color under, double t) {
            return Color.FromArgb((int)(under.R + (top.R - under.R) * t), (int)(under.G + (top.G - under.G) * t), (int)(under.B + (top.B - under.B) * t));
        }
        public static GraphicsPath Round(RectangleF r, float radius) {
            float d = Math.Max(0.01f, radius * 2);
            GraphicsPath p = new GraphicsPath();
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    // btn: a pill. primary = ink fill, secondary = hairline border, ghost = borderless.
    public class PillButton : Control {
        public TrayPalette P;
        public string Kind = "secondary";
        public string Glyph;      // an icon from Segoe MDL2 Assets instead of text
        bool hot, down;
        public PillButton() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.SupportsTransparentBackColor | ControlStyles.Selectable | ControlStyles.StandardClick, true);
            BackColor = Color.Transparent; Cursor = Cursors.Hand; TabStop = true;
        }
        protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hot = false; down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override bool IsInputKey(Keys k) { return k == Keys.Enter || base.IsInputKey(k); }
        protected override void OnKeyDown(KeyEventArgs e) {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { e.Handled = true; OnClick(EventArgs.Empty); }
            base.OnKeyDown(e);
        }
        protected override void OnPaint(PaintEventArgs e) {
            if (P == null) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            RectangleF r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            Color fill = Color.Transparent, border = Color.Transparent, fg = P.Fg;
            if (Kind == "primary") {
                fill = hot ? P.Fg2 : P.Fg; border = fill; fg = P.Canvas;
                if (down) fill = Ui.Mix(P.Fg2, P.Canvas, 0.85);
            } else if (Kind == "ghost") {
                fg = hot ? P.Fg : P.Fg3; if (hot) fill = P.Raised;
            } else {
                fill = hot ? P.Raised : P.Canvas; border = P.LineStrong; fg = P.Fg;
            }
            if (!Enabled) { fill = Ui.A(fill, fill.A / 3); border = Ui.A(border, border.A / 3); fg = Ui.A(fg, 90); }
            using (GraphicsPath path = Ui.Round(r, r.Height / 2f)) {
                if (fill.A > 0) using (SolidBrush b = new SolidBrush(fill)) g.FillPath(b, path);
                if (border.A > 0) using (Pen p = new Pen(border)) g.DrawPath(p, path);
            }
            if (Focused && Enabled && ShowFocusCues) {
                using (Pen p = new Pen(Ui.A(P.Fg, 80), 2f))
                using (GraphicsPath ring = Ui.Round(new RectangleF(r.X - 1, r.Y - 1, r.Width + 2, r.Height + 2), r.Height / 2f + 1)) g.DrawPath(p, ring);
            }
            // grayscale antialiasing: ClearType on a transparent control leaves coloured fringes
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            using (StringFormat sf = new StringFormat(StringFormatFlags.NoWrap))
            using (SolidBrush tb = new SolidBrush(fg)) {
                sf.Alignment = StringAlignment.Center; sf.LineAlignment = StringAlignment.Center; sf.HotkeyPrefix = HotkeyPrefix.None;
                RectangleF box = new RectangleF(0, 0, Width, Height);
                if (!String.IsNullOrEmpty(Glyph)) g.DrawString(Glyph, Ui.F("Segoe MDL2 Assets", 11), tb, box, sf);
                else g.DrawString(Text, Font, tb, box, sf);
            }
        }
    }

    // The input look: 8px radius, hairline border, a 2px ring and a darker border when focused. Hosts a borderless TextBox.
    public class FieldFrame : Control {
        public TrayPalette P;
        bool focus;
        public FieldFrame() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }
        public void Attach(Control child) {
            Controls.Add(child);
            child.GotFocus += delegate { focus = true; Invalidate(); };
            child.LostFocus += delegate { focus = false; Invalidate(); };
        }
        protected override void OnPaint(PaintEventArgs e) {
            if (P == null) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int m = Ui.S(2);
            RectangleF r = new RectangleF(m + 0.5f, m + 0.5f, Width - 2 * m - 1.5f, Height - 2 * m - 1.5f);
            using (GraphicsPath path = Ui.Round(r, Ui.S(8))) {
                if (focus) using (Pen ring = new Pen(Ui.A(P.Fg, 26), m * 2f)) g.DrawPath(ring, path);
                using (SolidBrush b = new SolidBrush(P.Canvas)) g.FillPath(b, path);
                using (Pen p = new Pen(focus ? Ui.A(P.Fg, 153) : P.Line)) g.DrawPath(p, path);
            }
        }
    }

    // A dropdown in the same look; its list is a menu drawn with the tray renderer.
    public class SelectBox : Control {
        public TrayPalette P;
        public List<string> Items = new List<string>();
        public event EventHandler SelectedIndexChanged;
        int sel = -1;
        bool hot, open;
        public SelectBox() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.SupportsTransparentBackColor | ControlStyles.Selectable, true);
            BackColor = Color.Transparent; Cursor = Cursors.Hand; TabStop = true;
        }
        public int SelectedIndex {
            get { return sel; }
            set { if (value != sel) { sel = value; Invalidate(); if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty); } }
        }
        protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hot = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override bool IsInputKey(Keys k) { return k == Keys.Down || k == Keys.Up || base.IsInputKey(k); }
        protected override void OnMouseDown(MouseEventArgs e) { Focus(); ShowList(); base.OnMouseDown(e); }
        protected override void OnKeyDown(KeyEventArgs e) {
            if (e.KeyCode == Keys.Down || e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { e.Handled = true; ShowList(); }
            base.OnKeyDown(e);
        }
        public void ShowList() {
            if (open || Items.Count == 0 || P == null) return;
            ContextMenuStrip m = new ContextMenuStrip();
            m.Renderer = new TrayRenderer(P);
            m.ShowImageMargin = true; m.ShowCheckMargin = false;
            m.Padding = new Padding(0, Ui.S(4), 0, Ui.S(4));
            m.DropShadowEnabled = true;
            m.MinimumSize = new Size(Width - Ui.S(4), 0);     // a drop-down sizes itself from its text; this makes it as wide as the field
            for (int i = 0; i < Items.Count; i++) {
                ToolStripMenuItem it = new ToolStripMenuItem(Items[i]);
                it.AutoSize = false; it.Size = new Size(Width - Ui.S(4), Ui.S(32));
                it.Font = Ui.F(Ui.Sans, 13);
                it.Padding = new Padding(Ui.S(8), 0, Ui.S(8), 0);
                it.ImageScaling = ToolStripItemImageScaling.None;
                if (i == sel) it.Image = Check(P.Fg);
                int idx = i;
                it.Click += delegate { SelectedIndex = idx; };
                m.Items.Add(it);
            }
            open = true; Invalidate();
            m.Closed += delegate { open = false; Invalidate(); };
            m.Show(this, new Point(Ui.S(2), Height - Ui.S(2)));
        }
        static Bitmap Check(Color c) {
            int n = Ui.S(16);
            Bitmap b = new Bitmap(n, n);
            using (Graphics g = Graphics.FromImage(b)) {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (Pen p = new Pen(c, Math.Max(1.5f, (float)(1.6 * Ui.Scale)))) {
                    p.StartCap = LineCap.Round; p.EndCap = LineCap.Round; p.LineJoin = LineJoin.Round;
                    g.DrawLines(p, new PointF[] { new PointF(n * 0.24f, n * 0.54f), new PointF(n * 0.43f, n * 0.72f), new PointF(n * 0.77f, n * 0.30f) });
                }
            }
            return b;
        }
        protected override void OnPaint(PaintEventArgs e) {
            if (P == null) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            int m = Ui.S(2);
            RectangleF r = new RectangleF(m + 0.5f, m + 0.5f, Width - 2 * m - 1.5f, Height - 2 * m - 1.5f);
            bool focus = (Focused && ShowFocusCues) || open;
            using (GraphicsPath path = Ui.Round(r, Ui.S(8))) {
                if (focus) using (Pen ring = new Pen(Ui.A(P.Fg, 26), m * 2f)) g.DrawPath(ring, path);
                using (SolidBrush b = new SolidBrush(P.Canvas)) g.FillPath(b, path);
                using (Pen p = new Pen(focus ? Ui.A(P.Fg, 153) : (hot ? P.LineStrong : P.Line))) g.DrawPath(p, path);
            }
            string text = (sel >= 0 && sel < Items.Count) ? Items[sel] : "";
            Rectangle tr = new Rectangle(m + Ui.S(12), m, Width - 2 * m - Ui.S(12) - Ui.S(34), Height - 2 * m);
            TextRenderer.DrawText(g, text, Ui.F(Ui.Sans, 13), tr, P.Fg,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            // chevron
            float cx = Width - m - Ui.S(17), cy = Height / 2f, w = (float)Ui.S(4.5);
            using (Pen p = new Pen(P.Fg3, Math.Max(1.4f, (float)(1.4 * Ui.Scale)))) {
                p.StartCap = LineCap.Round; p.EndCap = LineCap.Round; p.LineJoin = LineJoin.Round;
                g.DrawLines(p, new PointF[] { new PointF(cx - w, cy - w * 0.4f), new PointF(cx, cy + w * 0.6f), new PointF(cx + w, cy - w * 0.4f) });
            }
        }
    }

    // The sidebar's brand block (logo, the name, the small tagline beneath it) as a menu row, so it fills the menu's width.
    public class BrandItem : ToolStripMenuItem {
        public TrayPalette P; public Image Logo;
        public BrandItem() { Enabled = false; AutoSize = false; }
        protected override void OnPaint(PaintEventArgs e) {
            if (P == null) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            int pad = Ui.S(16), icon = Ui.S(22);
            if (Logo != null) g.DrawImage(Logo, pad, (Height - icon) / 2, icon, icon);
            int tx = pad + icon + Ui.S(10);
            Rectangle top = new Rectangle(tx, Height / 2 - Ui.S(17), Width - tx - pad, Ui.S(18));
            Rectangle bot = new Rectangle(tx, Height / 2 + Ui.S(1), Width - tx - pad, Ui.S(15));
            TextFormatFlags f = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
            TextRenderer.DrawText(g, "Oficina", Ui.F(Ui.Semi, 14), top, P.Fg, f);
            TextRenderer.DrawText(g, "agent router", Ui.F(Ui.Sans, 11), bot, P.Fg4, f);
        }
    }

    // The sidebar footer's status (a dot and one line of text) as a menu row.
    public class StatusItem : ToolStripMenuItem {
        public TrayPalette P;
        public StatusItem() { Enabled = false; AutoSize = false; }
        protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }
        protected override void OnPaint(PaintEventArgs e) {
            if (P == null) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            Color dot = Text.StartsWith("Running") ? P.Ok : (Text.StartsWith("Stopped") ? P.Bad : P.Fg4);
            int pad = Ui.S(16), d = Ui.S(7);
            using (SolidBrush b = new SolidBrush(dot)) g.FillEllipse(b, pad + Ui.S(1), (Height - d) / 2f, d, d);
            int tx = pad + Ui.S(15);
            TextRenderer.DrawText(g, Text, Ui.F(Ui.Sans, 12), new Rectangle(tx, 0, Width - tx - pad, Height), P.Fg3,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        }
    }

    // The menu look: surface, hairline border, rows that highlight like the sidebar's nav links.
    public class TrayRenderer : ToolStripProfessionalRenderer {
        public TrayPalette P;
        public TrayRenderer(TrayPalette p) : base() { P = p; RoundedEdges = false; }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) {
            using (SolidBrush b = new SolidBrush(P.Surface)) e.Graphics.FillRectangle(b, e.AffectedBounds);
        }
        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) {
            using (Pen p = new Pen(P.Line)) e.Graphics.DrawRectangle(p, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
        }
        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e) { e.ArrowColor = P.Fg3; base.OnRenderArrow(e); }
        protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e) {
            if (e.Image == null) return;
            e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            e.Graphics.DrawImage(e.Image, e.ImageRectangle);
        }
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
            ToolStripItem item = e.Item;
            if (!item.Selected || !item.Enabled) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            RectangleF r = new RectangleF(Ui.S(6), Ui.S(1), item.Width - Ui.S(12) - 1, item.Height - Ui.S(2) - 1);
            bool danger = (item.Tag as string) == "danger";
            using (GraphicsPath path = Ui.Round(r, Ui.S(8)))
            using (SolidBrush b = new SolidBrush(danger ? Ui.A(P.Bad, 28) : P.Raised)) e.Graphics.FillPath(b, path);
        }
        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
            using (Pen p = new Pen(P.Line)) e.Graphics.DrawLine(p, Ui.S(12), e.Item.Height / 2, e.Item.Width - Ui.S(12), e.Item.Height / 2);
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
            string tag = e.Item.Tag as string;
            Color c = e.Item.Selected ? P.Fg : P.Fg2;
            if (tag == "danger" && e.Item.Selected) c = P.Bad;
            if (!e.Item.Enabled) c = P.Fg4;
            TextFormatFlags f = TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding;
            if (e.Text == e.Item.Text) f |= TextFormatFlags.Left | TextFormatFlags.EndEllipsis;
            else { f |= TextFormatFlags.Right; c = P.Fg4; }       // the shortcut hint on the right
            e.Graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, c, f);
        }
    }

    public static class Dwm {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
        // Windows 11: rounded corners (33 = 2) and a dark frame (20); silently ignored where unsupported.
        public static void Apply(IntPtr hwnd, bool dark) {
            try {
                int round = 2; DwmSetWindowAttribute(hwnd, 33, ref round, 4);
                int d = dark ? 1 : 0; DwmSetWindowAttribute(hwnd, 20, ref d, 4);
            } catch (Exception) { }
        }
    }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'Oficina.PillButton').Type) {
    Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $csharp
}
[Oficina.Ui]::InitDpi()
function Px([double]$px) { return [Oficina.Ui]::S($px) }

# ---------------------------------------------------------------------------------------------
# Theme: the website's tokens, following the Windows app theme unless Appearance says otherwise
$script:ThemeMode = 'auto'    # auto = follow the Windows app theme | light | dark
function Get-TrayTheme {
    $light = $true
    if ($script:ThemeMode -eq 'light') { $light = $true }
    elseif ($script:ThemeMode -eq 'dark') { $light = $false }
    else {
        try {
            $v = Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop
            $light = ($v -ne 0)
        } catch { }
    }
    $c = { param($r, $g, $b) [System.Drawing.Color]::FromArgb($r, $g, $b) }
    if ($light) {
        return @{ Dark = $false; Canvas = (& $c 255 255 255); Surface = (& $c 255 255 255); Raised = (& $c 247 247 245); Sunken = (& $c 241 241 241)
                  Line = (& $c 230 230 230); LineStrong = (& $c 210 210 210); Fg = (& $c 0 0 0); Fg2 = (& $c 45 45 45); Fg3 = (& $c 96 96 96); Fg4 = (& $c 150 150 150)
                  Ok = (& $c 30 166 74); Bad = (& $c 220 38 38); Warn = (& $c 180 105 4); Info = (& $c 37 99 235) }
    }
    return @{ Dark = $true; Canvas = (& $c 12 13 15); Surface = (& $c 18 20 24); Raised = (& $c 27 30 36); Sunken = (& $c 9 10 12)
              Line = (& $c 38 42 49); LineStrong = (& $c 58 63 72); Fg = (& $c 238 239 242); Fg2 = (& $c 197 200 208); Fg3 = (& $c 137 142 152); Fg4 = (& $c 93 97 106)
              Ok = (& $c 106 207 142); Bad = (& $c 240 110 110); Warn = (& $c 232 178 84); Info = (& $c 125 165 248) }
}

function New-TrayPalette($t) {
    $p = New-Object Oficina.TrayPalette
    foreach ($k in 'Canvas', 'Surface', 'Raised', 'Sunken', 'Line', 'LineStrong', 'Fg', 'Fg2', 'Fg3', 'Fg4', 'Ok', 'Bad', 'Warn', 'Info') { $p.$k = $t[$k] }
    $p.Dark = [bool]$t.Dark
    return $p
}

# ---------------------------------------------------------------------------------------------
# The logo: four rounded squares, as in the sidebar. With a tile it is the tray icon; without, it sits on a surface.
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
    $n = Px 16
    $bmp = New-Object System.Drawing.Bitmap $n, $n
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $font = New-Object System.Drawing.Font('Segoe MDL2 Assets', [single](Px 14), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush $color
    $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
    $g.DrawString([string][char]$code, $font, $brush, (New-Object System.Drawing.RectangleF 0, 0, $n, $n), $sf)
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
    if ($text -match '\(404\)') { return "The daemon is older than this feature. Quit Oficina from the tray and start it again." }
    if ($text -match 'Unable to connect|refused|timed out|actively refused') { return "Oficina isn't running yet. Wait a moment and try again." }
    return $text
}

function Get-QueueCount {
    try { return @(Invoke-OfficeApi 'GET' '/api/queue' $null 2).Count } catch { return -1 }
}

# ---------------------------------------------------------------------------------------------
# Right-click menu
function New-TrayItem([string]$text, [string]$tag = '', [int]$glyph = 0, [string]$hint = '') {
    $it = New-Object System.Windows.Forms.ToolStripMenuItem
    $it.Text = $text
    $it.Tag = $tag
    $it.AutoSize = $false
    $it.Size = New-Object System.Drawing.Size (Px 264), (Px 32)
    $it.Padding = New-Object System.Windows.Forms.Padding (Px 8), 0, (Px 8), 0
    $it.Font = [Oficina.Ui]::F([Oficina.Ui]::Sans, 13)
    $it.ImageScaling = 'None'
    if ($glyph -gt 0) { $it.Name = "glyph:$glyph" }
    if ($hint) { $it.ShortcutKeyDisplayString = $hint }
    return $it
}
function Add-TrayItem($menu, [string]$text, [string]$tag = '', [int]$glyph = 0, [string]$hint = '') {
    $it = New-TrayItem $text $tag $glyph $hint
    [void]$menu.Items.Add($it)
    return $it
}

function Add-TraySeparator($menu) {
    $s = New-Object System.Windows.Forms.ToolStripSeparator
    $s.AutoSize = $false
    $s.Size = New-Object System.Drawing.Size (Px 264), (Px 9)
    [void]$menu.Items.Add($s)
}

# The whole menu: the brand block, a status line, the actions, appearance, and Quit.
function New-TrayMenu {
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $menu.ShowImageMargin = $true
    $menu.ShowCheckMargin = $false
    $menu.Padding = New-Object System.Windows.Forms.Padding 0, (Px 4), 0, (Px 4)
    $menu.MinimumSize = New-Object System.Drawing.Size (Px 264), 0     # a drop-down sizes itself from its text; this fixes the width the rows are laid out for
    $brand = New-Object Oficina.BrandItem
    $brand.Size = New-Object System.Drawing.Size (Px 264), (Px 52)
    [void]$menu.Items.Add($brand)
    $status = New-Object Oficina.StatusItem
    $status.Text = 'Starting...'
    $status.Size = New-Object System.Drawing.Size (Px 264), (Px 26)
    [void]$menu.Items.Add($status)
    Add-TraySeparator $menu
    $new = Add-TrayItem $menu 'New request' 'accent' 0xE710
    $open = Add-TrayItem $menu 'Open Oficina' '' 0xE8A7
    $queue = Add-TrayItem $menu 'Queue' '' 0xE8FD
    Add-TraySeparator $menu
    $appear = Add-TrayItem $menu 'Appearance' '' 0xE790
    $themeItems = @{}
    foreach ($pair in @(@('auto', 'Match Windows'), @('light', 'Light'), @('dark', 'Dark'))) {
        $child = New-TrayItem $pair[1] ("theme:" + $pair[0])
        $child.Size = New-Object System.Drawing.Size (Px 192), (Px 32)
        [void]$appear.DropDownItems.Add($child)
        $themeItems[$pair[0]] = $child
    }
    $appear.DropDown.ShowImageMargin = $true
    $appear.DropDown.ShowCheckMargin = $false
    $appear.DropDown.Padding = New-Object System.Windows.Forms.Padding 0, (Px 4), 0, (Px 4)
    $appear.DropDown.MinimumSize = New-Object System.Drawing.Size (Px 192), 0
    $quit = Add-TrayItem $menu 'Quit Oficina' 'danger' 0xE7E8
    return @{ Menu = $menu; Brand = $brand; Status = $status; New = $new; Open = $open; Queue = $queue; Quit = $quit; Appearance = $appear; ThemeAuto = $themeItems['auto']; ThemeLight = $themeItems['light']; ThemeDark = $themeItems['dark'] }
}

# Re-skin for the current theme; run each time the menu opens so a theme switch is picked up.
function Update-TrayMenuTheme($menu) {
    $t = Get-TrayTheme
    $p = New-TrayPalette $t
    $menu.Renderer = New-Object Oficina.TrayRenderer $p
    $menu.BackColor = $t.Surface
    $menu.DropShadowEnabled = $true
    foreach ($it in $menu.Items) {
        if ($it -is [Oficina.BrandItem]) {
            $it.P = $p
            if ($it.Logo) { $it.Logo.Dispose() }
            $it.Logo = New-LogoBitmap (Px 22) $false $t.Fg
        }
        if ($it -is [Oficina.StatusItem]) { $it.P = $p }
        if ($it -is [System.Windows.Forms.ToolStripMenuItem] -and $it.Name -like 'glyph:*') {
            $code = [int]($it.Name.Substring(6))
            $col = if ($it.Tag -eq 'danger') { $t.Bad } else { $t.Fg3 }
            if ($it.Image) { $it.Image.Dispose() }
            $it.Image = New-GlyphImage $code $col
        }
        if ($it -is [System.Windows.Forms.ToolStripMenuItem] -and $it.HasDropDownItems) {
            $dd = $it.DropDown
            $dd.Renderer = New-Object Oficina.TrayRenderer $p
            $dd.BackColor = $t.Surface
            $dd.DropShadowEnabled = $true
            foreach ($c in $it.DropDownItems) {
                if ($c.Image) { $c.Image.Dispose(); $c.Image = $null }
                if ($c.Tag -eq ("theme:" + $script:ThemeMode)) { $c.Image = New-GlyphImage 0xE73E $t.Fg }   # check mark
            }
        }
    }
    try { [Oficina.Dwm]::Apply($menu.Handle, $t.Dark) } catch { }
}

# ---------------------------------------------------------------------------------------------
# Settings kept between sessions: the theme and the last office queued into
$script:SettingsFile = Join-Path $env:LOCALAPPDATA 'Oficina\tray.json'
$script:OldSettingsFile = Join-Path $env:LOCALAPPDATA 'officeChain\tray.json'   # read once if the new file does not exist yet

function Read-TraySettings {
    foreach ($f in $script:SettingsFile, $script:OldSettingsFile) {
        try { return Get-Content $f -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
    }
    return $null
}
function Update-TraySettings([hashtable]$patch) {
    try {
        $cur = @{}
        $old = Read-TraySettings
        if ($old) { foreach ($p in $old.PSObject.Properties) { $cur[$p.Name] = $p.Value } }
        foreach ($k in $patch.Keys) { $cur[$k] = $patch[$k] }
        $dir = Split-Path $script:SettingsFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        ($cur | ConvertTo-Json -Compress) | Set-Content -Path $script:SettingsFile -Encoding UTF8
    } catch { }
}
function Save-TraySettings([string]$officeId) { Update-TraySettings @{ lastOfficeId = $officeId } }

function Initialize-TrayTheme {
    $s = Read-TraySettings
    if ($s -and (@('auto', 'light', 'dark') -contains [string]$s.theme)) { $script:ThemeMode = [string]$s.theme }
}

# Shared by the popup's event handlers. They run as closures, which get their own $script: scope, so state lives in
# one hashtable that every closure captures by reference.
$script:Quick = @{ Form = $null; HiddenAt = [DateTime]::MinValue; Draft = ''; LastOfficeId = $null }

function Set-TrayThemeMode([string]$mode) {
    $script:ThemeMode = $mode
    Update-TraySettings @{ theme = $mode }
    # the popup is built once with its colours; drop it so the next click builds it in the new theme (the draft survives)
    $q = $script:Quick
    if ($q.Form -and -not $q.Form.IsDisposed) { $q.Form.Dispose() }
    $q.Form = $null
}

# ---------------------------------------------------------------------------------------------
# Quick request popup: the website's modal, in the tray. Type a prompt; it joins the chosen office's queue.
function Find-Control($root, [string]$name) {
    foreach ($c in $root.Controls) {
        if ($c.Name -eq $name) { return $c }
        $d = Find-Control $c $name
        if ($d) { return $d }
    }
    return $null
}

function Show-QuickRequest([scriptblock]$OnOpenApp, [scriptblock]$OnQueued) {
    $q = $script:Quick
    # clicking the tray icon while the popup is open first deactivates (hides) it; treat that click as "close"
    if (((Get-Date) - $q.HiddenAt).TotalMilliseconds -lt 450) { return }
    if ($q.Form -and -not $q.Form.IsDisposed) { $q.Form.Show(); $q.Form.Activate(); return }

    $t = Get-TrayTheme
    $P = New-TrayPalette $t
    $ui = [Oficina.Ui]
    $sans = $ui::Sans; $semi = $ui::Semi; $mono = $ui::Mono
    $W = Px 440; $H = Px 392; $pad = Px 20
    $footerH = Px 60; $footerTop = $H - $footerH
    $footerFill = $ui::Mix($t.Raised, $t.Surface, 0.4)

    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'; $form.ShowInTaskbar = $false
    $form.TopMost = $true; $form.KeyPreview = $true; $form.BackColor = $t.Surface; $form.ForeColor = $t.Fg
    $form.Size = New-Object System.Drawing.Size $W, $H
    $form.Font = $ui::F($sans, 13)
    # beside the tray icon: the screen that was clicked, on the side the taskbar is
    $cur = [System.Windows.Forms.Cursor]::Position
    $scr = [System.Windows.Forms.Screen]::FromPoint($cur)
    $wa = $scr.WorkingArea
    $gap = Px 12
    $x = if ($cur.X -lt ($scr.Bounds.X + $scr.Bounds.Width / 2)) { $wa.Left + $gap } else { $wa.Right - $W - $gap }
    $y = if ($cur.Y -lt ($scr.Bounds.Y + $scr.Bounds.Height / 2)) { $wa.Top + $gap } else { $wa.Bottom - $H - $gap }
    $form.Location = New-Object System.Drawing.Point $x, $y

    $label = {
        param($text, $px, $py, $w, $h, $font, $color)
        $l = New-Object System.Windows.Forms.Label
        $l.AutoSize = $false; $l.Text = $text; $l.Location = New-Object System.Drawing.Point $px, $py; $l.Size = New-Object System.Drawing.Size $w, $h
        $l.Font = $font; $l.ForeColor = $color; $l.BackColor = [System.Drawing.Color]::Transparent
        $l.TextAlign = 'MiddleLeft'
        $form.Controls.Add($l); return $l
    }
    $eyebrow = $ui::F($mono, 10.5)
    $inner = $W - 2 * $pad

    # ---- header
    [void](& $label 'Quick request' $pad (Px 16) (Px 300) (Px 24) ($ui::F($semi, 16)) $t.Fg)
    $close = New-Object Oficina.PillButton
    $close.P = $P; $close.Kind = 'ghost'; $close.Glyph = [string][char]0xE711; $close.Name = 'qrClose'
    $close.Location = New-Object System.Drawing.Point ($W - $pad - (Px 28) + (Px 4)), (Px 14); $close.Size = New-Object System.Drawing.Size (Px 28), (Px 28)
    $form.Controls.Add($close)
    $sub = & $label '' $pad (Px 44) $inner (Px 36) ($ui::F($sans, 13)) $t.Fg3
    $sub.TextAlign = 'TopLeft'

    # ---- office
    [void](& $label 'OFFICE' $pad (Px 90) (Px 200) (Px 14) $eyebrow $t.Fg3)
    $sel = New-Object Oficina.SelectBox
    $sel.P = $P; $sel.Name = 'qrOffice'
    $sel.Location = New-Object System.Drawing.Point ($pad - (Px 2)), ((Px 108) - (Px 2)); $sel.Size = New-Object System.Drawing.Size ($inner + (Px 4)), ((Px 32) + (Px 4))
    $form.Controls.Add($sel)

    # ---- request
    [void](& $label 'REQUEST' $pad (Px 152) (Px 200) (Px 14) $eyebrow $t.Fg3)
    $frame = New-Object Oficina.FieldFrame
    $frame.P = $P
    $frame.Location = New-Object System.Drawing.Point ($pad - (Px 2)), ((Px 170) - (Px 2)); $frame.Size = New-Object System.Drawing.Size ($inner + (Px 4)), ((Px 116) + (Px 4))
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Name = 'qrText'; $tb.Multiline = $true; $tb.BorderStyle = 'None'; $tb.AcceptsReturn = $true; $tb.ScrollBars = 'None'; $tb.MaxLength = 8000
    $tb.Location = New-Object System.Drawing.Point (Px 14), (Px 11); $tb.Size = New-Object System.Drawing.Size ($inner - (Px 24)), ((Px 116) - (Px 18))
    $tb.BackColor = $t.Canvas; $tb.ForeColor = $t.Fg; $tb.Font = $ui::F($sans, 14)
    $frame.Attach($tb)
    $cue = New-Object System.Windows.Forms.Label
    $cue.AutoSize = $false
    $cue.Text = "What should the team build or fix?`nPress Ctrl+Enter to add it to the queue."
    $cue.Location = New-Object System.Drawing.Point (Px 14), (Px 11); $cue.Size = New-Object System.Drawing.Size ($inner - (Px 24)), (Px 44)
    $cue.Font = $ui::F($sans, 14); $cue.ForeColor = $t.Fg4; $cue.BackColor = $t.Canvas
    $cue.Add_Click({ $tb.Focus() }.GetNewClosure())
    $frame.Controls.Add($cue); $cue.BringToFront()
    $form.Controls.Add($frame)

    $status = & $label '' $pad (Px 294) ($inner - (Px 90)) (Px 20) ($ui::F($sans, 13)) $t.Fg3
    $status.Name = 'qrStatus'
    $count = & $label '' ($W - $pad - (Px 90)) (Px 294) (Px 90) (Px 20) ($ui::F($sans, 11)) $t.Fg4
    $count.TextAlign = 'MiddleRight'

    # ---- footer (the website modal's footer: hairline above, a faint fill)
    $openApp = & $label 'Open Oficina' $pad ($footerTop + (Px 20)) (Px 130) (Px 20) ($ui::F($sans, 13)) $t.Fg3
    $openApp.Cursor = [System.Windows.Forms.Cursors]::Hand; $openApp.Name = 'qrOpen'
    $openApp.Add_Click({ $form.Hide(); if ($OnOpenApp) { & $OnOpenApp } }.GetNewClosure())
    $openApp.Add_MouseEnter({ $openApp.ForeColor = $t.Fg }.GetNewClosure()); $openApp.Add_MouseLeave({ $openApp.ForeColor = $t.Fg3 }.GetNewClosure())
    $add = New-Object Oficina.PillButton
    $add.P = $P; $add.Kind = 'primary'; $add.Text = 'Add to queue'; $add.Name = 'qrAdd'; $add.Font = $ui::F($semi, 13)
    $add.Size = New-Object System.Drawing.Size (Px 128), (Px 32); $add.Location = New-Object System.Drawing.Point ($W - $pad - (Px 128)), ($footerTop + (Px 14))
    $cancel = New-Object Oficina.PillButton
    $cancel.P = $P; $cancel.Kind = 'ghost'; $cancel.Text = 'Cancel'; $cancel.Name = 'qrCancel'; $cancel.Font = $ui::F($semi, 13)
    $cancel.Size = New-Object System.Drawing.Size (Px 76), (Px 32); $cancel.Location = New-Object System.Drawing.Point ($W - $pad - (Px 128) - (Px 8) - (Px 76)), ($footerTop + (Px 14))
    $form.Controls.Add($cancel); $form.Controls.Add($add)

    # ---- offices
    $offices = @(); $autos = @()
    try { $offices = @(Invoke-OfficeApi 'GET' '/api/workspaces' $null 2) } catch { }
    foreach ($o in $offices) { [void]$sel.Items.Add([string]$o.name); $autos += [bool]($o.settings.autoStartQueue) }
    $saved = Read-TraySettings
    $want = if ($q.LastOfficeId) { $q.LastOfficeId } elseif ($saved) { $saved.lastOfficeId } else { $null }
    $idx = 0
    for ($i = 0; $i -lt $offices.Count; $i++) { if ($offices[$i].id -eq $want) { $idx = $i } }
    $setSub = {
        if ($offices.Count -eq 0) { $sub.Text = "Oficina isn't running yet. This will work in a moment."; return }
        if ($autos[$sel.SelectedIndex]) { $sub.Text = "This office starts queued requests by itself when it's idle, one at a time." }
        else { $sub.Text = "It waits in this office's queue. Nothing runs until you press Start on the dashboard." }
    }.GetNewClosure()
    $sel.add_SelectedIndexChanged($setSub)
    if ($offices.Count -gt 0) { $sel.SelectedIndex = $idx } else { & $setSub }

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
        if (-not $text) { $status.ForeColor = $t.Bad; $status.Text = 'Type a request first.'; return }
        if ($offices.Count -eq 0 -or $sel.SelectedIndex -lt 0) { $status.ForeColor = $t.Bad; $status.Text = "Oficina isn't running yet."; return }
        $office = $offices[$sel.SelectedIndex]
        $add.Enabled = $false
        try {
            [void](Invoke-OfficeApi 'POST' '/api/queue' @{ text = $text; workspaceId = $office.id; source = 'tray' } 4)
            $q.LastOfficeId = $office.id; Save-TraySettings $office.id
            $q.Draft = ''; $tb.Text = ''
            $status.Tag = 'sticky'; $status.ForeColor = $t.Ok; $status.Text = "Queued in $($office.name)"
            $hideTimer.Start()
            if ($OnQueued) { & $OnQueued $text $office.name }
        } catch {
            $status.ForeColor = $t.Bad; $status.Text = (Get-ApiError $_)
        }
        $add.Enabled = $true
    }.GetNewClosure()
    $add.Add_Click($submit)
    $cancel.Add_Click({ $form.Hide() }.GetNewClosure())
    $close.Add_Click({ $form.Hide() }.GetNewClosure())
    $tb.Add_KeyDown({ if ($_.Control -and $_.KeyCode -eq 'Return') { $_.SuppressKeyPress = $true; & $submit } }.GetNewClosure())
    $form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $form.Hide() } }.GetNewClosure())
    $form.Add_Deactivate({ if ($form.Visible) { $form.Hide() } }.GetNewClosure())
    $form.Add_VisibleChanged({
        if (-not $form.Visible) { $q.Draft = $tb.Text; $q.HiddenAt = Get-Date }
        else { $form.Activate(); $tb.Focus() }
    }.GetNewClosure())
    $radius = Px 16
    $form.Add_Paint({
        $g = $_.Graphics; $g.SmoothingMode = 'AntiAlias'
        $b = New-Object System.Drawing.SolidBrush $footerFill
        $g.FillRectangle($b, 0, $footerTop, $form.Width, $form.Height - $footerTop); $b.Dispose()
        $line = New-Object System.Drawing.Pen $t.Line, 1
        $g.DrawLine($line, 0, $footerTop, $form.Width, $footerTop)
        $g.DrawPath($line, [Oficina.Ui]::Round((New-Object System.Drawing.RectangleF 0.5, 0.5, ($form.Width - 1.5), ($form.Height - 1.5)), $radius))
        $line.Dispose()
    }.GetNewClosure())
    $form.Region = New-Object System.Drawing.Region ([Oficina.Ui]::Round((New-Object System.Drawing.RectangleF 0, 0, $form.Width, $form.Height), $radius))
    $q.Form = $form
    $form.Add_Shown({ try { [Oficina.Dwm]::Apply($form.Handle, $t.Dark) } catch { } }.GetNewClosure())
    $form.Show(); $form.Activate(); $tb.Focus()
}
