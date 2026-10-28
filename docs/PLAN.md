# Seijaku plan

Seijaku is a lightweight, quiet browser on Mozilla's Gecko engine,
built the way Breached was built — a small custom shell on top of
Firefox's engine — but stripped back to what a browser actually needs.

## Philosophy

- **Ma (間):** empty space is a feature. The window shows one tab
  strip, one address line, and one page. The home page is almost empty.
- **Kanso (簡素):** simplicity. One layout, two themes, four settings.
  If a feature needs a menu, a panel, or a second way to do it, it
  does not go in.
- **Lightness is a policy, not a slogan.** See docs/STRIPPED.md for
  everything removed or turned off, and what was kept on purpose.

## What is here (v0.1 scaffold)

| Path | What it is |
|---|---|
| `shell/` | The browser: window, tabs, address line, command bar |
| `shell/chrome/content/pages/` | Home page and settings page |
| `shell/modules/Theme.sys.mjs` | Ink and paper themes |
| `shell/defaults/preferences/seijaku.js` | Defaults, including the stripped services |
| `docs/STRIPPED.md` | Everything removed, and why |
| `scripts/build/package.ps1` | First packaging step (see below) |

## What is not here (on purpose)

Extensions, accounts, sync, mods, passkeys, DRM handling, pinned
sites, most-visited lists, and every tab position except top. Each of
those was a Breached feature and a Breached bug surface.

## How it runs (first Windows run is still the real test)

This scaffold has not been run on Windows yet — there is no Gecko
engine in this environment to run it on. The intended first run, from
a Firefox install on Windows:

```powershell
firefox.exe -app shell\application.ini
```

That starts the Seijaku window from the shell in this repo, with its
own profile in `%APPDATA%\Seijaku`. `scripts/build/package.ps1` copies
`shell/` into a Firefox install folder and renames the launcher, the
same way Breached's packaging worked; the installer and the Release
workflow come after that first run proves the window opens, tabs open,
and the address line navigates.

## Version

`SEIJAKU_VERSION` in `shell/chrome/content/seijaku.js`. v0.1.0 is the
scaffold: the window, the home page, and the settings page, with no
release yet.
