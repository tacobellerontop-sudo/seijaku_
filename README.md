# Seijaku

A lightweight, quiet web browser on Mozilla's Gecko engine. Ma: empty
space. Kanso: simplicity.

The window is one tab strip, one address line, and one page. The home
page is a wordmark, a search underline, and nothing else. Tabs fall
asleep after 15 idle minutes, and only the selected tab loads when
Seijaku starts.

Mozilla's background services are stripped: no telemetry, no studies,
no Pocket, no sponsored content, no accounts, no sync, no crash
uploads. See [docs/STRIPPED.md](docs/STRIPPED.md) for the full list and
the one real trade-off in it (Safe Browsing is off).

## Install it

Download SeijakuSetup-0.1.0.exe from the latest release and run it. It installs for your Windows account only, no admin rights, no Firefox needed first, nothing else to install. Or unzip the portable zip on the same page and run Seijaku.bat. See docs/INSTALLER.md for what the installer does and where your profile lives.

## Use it

- `Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+L` address line
- `:` for the command line (`:open`, `:tab`, `:close`, `:undo`,
  `:reload`, `:sleep`, `:settings`, `:help`)
- `Ctrl+,` settings: theme (ink dark / paper light), tab sleep time,
  search engine, home page

## Build it

This is a v0.1 scaffold, not a release yet. See
[docs/PLAN.md](docs/PLAN.md) for how to run it from a Firefox install
on Windows, and what still needs proving on that first run.

## Licence

Mozilla Public License 2.0, see [LICENSE](LICENSE). Firefox's engine,
which Seijaku runs on, is Mozilla's and under the same licence.
