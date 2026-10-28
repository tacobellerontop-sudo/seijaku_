# Seijaku plan

Seijaku is a lightweight, quiet browser on Mozilla's Gecko engine,
built the way Breached was built — a small custom shell on top of
Firefox's engine — but stripped back to what a browser actually needs.

## Philosophy

- **Ma (間):** empty space is a feature. The window shows one tab
  strip, one address line, and one page. The home page is almost empty.
- **Kanso (簡素):** simplicity. One layout, two themes, a handful of
  settings. If a feature needs a menu, a panel, or a second way to do
  it, it does not go in.
- **Lightness is a policy, not a slogan.** See docs/STRIPPED.md for
  everything removed or turned off, and what was kept on purpose.

## What is here

| Path | What it is |
|---|---|
| `shell/` | The browser: window, tabs, address line |
| `shell/chrome/content/pages/` | Home page and settings page |
| `shell/modules/Theme.sys.mjs` | Ink and paper themes |
| `shell/defaults/preferences/seijaku.js` | Defaults, including the stripped services |
| `docs/STRIPPED.md` | Everything removed, and why |
| `scripts/build/package.ps1` | Packaging step (see below) |

The chrome is compact (56px of tab row plus address line), tabs sleep
after 15 idle minutes, sessions restore lazily, and updates check
GitHub on startup and install when you quit.

## What is not here (on purpose)

Extensions, accounts, sync, mods, passkeys, DRM handling, pinned
sites, most-visited lists, a command bar, and every tab position
except top. Each of those was a Breached feature and a Breached bug
surface.

## How it runs, and the installer

The Release workflow builds a self-contained installer (see
docs/INSTALLER.md) that needs no Firefox first, no admin rights, and
nothing else on your computer. Download `SeijakuSetup` from the latest
release, run it, and Seijaku starts.

For developers, the window can also be started from a Firefox install:

```powershell
firefox.exe -app shell\application.ini
```

That starts the Seijaku window from the shell in this repo, with its
own profile in `%APPDATA%\Seijaku`. `scripts/build/package.ps1` is
what the Release workflow uses to turn a Firefox installer into the
packaged app the installer wraps.

## Version

`SEIJAKU_VERSION` in `shell/chrome/content/seijaku.js`. The Release
workflow checks it matches the version you enter, and refuses to
re-release an existing tag.
