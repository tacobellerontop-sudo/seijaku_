# The Seijaku installer

## What you need on your computer to install it: almost nothing

- Windows 10 or 11, 64-bit.
- That's it. No Firefox first, no admin rights, no extra downloads,
  no tools. The engine is inside the installer, renamed to
  `seijaku.exe`, so Task Manager shows Seijaku, not Firefox.

## What the installer does

1. Copies Seijaku into `%LOCALAPPDATA%\Programs\Seijaku` (your own
   folder, not Program Files, so no admin prompt).
2. Adds a Start menu shortcut (and a desktop shortcut, if you tick it).
3. Registers Seijaku for web pages and http(s) links, under your own
   user key — so Windows' Default apps can pick it, and uninstalling
   removes those entries.
4. Leaves your profile alone: it lives in `%APPDATA%\Seijaku`, so
   installing a new version keeps your tabs and settings, and
   uninstalling Seijaku does not delete your profile (the install
   folder itself is removed).

The installer is not code-signed yet, so Windows SmartScreen may warn
the first time: choose More info, then Run anyway.

## The portable zip, instead

`Seijaku-<version>-win64-portable.zip` needs no install at all: unzip
it anywhere and run `Seijaku.bat`. The profile stays in the `profile`
folder next to it, so it touches nothing else on your computer, and
you can delete the whole folder to remove it.

## How it is built (not on your computer)

The Release workflow (`.github/workflows/release.yml`, added via the
GitHub web UI because the GitHub App cannot create workflow files)
runs on GitHub's Windows runner:

1. Downloads the latest Firefox installer from Mozilla.
2. Runs `scripts/build/package.ps1`: extracts the engine, drops
   Firefox's front end and background helpers, renames `firefox.exe`
   to `seijaku.exe` (Gecko starts its children from its own path, so
   the name doesn't matter to it), and draws the seal icon at build
   time. Renaming changes no bytes, so Mozilla's signature stays
   valid — but Breached keeps an unrenamed `firefox.exe` for sites
   that only play video in Google-certified browsers, so DRM playback
   after a rename is untested.
3. Builds the installer with Inno Setup 6.
4. Installs it silently to check the files land, then uninstalls it.
5. Publishes `SeijakuSetup-<version>.exe` and the portable zip as a
   GitHub release.

To make a release: Actions > Release > Run workflow, version `0.1.0`
(or the next version — it must match `SEIJAKU_VERSION` in
`shell/chrome/content/seijaku.js` first).
