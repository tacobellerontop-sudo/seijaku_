# What Seijaku strips, and why

Breached proved a Gecko browser can be light. Seijaku goes further by
refusing to carry the parts that made Breached heavy to maintain. The
list below is the whole policy: if a Mozilla feature is not needed to
load and show a web page, it is off, and it is off by a pref in
`shell/defaults/preferences/seijaku.js`, not by a patch you have to
re-apply on every engine update.

## Removed outright (not in the shell at all)

- No mods system, no extensions host, no WebExtension APIs. Breached's
  extension code was a large share of its shell and its bug surface.
  Seijaku has no extension UI, so it needs none of that code.
- No accounts, no sync, no passkey provider, no DRM mod offer.
- No settings pack for Firefox. One install path only: the Seijaku app.
- No pinned sites, no most-visited list on the home page. Both query
  history on every new tab.
- No colour presets beyond ink and paper, no tab positions beyond top,
  no auto-hiding tab bar. One layout, tested once.

## Turned off by pref

- Telemetry and health reporting (`toolkit.telemetry.*`,
  `datareporting.*`): background uploads, on a metered connection or not.
- Studies and Normandy (`app.shield.*`, `app.normandy.*`): Mozilla
  pushing experiments into your browser.
- Pocket, sponsored stories, sponsored top sites, snippets
  (`extensions.pocket.*`, `browser.newtabpage.activity-stream.*`):
  content and network calls on the new tab page.
- Firefox Accounts and Sync (`identity.fxaccounts.*`,
  `services.sync.*`): account machinery in a browser with no accounts.
- Crash reporting (`breakpad.*`): uploads after a crash.
- Safe Browsing (`browser.safebrowsing.*`): a list downloaded from
  Google and consulted on every navigation. This is a real trade-off,
  stated plainly: Seijaku trusts the site you typed, and shows the lock
  state, instead of phoning a list. If you want it back, turn those
  prefs on in `about:config` (see docs/PLAN.md).
- Captive-portal and connectivity checks
  (`network.captive-portal-service.*`, `network.connectivity-service.*`):
  background probes.
- Promos (`browser.vpnPromo.*`, `browser.messaging-system.*`,
  `browser.preferences.moreFromMozilla`): ads for Mozilla products.

## Kept on purpose

- Tracker blocking at Strict, cookie and query stripping. Blocking
  trackers makes pages load faster and use less memory, so this is a
  lightness feature, not bloat.
- Tab sleeping after 15 idle minutes, and lazy session restore: only
  the selected tab loads at start; the rest load when clicked.
- One content process per tab, as Gecko does by default. Seijaku does
  not weaken site isolation to save memory, the way a "lean" mode could.
  Lightness here comes from doing less in the background, not from
  making sites less safe.

## On the minimal UI saving resources

A minimal UI does save something real, and it is worth saying exactly
how much: fewer DOM nodes and no animations in the chrome, no images
or tiles on the home page, and no background queries for pinned or
most-visited sites. That is measurable, but it is small next to the
engine: the big wins are the stripped services above, tracker blocking,
and tab sleeping. Seijaku does both, and does not claim the UI alone
makes it light.
