// seijaku.exe: starts Mozilla's firefox.exe (kept exactly as Mozilla
// ships it, so signed-engine sites still work) with Seijaku's shell.
// Arguments are passed on, so the portable start script can add -profile.
// Needs nothing but .NET Framework, which Windows 10 and 11 already have.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class Launcher
{
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
            return 0;
        }
    }
}
