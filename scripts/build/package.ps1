# Builds the portable Seijaku app for Windows from Mozilla's prebuilt Gecko.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build\package.ps1 -Installer "Firefox Setup.exe" -Out out
#
# This runs in the Release workflow, not on your computer: the workflow
# downloads the Firefox installer, extracts the engine, and builds this.
# It takes the engine (xul.dll and the Gecko runtime files) out of the
# official Firefox installer, drops Firefox's own front end (browser\) and
# the background helpers Seijaku doesn't use, keeps firefox.exe exactly as
# Mozilla signed it, and adds seijaku.exe (a small launcher, see
# Launcher.cs) plus the Seijaku shell from shell\.
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
# Dropping these is part of the lightness: no updater, no maintenance
# service, no crash reporter, no background agent, no Firefox front end.
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

# seijaku.exe, the launcher: it starts firefox.exe with Seijaku's shell.
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found (needs .NET Framework, built into Windows)" }
$launcherArgs = @('/nologo', '/target:winexe', "/out:$(Join-Path $app 'seijaku.exe')")
if ($icon) { $launcherArgs += "/win32icon:$icon" }
$launcherArgs += (Join-Path $repo 'scripts\build\Launcher.cs')
& $csc $launcherArgs
if ($LASTEXITCODE) { throw 'building the launcher failed' }

# The shell.
Copy-Item -Recurse (Join-Path $repo 'shell') (Join-Path $app 'seijaku')

# Portable: the profile lives next to the app, separate from any Firefox.
Set-Content (Join-Path $app 'Seijaku.bat') '@start "" "%~dp0seijaku.exe" -profile "%~dp0profile" -no-remote %*' -Encoding ascii
New-Item -ItemType Directory -Force (Join-Path $app 'profile') | Out-Null

Remove-Item -Recurse -Force $extract
$size = (Get-ChildItem -Recurse $app | Measure-Object Length -Sum).Sum / 1MB
"Seijaku app at $app ({0:N0} MB)" -f $size
