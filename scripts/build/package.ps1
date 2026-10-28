# Builds the portable Seijaku app for Windows from Mozilla's prebuilt Gecko.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build\package.ps1 -Installer "Firefox Setup.exe" -Out out
#
# This runs in the Release workflow, not on your computer: the workflow
# downloads the Firefox installer, extracts the engine, and builds this.
# It takes the engine (xul.dll and the Gecko runtime files) out of the
# official Firefox installer, drops Firefox's own front end (browser\) and
# the background helpers Seijaku doesn't use, renames firefox.exe to
# seijaku.exe (Breached's method: Gecko starts its child processes from
# its own path, so the name doesn't matter to it), and adds the Seijaku
# shell from shell\. Renaming changes no bytes, so Mozilla's signature
# on the binary stays valid — but Breached keeps an unrenamed firefox.exe
# for sites that only play video in Google-certified browsers, so
# DRM playback (Netflix and the like) after a rename is untested.
# Result: <Out>\seijaku\ with Seijaku.bat to start it as a portable app.
# Task Manager then shows seijaku.exe, not firefox.exe. There is no
# launcher any more (scripts/build/Launcher.cs is retained unused):
# Windows cannot rename a running process — the process name is the
# exe filename, full stop — so the engine binary itself has to carry
# the name. Needs 7-Zip (7z) and Python 3 on PATH, both present on
# GitHub's Windows runners.

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

# The engine's program is seijaku.exe. This is what makes Task Manager,
# the taskbar grouping and crash reports say Seijaku instead of Firefox.
# Gecko starts its child processes from its own path, so they are
# seijaku.exe too.
Rename-Item (Join-Path $app 'firefox.exe') 'seijaku.exe'

# The shell.
Copy-Item -Recurse (Join-Path $repo 'shell') (Join-Path $app 'seijaku')

# The window icon, Breached's method: Gecko picks up a window's icon
# from chrome/icons/default/<window-id>.ico, where <window-id> is the id
# of the <html> element in seijaku.xhtml ("seijaku-window"). That icon
# is what Windows shows on the taskbar and in Alt+Tab. The .ico is drawn
# here at build time (same seal as the installer icon), so the repo
# stays text-only.
$windowIconDir = Join-Path $app 'seijaku\chrome\icons\default'
New-Item -ItemType Directory -Force $windowIconDir | Out-Null
Copy-Item $icon (Join-Path $windowIconDir 'seijaku-window.ico')

# Portable: the profile lives next to the app, separate from any Firefox.
# The engine binary itself is seijaku.exe now, so the start script passes
# -app directly instead of going through a launcher.
Set-Content (Join-Path $app 'Seijaku.bat') '@start "" "%~dp0seijaku.exe" -app "%~dp0seijaku\application.ini" -profile "%~dp0profile" -no-remote %*' -Encoding ascii
New-Item -ItemType Directory -Force (Join-Path $app 'profile') | Out-Null

Remove-Item -Recurse -Force $extract
$size = (Get-ChildItem -Recurse $app | Measure-Object Length -Sum).Sum / 1MB
"Seijaku app at $app ({0:N0} MB)" -f $size
