# Seijaku "open a file from Windows" test. Installs a packaged build with
# its real installer, then opens PDFs exactly the way Explorer does: it
# reads the open commands the installer registered (the PDF file type,
# and "Open with" > Seijaku) and runs them with a file path for %1.
#
#   1. Seijaku not running: the PDF must open as a tab on start.
#   2. Seijaku running: a second PDF must open as a tab in that Seijaku.
#
# Before 1.0.4 the commands put -app before -osint, which the engine
# refuses (it quits at once with exit code 127), so nothing opened.
# The check reads Seijaku's saved session for the files' addresses.
#
#   powershell -ExecutionPolicy Bypass -File tests\open\run.ps1 -App out\seijaku

param(
    [Parameter(Mandatory)] [string] $App,
    [int] $TimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$App = (Resolve-Path $App).Path
$work = Join-Path $env:RUNNER_TEMP 'seijaku-open'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    choco install innosetup -y --no-progress | Out-Null
    $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
}
& $iscc /Q "/DAppVersion=0.0.1" "/DAppDir=$App" "/DOutDir=$work" (Join-Path $repo 'installer\seijaku.iss')
if ($LASTEXITCODE) { throw 'Inno Setup failed' }
$p = Start-Process (Join-Path $work 'SeijakuSetup-0.0.1.exe') -PassThru -Wait -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'
if ($p.ExitCode) { throw "installing exited with $($p.ExitCode)" }
$dir = "$env:LOCALAPPDATA\Programs\Seijaku"
"Installed to $dir"

function Seijaku-Processes {
    @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$dir\", [StringComparison]::OrdinalIgnoreCase) })
}

# A profile of its own (XRE_PROFILE_PATH is inherited by every start,
# so the second start finds the first Seijaku through it), headless.
$profile = Join-Path $work 'profile'
New-Item -ItemType Directory -Force $profile | Out-Null
@(
    'user_pref("seijaku.update.enabled", false);',
    'user_pref("seijaku.weather.enabled", false);',
    'user_pref("browser.dom.window.dump.enabled", true);'
) | Set-Content (Join-Path $profile 'user.js') -Encoding ascii
$env:XRE_PROFILE_PATH = $profile
$env:MOZ_HEADLESS = '1'
$session = Join-Path $profile 'seijaku-session.json'

# Two PDFs in a folder with a space, as in a real Documents path.
$files = Join-Path $work 'my files'
New-Item -ItemType Directory -Force $files | Out-Null
$pdf1 = Join-Path $files 'first file.pdf'
$pdf2 = Join-Path $files 'second file.pdf'
Copy-Item (Join-Path $repo 'tests\smoke\pages\hello.pdf') $pdf1
Copy-Item (Join-Path $repo 'tests\smoke\pages\hello.pdf') $pdf2

function Open-Command([string] $subkey) {
    $cmd = (Get-ItemProperty "HKCU:\Software\Classes\$subkey\shell\open\command").'(default)'
    if (-not $cmd) { throw "no open command registered under $subkey" }
    $cmd
}

function Run-Command([string] $cmd, [string] $path) {
    if ($cmd -notmatch '^"([^"]+)"\s*(.*)$') { throw "can't read the command: $cmd" }
    $exe = $Matches[1]
    $arguments = $Matches[2].Replace('%1', $path)
    Write-Host "Running: `"$exe`" $arguments"
    Start-Process $exe -ArgumentList $arguments -PassThru
}

function Wait-InSession([string] $name, [string] $what) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $needle = [Uri]::EscapeUriString($name)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $session) -and ((Get-Content -Raw $session) -match [Regex]::Escape($needle))) {
            "$what`: open"
            return
        }
        Start-Sleep 1
    }
    "Seijaku processes:"
    Seijaku-Processes | ForEach-Object { "  $($_.ProcessId) $($_.CommandLine)" }
    if (Test-Path $session) { "Session: $(Get-Content -Raw $session)" } else { 'No session file was written.' }
    throw "$what`: $name did not open within $TimeoutSeconds seconds"
}

try {
    $pdfCmd = Open-Command 'SeijakuPDF'
    $withCmd = Open-Command 'Applications\seijaku.exe'
    if ($pdfCmd -notmatch '^"[^"]+seijaku\.exe" -osint -url "%1"$') { throw "unexpected PDF open command: $pdfCmd" }
    $openWith = (Get-ItemProperty 'HKCU:\Software\Classes\.pdf\OpenWithProgids' -ErrorAction SilentlyContinue).SeijakuPDF
    if ($null -eq $openWith) { throw 'Seijaku is not offered under "Open with" for .pdf' }

    # 1. Not running yet.
    $launcher = Run-Command $pdfCmd $pdf1
    Wait-InSession 'first file.pdf' 'A PDF opened while Seijaku was closed'

    # 2. Running: "Open with" > Seijaku on another PDF. The engine never
    # hands a command line to a running instance from a headless start
    # (headless turns its remote client off), so this start isn't headless,
    # as a real one isn't; it only passes the file on and quits.
    Remove-Item Env:\MOZ_HEADLESS -ErrorAction SilentlyContinue
    $before = @(Seijaku-Processes | Where-Object { $_.Name -eq 'firefox.exe' -and $_.CommandLine -notmatch '-contentproc' }).Count
    $launcher = Run-Command $withCmd $pdf2
    Wait-InSession 'second file.pdf' 'A PDF opened while Seijaku was running'
    Start-Sleep 2
    $after = @(Seijaku-Processes | Where-Object { $_.Name -eq 'firefox.exe' -and $_.CommandLine -notmatch '-contentproc' }).Count
    if ($after -ne $before) { throw "a second Seijaku started ($before main processes before, $after after)" }
    if ((Get-Content -Raw $session) -notmatch [Regex]::Escape([Uri]::EscapeUriString('first file.pdf'))) { throw 'the first PDF tab is gone' }

    # A crafted address can't sneak in an engine flag.
    $bad = Start-Process (Join-Path $dir 'seijaku.exe') -ArgumentList '-osint', '-url', '-profile' -PassThru -Wait
    if ($bad.ExitCode -ne 1) { throw "seijaku.exe accepted -osint -url -profile (exit code $($bad.ExitCode))" }

    'Open test passed'
} finally {
    Seijaku-Processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep 3
    Remove-Item Env:\XRE_PROFILE_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\MOZ_HEADLESS -ErrorAction SilentlyContinue
    if (Test-Path "$dir\unins000.exe") {
        Start-Process "$dir\unins000.exe" -Wait -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' | Out-Null
    }
}
