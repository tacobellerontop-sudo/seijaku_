# Seijaku in-app update test on Windows. Builds two installers from a
# packaged build (scripts\build\package.ps1's output) with
# tests\update\updatetest.js added, installs the older one, and starts it
# with a pref that makes it run the real update path against the newer
# installer. Runs twice: once as Settings' Update button, once as an
# update staged in the background that installs when Seijaku is closed.
# Each passes when the newer version is installed and Seijaku has
# started again by itself, with an unrelated process named firefox.exe
# left running the whole time (the 0.2.10 updater waited for that
# forever, in a terminal window), with Seijaku having run the installer
# directly (no updater script: Windows asked permission to run one),
# and with nothing left behind in Temp.
#
#   powershell -ExecutionPolicy Bypass -File tests\update\run.ps1 -App out\seijaku

param(
    [Parameter(Mandatory)] [string] $App,
    [int] $TimeoutSeconds = 300
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$App = (Resolve-Path $App).Path
$work = Join-Path $env:RUNNER_TEMP 'seijaku-update'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null

# A copy of the build with the hook added after seijaku.js.
$build = Join-Path $work 'seijaku'
Copy-Item -Recurse $App $build
$content = Join-Path $build 'seijaku\chrome\content'
Copy-Item (Join-Path $PSScriptRoot 'updatetest.js') $content
$xhtml = Join-Path $content 'seijaku.xhtml'
$text = Get-Content -Raw $xhtml
$tag = '<script src="chrome://seijaku/content/seijaku.js"></script>'
if (-not $text.Contains($tag)) { throw "seijaku.xhtml has no seijaku.js script tag" }
$text = $text.Replace($tag, $tag + "`n  <script src=`"chrome://seijaku/content/updatetest.js`"></script>")
Set-Content $xhtml $text -Encoding utf8

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    choco install innosetup -y --no-progress | Out-Null
    $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
}
$release = Join-Path $work 'release'
foreach ($v in '0.0.1', '99.0.0') {
    & $iscc /Q "/DAppVersion=$v" "/DAppDir=$build" "/DOutDir=$release" (Join-Path $repo 'installer\seijaku.iss')
    if ($LASTEXITCODE) { throw "Inno Setup failed for $v" }
}
$old = Join-Path $release 'SeijakuSetup-0.0.1.exe'
$new = Join-Path $release 'SeijakuSetup-99.0.0.exe'

$dir = "$env:LOCALAPPDATA\Programs\Seijaku"
$key = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{3B84B47F-E97E-4C90-AC83-37273A1DF910}_is1'
function Installed-Version { (Get-ItemProperty $key -ErrorAction SilentlyContinue).DisplayVersion }
function Seijaku-Processes {
    @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$dir\", [StringComparison]::OrdinalIgnoreCase) })
}

function Test-Update([string] $Mode) {
"=== Update test: $Mode ==="
    $p = Start-Process $old -PassThru -Wait -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'
    if ($p.ExitCode) { throw "installing 0.0.1 exited with $($p.ExitCode)" }
    if ((Installed-Version) -ne '0.0.1') { throw "expected 0.0.1 installed, registry says '$(Installed-Version)'" }
    "Installed 0.0.1 to $dir"

    # Something else called firefox.exe, as a real Firefox would be.
    $decoyDir = Join-Path $work 'decoy'
    New-Item -ItemType Directory -Force $decoyDir | Out-Null
    Copy-Item "$env:WINDIR\System32\PING.EXE" (Join-Path $decoyDir 'firefox.exe')
    $decoy = Start-Process (Join-Path $decoyDir 'firefox.exe') -ArgumentList '-n', '100000', '127.0.0.1' -PassThru -WindowStyle Hidden

    $profile = Join-Path $work "profile-$Mode"
    New-Item -ItemType Directory -Force $profile | Out-Null
    $newJs = $new.Replace('\', '\\')
    @(
        'user_pref("seijaku.update.enabled", false);',
        'user_pref("seijaku.weather.enabled", false);',
        'user_pref("seijaku.startup", "blank");',
        "user_pref(`"seijaku.test.updateInstaller`", `"$newJs`");",
        'user_pref("seijaku.test.updateVersion", "99.0.0");',
        "user_pref(`"seijaku.test.updateMode`", `"$Mode`");",
        'user_pref("browser.dom.window.dump.enabled", true);',
        'user_pref("devtools.console.stdout.chrome", true);'
    ) | Set-Content (Join-Path $profile 'user.js') -Encoding ascii

    # Headless, inherited by the updater and the Seijaku it starts again.
    $env:MOZ_HEADLESS = '1'
    $log = Join-Path $work "browser-$Mode.log"
    $engine = Start-Process (Join-Path $dir 'firefox.exe') -PassThru `
        -ArgumentList '-app', "`"$dir\seijaku\application.ini`"", '-profile', "`"$profile`"", '-no-remote' `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    "Started installed Seijaku (pid $($engine.Id))"

    $ok = $false
    $seenQuit = $false
    $script = $null
    $setupLine = $null
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    try {
        while ((Get-Date) -lt $deadline) {
            if (-not $seenQuit -and $engine.HasExited) {
                $seenQuit = $true
                "Seijaku quit for the update; processes still running from the install folder:"
                Seijaku-Processes | ForEach-Object { "  $($_.ProcessId) $($_.CommandLine)" }
            }
            foreach ($proc in Get-CimInstance Win32_Process) {
                if ($proc.CommandLine -match 'seijaku-update\.ps1') { $script = $proc.CommandLine }
                if (-not $setupLine -and $proc.CommandLine -match 'SeijakuSetup-99\.0\.0\.exe') {
                    $setupLine = $proc.CommandLine
                    "Installer started: $setupLine"
                }
            }
            if (Test-Path (Join-Path $env:TEMP 'seijaku-update.ps1')) { $script = 'seijaku-update.ps1 in Temp' }
            if ((Installed-Version) -eq '99.0.0' -and (Seijaku-Processes | Where-Object { $_.Name -eq 'firefox.exe' })) {
                $ok = $true
                break
            }
            Start-Sleep 1
        }
        Write-Host '--- browser output ---'
        foreach ($f in $log, "$log.err") {
            if (Test-Path $f) { Get-Content $f | Select-String -Pattern 'error|exception|Seijaku' | Select-Object -First 60 | ForEach-Object { $_.Line } }
        }
        $setupLog = Join-Path $env:TEMP 'seijaku-update.log'
        if (Test-Path $setupLog) {
            Write-Host '--- installer log (last lines) ---'
            Get-Content $setupLog | Select-Object -Last 15
        }
        if (-not $seenQuit) { throw 'Seijaku never quit to install the update' }
        if (-not $ok) { throw "no update within $TimeoutSeconds seconds: registry says '$(Installed-Version)'" }
        "Updated to 99.0.0 and Seijaku started again:"
        Seijaku-Processes | Where-Object { $_.Name -eq 'firefox.exe' } | Select-Object -First 1 | ForEach-Object { "  $($_.ProcessId) $($_.CommandLine)" }
        if ($decoy.HasExited) { throw 'the unrelated firefox.exe was ended by the update' }
        if ($script) { throw "the update went through an updater script: $script" }
        if (-not $setupLine) { throw 'never saw the installer running' }
        if ($setupLine -notmatch '/update=1') { throw "the installer was started without /update=1: $setupLine" }
        if (@(Seijaku-Processes | Where-Object { $_.Name -eq 'firefox.exe' -and $_.CommandLine -match '-app' }).Count -lt 1) { throw 'Seijaku came back without -app' }
        # The Seijaku that came back tidies the installer out of Temp a
        # little after it starts.
        $downloaded = Join-Path $env:TEMP 'SeijakuSetup-99.0.0.exe'
        $tidyBy = (Get-Date).AddSeconds(90)
        while ((Test-Path $downloaded) -and (Get-Date) -lt $tidyBy) { Start-Sleep 2 }
        if (Test-Path $downloaded) { throw 'the downloaded installer was left behind' }
        "Update test passed ($Mode)"
    } finally {
        Seijaku-Processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $decoy.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep 3
        Remove-Item -Force (Join-Path $env:TEMP 'SeijakuSetup-99.0.0.exe') -ErrorAction SilentlyContinue
        if (Test-Path "$dir\unins000.exe") {
            Start-Process "$dir\unins000.exe" -Wait -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' | Out-Null
        }
    }
}

Test-Update 'button'
Test-Update 'quit'
