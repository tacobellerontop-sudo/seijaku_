# Seijaku packaging, first step only.
# Copies shell/ into a Firefox install folder so firefox.exe starts the
# Seijaku window instead of Firefox's. The installer and the Release
# workflow come after the first run proves the window works.
#   powershell -ExecutionPolicy Bypass -File scripts\build\package.ps1 -FirefoxDir "C:\Program Files\Mozilla Firefox" -Out out
param(
  [Parameter(Mandatory = $true)][string]$FirefoxDir,
  [string]$Out = "out"
)

# $PSScriptRoot is scripts\build, so the repo root is three levels up.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$app = Join-Path $Out "seijaku"
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $FirefoxDir "*") $app -Recurse -Force
Copy-Item -Recurse (Join-Path $repo "shell") (Join-Path $app "seijaku") -Force
Copy-Item (Join-Path $app "firefox.exe") (Join-Path $app "seijaku.exe") -Force
"Seijaku packaged into $app. Run seijaku.exe there."
