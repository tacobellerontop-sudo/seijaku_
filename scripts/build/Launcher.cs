// seijaku.exe for builds on Mozilla's own signed engine: Mozilla's files stay
// exactly as Mozilla ships them (firefox.exe included), and this starts
// firefox.exe with Seijaku's shell. Arguments are passed on unchanged:
// every caller (Seijaku.bat, the installer shortcuts, the open commands,
// the update restart) already passes -app, so the launcher adds nothing
// of its own — except when -app is missing entirely (a bare double-click),
// where it supplies the shell's application.ini, so the launcher is a
// complete entry point on its own instead of starting a bare engine.
//
// One exception: Windows' open commands (links, "Open with", default
// apps) pass `-osint -url <address or file>`. The engine accepts -osint
// only as the very first argument, followed by nothing but -url and its
// one value, and quits on the spot otherwise (exit code 127), so it can
// never be combined with -app. The launcher makes the same safety check
// itself and passes the value as `-seijaku-open <value>` (Firefox's
// handlers, built into the engine, take -url and try to open a Firefox
// window), and in the SEIJAKU_OPEN environment variable, which is how the
// first window of a cold start finds it. A single file dropped on
// seijaku.exe is passed on the same way.
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

    static bool IsFlag(string arg, string name)
    {
        string bare = arg.TrimStart('-');
        if (arg.StartsWith("/")) bare = arg.Substring(1);
        return bare.Length < arg.Length && string.Equals(bare, name, StringComparison.OrdinalIgnoreCase);
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
        string open = null;
        int osint = Array.FindIndex(args, a => IsFlag(a, "osint"));
        if (osint >= 0)
        {
            // Accepted: [-app <ini>] -osint -url <value>, nothing else, and
            // the value never itself a flag (a crafted link can't add any).
            string[] head = new string[osint];
            Array.Copy(args, head, osint);
            bool headOk = osint == 0 || (osint == 2 && IsFlag(args[0], "app"));
            if (!headOk || args.Length != osint + 3 || !IsFlag(args[osint + 1], "url") ||
                args[osint + 2].Length == 0 || args[osint + 2][0] == '-')
            {
                return 1;
            }
            var safe = new string[head.Length + 2];
            head.CopyTo(safe, 0);
            safe[head.Length] = "-seijaku-open";
            safe[head.Length + 1] = args[osint + 2];
            open = args[osint + 2];
            args = safe;
        }
        else if (args.Length == 1 && args[0].Length > 0 && args[0][0] != '-')
        {
            open = args[0];
            args = new[] { "-seijaku-open", open };
        }
        if (open != null && File.Exists(open))
        {
            open = Path.GetFullPath(open);
            args[args.Length - 1] = open;
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
        info.EnvironmentVariables.Remove("SEIJAKU_OPEN");
        if (open != null) info.EnvironmentVariables["SEIJAKU_OPEN"] = open;
        using (var p = Process.Start(info))
        {
            // -wait-for-browser (kept from Breached's launcher) waits for the browser to close.
            if (Array.IndexOf(args, "-wait-for-browser") >= 0) { p.WaitForExit(); return p.ExitCode; }
        }
        return 0;
    }
}
