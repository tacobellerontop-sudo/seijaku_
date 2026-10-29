/* Seijaku settings: saved as soon as they change. */

"use strict";

function flashSaved() {
  document.getElementById("saved").hidden = false;
  setTimeout(() => (document.getElementById("saved").hidden = true), 2000);
}

function bind(id, pref, kind) {
  let el = document.getElementById(id);
  let get = () => {
    switch (kind) {
      case "int":
        return Services.prefs.getIntPref(pref, 0);
      default:
        return Services.prefs.getStringPref(pref, "");
    }
  };
  el.value = get();
  el.addEventListener("change", () => {
    if (kind == "int") {
      Services.prefs.setIntPref(pref, Math.max(0, Number(el.value) || 0));
    } else {
      Services.prefs.setStringPref(pref, el.value);
    }
    flashSaved();
  });
  return el;
}

function bindBool(id, pref) {
  let el = document.getElementById(id);
  el.checked = Services.prefs.getBoolPref(pref, true);
  el.addEventListener("change", () => {
    Services.prefs.setBoolPref(pref, el.checked);
    flashSaved();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  let shellWindow = () => window.browsingContext.topChromeWindow;
  let theme = bind("setting-theme", "seijaku.theme", "string");
  let customBlock = document.getElementById("setting-custom-theme");
  let showCustom = () => (customBlock.hidden = theme.value != "custom");
  theme.addEventListener("change", showCustom);
  showCustom();
  bind("setting-custom-bg", "seijaku.theme.custom.barBg", "string");
  bind("setting-custom-fg", "seijaku.theme.custom.fg", "string");
  bind("setting-custom-accent", "seijaku.theme.custom.accent", "string");
  bind("setting-sleep", "seijaku.tabs.unloadAfterMinutes", "int");
  bind("setting-tabs-position", "seijaku.tabs.position", "string");
  // Search engine: the dropdown holds the known engines; picking one
  // writes its URL into the custom field and the pref, so the field
  // always shows what is actually used. Anything else reads as Custom.
  let search = bind("setting-search", "seijaku.searchUrl", "string");
  let engine = document.getElementById("setting-search-engine");
  let known = [...engine.options].map(o => o.value);
  engine.value = known.includes(search.value) ? search.value : "custom";
  engine.addEventListener("change", () => {
    if (engine.value != "custom") {
      search.value = engine.value;
      Services.prefs.setStringPref("seijaku.searchUrl", engine.value);
      flashSaved();
    }
  });
  search.addEventListener("change", () => {
    engine.value = known.includes(search.value) ? search.value : "custom";
  });
  bind("setting-homepage", "seijaku.homepage", "string");
  bind("setting-startup", "seijaku.startup", "string");
  bind("setting-tracking", "seijaku.trackingprotection", "string");
  // Page fonts: the engine's own content font prefs. The family
  // dropdown writes the generic family into both the proportional
  // and the fixed slots, so code blocks match the choice too.
  let fontFamily = document.getElementById("setting-font-family");
  let fontSize = document.getElementById("setting-font-size");
  try {
    fontFamily.value = Services.prefs.getStringPref("font.name.variable.x-western", "sans-serif");
    fontSize.value = Services.prefs.getIntPref("font.size.variable.x-western", 16);
  } catch (e) { /* the fields just show their defaults */ }
  let applyFont = () => {
    try {
      let family = ["sans-serif", "serif", "monospace"].includes(fontFamily.value)
        ? fontFamily.value
        : "sans-serif";
      let size = Math.min(32, Math.max(9, Number(fontSize.value) || 16));
      fontSize.value = size;
      Services.prefs.setStringPref("font.name.variable.x-western", family);
      Services.prefs.setStringPref("font.name.fixed.x-western", family);
      Services.prefs.setIntPref("font.size.variable.x-western", size);
      Services.prefs.setIntPref("font.size.fixed.x-western", size);
      flashSaved();
    } catch (e) { /* a font that won't apply leaves the old one */ }
  };
  fontFamily.addEventListener("change", applyFont);
  fontSize.addEventListener("change", applyFont);
  // Weather: changing the city clears the stored coordinates, so
  // the next home page load geocodes the new city once.
  bindBool("setting-weather-enabled", "seijaku.weather.enabled");
  let weatherCity = bind("setting-weather-city", "seijaku.weather.city", "string");
  weatherCity.addEventListener("change", () => {
    try {
      Services.prefs.clearUserPref("seijaku.weather.lat");
      Services.prefs.clearUserPref("seijaku.weather.lon");
    } catch (e) { /* the next fetch just re-geocodes anyway */ }
  });
  // Downloads: the folder is a Seijaku pref, applied to the engine's
  // own download-directory prefs on change (and again by the shell at
  // startup), so files downloaded from pages land there. Annotated
  // PDFs and bookmark exports follow the same folder. Changing it
  // affects new downloads only.
  let dlFolder = bind("setting-download-folder", "seijaku.download.folder", "string");
  let applyDlFolder = () => {
    try {
      let dir = dlFolder.value.trim();
      if (dir) {
        Services.prefs.setStringPref("browser.download.dir", dir);
        Services.prefs.setIntPref("browser.download.folderList", 2);
      } else {
        Services.prefs.setIntPref("browser.download.folderList", 1);
      }
      flashSaved();
    } catch (e) {
      // The typed value is still saved to the Seijaku pref by bind();
      // the shell applies it at the next startup.
    }
  };
  dlFolder.addEventListener("change", applyDlFolder);
  document.getElementById("setting-download-choose").addEventListener("click", async () => {
    try {
      let path = await shellWindow()?.Seijaku?.pickDownloadFolder();
      if (path) {
        dlFolder.value = path;
        // Setting the value by hand does not fire change, so save and
        // apply it explicitly (bind's saver reads el.value).
        Services.prefs.setStringPref("seijaku.download.folder", path);
        applyDlFolder();
      }
    } catch (e) {
      // Typing the path by hand still works.
    }
  });
  let dlAsk = document.getElementById("setting-download-ask");
  try {
    dlAsk.checked = Services.prefs.getBoolPref("seijaku.download.ask", false);
  } catch (e) {
    dlAsk.checked = false;
  }
  dlAsk.addEventListener("change", () => {
    try {
      Services.prefs.setBoolPref("seijaku.download.ask", dlAsk.checked);
      // Engine meaning is inverted: useDownloadDir false = ask.
      Services.prefs.setBoolPref("browser.download.useDownloadDir", !dlAsk.checked);
      flashSaved();
    } catch (e) {}
  });
  // Clear browsing data goes through the shell (the page never
  // touches the cookie or cache services itself).
  document.getElementById("setting-clear-data").addEventListener("click", () => {
    let shell = shellWindow()?.Seijaku;
    let result = document.getElementById("clear-result");
    if (!shell) {
      result.textContent = "Couldn't reach the browser to clear anything.";
      return;
    }
    try {
      result.textContent = shell.clearBrowsingData({
        history: document.getElementById("clear-history").checked,
        cookies: document.getElementById("clear-cookies").checked,
        cache: document.getElementById("clear-cache").checked,
        downloads: document.getElementById("clear-downloads").checked,
      });
    } catch (e) {
      result.textContent = `Couldn't clear: ${e.message}`;
    }
  });
  bindBool("setting-update", "seijaku.update.enabled");
  bindBool("setting-autohide", "seijaku.chrome.autohide");
  // Permission switch: one checkbox drives three policy prefs.
  // Checked means "allow at once" (1); unchecked clears them back to
  // the engine's ask-by-default instead of guessing each one's ask
  // value. Location is deliberately not here: its allow value is
  // unconfirmed, and it still needs a real prompt UI.
  let perm = document.getElementById("setting-permissions-allow");
  let permPrefs = [
    "permissions.default.camera",
    "permissions.default.microphone",
    "permissions.default.desktop-notification",
  ];
  try {
    perm.checked = Services.prefs.getIntPref("permissions.default.camera", 0) == 1;
  } catch (e) {
    perm.checked = false;
  }
  perm.addEventListener("change", () => {
    for (let pref of permPrefs) {
      try {
        if (perm.checked) {
          Services.prefs.setIntPref(pref, 1);
        } else {
          Services.prefs.clearUserPref(pref);
        }
      } catch (e) { /* one permission staying put is not fatal */ }
    }
    flashSaved();
  });
  // The settings page cannot call the chrome window directly, so it
  // asks for an update by flipping a pref the chrome window watches.
  document.getElementById("setting-update-now").addEventListener("click", () => {
    Services.prefs.setBoolPref("seijaku.update.installNow", true);
  });
});
