// NOTE (0.1.2): this launcher is no longer built. package.ps1 renames
// the engine binary itself to seijaku.exe instead, so Task Manager
// shows Seijaku and no launcher is needed. Kept for reference only.
// seijaku.exe: starts Mozilla's firefox.exe (kept exactly as Mozilla
// ships it, so signed-engine sites still work) with Seijaku's shell.
// Arguments are passed on, so the portable start script can add -profile.
// Needs nothing but .NET Framework, which Windows 10 and 11 already have.
//
// Why this stays running: the browser window belongs to firefox.exe, so
// Windows would otherwise show Firefox's icon on the taskbar, in Alt+Tab
// and in the window switcher, even though seijaku.exe itself (Start menu,
// pinned shortcut) already carries the seal icon. The launcher therefore
// waits for the browser's windows to appear and stamps the seal icon onto
// each of them with WM_SETICON, then exits with the browser's exit code
// when it closes. If seijaku.ico is missing, it just waits: launching
// must never fail because of an icon.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Launcher
{
    const uint WM_SETICON = 0x0080;
    static readonly IntPtr ICON_SMALL = IntPtr.Zero;
    static readonly IntPtr ICON_BIG = new IntPtr(1);

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    // LoadImage straight from user32, not System.Drawing: the OS reads
    // PNG-compressed .ico entries fine, .NET Framework's Icon does not.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr LoadImage(IntPtr hInst, string name, uint type, int cx, int cy, uint fuLoad);
    const uint IMAGE_ICON = 1;
    const uint LR_LOADFROMFILE = 0x10;

    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); }
            else { sb.Append('\\', slashes); }
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes * 2).Append('"');
        return sb.ToString();
    }

    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        var line = new StringBuilder("-app " + Quote(Path.Combine(dir, "seijaku", "application.ini")));
        foreach (string arg in args) line.Append(' ').Append(Quote(arg));
        var info = new ProcessStartInfo(Path.Combine(dir, "firefox.exe"), line.ToString()) { UseShellExecute = false };
        using (var p = Process.Start(info))
        {
            // The seal icon, drawn at build time into seijaku.ico next to
            // this launcher (installer and portable zip both include it).
            IntPtr big = IntPtr.Zero, small = IntPtr.Zero;
            try
            {
                string iconPath = Path.Combine(dir, "seijaku.ico");
                if (File.Exists(iconPath))
                {
                    big = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
                    small = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
                }
            }
            catch { big = IntPtr.Zero; small = IntPtr.Zero; }

            if (big == IntPtr.Zero)
            {
                p.WaitForExit();
                return p.ExitCode;
            }

            var done = new HashSet<IntPtr>();
            while (!p.HasExited)
            {
                int pid = p.Id;
                EnumWindows((hwnd, unused) =>
                {
                    if (done.Contains(hwnd)) return true;
                    uint wpid;
                    GetWindowThreadProcessId(hwnd, out wpid);
                    if (wpid == pid && IsWindowVisible(hwnd))
                    {
                        SendMessage(hwnd, WM_SETICON, ICON_BIG, big);
                        SendMessage(hwnd, WM_SETICON, ICON_SMALL, small);
                        done.Add(hwnd);
                    }
                    return true;
                }, IntPtr.Zero);
                Thread.Sleep(500);
            }
            return p.ExitCode;
        }
    }
}
