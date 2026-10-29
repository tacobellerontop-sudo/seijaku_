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
  let theme = bind("setting-theme", "seijaku.theme", "string");
  let customBlock = document.getElementById("setting-custom-theme");
  let showCustom = () => (customBlock.hidden = theme.value != "custom");
  theme.addEventListener("change", showCustom);
  showCustom();
  bind("setting-custom-bg", "seijaku.theme.custom.barBg", "string");
  bind("setting-custom-fg", "seijaku.theme.custom.fg", "string");
  bind("setting-custom-accent", "seijaku.theme.custom.accent", "string");
  bind("setting-sleep", "seijaku.tabs.unloadAfterMinutes", "int");
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
