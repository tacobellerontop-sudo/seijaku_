// seijaku.exe for builds on Mozilla's own signed engine: Mozilla's files stay
// exactly as Mozilla ships them (firefox.exe included), and this starts
// firefox.exe with Seijaku's shell. Arguments are passed on unchanged:
// every caller (Seijaku.bat, the installer shortcuts, the open commands,
// the update restart) already passes -app, so the launcher adds nothing
// of its own — except when -app is missing entirely (a bare double-click),
// where it supplies the shell's application.ini, so the launcher is a
// complete entry point on its own instead of starting a bare engine.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

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
        string engine = Path.Combine(dir, "firefox.exe");
        if (!File.Exists(engine))
        {
            MessageBox(IntPtr.Zero, "Seijaku can't find firefox.exe next to seijaku.exe. Reinstall Seijaku.", "Seijaku", 0x10);
            return 1;
        }
        var line = new StringBuilder();
        if (Array.IndexOf(args, "-app") < 0)
        {
            line.Append("-app ").Append(Quote(Path.Combine(dir, "seijaku", "application.ini")));
        }
        foreach (string arg in args)
        {
            if (line.Length > 0) line.Append(' ');
            line.Append(Quote(arg));
        }
        var info = new ProcessStartInfo(engine, line.ToString()) { UseShellExecute = false };
        using (var p = Process.Start(info))
        {
            // -wait-for-browser (kept from Breached's launcher) waits for the browser to close.
            if (Array.IndexOf(args, "-wait-for-browser") >= 0) { p.WaitForExit(); return p.ExitCode; }
        }
        return 0;
    }
}
