# Seijaku themes

Pick one in Settings (or the `seijaku.theme` pref). Every theme is one
accent colour plus text, background, and hairlines — nothing else
changes, so a theme can never make the browser harder to read.

| Theme | Look | Accent |
| --- | --- | --- |
| `ink` (default) | Warm dark, sumi on washi | Vermilion `#d8442a` |
| `paper` | Warm light | Vermilion `#c23a22` |
| `matcha` | Dark green | Matcha `#a3b86b` |
| `sakura` | Light pink | Sakura `#d4626e` |
| `ai` | Dark indigo | Indigo `#6f7fd4` |
| `custom` | Your three colours below | Your accent |

## Custom themes

Choose `custom` in Settings and pick three colours: background, text,
and accent. Everything else (muted text, hairlines, error colour)
stays Ink, so a custom theme can't come out unreadable. The same three
colours live in prefs if you'd rather set them by hand:

- `seijaku.theme.custom.barBg` — background (default `#171310`)
- `seijaku.theme.custom.fg` — text (default `#ece4d3`)
- `seijaku.theme.custom.accent` — accent (default `#d8442a`)

The home and settings pages follow the theme at once; light
backgrounds automatically get light form controls.

## Adding a theme to the code

A built-in theme is one entry in `THEMES` in
`shell/modules/Theme.sys.mjs` (seven colours: `barBg`, `fg`,
`tabSelectedFg`, `accent`, `muted`, `line`, `error`) plus one
`<option>` in `shell/chrome/content/pages/settings.html`. That's the
whole change — themes are data, not code paths.
