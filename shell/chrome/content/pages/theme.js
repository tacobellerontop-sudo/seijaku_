/* Gives Seijaku's own pages the browser's colours, and keeps them in
   step when the theme changes. */

"use strict";

{
  const Theme = ChromeUtils.importESModule("resource://seijaku/Theme.sys.mjs");
  let apply = () => {
    let theme = Services.prefs.getStringPref("seijaku.theme", "ink");
    Theme.applyColors(document.documentElement, theme);
  };
  apply();
  let observer = { observe: () => apply() };
  Services.prefs.addObserver("seijaku.theme", observer);
  window.addEventListener("unload", () => Services.prefs.removeObserver("seijaku.theme", observer), { once: true });
}
