/* Seijaku defaults. The interface (change these on the settings page). */
pref("toolkit.defaultChromeURI", "chrome://seijaku/content/seijaku.xhtml");
pref("toolkit.singletonWindowType", "seijaku:main");

pref("seijaku.update.enabled", true);          // check GitHub for a new release on startup, at most once a day
pref("seijaku.update.lastCheck", 0);           // seconds since the epoch of the last check
pref("seijaku.update.installNow", false);      // flipped by the Settings page to ask the chrome window to update now
pref("seijaku.theme", "ink");                  // ink, paper, matcha, sakura, ai, or custom (see docs/THEMES.md)
pref("seijaku.theme.custom.barBg", "#171310"); // custom theme colours, picked in Settings
pref("seijaku.theme.custom.fg", "#ece4d3");
pref("seijaku.theme.custom.accent", "#d8442a");
pref("seijaku.homepage", "seijaku:home");      // seijaku:home, about:blank or any address
pref("seijaku.searchUrl", "https://duckduckgo.com/?q=%s");
pref("seijaku.tabs.unloadAfterMinutes", 15);   // 0 turns tab sleeping off
pref("seijaku.chrome.autohide", false);        // hide the top bars, keep only the red line at the top edge (Settings)

/* The engine already composites on the GPU; nothing here turns that
   off, and the shell's own animations are opacity/transform only, so
   they ride the compositor instead of reflowing anything. */
pref("layers.acceleration.disabled", false);

/* DRM, kept on: encrypted video (Netflix and the like) needs the
   Widevine CDM, which Gecko downloads on first use — it is not bundled
   and nothing in the package drops it (only the clear-key module goes,
   which no DRM site uses). One honest caveat, still untested: the
   engine binary is renamed, and Breached keeps an unrenamed binary for
   Google-certified video sites, so if a DRM site refuses to play, the
   rename is the first suspect. */
pref("media.eme.enabled", true);
pref("media.gmp-widevinecdm.enabled", true);

/* Stripped Mozilla services: see docs/STRIPPED.md for why each is here.
   Every one of these is a background task, a network call, or a bundled
   feature that a browser does not need to browse the web. */
pref("toolkit.telemetry.enabled", false);
pref("toolkit.telemetry.unified", false);
pref("datareporting.healthreport.uploadEnabled", false);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("app.shield.optoutstudies.enabled", false);
pref("experiments.enabled", false);
pref("browser.newtabpage.activity-stream.showSponsored", false);
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
pref("browser.newtabpage.activity-stream.feeds.snippets", false);
pref("extensions.pocket.enabled", false);
pref("browser.pocket.enabled", false);
pref("identity.fxaccounts.enabled", false);
pref("browser.sync.enabled", false);
pref("services.sync.enabled", false);
pref("app.normandy.enabled", false);
pref("app.normandy.api_url", "");
pref("browser.crashReports.unsubmittedCheck.enabled", false);
pref("breakpad.reportURL", "");
pref("browser.safebrowsing.enabled", false);
pref("browser.safebrowsing.malware.enabled", false);
pref("browser.safebrowsing.phishing.enabled", false);
pref("browser.safebrowsing.downloads.enabled", false);
pref("network.captive-portal-service.enabled", false);
pref("network.connectivity-service.enabled", false);
pref("browser.messaging-system.whatsNewPanel.enabled", false);
pref("browser.vpnPromo.enabled", false);
pref("browser.preferences.moreFromMozilla", false);
pref("toolkit.coverage.opt-out", true);
pref("toolkit.coverage.endpoint.base", "");

/* Content windows open as tabs, not new windows. */
pref("browser.link.open_newwindow", 3);
pref("browser.link.open_newwindow.restriction", 0);
pref("dom.disable_open_during_load", true);

/* Downloads go straight to the Downloads folder, without asking. */
pref("browser.download.useDownloadDir", true);
pref("browser.download.folderList", 1);
pref("browser.download.always_ask_before_handling_new_files", false);

/* Built-in tracker blocking (Firefox's "Strict" level), kept: blocking
   trackers makes pages lighter, so this one stays. */
pref("privacy.trackingprotection.enabled", true);
pref("privacy.trackingprotection.socialtracking.enabled", true);
pref("privacy.trackingprotection.emailtracking.enabled", true);
pref("privacy.trackingprotection.fingerprinting.enabled", true);
pref("privacy.trackingprotection.cryptomining.enabled", true);
pref("network.cookie.cookieBehavior", 5);
pref("privacy.query_stripping.enabled", true);
