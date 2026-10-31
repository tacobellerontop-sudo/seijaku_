# Seijaku smoke test on Windows: takes a packaged build (scripts\build\
# package.ps1's output), adds tests\smoke\smoketest.js to it, serves
# tests\smoke\pages on 127.0.0.1, starts the browser headless with a
# fresh profile, and fails if any check in smoke-results.json failed.
#
#   powershell -ExecutionPolicy Bypass -File tests\smoke\run.ps1 -App out\seijaku

param(
    [Parameter(Mandatory)] [string] $App,
    [int] $TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$App = (Resolve-Path $App).Path
$content = Join-Path $App 'seijaku\chrome\content'

# The test script runs inside the window, after the shell's own.
Copy-Item (Join-Path $PSScriptRoot 'smoketest.js') $content
$xhtml = Join-Path $content 'seijaku.xhtml'
$text = Get-Content -Raw -Encoding UTF8 $xhtml
$tag = '<script src="chrome://seijaku/content/seijaku.js"></script>'
if (-not $text.Contains($tag)) { throw "seijaku.xhtml has no seijaku.js script tag" }
$text = $text.Replace($tag, $tag + "`n  <script src=`"chrome://seijaku/content/smoketest.js`"></script>")
Set-Content $xhtml $text -Encoding utf8

# A fresh profile with test prefs: fake camera and microphone, no
# user-gesture rule for notifications, no network calls of our own.
$profile = Join-Path $env:RUNNER_TEMP 'seijaku-smoke-profile'
Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $profile | Out-Null
@(
    'user_pref("media.navigator.streams.fake", true);',
    'user_pref("dom.webnotifications.requireuserinteraction", false);',
    'user_pref("seijaku.update.enabled", false);',
    'user_pref("full-screen-api.allow-trusted-requests-only", false);',
    'user_pref("full-screen-api.transition-duration.enter", "0 0");',
    'user_pref("full-screen-api.transition-duration.leave", "0 0");',
    'user_pref("seijaku.weather.enabled", false);',
    'user_pref("seijaku.startup", "blank");',
    'user_pref("seijaku.smoke.base", "http://127.0.0.1:8765/");',
    'user_pref("browser.dom.window.dump.enabled", true);',
    'user_pref("devtools.console.stdout.chrome", true);'
) | Set-Content (Join-Path $profile 'user.js') -Encoding ascii

$server = Start-Process python -ArgumentList '-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', (Join-Path $PSScriptRoot 'pages') -PassThru -WindowStyle Hidden
try {
    Start-Sleep 2
    $log = Join-Path $env:RUNNER_TEMP 'seijaku-smoke.log'
    $engine = Start-Process (Join-Path $App 'firefox.exe') -PassThru `
        -ArgumentList '-app', "`"$(Join-Path $App 'seijaku\application.ini')`"", '-profile', "`"$profile`"", '-no-remote', '-headless' `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    if (-not $engine.WaitForExit($TimeoutSeconds * 1000)) {
        Stop-Process -Id $engine.Id -Force -ErrorAction SilentlyContinue
        Get-Process firefox -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "The browser did not quit within $TimeoutSeconds seconds."
    }
    Start-Sleep 2
    Write-Host '--- browser output (errors and warnings) ---'
    foreach ($f in $log, "$log.err") {
        if (Test-Path $f) { Get-Content $f | Select-String -Pattern 'error|exception|Seijaku' | Select-Object -First 80 | ForEach-Object { $_.Line } }
    }
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}

$resultsFile = Join-Path $profile 'smoke-results.json'
if (-not (Test-Path $resultsFile)) { throw 'no smoke-results.json: the test never finished (see the output above)' }
$results = Get-Content -Raw $resultsFile | ConvertFrom-Json
$failed = 0
Write-Host '--- smoke results ---'
foreach ($r in $results) {
    $mark = if ($r.ok) { 'PASS' } else { 'FAIL'; $failed++ }
    Write-Host "$mark  $($r.name)  $($r.detail)"
}
if ($failed) { throw "$failed smoke check(s) failed" }
"All $($results.Count) smoke checks passed"
