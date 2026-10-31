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
pref("seijaku.tabs.position", "top");           // top, bottom, left or right (Settings)
pref("seijaku.startup", "restore");            // restore, home or blank (Settings)
pref("seijaku.trackingprotection", "strict");  // strict, standard or off (Settings) — strict is the bundle below, kept as the default so the setting never weakens anyone on its own
pref("seijaku.weather.enabled", true);         // the home page's weather widget
pref("seijaku.weather.city", "Singapore");     // geocoded once, then stored as lat/lon below
pref("seijaku.weather.lat", "");               // filled on first weather fetch
pref("seijaku.weather.lon", "");
pref("seijaku.tabs.icons", true);         // site icons in tabs (Settings); private windows never show them
pref("seijaku.strip.buttons", "back,forward,reload,new,undo,bookmark,downloads,security,extensions,permissions,menu"); // shown strip buttons (Settings, or right-click the strip); home, reader, bookmarks and history are off by default
pref("seijaku.chrome.autohide", false);   // hide the strip, keep only the reveal strip at the placement edge (Settings)
pref("seijaku.download.folder", "");   // custom download folder (Settings); empty means the system Downloads folder
pref("seijaku.download.ask", false);   // ask where to save each file (Settings)
/* Location is denied outright, never prompted: it is the one
   permission Seijaku deliberately does not offer. The prompt
   component denies it again as a second layer. */
pref("geo.enabled", false);

/* The engine already composites on the GPU; nothing here turns that
   off, and the shell's own animations are opacity/transform only, so
   they ride the compositor instead of reflowing anything. */
pref("layers.acceleration.disabled", false);

/* DRM, kept on: encrypted video (Netflix and the like) needs the
   Widevine CDM, which Gecko downloads on first use — it is not bundled
   and nothing in the package drops it (only the clear-key module goes,
   which no DRM site uses). The engine binary stays unrenamed
   (firefox.exe) with seijaku.exe as a launcher, precisely so certified
   video sites accept it; the Settings "Protected video" button asks
   for Widevine on demand because the automatic check never runs on
   its own here. */
pref("media.eme.enabled", true);
pref("media.gmp-widevinecdm.enabled", true);
/* The update channel Widevine's download needs: Firefox sets this in
   its own channel-prefs.js, which lives in the front end the packager
   drops — so without this line the GMP download request goes out with
   an empty channel, Mozilla's server returns nothing, and the CDM
   never downloads (a DRM tester then reports Widevine not found). */
pref("app.update.channel", "release");
/* Explicit Widevine download settings (belt-and-braces: the URL
   default lives in the engine, but stating it here removes one
   unknown from the DRM diagnosis, and visible/autoupdate make the
   intent explicit). */
pref("media.gmp-manager.url", "https://aus5.mozilla.org/update/3/GMP/%VERSION%/%BUILD_ID%/%BUILD_TARGET%/%LOCALE%/%CHANNEL%/%OS_VERSION%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml");
pref("media.gmp-widevinecdm.visible", true);
pref("media.gmp-widevinecdm.autoupdate", true);

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

/* No password manager: Seijaku has no UI to save or fill logins, and
   the engine's login actor would otherwise try to offer a save prompt
   that has nowhere to appear on every sign-in form. */
pref("signon.rememberSignons", false);
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

/* Extensions. Firefox sets these in its front end's prefs, which the
   packager drops; without them the engine falls back to developer
   defaults. Extensions run in their own process and must be signed by
   Mozilla, exactly as in Firefox. Installs from addons.mozilla.org are
   allowed by shell/defaults/permissions; every install still shows its
   permissions first. Extensions update themselves from
   addons.mozilla.org once a day, asking as Firefox (its application id
   is written into the update address, since addons.mozilla.org does
   not know Seijaku's); nothing else about add-ons is fetched (no
   recommendations, no metadata cache). */
pref("permissions.manager.defaultsUrl", "resource://app/defaults/permissions");
pref("extensions.webextensions.remote", true);
pref("xpinstall.signatures.required", true);
pref("extensions.langpacks.signatures.required", true);
pref("extensions.postDownloadThirdPartyPrompt", true);
pref("extensions.webextOptionalPermissionPrompts", true);
pref("extensions.autoDisableScopes", 15);
pref("extensions.startupScanScopes", 0);
pref("extensions.update.enabled", true);
pref("extensions.update.autoUpdateDefault", true);
pref("extensions.update.interval", 86400);
pref("extensions.update.url", "https://versioncheck.addons.mozilla.org/update/VersionCheck.php?reqVersion=%REQ_VERSION%&id=%ITEM_ID%&version=%ITEM_VERSION%&maxAppVersion=%ITEM_MAXAPPVERSION%&status=%ITEM_STATUS%&appID={ec8030f7-c20a-464f-9b0e-13a3a9e97384}&appVersion=%APP_VERSION%&appOS=%APP_OS%&appABI=%APP_ABI%&locale=%APP_LOCALE%&currentAppVersion=%CURRENT_APP_VERSION%&updateType=%UPDATE_TYPE%&compatMode=%COMPATIBILITY_MODE%");
pref("extensions.update.background.url", "https://versioncheck-bg.addons.mozilla.org/update/VersionCheck.php?reqVersion=%REQ_VERSION%&id=%ITEM_ID%&version=%ITEM_VERSION%&maxAppVersion=%ITEM_MAXAPPVERSION%&status=%ITEM_STATUS%&appID={ec8030f7-c20a-464f-9b0e-13a3a9e97384}&appVersion=%APP_VERSION%&appOS=%APP_OS%&appABI=%APP_ABI%&locale=%APP_LOCALE%&currentAppVersion=%CURRENT_APP_VERSION%&updateType=%UPDATE_TYPE%&compatMode=%COMPATIBILITY_MODE%");
pref("extensions.getAddons.cache.enabled", false);
pref("extensions.systemAddon.update.enabled", false);
pref("extensions.abuseReport.enabled", false);
/* Read by the engine's browserAction code, which assumes Firefox's
   toolbars exist. */
pref("sidebar.verticalTabs", false);
pref("browser.toolbars.bookmarks.visibility", "never");

/* PDFs open in the engine's own viewer (pdf.js, started by seijaku.js),
   as in Firefox: PDFs a site sends as an attachment or as a plain
   binary file too, instead of going to the download list. */
pref("browser.download.open_pdf_attachments_inline", true);
pref("pdfjs.handleOctetStream", true);
/* The viewer's newer look takes its colours from Firefox's front end,
   which Seijaku doesn't have (Breached found its toolbar icons drawn
   blank with it), and no "PDFs just got easier" promotion bar. */
pref("pdfjs.enableNova", false);
pref("pdfjs.featuresNotificationImpressionLimit", 0);
