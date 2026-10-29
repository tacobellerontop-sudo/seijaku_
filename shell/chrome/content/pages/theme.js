/* Gives Seijaku's own pages the browser's colours, and keeps them in
   step when the theme changes. */

"use strict";

{
  const Theme = ChromeUtils.importESModule("resource://seijaku/Theme.sys.mjs");
  let apply = () => {
    let theme = Services.prefs.getStringPref("seijaku.theme", "ink");
    let custom = {
      barBg: Services.prefs.getStringPref("seijaku.theme.custom.barBg", "#171310"),
      fg: Services.prefs.getStringPref("seijaku.theme.custom.fg", "#ece4d3"),
      accent: Services.prefs.getStringPref("seijaku.theme.custom.accent", "#d8442a"),
    };
    Theme.applyColors(document.documentElement, theme, custom);
  };
  apply();
  // A branch observer: this fires for the theme itself and for any
  // custom colour underneath it, so custom picks apply at once.
  let observer = { observe: () => apply() };
  Services.prefs.addObserver("seijaku.theme", observer);
  window.addEventListener("unload", () => Services.prefs.removeObserver("seijaku.theme", observer), { once: true });
}
