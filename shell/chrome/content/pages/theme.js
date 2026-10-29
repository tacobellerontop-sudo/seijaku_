/* Gives Seijaku's own pages the browser's colours, and keeps them in
   step when the theme changes. */

"use strict";

{
  const Theme = ChromeUtils.importESModule("resource://seijaku/Theme.sys.mjs");
  let apply = () => {
    let theme = Services.prefs.getStringPref("seijaku.theme", "ink");
    // "system" resolves through the OS setting, the way the chrome
    // window does: dark is the ink look, light is the paper look.
    if (theme == "system") {
      try {
        theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "ink" : "paper";
      } catch (e) {
        theme = "ink";
      }
    }
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
  // A System theme follows the OS live, like the chrome window.
  let media = null;
  try {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      if (Services.prefs.getStringPref("seijaku.theme", "ink") == "system") {
        apply();
      }
    });
  } catch (e) { /* a System theme just won't follow live */ }
  window.addEventListener("unload", () => Services.prefs.removeObserver("seijaku.theme", observer), { once: true });
}
