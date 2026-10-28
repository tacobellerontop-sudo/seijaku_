/* Seijaku settings: saved as soon as they change. */

"use strict";

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
    document.getElementById("saved").hidden = false;
    setTimeout(() => (document.getElementById("saved").hidden = true), 2000);
  });
}

function bindBool(id, pref) {
  let el = document.getElementById(id);
  el.checked = Services.prefs.getBoolPref(pref, true);
  el.addEventListener("change", () => {
    Services.prefs.setBoolPref(pref, el.checked);
    document.getElementById("saved").hidden = false;
    setTimeout(() => (document.getElementById("saved").hidden = true), 2000);
  });
}

window.addEventListener("DOMContentLoaded", () => {
  bind("setting-theme", "seijaku.theme", "string");
  bind("setting-sleep", "seijaku.tabs.unloadAfterMinutes", "int");
  bind("setting-search", "seijaku.searchUrl", "string");
  bind("setting-homepage", "seijaku.homepage", "string");
  bindBool("setting-update", "seijaku.update.enabled");
});
