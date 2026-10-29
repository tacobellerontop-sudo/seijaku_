/* Protected video: Google's Widevine, which plays Netflix, Disney+,
   Spotify and the like in Gecko. Mozilla's update server hands it
   out (about 10 MB); Gecko keeps it in the profile and updates it.
   The automatic check never fires on this shell's profiles (it is
   throttled to once a day and evidently never runs here), so the
   Settings page installs it on demand through this module instead:
   ask the server now, rather than waiting for a check that may never
   come. Nothing here changes the automatic path — this is purely an
   on-demand setup alongside it. */

const WIDEVINE = "gmp-widevinecdm";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  GMPInstallManager: "resource://gre/modules/GMPInstallManager.sys.mjs",
});

/** True once Gecko has Widevine: the version pref is only set when
    the CDM actually downloaded. */
export function installed() {
  return !!Services.prefs.getStringPref(`media.${WIDEVINE}.version`, "");
}

export function version() {
  return Services.prefs.getStringPref(`media.${WIDEVINE}.version`, "");
}

/** Lets Gecko use Widevine (Firefox's own switches for it). */
export function allow(on) {
  Services.prefs.setBoolPref("media.eme.enabled", on);
  Services.prefs.setBoolPref(`media.${WIDEVINE}.visible`, on);
  Services.prefs.setBoolPref(`media.${WIDEVINE}.enabled`, on);
}

// One download at a time, shared by every window.
let installing = null;

/** Downloads Widevine if it isn't here yet. Resolves true only when
    the version pref confirms it is actually installed. */
export function install() {
  if (installed()) {
    return Promise.resolve(true);
  }
  installing ??= (async () => {
    let manager = new lazy.GMPInstallManager();
    try {
      let { addons } = await manager.checkForAddons();
      let widevine = addons.find(a => a.id == WIDEVINE && a.isValid);
      if (!widevine) {
        throw new Error("Mozilla's update server didn't offer Widevine");
      }
      if (!widevine.isInstalled) {
        await manager.installAddon(widevine);
      }
      return installed();
    } finally {
      manager.uninit();
      installing = null;
    }
  })();
  return installing;
}

export function busy() {
  return !!installing;
}
