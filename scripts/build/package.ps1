# Builds the portable Seijaku app for Windows from Mozilla's prebuilt Gecko.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build\package.ps1 -Installer "Firefox Setup.exe" -Out out
#
# This runs in the Release workflow, not on your computer: the workflow
# downloads the Firefox installer, extracts the engine, and builds this.
# It takes the engine (xul.dll and the Gecko runtime files) out of the
# official Firefox installer, drops Firefox's own front end (browser\) and
# the background helpers Seijaku doesn't use, keeps firefox.exe exactly
# as Mozilla signed it, and adds the Seijaku shell from shell\.
# firefox.exe stays unrenamed on purpose: sites that only play video in
# browsers whose engine Google has certified need the certified name,
# so protected video (Netflix and the like) loads its Widevine CDM
# under it — the renamed binary downloaded Widevine fine but the CDM
# would not load. The entry point is a small launcher, seijaku.exe
# (scripts\build\Launcher.cs, compiled below with the .NET Framework
# compiler on the runner, Breached's method), which starts firefox.exe
# with the shell and passes its arguments through. Task Manager
# therefore shows firefox.exe for the running browser — that is the
# accepted trade-off for DRM playback. The window's taskbar grouping
# is unaffected: it comes from the AppUserModelID the shell sets on
# its window, not the binary name.
# Result: <Out>\seijaku\ with Seijaku.bat to start it as a portable app.
# Needs 7-Zip (7z) and Python 3 on PATH, both present on GitHub's
# Windows runners.

param(
    [Parameter(Mandatory)] [string] $Installer,
    [string] $Out = "out"
)
$ErrorActionPreference = 'Stop'
# $PSScriptRoot is scripts\build, so the repo root is two levels up.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$extract = Join-Path $Out 'extract'
$app = Join-Path $Out 'seijaku'
Remove-Item -Recurse -Force $extract, $app -ErrorAction SilentlyContinue
& 7z x $Installer "-o$extract" -y | Out-Null
if ($LASTEXITCODE) { throw "7z failed on $Installer" }
# Mozilla's installer keeps the files in core\.
$engine = Join-Path $extract 'core'
if (-not (Test-Path $engine)) { throw "no engine folder in $Installer" }
Move-Item $engine $app

# Firefox's front end and the background helpers Seijaku doesn't use.
# Dropping these is part of the lightness: no Mozilla updater (Seijaku
# updates itself from GitHub instead), no maintenance service, no
# crash reporter, no background agent, no Firefox front end.
$drop = @(
    'browser', 'uninstall', 'distribution',
    'default-browser-agent.exe', 'maintenanceservice.exe', 'maintenanceservice_installer.exe',
    'updater.exe', 'updater.ini', 'update-settings.ini', 'pingsender.exe',
    'private_browsing.exe', 'private_browsing.VisualElementsManifest.xml',
    'crashreporter.exe', 'crashhelper.exe', 'minidump-analyzer.exe', 'nmhproxy.exe',
    'firefox.VisualElementsManifest.xml', 'precomplete', 'removed-files',
    'fonts', 'gmp-clearkey'
)
foreach ($name in $drop) {
    Remove-Item -Recurse -Force (Join-Path $app $name) -ErrorAction SilentlyContinue
}

# The seal icon, drawn at build time (see make-icon.py). The installer
# needs it, so if Pillow is missing, install it and try again before
# giving up: without an icon, the installer build below would fail.
$icon = Join-Path $app 'seijaku.ico'
& python (Join-Path $repo 'scripts\build\make-icon.py') --out $icon | Out-Null
if (-not (Test-Path $icon)) {
    & python -m pip install --quiet pillow | Out-Null
    & python (Join-Path $repo 'scripts\build\make-icon.py') --out $icon | Out-Null
}
if (-not (Test-Path $icon)) { throw 'the seal icon could not be drawn (needs Pillow and a CJK font)' }

# The launcher: seijaku.exe starts firefox.exe (kept exactly as Mozilla
# signed it) with the shell. Compiled with the .NET Framework compiler,
# the same method Breached uses for its launcher on these runners. The
# seal icon (drawn above) becomes the launcher's file icon. A failed
# compile must fail the build: a package without its entry point is
# useless, and a silent fallback would ship it anyway.
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:winexe "/win32icon:$icon" "/out:$(Join-Path $app 'seijaku.exe')" (Join-Path $repo 'scripts\build\Launcher.cs')
if ($LASTEXITCODE) { throw "Launcher.cs failed to compile (csc exit code $LASTEXITCODE)" }

# The shell.
Copy-Item -Recurse (Join-Path $repo 'shell') (Join-Path $app 'seijaku')

# Stamp the engine's real version and build ID into the packaged
# application.ini, so the Widevine download request advertises the
# engine that is actually shipping instead of the repo's hardcoded
# values (which drift as firefox-latest moves on). If platform.ini is
# absent or unreadable, the repo values stand — never fail the build
# over this.
$platformIni = Join-Path $app 'platform.ini'
$packagedIni = Join-Path $app 'seijaku\application.ini'
if ((Test-Path $platformIni) -and (Test-Path $packagedIni)) {
    $milestone = $null; $buildId = $null
    foreach ($line in (Get-Content $platformIni)) {
        if ($line -match '^Milestone=(.+)$') { $milestone = $Matches[1].Trim() }
        if ($line -match '^BuildID=(.+)$') { $buildId = $Matches[1].Trim() }
    }
    if ($milestone -and $buildId) {
        $iniText = Get-Content $packagedIni -Raw
        $iniText = $iniText -replace '(?m)^Version=.*$', "Version=$milestone"
        $iniText = $iniText -replace '(?m)^BuildID=.*$', "BuildID=$buildId"
        Set-Content $packagedIni $iniText -Encoding ascii
    }
}

# The window icon, Breached's method: Gecko picks up a window's icon
# from chrome/icons/default/<window-id>.ico, where <window-id> is the id
# of the <html> element in seijaku.xhtml ("seijaku-window"). That icon
# is what Windows shows on the taskbar and in Alt+Tab. The .ico is drawn
# here at build time (same seal as the installer icon), so the repo
# stays text-only.
$windowIconDir = Join-Path $app 'seijaku\chrome\icons\default'
New-Item -ItemType Directory -Force $windowIconDir | Out-Null
Copy-Item $icon (Join-Path $windowIconDir 'seijaku-window.ico')
# Same icon under the content package too, and named by the <html>
# element's icon attribute in seijaku.xhtml: Gecko's window-icon
# lookup base is not documented precisely enough to bet on one path,
# and the file is 7 KB, so cover both.
$contentIconDir = Join-Path $app 'seijaku\chrome\content\icons\default'
New-Item -ItemType Directory -Force $contentIconDir | Out-Null
Copy-Item $icon (Join-Path $contentIconDir 'seijaku-window.ico')

# Portable: the profile lives next to the app, separate from any Firefox.
# The start script launches seijaku.exe — the launcher — which forwards
# everything to firefox.exe. The line itself needs no change: it already
# starts seijaku.exe, which is now the launcher instead of the engine,
# and -app finds the shell, -profile keeps the portable profile next
# to the app, and %* forwards anything else (a URL, -osint).
Set-Content (Join-Path $app 'Seijaku.bat') '@start "" "%~dp0seijaku.exe" -app "%~dp0seijaku\application.ini" -profile "%~dp0profile" -no-remote %*' -Encoding ascii
New-Item -ItemType Directory -Force (Join-Path $app 'profile') | Out-Null

Remove-Item -Recurse -Force $extract
$size = (Get-ChildItem -Recurse $app | Measure-Object Length -Sum).Sum / 1MB
"Seijaku app at $app ({0:N0} MB)" -f $size
