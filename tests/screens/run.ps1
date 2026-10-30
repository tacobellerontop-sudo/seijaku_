# Seijaku screenshots on Windows: takes a packaged build (scripts\build\
# package.ps1's output), adds tests\screens\shots.js to it, starts the
# browser in a real window with a fresh profile, and captures the screen
# each time shots.js asks for it. PNGs land in -Out.
#
#   powershell -ExecutionPolicy Bypass -File tests\screens\run.ps1 -App out\seijaku -Out screens

param(
    [Parameter(Mandatory)] [string] $App,
    [Parameter(Mandatory)] [string] $Out,
    [int] $TimeoutSeconds = 240
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$App = (Resolve-Path $App).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$content = Join-Path $App 'seijaku\chrome\content'

Copy-Item (Join-Path $PSScriptRoot 'shots.js') $content
$xhtml = Join-Path $content 'seijaku.xhtml'
$text = Get-Content -Raw $xhtml
$tag = '<script src="chrome://seijaku/content/seijaku.js"></script>'
if (-not $text.Contains($tag)) { throw "seijaku.xhtml has no seijaku.js script tag" }
$text = $text.Replace($tag, $tag + "`n  <script src=`"chrome://seijaku/content/shots.js`"></script>")
Set-Content $xhtml $text -Encoding utf8

$profile = Join-Path $env:RUNNER_TEMP 'seijaku-shots-profile'
Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $profile | Out-Null
@(
    'user_pref("seijaku.update.enabled", false);',
    'user_pref("seijaku.weather.enabled", false);',
    'user_pref("seijaku.startup", "blank");'
) | Set-Content (Join-Path $profile 'user.js') -Encoding ascii

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Host "Screen: $($bounds.Width)x$($bounds.Height)"
$engine = Start-Process (Join-Path $App 'firefox.exe') -PassThru `
    -ArgumentList '-app', "`"$(Join-Path $App 'seijaku\application.ini')`"", '-profile', "`"$profile`"", '-no-remote'
$request = Join-Path $profile 'shot-request.txt'
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (-not $engine.HasExited -and (Get-Date) -lt $deadline) {
    if (Test-Path $request) {
        Start-Sleep -Milliseconds 300
        $name = (Get-Content -Raw $request).Trim()
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Host "captured $name"
        Remove-Item $request
    }
    Start-Sleep -Milliseconds 150
}
if (-not $engine.HasExited) {
    Stop-Process -Id $engine.Id -Force -ErrorAction SilentlyContinue
    Write-Host "The browser did not quit within $TimeoutSeconds seconds."
}
$err = Join-Path $profile 'shots-error.txt'
if (Test-Path $err) { Write-Host '--- shots.js error ---'; Get-Content $err }
Get-ChildItem $Out
