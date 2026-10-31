/* Seijaku: a lean browser shell on Gecko. Tabs on any edge, a floating
   URL bar (no persistent address line), a home page, settings, tab
   sleeping (auto and on demand), auto-update, find, zoom, themes,
   bookmarks, history, downloads, tab suggestions, a PDF viewer with
   annotation, permission prompts, private windows, extensions, a
   reader view, right-click menus, and page fullscreen. Nothing else on purpose: no accounts, no services, no
   command bar, no sync, no AI. See docs/PLAN.md. */

"use strict";

const { E10SUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/E10SUtils.sys.mjs"
);
const Theme = ChromeUtils.importESModule("resource://seijaku/Theme.sys.mjs");
const Widevine = ChromeUtils.importESModule("resource://seijaku/Widevine.sys.mjs");

// The engine's own page actors (Select, Finder, UAWidgets, AudioPlayback,
// AutoScroll and the rest) are registered by whoever imports this
// module. In Firefox that is the front end (browser/), which the
// packager drops, so without this line web pages get no <select>
// dropdowns, no video controls, no find, no sound events. Importing it
// registers the toolkit set once per process; later windows reuse it.
try {
  ChromeUtils.importESModule("resource://gre/modules/ActorManagerParent.sys.mjs");
} catch (e) {
  console.error("Seijaku: registering the engine's page actors", e);
}

// Seijaku's own actor: reader view runs Readability inside the page's
// process, because web pages live in a content process and the chrome
// window cannot reach their document directly. Registering twice (a
// second window) throws, which is fine: the first registration stands.
try {
  ChromeUtils.registerWindowActor("SeijakuReader", {
    parent: { esModuleURI: "resource://seijaku/SeijakuReaderParent.sys.mjs" },
    child: { esModuleURI: "resource://seijaku/SeijakuReaderChild.sys.mjs" },
    messageManagerGroups: ["browsers"],
    // Web pages run in "untrusted" web processes, which an actor may
    // only enter when it says it is safe there: this one only reads
    // the page it is in and returns text, and the shell sanitises it.
    safeForUntrustedWebProcess: true,
  });
} catch (e) { /* already registered by another window */ }

// Tab icons: the page's own icon, read in its process once it has
// loaded (see SeijakuIconChild.sys.mjs). Top-level http(s) pages only.
try {
  ChromeUtils.registerWindowActor("SeijakuIcon", {
    parent: { esModuleURI: "resource://seijaku/SeijakuIconParent.sys.mjs" },
    child: { esModuleURI: "resource://seijaku/SeijakuIconChild.sys.mjs" },
    matches: ["http://*/*", "https://*/*"],
    messageManagerGroups: ["browsers"],
    // Only reads link elements and returns their resolved address.
    safeForUntrustedWebProcess: true,
  });
} catch (e) { /* already registered by another window */ }

// The right-click menu, link clicks with a modifier or the middle
// button, and page fullscreen: each was handled by Firefox's front
// end, which the packager drops. See the modules for why each exists.
// Each one only wakes on its own event, so pages cost nothing extra.
for (let [name, events] of [
  // After the page's own handlers (the system group), so a page that
  // draws its own menu can still say so.
  ["SeijakuContextMenu", { contextmenu: { mozSystemGroup: true } }],
  // The engine's report of a link click it won't follow by itself.
  ["SeijakuLink", { chromelinkclick: { capture: true, mozSystemGroup: true } }],
  ["SeijakuFullscreen", {
    "MozDOMFullscreen:Request": {},
    "MozDOMFullscreen:Entered": {},
    "MozDOMFullscreen:NewOrigin": {},
    "MozDOMFullscreen:Exit": {},
    "MozDOMFullscreen:Exited": {},
  }],
]) {
  try {
    ChromeUtils.registerWindowActor(name, {
      parent: { esModuleURI: `resource://seijaku/${name}Parent.sys.mjs` },
      child: { esModuleURI: `resource://seijaku/${name}Child.sys.mjs`, events },
      messageManagerGroups: ["browsers"],
      allFrames: true,
      safeForUntrustedWebProcess: true,
    });
  } catch (e) { /* already registered by another window */ }
}

// Site permission prompts (notifications, camera, microphone): see
// PermissionPrompt.sys.mjs for why these are registered at runtime.
try {
  ChromeUtils.importESModule("resource://seijaku/PermissionPrompt.sys.mjs").register();
} catch (e) {
  console.error("Seijaku: registering permission prompts", e);
}

const PREF = "seijaku.";
const SESSION_FILE = "seijaku-session.json";
const DATA_FILE = "seijaku-data.json";
const HISTORY_LIMIT = 1000;
const MESSAGE_MS = 4000;
const SEIJAKU_VERSION = "0.2.13";
const UPDATE_REPO = "tacobellerontop-sudo/seijaku_";
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
// Session and data writes are batched: a page load reports its
// address, title and finish separately, and each used to rewrite the
// whole file. One write per second at most, flushed on close.
const SAVE_DELAY_MS = 1000;
// The strip's buttons, in strip order, for the "which buttons show"
// setting (seijaku.strip.buttons lists the shown keys). The ones
// marked off start hidden; everything else shows by default.
const STRIP_BUTTONS = [
  { key: "back", id: "nav-back", label: "Back" },
  { key: "forward", id: "nav-forward", label: "Forward" },
  { key: "reload", id: "nav-reload", label: "Reload" },
  { key: "home", id: "nav-home", label: "Home", off: true },
  { key: "new", id: "tab-new", label: "New tab" },
  { key: "undo", id: "tab-undo", label: "Reopen closed tab" },
  { key: "bookmark", id: "bookmark-star", label: "Bookmark this page" },
  { key: "reader", id: "reader-button", label: "Reader view", off: true },
  { key: "bookmarks", id: "bookmarks-button", label: "Bookmarks", off: true },
  { key: "history", id: "history-button", label: "History", off: true },
  { key: "downloads", id: "downloads-button", label: "Downloads" },
  { key: "security", id: "sec-lock", label: "Connection security" },
  { key: "extensions", id: "ext-buttons", label: "Extension buttons" },
  { key: "permissions", id: "perm-lock", label: "Site permissions" },
  { key: "menu", id: "strip-menu", label: "Settings" },
];
const STRIP_DEFAULT = STRIP_BUTTONS.filter(b => !b.off).map(b => b.key).join(",");

function emptyData() {
  return { bookmarks: [], history: [], permissions: {}, folders: [], downloadsHistory: [] };
}

const PAGES = {
  "seijaku:home": "chrome://seijaku/content/pages/home.html",
  "seijaku:settings": "chrome://seijaku/content/pages/settings.html",
  "seijaku:bookmarks": "chrome://seijaku/content/pages/bookmarks.html",
  "seijaku:history": "chrome://seijaku/content/pages/history.html",
  "seijaku:downloads": "chrome://seijaku/content/pages/downloads.html",
  "seijaku:extensions": "chrome://seijaku/content/pages/extensions.html",
  "seijaku:reader": "chrome://seijaku/content/pages/reader.html",
  "seijaku:pdf": "chrome://seijaku/content/pages/pdf.html",
};

function realURL(url) {
  let [page, hash] = url.split("#", 2);
  return PAGES[page] ? PAGES[page] + (hash ? "#" + hash : "") : url;
}

function displayURL(spec) {
  let [page, hash] = spec.split("#", 2);
  for (let [name, real] of Object.entries(PAGES)) {
    if (page == real) {
      return name + (hash ? "#" + hash : "");
    }
  }
  return spec;
}

/** One tab: its strip entry and, while awake, its <browser>. */
class Tab {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "tab";
    this.el.setAttribute("role", "tab");
    this.labelEl = document.createElement("span");
    this.labelEl.className = "tab-label";
    // The site's icon, when it has one and icons are on (Settings).
    // Hidden until it loads, and hidden again if it fails to.
    this.iconEl = document.createElement("img");
    this.iconEl.className = "tab-icon";
    this.iconEl.alt = "";
    this.iconEl.hidden = true;
    this.iconEl.addEventListener("load", () => (this.iconEl.hidden = false));
    this.iconEl.addEventListener("error", () => (this.iconEl.hidden = true));
    // No close button on purpose: a tab closes with a double-click
    // (or Ctrl+W, or middle-click). One less control per tab keeps the
    // strip quiet, and the strip is where the eye lives.
    // The speaker mark: shown while the tab makes sound, dimmed while
    // muted; clicking it mutes or unmutes the tab (see toggleMute).
    this.speakerEl = document.createElement("span");
    this.speakerEl.className = "tab-speaker";
    this.speakerEl.title = "Mute this tab";
    this.el.append(this.iconEl, this.labelEl, this.speakerEl);
    this.el.tab = this;
    Object.defineProperty(this.el, "linkedBrowser", { get: () => this.browser });
    this.browser = null;
    this.url = "about:blank";
    this.title = "";
    this.lastActive = Date.now();
    // Pinned tabs sit first in the strip and are never slept or
    // closed until unpinned (see togglePin). Security is the last
    // state the progress listener reported: secure, broken,
    // insecure, or internal for the browser's own pages.
    this.pinned = false;
    this.security = "internal";
    this.icon = "";
  }

  /** Shows the icon at this address, or none for "". */
  setIcon(href) {
    if (href == this.icon) {
      return;
    }
    this.icon = href;
    if (href) {
      this.iconEl.src = href;
    } else {
      this.iconEl.removeAttribute("src");
      this.iconEl.hidden = true;
    }
    Seijaku.tabEvent("TabAttrModified", this, { changed: ["image"] });
  }

  get asleep() {
    return !this.browser;
  }

  // The names the engine's extension code reads off a tab: its
  // browser, and "pending" for a tab that has no page loaded.
  get linkedBrowser() {
    return this.browser;
  }

  getAttribute(name) {
    if (name == "pending") {
      return this.asleep ? "true" : null;
    }
    return this.el.getAttribute(name);
  }

  update() {
    this.labelEl.textContent = this.title || this.url;
    this.el.title = this.url;
    this.el.toggleAttribute("asleep", this.asleep);
    this.el.toggleAttribute("pinned", this.pinned);
  }
}

var Seijaku = {
  version: SEIJAKU_VERSION,
  tabs: [],
  selected: null,
  closed: [],
  // Bookmarks + history, loaded from the profile (null until loaded).
  _data: null,
  // The engine's download list, kept by initDownloads.
  _downloads: [],
  _downloadsReady: false,
  _downloadsList: null,
  // Whether this window is private (Ctrl+Shift+N): no session, no
  // history, the private downloads list. Set in init from the window
  // arguments (and the engine's own private flag).
  isPrivate: false,
  // Current floating-bar suggestions, if the bar is open.
  _suggestItems: [],
  _suggestIndex: -1,
  // Current command-palette entries, if the palette is open.
  _paletteItems: [],
  _paletteIndex: -1,
  // Weather, cached so the home page never waits on the network.
  _weatherCache: null,
  // Permission prompts waiting for an answer, and the one on screen.
  _permQueue: [],
  _permActive: null,
  // The article the reader page renders, set by openReader.
  _readerArticle: null,
  // The extension host, once AddonManager has started.
  _AddonManager: null,
  _extReady: false,
  _messageTimer: null,
  _pendingUpdate: null,
  _stagedUpdate: null,
  _updating: false,

  get $tabbar() {
    return document.getElementById("tabbar");
  },
  get $content() {
    return document.getElementById("content");
  },
  get selectedBrowser() {
    return this.selected?.browser ?? null;
  },

  pref(name, fallback) {
    let full = PREF + name;
    switch (Services.prefs.getPrefType(full)) {
      case Services.prefs.PREF_BOOL:
        return Services.prefs.getBoolPref(full);
      case Services.prefs.PREF_INT:
        return Services.prefs.getIntPref(full);
      case Services.prefs.PREF_STRING:
        return Services.prefs.getStringPref(full);
    }
    return fallback;
  },

  init() {
    // A private window (Ctrl+Shift+N) is flagged two ways, the way
    // Breached does it: the engine's own private flag (the "private"
    // window feature), and the JSON argument the opener passed. The
    // engine flag is what keeps this window out of the singleton
    // main window's way; the argument carries the URL to open.
    this.initPrivateFlag();
    if (this.isPrivate) {
      document.documentElement.setAttribute("private", "true");
    }
    this.applyTheme();
    this.applyTrackingProtection();
    this.applyDownloadPrefs();
    // A System theme follows the OS live: when the OS flips dark /
    // light, the chrome re-applies (pages do the same in theme.js).
    try {
      this._systemMedia = window.matchMedia("(prefers-color-scheme: dark)");
      this._systemMedia.addEventListener("change", () => {
        if (this.pref("theme", "ink") == "system") {
          this.applyTheme();
        }
      });
    } catch (e) { /* a System theme just won't follow live */ }
    Services.prefs.addObserver(PREF, this);
    this.initStrip();
    this.applyStripButtons();
    this.applyTabsPosition();
    this.initBrowserDOMWindow();
    this.applyChromeAutohide();
    this.$tabbar.addEventListener("mousedown", this);
    this.$tabbar.addEventListener("auxclick", this);
    this.$tabbar.addEventListener("dblclick", this);
    this.initFindBar();
    document.getElementById("nav-back").addEventListener("click", () => this.selectedBrowser?.goBack());
    document.getElementById("nav-forward").addEventListener("click", () => this.selectedBrowser?.goForward());
    // Reload — or Stop while the tab is loading (see stopLoad).
    document.getElementById("nav-reload").addEventListener("click", () => {
      if (this.selected?.browser && this.selected.el.hasAttribute("busy")) {
        this.stopLoad();
      } else {
        this.selectedBrowser?.reload();
      }
    });
    document.getElementById("tab-new").addEventListener("click", () => this.newTab());
    document.getElementById("tab-undo").addEventListener("click", () => this.undoCloseTab());
    document.getElementById("bookmark-star").addEventListener("click", () => this.toggleBookmark());
    document.getElementById("strip-menu").addEventListener("click", () => this.openPage("settings"));
    document.getElementById("downloads-button").addEventListener("click", () => this.openPage("downloads"));
    document.getElementById("nav-home").addEventListener("click", () => this.goHome());
    document.getElementById("reader-button").addEventListener("click", () => this.openReader());
    document.getElementById("bookmarks-button").addEventListener("click", () => this.openPage("bookmarks"));
    document.getElementById("history-button").addEventListener("click", () => this.openPage("history"));
    // Right-click: a tab gets the tab menu; anywhere else on the strip
    // gets the list of buttons to show or hide.
    document.getElementById("strip").addEventListener("contextmenu", event => this.onStripContextMenu(event));
    // The mouse's side buttons (and keyboard media keys) arrive as
    // AppCommand events; Firefox's front end handled them.
    window.addEventListener("AppCommand", event => this.onAppCommand(event), true);
    document.getElementById("perm-lock").addEventListener("click", () => this.showPermissionManage());
    document.getElementById("sec-lock").addEventListener("click", () => this.showSiteInfo());
    document.getElementById("edge-strip").addEventListener("mouseenter", () => this.showChrome());
    document.getElementById("main").addEventListener("mouseover", () => {
      // Moving onto the page hides auto-hidden chrome. This fires
      // when the pointer enters the page area from the strip; moves
      // inside the page itself never reach chrome at all.
      if (this._autohide) {
        this.hideChrome();
      }
    });
    this.loadData();
    this.initDownloads();
    this.updateUndoButton();
    this.initFloatingBar();
    this.initPalette();
    this.initSitePanel();
    this.initPermissionPanel();
    this.initExtensions();
    window.addEventListener("keydown", this, true);
    window.addEventListener("mousemove", this);
    window.addEventListener("unload", this);
    Keys.install();
    // A link clicked elsewhere while Seijaku runs arrives as a remote
    // command line; without a handler of its own, the shell learns
    // about it here instead (see launchURL below). A private window
    // never takes these: the link belongs in the main window, and
    // this window must not open it a second time.
    if (!this.isPrivate) {
      try {
        Services.obs.addObserver(this, "commandline-args-changed");
      } catch (e) { /* remote links just open a new window instead */ }
    }

    if (this.isPrivate) {
      // No restored session, no launched link: a private window
      // starts clean, on the URL it was opened with or the home page.
      this.openTab(this._privateURL || this.homepage());
    } else {
      // A launched link beats the home page: it opens as the first tab
      // on a cold start, or as a new tab after a restored session.
      let launch = this.launchURL();
      let launchTarget = null;
      if (launch) {
        try {
          launchTarget = this.urlFor(launch);
        } catch (e) {
          launchTarget = launch;
        }
      }
      // Startup mode (Settings): restore is the old behavior; home
      // opens only the home page; blank opens only about:blank. A
      // launched link still opens on top in home/blank modes — a
      // clicked link is an explicit request, not a startup page.
      let mode = this.pref("startup", "restore");
      if (mode == "home") {
        this.openTab(this.homepage());
        if (launchTarget) {
          this.openTab(launchTarget, { afterCurrent: true });
        }
      } else if (mode == "blank") {
        this.openTab("about:blank");
        if (launchTarget) {
          this.openTab(launchTarget, { afterCurrent: true });
        }
      } else {
        this.restoreSession().then(restored => {
          if (launchTarget) {
            this.openTab(launchTarget, { afterCurrent: true });
          } else if (!restored) {
            this.openTab(this.homepage());
          }
        });
      }
    }
    this._sleepTimer = setInterval(() => this.sleepIdleTabs(), 60 * 1000);
    if (!this.isPrivate) {
      this.maybeCheckForUpdates();
    }
  },

  /** Reads the private flag from the engine and the window argument. */
  initPrivateFlag() {
    try {
      let { PrivateBrowsingUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
      );
      if (PrivateBrowsingUtils.isWindowPrivate(window)) {
        this.isPrivate = true;
      }
    } catch (e) { /* fall through to the argument */ }
    if (this.isPrivate) {
      return;
    }
    try {
      let arg = (window.arguments || [])[0];
      let text = typeof arg == "string" ? arg : arg?.data;
      if (text) {
        let parsed = JSON.parse(text);
        if (parsed?.private) {
          this.isPrivate = true;
          this._privateURL = parsed.url || null;
        }
      }
    } catch (e) { /* not a private window */ }
  },

  // -------------------------------------------------------------- updates
  //
  // Auto-update, the small way: once a day at most, ask GitHub for the
  // latest release. If there is a newer one, download the installer in
  // the background and stage it; quitting the browser then hands it to
  // a small hidden PowerShell script that waits for this install's
  // processes to exit (so Inno is never fighting a running browser),
  // installs silently, and starts Seijaku again. The Settings page has an Update button that does the same
  // thing immediately, by flipping the update.installNow pref. The
  // portable build has no installer to run, so it just opens the
  // release page.

  versionParts(version) {
    return String(version).replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  },

  isNewer(version) {
    let latest = this.versionParts(version);
    let current = this.versionParts(SEIJAKU_VERSION);
    for (let i = 0; i < Math.max(latest.length, current.length); i++) {
      if ((latest[i] || 0) > (current[i] || 0)) {
        return true;
      }
      if ((latest[i] || 0) < (current[i] || 0)) {
        return false;
      }
    }
    return false;
  },

  async checkForUpdates(announce) {
    let release;
    try {
      let response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) {
        throw new Error(`GitHub answered ${response.status}`);
      }
      release = await response.json();
    } catch (e) {
      if (announce) {
        this.showMessage(`Couldn't check for updates: ${e.message}`, "error");
      }
      return null;
    }
    try {
      Services.prefs.setIntPref(PREF + "update.lastCheck", Math.floor(Date.now() / 1000));
    } catch (e) { /* a missed timestamp only means checking again sooner */ }
    let tag = release.tag_name || "";
    if (!this.isNewer(tag)) {
      if (announce) {
        this.showMessage("Seijaku is up to date");
      }
      return null;
    }
    let installer = (release.assets || []).find(a => a.name.startsWith("SeijakuSetup-") && a.name.endsWith(".exe"));
    this._pendingUpdate = { version: tag.replace(/^v/, ""), url: installer?.browser_download_url, page: release.html_url };
    if (announce) {
      this.showMessage(`Seijaku ${this._pendingUpdate.version} is available`);
      return this._pendingUpdate;
    }
    // The quiet startup check: stage the update in the background so
    // quitting installs it, with no step the user has to remember.
    if (this.isInstalledBuild() && this._pendingUpdate.url) {
      try {
        await this.downloadAndStageUpdate(this._pendingUpdate);
        this.showMessage(`Seijaku ${this._pendingUpdate.version} downloaded — it will install when you quit`);
      } catch (e) {
        this.showMessage(`Seijaku ${this._pendingUpdate.version} is available — press Update in Settings to install it`);
      }
    } else {
      this.showMessage(`Seijaku ${this._pendingUpdate.version} is available — press Update in Settings to install it`);
    }
    return this._pendingUpdate;
  },

  async downloadAndStageUpdate(pending) {
    let tmp = Services.dirsvc.get("TmpD", Ci.nsIFile);
    let installerFile = tmp.clone();
    installerFile.append(`SeijakuSetup-${pending.version}.exe`);
    await this.downloadToFile(pending.url, installerFile);
    let script = tmp.clone();
    script.append("seijaku-update.ps1");
    let appDir = Services.dirsvc.get("GreD", Ci.nsIFile).path;
    await this.writeTextFile(script, this.updaterScript(installerFile.path, appDir));
    this._stagedUpdate = script.path;
  },

  // The updater waits for Seijaku to quit before installing over it,
  // installs silently, and starts Seijaku again. It runs hidden, so
  // nothing but Seijaku itself coming back is visible.
  //
  // What it waits for is every process running from this install
  // folder: the engine, its content processes, and any background
  // task the engine starts at shutdown. 0.2.10 and earlier waited for
  // any firefox.exe at all, so a real Firefox left open (or anything
  // else named firefox.exe) kept the update waiting in a terminal
  // window forever. Processes from this folder that are still there a
  // minute after quitting are stuck, and are ended so the update can
  // go ahead. The installer writes a log to %TEMP%\seijaku-update.log.
  updaterScript(installerPath, appDir) {
    let quote = s => "'" + String(s).replace(/'/g, "''") + "'";
    return [
      "$ErrorActionPreference = 'Continue'",
      "$dir = " + quote(appDir),
      "$setup = " + quote(installerPath),
      "$log = Join-Path $env:TEMP 'seijaku-update.log'",
      "function Get-SeijakuProcess {",
      "  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {",
      "    $path = try { $_.Path } catch { $null }",
      "    $path -and $path.StartsWith($dir + '\\', [StringComparison]::OrdinalIgnoreCase)",
      "  })",
      "}",
      "$deadline = (Get-Date).AddSeconds(60)",
      "while ((Get-SeijakuProcess).Count) {",
      "  if ((Get-Date) -gt $deadline) {",
      "    Get-SeijakuProcess | Stop-Process -Force -ErrorAction SilentlyContinue",
      "    Start-Sleep -Seconds 2",
      "    break",
      "  }",
      "  Start-Sleep -Milliseconds 500",
      "}",
      "Start-Process -FilePath $setup -Wait -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', \"/LOG=`\"$log`\"\"",
      "Start-Process -FilePath (Join-Path $dir 'seijaku.exe') -ArgumentList '-app', ('\"' + (Join-Path $dir 'seijaku\\application.ini') + '\"')",
      "Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue",
      "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
      "",
    ].join("\r\n");
  },

  launchUpdater(scriptPath) {
    let powershell = Services.dirsvc.get("WinD", Ci.nsIFile);
    for (let part of ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"]) {
      powershell.append(part);
    }
    let process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    process.init(powershell);
    try {
      process.startHidden = true;
    } catch (e) { /* -WindowStyle Hidden below still hides it */ }
    process.run(false, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath], 8);
  },

  maybeCheckForUpdates() {
    try {
      if (!this.pref("update.enabled", true)) {
        return;
      }
      let last = this.pref("update.lastCheck", 0) * 1000;
      if (Date.now() - last < UPDATE_CHECK_MS) {
        return;
      }
    } catch (e) {
      return;
    }
    this.checkForUpdates(false).catch(() => {});
  },

  isInstalledBuild() {
    // Two independent signals; either one saying "installed" wins.
    // The old single signal — unins000.exe next to the engine —
    // proved unreliable: on a genuine installed build, with
    // unins000.exe visibly present next to the exe, it still
    // returned false, and the exact CurProcD mechanism cannot be
    // reproduced outside Windows. So the primary signal is now the
    // uninstall registry key Inno writes for every install, which
    // does not depend on CurProcD at all.
    // 1. Uninstall registry key (HKCU, written by the installer).
    // open() succeeding means the key exists; throwing means it
    // does not. Any failure of the registry attempt itself falls
    // through to the file check below, never out of this method.
    try {
      let reg = Cc["@mozilla.org/windows-registry-key;1"]
        .createInstance(Ci.nsIWindowsRegKey);
      try {
        reg.open(
          Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
          "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{3B84B47F-E97E-4C90-AC83-37273A1DF910}_is1",
          Ci.nsIWindowsRegKey.ACCESS_READ
        );
        return true;
      } catch (e) {
        // Key absent: not installed by this signal. Fall through.
      } finally {
        try {
          reg.close();
        } catch (e) { /* already closed or never opened */ }
      }
    } catch (e) {
      // Registry API unavailable or unusable: fall through to the
      // file check rather than failing the update flow.
    }
    // 2. The installer leaves unins000.exe next to the engine; the
    // portable zip has Seijaku.bat there instead.
    try {
      let dir = Services.dirsvc.get("CurProcD", Ci.nsIFile).clone();
      dir.append("unins000.exe");
      return dir.exists();
    } catch (e) {
      // If even the fallback cannot be evaluated, prefer
      // "installed": an installed build must never be misread as
      // portable. A portable build with no install reaches a clean
      // false above, not this exception path.
      return true;
    }
  },

  async installUpdate() {
    if (this._updating) {
      this.showMessage("Update already in progress");
      return;
    }
    let pending = this._pendingUpdate || (await this.checkForUpdates(true));
    if (!pending) {
      return;
    }
    if (!this.isInstalledBuild()) {
      this.showMessage("This is the portable build — opening the release page instead");
      this.openTab(pending.page, { afterCurrent: true });
      return;
    }
    if (!pending.url) {
      this.showMessage("No installer found in that release — opening its page instead");
      this.openTab(pending.page, { afterCurrent: true });
      return;
    }
    this._updating = true;
    try {
      this.showMessage(`Downloading Seijaku ${pending.version}…`);
      await this.downloadAndStageUpdate(pending);
      this.launchUpdater(this._stagedUpdate);
      try {
        Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
      } catch (e) {
        window.close();
      }
    } catch (e) {
      this._updating = false;
      this.showMessage(`Update failed: ${e.message} — opening the release page instead`, "error");
      this.openTab(pending.page, { afterCurrent: true });
    }
  },

  downloadToFile(url, file) {
    // Streams to disk, so the ~90 MB installer never sits in memory.
    return new Promise((resolve, reject) => {
      let persist = Cc["@mozilla.org/embedding/browser/nsWebBrowserPersist;1"]
        .createInstance(Ci.nsIWebBrowserPersist);
      persist.persistFlags = Ci.nsIWebBrowserPersist.PERSIST_FLAGS_FROM_CACHE |
        Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES;
      persist.progressListener = {
        onStateChange(_progress, _request, stateFlags, status) {
          if (stateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
            if (status == 0) {
              resolve();
            } else {
              reject(new Error(`download failed (${status})`));
            }
          }
        },
        onProgressChange() {},
        onLocationChange() {},
        onStatusChange() {},
        onSecurityChange() {},
        onContentBlockingEvent() {},
        QueryInterface: ChromeUtils.generateQI([Ci.nsIWebProgressListener]),
      };
      try {
        // Current saveURI takes 10 arguments (the old 7-arg call threw
        // "Not enough arguments" on the update download — it had never
        // successfully run, since no newer release existed to fetch
        // until 0.2.8). Mirrors Firefox's own internalSave caller:
        // system principal (no source document for an updater fetch),
        // nulls for cache key / referrer / cookie jar / post data /
        // extra headers, the target as a file URI, save-as-download
        // policy, not private.
        persist.saveURI(
          Services.io.newURI(url),
          Services.scriptSecurityManager.getSystemPrincipal(),
          null,
          null,
          null,
          null,
          null,
          Services.io.newFileURI(file),
          Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
          false
        );
      } catch (e) {
        reject(e);
      }
    });
  },

  async writeTextFile(file, text) {
    try {
      let { IOUtils } = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs");
      await IOUtils.write(file.path, new TextEncoder().encode(text));
      return;
    } catch (e) { /* fall through to the stream writer */ }
    let stream = Cc["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream);
    stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
    stream.write(text, text.length);
    stream.close();
  },

  observe(subject, topic, data) {
    // A link clicked while Seijaku runs: open it in a new tab here
    // and bring this window forward, instead of leaving the user on
    // whatever page was already open.
    if (topic == "commandline-args-changed") {
      try {
        let url = subject?.QueryInterface
          ? this.launchURLFromCommandLine(subject.QueryInterface(Ci.nsICommandLine))
          : null;
        if (url) {
          let target = url;
          try {
            target = this.urlFor(url);
          } catch (e) { /* keep the raw address */ }
          this.openTab(target, { afterCurrent: true });
          window.focus();
        }
      } catch (e) { /* a remote link just doesn't open */ }
      return;
    }
    if (topic == "nsPref:changed" && data.startsWith(PREF)) {
      if (data == PREF + "theme" || data.startsWith(PREF + "theme.")) {
        this.applyTheme();
      }
      if (data == PREF + "trackingprotection") {
        this.applyTrackingProtection();
      }
      if (data == PREF + "chrome.autohide") {
        this.applyChromeAutohide();
      }
      if (data == PREF + "tabs.position") {
        this.applyTabsPosition();
      }
      if (data == PREF + "strip.buttons") {
        this.applyStripButtons();
      }
      if (data == PREF + "tabs.icons" && !this.iconsEnabled()) {
        for (let tab of this.tabs) {
          tab.setIcon("");
        }
        this.saveSession();
      }
      // The Settings page has no way to call into this window, so it
      // asks for an update by flipping this pref instead.
      if (data == PREF + "update.installNow") {
        try {
          if (Services.prefs.getBoolPref(data, false)) {
            Services.prefs.setBoolPref(data, false);
            this.installUpdate();
          }
        } catch (e) { /* installing stays available from the next start */ }
      }
    }
  },

  applyTheme() {
    // A custom theme is three colours from prefs; everything else
    // falls back to ink, so a custom theme can never come out unreadable.
    // "system" resolves through the OS setting, live (see init): dark
    // is the ink look, light is the paper look — no new colour set.
    let custom = {
      barBg: this.pref("theme.custom.barBg", "#171310"),
      fg: this.pref("theme.custom.fg", "#ece4d3"),
      accent: this.pref("theme.custom.accent", "#d8442a"),
    };
    let theme = this.pref("theme", "ink");
    if (theme == "system") {
      try {
        theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "ink" : "paper";
      } catch (e) {
        theme = "ink";
      }
    }
    Theme.applyColors(document.documentElement, theme, custom);
  },

  // -------------------------------------------------------------- taskbar
  //
  // The taskbar button is not the exe's icon and not the branding
  // package: Windows groups the button by AppUserModelID and takes the
  // icon from the shortcut that matches that ID. So Seijaku sets one
  // stable ID on its window here, and the installer puts the identical
  // ID (plus the seal icon) on its shortcuts. Either half alone is
  // what "still Firefox" looked like. The window-icon file and the
  // branding package stay, but neither fixes the button by itself.
  // If this service is missing in the shipped engine, nothing breaks:
  // the button just falls back to the old behaviour.

  setAppUserModelId() {
    try {
      if (Services.appinfo.OS != "WINNT") {
        return;
      }
      let taskbar = Cc["@mozilla.org/windows-taskbar;1"].getService(Ci.nsIWinTaskbar);
      taskbar.setGroupIdForWindow(window, "Seijaku.Seijaku");
    } catch (e) { /* the button keeps its old grouping */ }
  },

  // -------------------------------------------------------------- popups
  //
  // A window.open that did nothing was the expected symptom of a
  // shell that gives Gecko nowhere to put the new window. The chrome
  // window answers for its pages through nsIBrowserDOMWindow, so this
  // is Seijaku's: every request maps onto a tab, which is the shell's
  // policy already (open_newwindow=3 with restriction=0 diverts even
  // feature popups to tabs). It returns the new tab's content window,
  // because a caller that gets nothing back experiences exactly
  // "popup did nothing". Two assignment points are documented for
  // this object and they disagree, so both are set; each is guarded,
  // so a missing interface in the shipped engine just leaves popups
  // as they were instead of breaking the shell.

  initBrowserDOMWindow() {
    let provider;
    try {
      provider = {
        QueryInterface: ChromeUtils.generateQI([Ci.nsIBrowserDOMWindow]),
        openURI(uri, opener, where) {
          return Seijaku.openPopup(uri, where);
        },
        openURIInFrame(uri, opener, where) {
          return Seijaku.openPopup(uri, where);
        },
        isTabContentWindow(win) {
          try {
            return Seijaku.tabs.some(t => t.browser?.contentWindow == win);
          } catch (e) {
            return false;
          }
        },
        createNewWindow(uri, opener, where) {
          return Seijaku.openPopup(uri, where);
        },
      };
    } catch (e) {
      return;
    }
    try {
      window.QueryInterface(Ci.nsIDOMChromeWindow).browserDOMWindow = provider;
    } catch (e) { /* the other assignment may still work */ }
    try {
      window.browserDOMWindow = provider;
    } catch (e) { /* assignment is best-effort */ }
  },

  openPopup(uri, where) {
    let url = "";
    try {
      url = uri?.spec ?? String(uri ?? "");
    } catch (e) {
      return null;
    }
    if (!url) {
      return null;
    }
    try {
      if (where == Ci.nsIBrowserDOMWindow.OPEN_CURRENTWINDOW && this.selectedBrowser) {
        this.load(this.selectedBrowser, url);
        return this.selectedBrowser?.contentWindow ?? null;
      }
      let tab = this.openTab(url, { afterCurrent: true });
      return tab.browser?.contentWindow ?? null;
    } catch (e) {
      return null;
    }
  },

  // -------------------------------------------------------------- tab placement
  //
  // seijaku.tabs.position moves the whole strip — seal, nav, tabs,
  // actions, window buttons — to any edge: top (the default), bottom,
  // left, or right. The CSS does the laying out; this only stamps
  // the attribute the CSS reads. An unknown value falls back to top
  // instead of leaving the strip unplaced.

  applyTabsPosition() {
    let position = this.pref("tabs.position", "top");
    if (!["top", "bottom", "left", "right"].includes(position)) {
      position = "top";
    }
    this._tabsPosition = position;
    document.documentElement.setAttribute("tabs-position", position);
  },

  // -------------------------------------------------------------- auto-hide chrome
  //
  // An opt-in "just the page" mode: with seijaku.chrome.autohide on,
  // the strip collapses and only the reveal strip stays at the
  // placement edge. Ctrl+Shift+H flips the setting, so the mode can
  // always be left from the keyboard too.
  //
  // Why the old reveal did not work: the 2px line lived INSIDE the
  // hidden chrome container (visibility: collapse takes it out of
  // hit-testing, so it could never receive a mouse event), and the
  // only other reveal path was a window mousemove — which the page
  // never delivers, because the page lives in a content process and
  // its mouse events never reach the chrome window. The fix is the
  // #edge-strip element: it sits OUTSIDE the hidden container at the
  // placement edge, always hit-testable while hidden, and its own
  // mouseenter reveals the strip (see init). The window mousemove
  // below stays only as a fallback for the strip's edge, and the
  // #main mouseover in init is what hides the strip again — moving
  // onto the page is the one chrome-side event that reliably fires.

  applyChromeAutohide() {
    try {
      this._autohide = Services.prefs.getBoolPref("seijaku.chrome.autohide", false);
    } catch (e) {
      this._autohide = false;
    }
    if (this._autohide) {
      document.documentElement.setAttribute("autohide", "true");
      this.hideChrome();
    } else {
      document.documentElement.removeAttribute("autohide");
      document.documentElement.removeAttribute("chrome-hidden");
    }
  },

  showChrome() {
    document.documentElement.removeAttribute("chrome-hidden");
  },

  hideChrome() {
    if (this._autohide) {
      document.documentElement.setAttribute("chrome-hidden", "true");
    }
  },

  toggleChromeAutohide() {
    try {
      Services.prefs.setBoolPref(
        "seijaku.chrome.autohide",
        !Services.prefs.getBoolPref("seijaku.chrome.autohide", false)
      );
    } catch (e) { /* the setting just doesn't flip */ }
  },

  initStrip() {
    // This is what hides the Windows title bar: without it Gecko draws
    // its own bar above ours (the double-bar bug in 0.1.0). The attribute
    // is also on the <html> element in seijaku.xhtml; setting it here too
    // covers the case where the document is reloaded. The strip IS the
    // title bar now (there is no separate title row): its background
    // drags the window, and every control on it opts out in CSS.
    document.documentElement.setAttribute("customtitlebar", "true");
    this.setAppUserModelId();
    let buttons = {
      "titlebar-min": () => window.minimize(),
      "titlebar-max": () => window.maximize(),
      "titlebar-restore": () => window.restore(),
      "titlebar-close": () => window.close(),
    };
    for (let [id, action] of Object.entries(buttons)) {
      document.getElementById(id).addEventListener("click", action);
    }
    let updateSizeMode = () => {
      let mode = {
        [window.STATE_MAXIMIZED]: "maximized",
        [window.STATE_MINIMIZED]: "minimized",
        [window.STATE_FULLSCREEN]: "fullscreen",
      }[window.windowState] ?? "normal";
      document.documentElement.setAttribute("sizemode", mode);
    };
    window.addEventListener("sizemodechange", updateSizeMode);
    updateSizeMode();
  },

  homepage() {
    return this.pref("homepage", "seijaku:home") || "about:blank";
  },

  // -------------------------------------------------------------- bookmarks and history
  //
  // One small JSON file in the profile holds both, because the shell
  // already trusts IOUtils + JSON for the session and because Places
  // (Firefox's history/bookmark database) is a whole service the
  // shell deliberately never wakes. Only the user's real visits and
  // bookmarks are ever in here — nothing is invented, and internal
  // pages (seijaku:, about:, chrome://) are never recorded. The
  // manager pages read this through the shell object, the way the
  // home page already reaches it, so there is exactly one writer.

  dataPath() {
    try {
      return PathUtils.join(PathUtils.profileDir, DATA_FILE);
    } catch (e) {
      return null;
    }
  },

  /** The window whose store this one uses. A private window shares
      the main window's live store (bookmarks are shared, the way
      Firefox does it) instead of loading a copy of its own: two
      copies of one file would each overwrite the other's changes. */
  dataOwner() {
    if (this.isPrivate) {
      try {
        for (let win of Services.wm.getEnumerator("seijaku:main")) {
          let other = win.Seijaku;
          if (win != window && !win.closed && other && !other.isPrivate && other._dataLoaded) {
            return other;
          }
        }
      } catch (e) { /* fall back to this window's own copy */ }
    }
    return this;
  },

  async loadData() {
    let owner = this.dataOwner();
    if (owner != this) {
      this._data = owner._data;
      this._dataLoaded = true;
      return;
    }
    let path = this.dataPath();
    if (!path) {
      this._data ??= emptyData();
      this._dataLoaded = true;
      return;
    }
    let loaded = emptyData();
    try {
      let data = await IOUtils.readJSON(path);
      // Bookmarks carry a folder ("" is All); older stores have
      // none, so they migrate to All here. Folder names the user
      // created live alongside, so an empty folder still exists.
      let bookmarks = Array.isArray(data?.bookmarks) ? data.bookmarks : [];
      for (let b of bookmarks) {
        if (typeof b.folder != "string") {
          b.folder = "";
        }
      }
      loaded = {
        bookmarks,
        history: Array.isArray(data?.history) ? data.history : [],
        permissions: data?.permissions && typeof data.permissions == "object" ? data.permissions : {},
        folders: Array.isArray(data?.folders)
          ? data.folders.filter(f => typeof f == "string" && f)
          : [],
        downloadsHistory: Array.isArray(data?.downloadsHistory)
          ? data.downloadsHistory.filter(e => e && typeof e.path == "string")
          : [],
      };
    } catch (e) {
      // A missing file is a first run. Anything else is a damaged
      // file: keep a copy before the next save replaces it, so the
      // bookmarks in it can still be recovered by hand.
      if (e?.name != "NotFoundError") {
        console.error("Seijaku: reading data", e);
        await IOUtils.copy(path, path + ".damaged").catch(() => {});
      }
    }
    // Anything recorded before the file finished loading (the first
    // page's history entry, a quick Ctrl+D) is merged in, not lost.
    let early = this._data;
    this._data = loaded;
    this._dataLoaded = true;
    if (early) {
      let marked = new Set(loaded.bookmarks.map(b => b.url));
      loaded.bookmarks.push(...early.bookmarks.filter(b => !marked.has(b.url)));
      loaded.history.push(...early.history);
      if (loaded.history.length > HISTORY_LIMIT) {
        loaded.history.splice(0, loaded.history.length - HISTORY_LIMIT);
      }
      for (let [host, grants] of Object.entries(early.permissions)) {
        loaded.permissions[host] = { ...loaded.permissions[host], ...grants };
      }
      loaded.folders.push(...early.folders.filter(f => !loaded.folders.includes(f)));
      loaded.downloadsHistory.unshift(...early.downloadsHistory);
      this.saveData();
    }
    this.updateBookmarkStar();
    this.updatePermLock();
  },

  /** Marks the data file for writing; see flushData. */
  saveData() {
    if (!this._data) {
      return;
    }
    let owner = this.dataOwner();
    if (owner != this && owner._data === this._data) {
      owner.saveData();
      return;
    }
    this._dataDirty = true;
    // Never write before the file has loaded: that would replace the
    // user's bookmarks with whatever this window has seen so far.
    if (this._dataLoaded && !this._dataTimer) {
      this._dataTimer = setTimeout(() => this.flushData(), SAVE_DELAY_MS);
    }
  },

  /** Writes the data file now, if anything changed. The write goes to
      a temporary file first and is then moved over the real one, so a
      crash mid-write can never leave a half-written store behind. */
  flushData() {
    clearTimeout(this._dataTimer);
    this._dataTimer = null;
    let path = this.dataPath();
    if (!path || !this._dataDirty || !this._dataLoaded) {
      return;
    }
    this._dataDirty = false;
    IOUtils.writeJSON(path, this._data, { tmpPath: path + ".tmp" }).catch(e =>
      console.error("Seijaku: saving data", e)
    );
  },

  /** True once the data file has loaded (home counts wait for this). */
  dataReady() {
    return !!this._dataLoaded;
  },

  getBookmarks() {
    return (this._data?.bookmarks ?? []).slice().reverse();
  },

  isBookmarked(url) {
    return (this._data?.bookmarks ?? []).some(b => b.url == url);
  },

  toggleBookmark() {
    let tab = this.selected;
    if (!tab || !tab.url || tab.url == "about:blank") {
      this.showMessage("Nothing to bookmark on this tab");
      return;
    }
    if (!this._data) {
      this._data = emptyData();
    }
    let index = this._data.bookmarks.findIndex(b => b.url == tab.url);
    if (index >= 0) {
      this._data.bookmarks.splice(index, 1);
      this.showMessage("Bookmark removed");
    } else {
      // The star adds to All (folder ""); moving it to a folder is
      // the bookmarks page's job.
      this._data.bookmarks.push({ url: tab.url, title: tab.title || "", added: Date.now(), folder: "" });
      this.showMessage("Bookmarked");
    }
    this.saveData();
    this.updateBookmarkStar();
  },

  removeBookmark(url) {
    if (!this._data) {
      return;
    }
    this._data.bookmarks = this._data.bookmarks.filter(b => b.url != url);
    this.saveData();
    this.updateBookmarkStar();
  },

  // -------------------------------------------------------------- bookmark folders, import, export
  //
  // A bookmark's folder is one string: "" is All, and "Reading list"
  // and "Frequent" are always offered (the home page's FREQUENT row
  // is the Frequent folder). Folders the user creates live in the
  // store's folders list, so an empty folder still exists; folders
  // used by a bookmark appear even if they were never created that
  // way. Import never wipes anything: it merges, skipping URLs
  // already bookmarked, and reports how many arrived.

  getBookmarkFolders() {
    let out = ["Reading list", "Frequent"];
    let extra = [...(this._data?.folders ?? [])];
    for (let b of this._data?.bookmarks ?? []) {
      if (b.folder) {
        extra.push(b.folder);
      }
    }
    for (let f of extra) {
      if (f && !out.includes(f)) {
        out.push(f);
      }
    }
    return out;
  },

  getBookmarksByFolder(folder) {
    return this.getBookmarks().filter(b => (b.folder || "") == folder);
  },

  getFrequentBookmarks() {
    return this.getBookmarksByFolder("Frequent");
  },

  setBookmarkFolder(url, folder) {
    if (!this._data) {
      return;
    }
    folder = String(folder || "");
    let mark = this._data.bookmarks.find(b => b.url == url);
    if (!mark) {
      return;
    }
    mark.folder = folder;
    if (folder && !this._data.folders.includes(folder)) {
      this._data.folders.push(folder);
    }
    this.saveData();
  },

  createBookmarkFolder(name) {
    if (!this._data) {
      return false;
    }
    name = String(name || "").trim();
    if (!name || name == "All" || this.getBookmarkFolders().includes(name)) {
      return false;
    }
    this._data.folders.push(name);
    this.saveData();
    return true;
  },

  /** Writes a text file into the Downloads folder. */
  async saveTextFile(filename, text) {
    let safe = String(filename).replace(/[\\/:*?"<>|]/g, "_") || "seijaku.txt";
    // The Settings download folder, when set (else the engine default).
    let dir = this.downloadDir();
    let file = dir.clone();
    file.append(safe);
    let { IOUtils } = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs");
    await IOUtils.write(file.path, new TextEncoder().encode(text));
    return safe;
  },

  bookmarksHTML() {
    let esc = s => String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    let rows = marks => marks.map(m =>
      `        <DT><A HREF="${esc(m.url)}" ADD_DATE="${Math.floor((m.added || Date.now()) / 1000)}">${esc(m.title || m.url)}</A>`
    ).join("\n");
    let marks = this._data?.bookmarks ?? [];
    let parts = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      "<TITLE>Bookmarks</TITLE>",
      "<H1>Bookmarks</H1>",
      "<DL><p>",
    ];
    let top = marks.filter(m => !m.folder);
    if (top.length) {
      parts.push(rows(top));
    }
    for (let folder of this.getBookmarkFolders()) {
      let inFolder = marks.filter(m => m.folder == folder);
      if (!inFolder.length) {
        continue;
      }
      parts.push(`        <DT><H3>${esc(folder)}</H3>`);
      parts.push("        <DL><p>");
      parts.push(rows(inFolder));
      parts.push("        </DL><p>");
    }
    parts.push("</DL><p>");
    return parts.join("\n");
  },

  async exportBookmarks(format) {
    try {
      if (format == "html") {
        let name = await this.saveTextFile("seijaku-bookmarks.html", this.bookmarksHTML());
        this.showMessage(`Exported bookmarks to ${name}`);
        return name;
      }
      let name = await this.saveTextFile(
        "seijaku-bookmarks.json",
        JSON.stringify(this._data?.bookmarks ?? [], null, 2)
      );
      this.showMessage(`Exported bookmarks to ${name}`);
      return name;
    } catch (e) {
      this.showMessage(`Couldn't export bookmarks: ${e.message}`, "error");
      throw e;
    }
  },

  /** Parses Netscape-format bookmark HTML into {url, title, folder}. */
  parseNetscapeBookmarks(html) {
    let out = [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch (e) {
      return out;
    }
    // The parser nests a folder's list two ways (as the next <DL>
    // sibling of its <DT>, or inside that <DT>), so the walk accepts
    // both: a folder name applies to the list that follows it, and
    // the walk returns to the enclosing folder when that list ends.
    let walkDL = (dl, folder) => {
      let current = folder;
      for (let child of dl.children) {
        if (child.tagName == "DT") {
          let h3 = child.querySelector("H3");
          let a = child.querySelector("A");
          let inner = [...child.querySelectorAll(":scope > DL")];
          if (h3) {
            current = h3.textContent.trim();
            for (let d of inner) {
              walkDL(d, current);
            }
            current = folder;
          } else if (a?.href) {
            out.push({ url: a.href, title: a.textContent.trim(), folder: current });
          } else {
            for (let d of inner) {
              walkDL(d, current);
            }
          }
        } else if (child.tagName == "DL") {
          walkDL(child, current);
          current = folder;
        } else if (child.tagName == "H3") {
          current = child.textContent.trim();
        } else if (child.tagName == "A" && child.href) {
          out.push({ url: child.href, title: child.textContent.trim(), folder: current });
        }
      }
    };
    let root = doc.querySelector("DL");
    if (root) {
      walkDL(root, "");
    }
    return out;
  },

  /** Parses Chromium's Bookmarks JSON (Chrome, Edge, Brave share it). */
  parseChromiumBookmarks(data) {
    let out = [];
    let walk = (node, folder) => {
      if (!node || typeof node != "object") {
        return;
      }
      if (node.type == "url" && node.url) {
        out.push({ url: node.url, title: node.name || node.url, folder });
        return;
      }
      if (Array.isArray(node.children)) {
        // A root (bookmark_bar, other, synced) keeps its children
        // unfiled; a real folder files them under its name.
        let next = folder;
        if (node.type == "folder" && node.name && !["Bookmarks bar", "Other bookmarks", "Mobile bookmarks"].includes(node.name)) {
          next = node.name;
        }
        for (let child of node.children) {
          walk(child, next);
        }
      }
    };
    for (let root of Object.values(data?.roots ?? {})) {
      walk(root, "");
    }
    return out;
  },

  /** Merges parsed bookmarks, skipping URLs already stored. */
  mergeBookmarks(parsed) {
    if (!this._data) {
      this._data = emptyData();
    }
    let have = new Set(this._data.bookmarks.map(b => b.url));
    let added = 0;
    let skipped = 0;
    for (let item of parsed) {
      if (!item.url || have.has(item.url)) {
        skipped++;
        continue;
      }
      have.add(item.url);
      let folder = String(item.folder || "");
      this._data.bookmarks.push({ url: item.url, title: item.title || item.url, added: Date.now(), folder });
      if (folder && !this._data.folders.includes(folder)) {
        this._data.folders.push(folder);
      }
      added++;
    }
    if (added) {
      this.saveData();
    }
    return { added, skipped };
  },

  async importBookmarksFromFile() {
    let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(window, "Import bookmarks", Ci.nsIFilePicker.modeOpen);
    picker.appendFilter("Bookmark files (*.html, *.json)", "*.html; *.json");
    let result = await picker.open();
    if (result != Ci.nsIFilePicker.returnOK || !picker.file) {
      throw new Error("Import cancelled — no file chosen");
    }
    let { IOUtils } = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs");
    let text = new TextDecoder().decode(await IOUtils.read(picker.file.path));
    let trimmed = text.trim();
    let parsed = [];
    if (trimmed.startsWith("[")) {
      // Seijaku's own JSON export: an array of bookmark objects.
      try {
        parsed = JSON.parse(trimmed).map(b => ({
          url: b.url, title: b.title || b.url, folder: b.folder || "",
        }));
      } catch (e) {
        parsed = [];
      }
    } else if (trimmed.startsWith("{")) {
      try {
        parsed = this.parseChromiumBookmarks(JSON.parse(trimmed));
      } catch (e) {
        parsed = [];
      }
    } else {
      parsed = this.parseNetscapeBookmarks(trimmed);
    }
    if (!parsed.length) {
      throw new Error("No bookmarks found in that file");
    }
    let counts = this.mergeBookmarks(parsed);
    this.showMessage(`Imported ${counts.added} bookmark${counts.added == 1 ? "" : "s"} (${counts.skipped} already here)`);
    return counts;
  },

  async importBookmarksFromBrowser(browser) {
    // Chromium's profile layout is the same for Chrome, Edge and
    // Brave; only the vendor folder differs. Firefox is deliberately
    // not here: its bookmarks live in places.sqlite, and reading
    // them would wake the storage service for a one-off import —
    // Firefox users export HTML from Firefox itself instead, which
    // the file import above reads.
    let vendor = {
      chrome: "Google/Chrome/User Data/Default/Bookmarks",
      edge: "Microsoft/Edge/User Data/Default/Bookmarks",
      brave: "BraveSoftware/Brave-Browser/User Data/Default/Bookmarks",
    }[browser];
    let label = { chrome: "Chrome", edge: "Edge", brave: "Brave" }[browser] || browser;
    if (!vendor) {
      throw new Error("Unknown browser");
    }
    let base = "";
    try {
      base = Services.dirsvc.get("LocalAppData", Ci.nsIFile).path;
    } catch (e) { /* fall through to the environment */ }
    if (!base) {
      try {
        base = Services.env.get("LOCALAPPDATA") || "";
      } catch (e) { /* no base, the read below fails plainly */ }
    }
    let path = [base, ...vendor.split("/")].join("\\");
    let { IOUtils } = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs");
    let data;
    try {
      data = await IOUtils.readJSON(path);
    } catch (e) {
      throw new Error(`No ${label} profile found (looked for its Bookmarks file)`);
    }
    let parsed = this.parseChromiumBookmarks(data);
    if (!parsed.length) {
      throw new Error(`No bookmarks found in the ${label} profile`);
    }
    let counts = this.mergeBookmarks(parsed);
    this.showMessage(`Imported ${counts.added} bookmark${counts.added == 1 ? "" : "s"} from ${label} (${counts.skipped} already here)`);
    return counts;
  },

  // -------------------------------------------------------------- tracking protection
  //
  // One setting, three bundles, applied as prefs so new page loads
  // pick them up. Strict is the bundle the defaults file already
  // sets — and the default here, so switching the setting on never
  // quietly weakens anyone: strict keeps the full bundle, standard
  // keeps tracker blocking with the extra modules off, off turns it
  // all off (cookies then behave normally). uBlock Origin, through
  // the extension host, is still the stronger ad-blocking option;
  // the Settings page says so.

  applyTrackingProtection(mode) {
    mode = mode || this.pref("trackingprotection", "strict");
    if (!["strict", "standard", "off"].includes(mode)) {
      mode = "strict";
    }
    let bundle = {
      strict: { tp: true, social: true, email: true, finger: true, crypto: true, cookie: 5, strip: true },
      standard: { tp: true, social: false, email: false, finger: false, crypto: false, cookie: 5, strip: false },
      off: { tp: false, social: false, email: false, finger: false, crypto: false, cookie: 0, strip: false },
    }[mode];
    try {
      let p = Services.prefs;
      p.setBoolPref("privacy.trackingprotection.enabled", bundle.tp);
      p.setBoolPref("privacy.trackingprotection.socialtracking.enabled", bundle.social);
      p.setBoolPref("privacy.trackingprotection.emailtracking.enabled", bundle.email);
      p.setBoolPref("privacy.trackingprotection.fingerprinting.enabled", bundle.finger);
      p.setBoolPref("privacy.trackingprotection.cryptomining.enabled", bundle.crypto);
      p.setIntPref("network.cookie.cookieBehavior", bundle.cookie);
      p.setBoolPref("privacy.query_stripping.enabled", bundle.strip);
    } catch (e) { /* a bundle that won't apply leaves the old one */ }
  },

  // -------------------------------------------------------------- clear browsing data
  //
  // History wipes the stored log; cookies go through the cookie
  // manager (which is why the UI warns: this signs the user out of
  // sites); cache goes through the cache service, or is skipped with
  // a note if that service is missing; downloads clears the list
  // only — files on disk stay where they are.

  clearBrowsingData(what) {
    let done = [];
    let skipped = [];
    if (what.history) {
      try {
        this.clearHistory();
        done.push("history");
      } catch (e) { skipped.push("history"); }
    }
    if (what.cookies) {
      try {
        Cc["@mozilla.org/cookiemanager;1"].getService(Ci.nsICookieManager).removeAll();
        done.push("cookies");
      } catch (e) { skipped.push("cookies"); }
    }
    if (what.cache) {
      let cleared = false;
      try {
        if (Services.cache2?.clear) {
          Services.cache2.clear();
          cleared = true;
        }
      } catch (e) { /* fall through to the old service */ }
      if (!cleared) {
        try {
          Cc["@mozilla.org/network/cache-service;1"]
            .getService(Ci.nsICacheService).evictEntries(Ci.nsICache.STORE_ANYWHERE);
          cleared = true;
        } catch (e) { /* no cache service on this engine */ }
      }
      if (cleared) {
        done.push("cache");
      } else {
        skipped.push("cache (no cache service)");
      }
    }
    if (what.downloads) {
      try {
        for (let entry of this._downloads ?? []) {
          try {
            entry.dl?.remove();
          } catch (e) { /* one download staying listed is fine */ }
        }
        this._downloads = [];
        // The stored history is part of "downloads" too; files on
        // disk are untouched, as before.
        if (this._data?.downloadsHistory) {
          this._data.downloadsHistory = [];
          this.saveData();
        }
        this.updateDownloadsButton();
        done.push("downloads");
      } catch (e) { skipped.push("downloads"); }
    }
    let message = done.length ? `Cleared ${done.join(", ")}` : "Nothing cleared";
    if (skipped.length) {
      message += ` (skipped: ${skipped.join(", ")})`;
    }
    this.showMessage(message);
    return message;
  },

  // -------------------------------------------------------------- weather
  //
  // Open-Meteo, no API key: the geocoding API turns the Settings city
  // into coordinates (stored, so it geocodes once), then the forecast
  // API returns the current temperature and weather code. The shell
  // fetches with the system principal — the home page never fetches
  // cross-origin itself. A failed fetch returns null and the home
  // page hides the widget quietly; cached data, if any, keeps
  // showing instead of a broken widget.

  weatherEnabled() {
    return this.pref("weather.enabled", true);
  },

  getWeather() {
    return this._weatherCache;
  },

  weatherWord(code) {
    if (code == 0) { return ["Clear", "☀"]; }
    if (code == 1 || code == 2) { return ["Partly cloudy", "☁"]; }
    if (code == 3) { return ["Overcast", "☁"]; }
    if (code == 45 || code == 48) { return ["Fog", "≈"]; }
    if (code >= 51 && code <= 57) { return ["Drizzle", "☂"]; }
    if (code >= 61 && code <= 67) { return ["Rain", "☂"]; }
    if (code >= 71 && code <= 77) { return ["Snow", "❄"]; }
    if (code >= 80 && code <= 82) { return ["Rain showers", "☂"]; }
    if (code == 85 || code == 86) { return ["Snow showers", "❄"]; }
    if (code == 95) { return ["Thunderstorm", "⚡"]; }
    if (code == 96 || code == 99) { return ["Thunderstorm with hail", "⚡"]; }
    return ["", "•"];
  },

  async refreshWeather() {
    if (!this.weatherEnabled()) {
      return null;
    }
    if (this._weatherCache && Date.now() - this._weatherCache.at < 30 * 60 * 1000) {
      return this._weatherCache;
    }
    try {
      let city = this.pref("weather.city", "Singapore") || "Singapore";
      let lat = this.pref("weather.lat", "");
      let lon = this.pref("weather.lon", "");
      if (!lat || !lon) {
        let geo = await (await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
        )).json();
        let place = geo?.results?.[0];
        if (!place) {
          throw new Error("city not found");
        }
        lat = String(place.latitude);
        lon = String(place.longitude);
        Services.prefs.setStringPref(PREF + "weather.lat", lat);
        Services.prefs.setStringPref(PREF + "weather.lon", lon);
      }
      let data = await (await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=celsius&timezone=auto`
      )).json();
      let current = data?.current;
      if (current == null || current.temperature_2m == null) {
        throw new Error("no current weather");
      }
      let [word, mark] = this.weatherWord(current.weather_code);
      this._weatherCache = {
        at: Date.now(),
        city,
        temp: Math.round(current.temperature_2m),
        word,
        mark,
      };
      return this._weatherCache;
    } catch (e) {
      // A failed fetch hides the widget (unless cached data exists,
      // which the home page keeps showing) — never an error line.
      return null;
    }
  },

  // -------------------------------------------------------------- connection security + site info
  //
  // The progress listener reports the security state; the strip
  // shows it separately from the permission lock (perm-lock is what
  // the site may USE; this is whether the connection itself is
  // trustworthy). Secure is a lock, anything else on the web is a
  // warning, and the browser's own pages show no mark at all.
  // Clicking the mark opens the site panel: host, connection state
  // in plain words, the site's stored permission decisions with
  // Revoke, and a way to Settings.

  updateSecLock() {
    let lock = document.getElementById("sec-lock");
    if (!lock) {
      return;
    }
    let tab = this.selected;
    if (!tab || tab.security == "internal") {
      lock.hidden = true;
      return;
    }
    lock.hidden = false;
    // The glyph is drawn in CSS from the state: a closed lock when
    // secure, an open one otherwise.
    lock.setAttribute("state", tab.security);
    if (tab.security == "secure") {
      lock.title = "Connection is secure — click for site information";
    } else {
      lock.title = "Connection is not secure — click for site information";
    }
  },

  initSitePanel() {
    document.getElementById("site-settings").addEventListener("click", () => {
      try {
        document.getElementById("site-panel").hidePopup();
      } catch (e) { /* already closed */ }
      this.openPage("settings");
    });
    document.getElementById("site-close").addEventListener("click", () => {
      try {
        document.getElementById("site-panel").hidePopup();
      } catch (e) { /* already closed */ }
    });
  },

  showSiteInfo() {
    let tab = this.selected;
    if (!tab) {
      return;
    }
    let host = this.permissionHost(tab.url);
    if (!host) {
      return;
    }
    document.getElementById("site-host").textContent = host;
    document.getElementById("site-state").textContent =
      tab.security == "secure"
        ? "This connection is secure."
        : tab.security == "broken"
          ? "This connection is broken or untrusted."
          : "This connection is not secure — anything you send could be read.";
    let list = document.getElementById("site-perms");
    list.replaceChildren();
    let grants = this.getPermissionsFor(host);
    let types = Object.keys(grants);
    if (!types.length) {
      let empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No permissions granted or blocked yet.";
      list.append(empty);
    }
    for (let type of types) {
      let row = document.createElement("div");
      row.className = "perm-manage-row";
      let label = document.createElement("span");
      label.textContent = `${this.permissionTypeText(type)}: ${grants[type]}`;
      let revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => {
        this.setPermission(host, type, null);
        this.showSiteInfo();
      });
      row.append(label, revoke);
      list.append(row);
    }
    try {
      let width = 360;
      let x = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
      document.getElementById("site-panel").openPopupAtScreen(x, window.screenY + 48);
    } catch (e) { /* the panel just doesn't open */ }
  },

  // -------------------------------------------------------------- pinned tabs
  //
  // Ctrl+Shift+P pins the current tab: it moves first in the strip,
  // renders narrow with a vermilion dot, never auto-sleeps, and
  // cannot be closed by any means until it is unpinned (closeTab
  // refuses with a message). Pinning survives restart through the
  // saved session.

  // -------------------------------------------------------------- tab icons, reordering, switching

  iconsEnabled() {
    return !this.isPrivate && this.pref("tabs.icons", true);
  },

  /** Asks a loaded page for its icon (the SeijakuIcon actor). */
  async fetchTabIcon(tab) {
    if (!this.iconsEnabled() || !/^https?:/.test(tab.url)) {
      return;
    }
    let url = tab.url;
    let answer = null;
    try {
      answer = await tab.browser?.browsingContext?.currentWindowGlobal
        ?.getActor("SeijakuIcon")
        .sendQuery("GetIcon");
    } catch (e) {
      return; // the page went away, or isn't a web page
    }
    let href = answer?.href || "";
    // The tab may have moved on while the page answered.
    if (tab.url != url || !/^(https?|data):/.test(href)) {
      return;
    }
    tab.setIcon(href);
    this.saveSession();
  },

  /** Drag a tab along the strip to move it. Pinned tabs move among
      pinned tabs only, the rest among the rest. Nothing listens
      until a tab is pressed, and the listeners go when it is let go. */
  startTabDrag(tab, down) {
    let vertical = this._tabsPosition == "left" || this._tabsPosition == "right";
    let dragging = false;
    let move = event => {
      // The button came up somewhere this window never heard about
      // (over the page): the drag is over.
      if (!(event.buttons & 1)) {
        up();
        return;
      }
      if (!dragging) {
        let dist = vertical ? event.screenY - down.screenY : event.screenX - down.screenX;
        if (Math.abs(dist) < 6) {
          return;
        }
        dragging = true;
        tab.el.setAttribute("dragging", "true");
      }
      let over = document.elementFromPoint(event.clientX, event.clientY)?.closest(".tab")?.tab;
      if (!over || over === tab || over.pinned != tab.pinned) {
        return;
      }
      let rect = over.el.getBoundingClientRect();
      let after = vertical
        ? event.clientY > rect.top + rect.height / 2
        : event.clientX > rect.left + rect.width / 2;
      let fromIndex = this.tabs.indexOf(tab);
      this.tabs.splice(fromIndex, 1);
      this.tabs.splice(this.tabs.indexOf(over) + (after ? 1 : 0), 0, tab);
      this.placeTabEl(tab);
      this.tabEvent("TabMove", tab, { fromIndex, toIndex: this.tabs.indexOf(tab) });
    };
    let up = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      if (dragging) {
        tab.el.removeAttribute("dragging");
        this.saveSession();
      }
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  },

  /** Ctrl+Tab / Ctrl+Shift+Tab: the next or previous tab, wrapping. */
  cycleTab(delta) {
    if (this.tabs.length < 2) {
      return;
    }
    let i = this.tabs.indexOf(this.selected);
    this.selectTab(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
  },

  /** Ctrl+1–8 pick that tab; Ctrl+9 is always the last one. */
  selectTabNumber(n) {
    let tab = n == 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
    if (tab) {
      this.selectTab(tab);
    }
  },

  /** F11: the window fills the screen and the strip steps away. */
  toggleFullScreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    window.fullScreen = !window.fullScreen;
  },

  /** Ctrl+P: the Windows print dialog for this page. Seijaku has no
      print preview of its own (that is Firefox's front end), so the
      system dialog is the whole flow: pick a printer, print. */
  async printPage() {
    let bc = this.selectedBrowser?.browsingContext;
    if (!bc) {
      return;
    }
    try {
      let PSSVC = Cc["@mozilla.org/gfx/printsettings-service;1"].getService(Ci.nsIPrintSettingsService);
      let settings = PSSVC.createNewPrintSettings();
      settings.printerName =
        PSSVC.lastUsedPrinterName ||
        Cc["@mozilla.org/gfx/printerlist;1"].getService(Ci.nsIPrinterList).systemDefaultPrinterName;
      try {
        PSSVC.initPrintSettingsFromPrinter(settings.printerName, settings);
        PSSVC.initPrintSettingsFromPrefs(settings, true, Ci.nsIPrintSettings.kInitSaveAll);
      } catch (e) { /* the printer's defaults are enough */ }
      let dialog = Cc["@mozilla.org/widget/printdialog-service;1"].getService(Ci.nsIPrintDialogService);
      try {
        await dialog.showPrintDialog(window, false, settings);
      } catch (e) {
        if (e.result == Cr.NS_ERROR_ABORT) {
          return;
        }
        throw e;
      }
      PSSVC.maybeSaveLastUsedPrinterNameToPrefs(settings.printerName);
      PSSVC.maybeSavePrintSettingsToPrefs(settings, Ci.nsIPrintSettings.kPrintDialogPersistSettings);
      await bc.print(settings);
    } catch (e) {
      this.showMessage(`Couldn't print: ${e.message}`, "error");
    }
  },

  /** Ctrl+Shift+Del: Settings, scrolled to Clear browsing data. */
  openClearData() {
    let tab = this.openPage("settings", "clear-data");
    try {
      tab?.browser?.contentDocument?.getElementById("clear-data")?.scrollIntoView({ block: "center" });
    } catch (e) { /* the page scrolls itself to the anchor when it loads */ }
  },

  togglePinCurrent() {
    let tab = this.selected;
    if (!tab) {
      return;
    }
    this.togglePin(tab);
  },

  togglePin(tab, { quiet = false } = {}) {
    if (!tab) {
      return;
    }
    tab.pinned = !tab.pinned;
    tab.update();
    this.orderTabs();
    this.saveSession();
    this.tabEvent("TabAttrModified", tab, { changed: ["pinned"] });
    if (!quiet) {
      this.showMessage(tab.pinned ? "Tab pinned — it stays first and can't be closed until unpinned" : "Tab unpinned");
    }
  },

  /** Pinned tabs first, otherwise the order they were opened in. */
  orderTabs() {
    let before = this.tabs.slice();
    let pinned = this.tabs.filter(t => t.pinned);
    let rest = this.tabs.filter(t => !t.pinned);
    this.tabs = [...pinned, ...rest];
    for (let tab of this.tabs) {
      this.$tabbar.append(tab.el);
    }
    this.tabs.forEach((tab, toIndex) => {
      let fromIndex = before.indexOf(tab);
      if (fromIndex != toIndex) {
        this.tabEvent("TabMove", tab, { fromIndex, toIndex });
      }
    });
  },

  // -------------------------------------------------------------- right-click menus
  //
  // One XUL menupopup (#seijaku-menu), refilled each time it opens: the
  // page menu (what the page's SeijakuContextMenu actor reported), the
  // tab menu, and the strip menu (which buttons show). Nothing is built
  // until a right-click, and the items are dropped again on close.

  /** Opens the shared menu with these items at a screen point (CSS
      pixels of this window). Items are {label, run, disabled, checked}
      or "-" for a line; empty and doubled lines are dropped. */
  openMenu(items, x, y) {
    let popup = document.getElementById("seijaku-menu");
    popup.replaceChildren();
    for (let item of items) {
      if (!item) {
        continue;
      }
      if (item == "-") {
        if (popup.lastElementChild && popup.lastElementChild.localName != "menuseparator") {
          popup.append(document.createXULElement("menuseparator"));
        }
        continue;
      }
      let el = document.createXULElement("menuitem");
      el.setAttribute("label", item.label);
      if (item.disabled) {
        el.setAttribute("disabled", "true");
      }
      if (item.checked !== undefined) {
        el.setAttribute("type", "checkbox");
        if (item.checked) {
          el.setAttribute("checked", "true");
        }
      }
      el.addEventListener("command", () => {
        try {
          item.run();
        } catch (e) {
          console.error(e);
        }
      });
      popup.append(el);
    }
    if (popup.lastElementChild?.localName == "menuseparator") {
      popup.lastElementChild.remove();
    }
    if (!popup.childElementCount) {
      return;
    }
    popup.openPopupAtScreen(Math.round(x), Math.round(y), true);
  },

  copyText(text, note) {
    try {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(text);
      if (note) {
        this.showMessage(note);
      }
    } catch (e) {
      this.showMessage("Couldn't copy that", "error");
    }
  },

  /** The page menu, from what SeijakuContextMenuChild reported. The
      actor stays the way back to the page, for its edit commands. */
  showPageMenu(browser, data, actor) {
    if (!browser || !this.tabs.some(t => t.browser === browser)) {
      return;
    }
    let tab = browser.tab;
    // SpellCheckHelper's flags: EDITABLE (text boxes) and
    // CONTENTEDITABLE (rich editors).
    let editable = (data.editFlags & (0x1 | 0x20)) != 0;
    let command = name => () => {
      try {
        actor.sendAsyncMessage("DoCommand", { command: name });
      } catch (e) { /* the page has gone */ }
    };
    let web = url => /^(https?|ftp|file):/i.test(url || "");
    let fromPage = { triggeringPrincipal: data.principal };
    let items = [];

    if (data.link && !editable) {
      let link = data.link;
      if (/^mailto:/i.test(link)) {
        let address = decodeURIComponent(link.slice(7).split("?")[0]);
        items.push({ label: "Copy email address", run: () => this.copyText(address, "Email address copied") });
      } else {
        if (web(link)) {
          items.push({
            label: "Open link in new tab",
            run: () => this.openRelatedTab(link, { ...fromPage, referrerInfo: data.linkReferrerInfo, background: true }),
          });
          if (!this.isPrivate && /^https?:/i.test(link)) {
            items.push({ label: "Open link in private window", run: () => this.openPrivateWindow(link) });
          }
        }
        items.push({ label: "Copy link address", run: () => this.copyText(link, "Link copied") });
        if (web(link)) {
          items.push({ label: "Save link as…", run: () => this.saveURL(link, { referrerInfo: data.linkReferrerInfo }) });
        }
      }
      items.push("-");
    }

    if (data.image) {
      let image = data.image;
      if (web(image)) {
        items.push({ label: "Open image in new tab", run: () => this.openRelatedTab(image, { ...fromPage, background: false }) });
      }
      items.push({ label: "Copy image", run: command("cmd_copyImage") });
      items.push({ label: "Copy image address", run: () => this.copyText(image, "Image address copied") });
      if (web(image) || /^data:image\//i.test(image)) {
        items.push({ label: "Save image as…", run: () => this.saveURL(image, { referrerInfo: data.referrerInfo }) });
      }
      items.push("-");
    }

    if (data.mediaKind && data.media) {
      let media = data.media;
      let kind = data.mediaKind;
      if (web(media)) {
        items.push({ label: `Open ${kind} in new tab`, run: () => this.openRelatedTab(media, { ...fromPage, background: false }) });
      }
      items.push({ label: `Copy ${kind} address`, run: () => this.copyText(media, "Address copied") });
      items.push({ label: `Save ${kind} as…`, run: () => this.saveURL(media, { referrerInfo: data.referrerInfo }) });
      items.push("-");
    }

    let can = name => !!data.commands?.[name];
    if (editable) {
      items.push(
        { label: "Undo", run: command("cmd_undo"), disabled: !can("cmd_undo") },
        "-",
        { label: "Cut", run: command("cmd_cut"), disabled: !can("cmd_cut") },
        { label: "Copy", run: command("cmd_copy"), disabled: !can("cmd_copy") },
        { label: "Paste", run: command("cmd_paste"), disabled: !can("cmd_paste") },
        { label: "Delete", run: command("cmd_delete"), disabled: !can("cmd_delete") },
        "-",
        { label: "Select all", run: command("cmd_selectAll"), disabled: !can("cmd_selectAll") },
        "-",
      );
    }

    if (data.selection) {
      let text = data.selection;
      let short = text.replace(/\s+/g, " ");
      if (short.length > 24) {
        short = short.slice(0, 24) + "…";
      }
      if (!editable) {
        items.push({ label: "Copy", run: command("cmd_copy") });
      }
      items.push({ label: `Search for “${short}”`, run: () => this.openRelatedTab(this.searchURL(text), { background: false }) });
      items.push("-");
    }

    if (!items.length) {
      let marked = !!(tab?.url && this.isBookmarked(tab.url));
      let sourceable = /^(https?|file):/i.test(data.docURL || "");
      items.push(
        { label: "Back", run: () => browser.goBack(), disabled: !browser.canGoBack },
        { label: "Forward", run: () => browser.goForward(), disabled: !browser.canGoForward },
        { label: "Reload", run: () => browser.reload() },
        "-",
        { label: marked ? "Remove bookmark" : "Bookmark this page", run: () => this.toggleBookmark(), disabled: tab !== this.selected },
        { label: "Save page as…", run: () => this.savePage(tab), disabled: !/^(https?|file):/i.test(tab?.url || "") },
        { label: "Print…", run: () => this.printPage(), disabled: tab !== this.selected },
        { label: "Reader view", run: () => this.openReader(), disabled: tab !== this.selected || !/^https?:/i.test(tab?.url || "") },
        "-",
        { label: "Select all", run: command("cmd_selectAll") },
        sourceable && { label: "View page source", run: () => this.openRelatedTab("view-source:" + data.docURL, { background: false }) },
      );
    }

    this.openMenu(items, data.screenX / window.devicePixelRatio, data.screenY / window.devicePixelRatio);
  },

  /** A right-click on the strip: the tab menu on a tab, the button
      list anywhere else. */
  onStripContextMenu(event) {
    event.preventDefault();
    let tab = event.target.closest?.(".tab")?.tab;
    if (tab) {
      this.showTabMenu(tab, event.screenX, event.screenY);
    } else {
      this.showStripMenu(event.screenX, event.screenY);
    }
  },

  showTabMenu(tab, x, y) {
    let i = this.tabs.indexOf(tab);
    let others = this.tabs.filter(t => t !== tab && !t.pinned);
    let right = this.tabs.slice(i + 1).filter(t => !t.pinned);
    let muted = false;
    try {
      muted = !!tab.browser?.audioMuted;
    } catch (e) { /* unknown */ }
    this.openMenu([
      { label: "New tab", run: () => this.newTab() },
      "-",
      { label: "Reload tab", run: () => (tab.browser ? tab.browser.reload() : this.selectTab(tab)) },
      { label: "Duplicate tab", run: () => this.duplicateTab(tab) },
      { label: tab.pinned ? "Unpin tab" : "Pin tab", run: () => this.togglePin(tab) },
      { label: muted ? "Unmute tab" : "Mute tab", run: () => this.toggleMute(tab), disabled: !tab.browser },
      { label: "Sleep tab", run: () => this.sleepTabNow(tab), disabled: tab.asleep || tab.pinned || this.tabs.length < 2 },
      { label: "Copy address", run: () => this.copyText(tab.url, "Address copied") },
      "-",
      { label: "Close tab", run: () => this.closeTab(tab), disabled: tab.pinned },
      { label: "Close other tabs", run: () => this.closeTabs(others, tab), disabled: !others.length },
      { label: "Close tabs to the right", run: () => this.closeTabs(right, tab), disabled: !right.length },
      "-",
      { label: "Reopen closed tab", run: () => this.undoCloseTab(), disabled: !this.closed.length },
    ], x, y);
  },

  showStripMenu(x, y) {
    let shown = this.shownStripButtons();
    this.openMenu([
      ...STRIP_BUTTONS.map(b => ({
        label: b.label,
        checked: shown.has(b.key),
        run: () => this.setStripButton(b.key, !shown.has(b.key)),
      })),
      "-",
      { label: "Strip settings…", run: () => this.openPage("settings", "strip") },
    ], x, y);
  },

  /** A copy of the tab beside it: the same address, a fresh page. */
  duplicateTab(tab) {
    this.openTab(tab.url, { index: this.tabs.indexOf(tab) + 1 });
  },

  /** Sleeps a tab from its menu; the selected one hands over first. */
  sleepTabNow(tab) {
    if (tab === this.selected) {
      this.sleepCurrentTab();
      return;
    }
    if (this.sleep(tab)) {
      this.saveSession();
    }
  },

  /** Closes these tabs, leaving `keep` selected. Pinned tabs stay. */
  closeTabs(tabs, keep) {
    if (keep && keep !== this.selected) {
      this.selectTab(keep);
    }
    for (let tab of tabs) {
      if (!tab.pinned && this.tabs.length > 1) {
        this.closeTab(tab);
      }
    }
  },

  // -------------------------------------------------------------- links opened from pages
  //
  // Tabs opened from a page (a middle-click, Ctrl+click, or "Open link
  // in new tab") go right after the tab they came from, and several in
  // a row keep their order, the way Firefox places them.

  openRelatedTab(url, { background = false, triggeringPrincipal, referrerInfo } = {}) {
    let owner = this.selected;
    let index = this.tabs.length;
    if (owner) {
      let last = this._related?.owner === owner && this.tabs.includes(this._related.last)
        ? this._related.last
        : owner;
      index = this.tabs.indexOf(last) + 1;
    }
    index = Math.max(index, this.tabs.filter(t => t.pinned).length);
    let tab = this.openTab(url, { index, background, triggeringPrincipal, referrerInfo });
    this._related = background ? { owner, last: tab } : null;
    return tab;
  },

  /** A middle-click, Ctrl+click or Shift+click on a link in a page
      (see SeijakuLinkChild). The page's own principal opens it, so it
      can load only what the page itself could. */
  openLinkFromPage(browser, data) {
    if (!browser || !this.tabs.some(t => t.browser === browser) || !data?.href) {
      return;
    }
    this.openRelatedTab(data.href, {
      background: !!data.background,
      triggeringPrincipal: data.principal,
      referrerInfo: data.referrerInfo,
    });
  },

  searchURL(text) {
    return this.pref("searchUrl", "https://duckduckgo.com/?q=%s").replace("%s", encodeURIComponent(text));
  },

  goHome() {
    let browser = this.selectedBrowser;
    if (browser) {
      this.load(browser, this.homepage());
    } else {
      this.openTab(this.homepage());
    }
  },

  /** Ctrl+Shift+R / Ctrl+F5: reload, fetching everything afresh. */
  hardReload() {
    try {
      this.selectedBrowser?.reloadWithFlags(
        Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY | Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE
      );
    } catch (e) {
      this.selectedBrowser?.reload();
    }
  },

  /** Mouse side buttons and keyboard media keys. */
  onAppCommand(event) {
    let browser = this.selectedBrowser;
    switch (event.command) {
      case "Back":
        browser?.goBack();
        break;
      case "Forward":
        browser?.goForward();
        break;
      case "Reload":
        browser?.reload();
        break;
      case "Stop":
        this.stopLoad();
        break;
      case "Home":
        this.goHome();
        break;
      case "New":
        this.newTabWithBar();
        break;
      case "Close":
        this.closeTab();
        break;
      case "Find":
        this.showFindBar();
        break;
      case "Search":
        this.showFloatingBar();
        break;
      case "Bookmarks":
        this.openPage("bookmarks");
        break;
      case "Print":
        this.printPage();
        break;
      case "Save":
        this.savePage();
        break;
      default:
        return;
    }
    event.stopPropagation();
  },

  // -------------------------------------------------------------- saving files from pages
  //
  // Save link / image / video / page as: a save dialog, then the
  // engine's own download machinery, so the file shows on the
  // downloads page like any other. A saved page is the page's file as
  // the site sends it (its HTML, a PDF, an image), not a snapshot of
  // everything it loaded.

  pickerInit(picker, title, mode) {
    try {
      picker.init(window.browsingContext, title, mode);
    } catch (e) {
      picker.init(window, title, mode);
    }
  },

  /** A file name for an address: its last path part, made safe. */
  fileNameFor(url, fallback = "download") {
    let name = "";
    try {
      let u = new URL(url);
      if (u.protocol == "data:") {
        let type = /^data:image\/([a-z0-9.+-]+)/i.exec(url)?.[1] || "";
        return "image" + (type ? "." + type.replace("svg+xml", "svg").replace("jpeg", "jpg") : "");
      }
      name = decodeURIComponent(u.pathname.split("/").pop() || "") || u.hostname;
    } catch (e) { /* the fallback below */ }
    return this.safeFileName(name) || fallback;
  },

  safeFileName(name) {
    try {
      let { DownloadPaths } = ChromeUtils.importESModule("resource://gre/modules/DownloadPaths.sys.mjs");
      return DownloadPaths.sanitize(name);
    } catch (e) {
      return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 200);
    }
  },

  async saveURL(url, { referrerInfo = null, name = "" } = {}) {
    try {
      let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      this.pickerInit(picker, "Save as", Ci.nsIFilePicker.modeSave);
      picker.defaultString = name || this.fileNameFor(url);
      let ext = /\.([a-z0-9]{1,8})$/i.exec(picker.defaultString)?.[1];
      if (ext) {
        picker.defaultExtension = ext;
      }
      try {
        picker.displayDirectory = this.downloadDir();
      } catch (e) { /* the picker's own folder */ }
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
      let result = await picker.open();
      if (
        (result != Ci.nsIFilePicker.returnOK && result != Ci.nsIFilePicker.returnReplace) ||
        !picker.file
      ) {
        return;
      }
      let source = { url, isPrivate: this.isPrivate };
      if (referrerInfo) {
        try {
          source.referrerInfo = E10SUtils.deserializeReferrerInfo(referrerInfo);
        } catch (e) { /* no referrer, then */ }
      }
      await this.startDownload(source, picker.file.path);
    } catch (e) {
      this.showMessage(`Couldn't save that: ${e.message}`, "error");
    }
  },

  /** Ctrl+S: save this page's file. */
  savePage(tab = this.selected) {
    let url = tab?.url || "";
    if (!/^(https?|file):/i.test(url)) {
      this.showMessage("Only web pages and files can be saved");
      return;
    }
    let name = this.fileNameFor(url, "");
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
      name = (this.safeFileName(tab.title || "") || name || "page") + ".html";
    }
    this.saveURL(url, { name });
  },

  async startDownload(source, targetPath) {
    let { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    if (!this._downloadsList) {
      this._downloadsList = await Downloads.getList(this.isPrivate ? Downloads.PRIVATE : Downloads.PUBLIC);
    }
    let download = await Downloads.createDownload({ source, target: { path: targetPath } });
    await this._downloadsList.add(download);
    await download.start();
  },

  // -------------------------------------------------------------- strip buttons
  //
  // seijaku.strip.buttons lists the buttons that show (see
  // STRIP_BUTTONS); the rest are hidden with an attribute, so a button
  // that hides itself for its own reasons (the locks, which show only
  // on web pages) keeps doing so. Right-click the strip, or Settings,
  // to change it. Keyboard shortcuts keep working for hidden buttons.

  shownStripButtons() {
    return new Set(String(this.pref("strip.buttons", STRIP_DEFAULT)).split(",").map(k => k.trim()));
  },

  applyStripButtons() {
    let shown = this.shownStripButtons();
    for (let b of STRIP_BUTTONS) {
      document.getElementById(b.id)?.toggleAttribute("strip-off", !shown.has(b.key));
    }
  },

  setStripButton(key, on) {
    let shown = this.shownStripButtons();
    if (on) {
      shown.add(key);
    } else {
      shown.delete(key);
    }
    let value = STRIP_BUTTONS.filter(b => shown.has(b.key)).map(b => b.key).join(",");
    try {
      Services.prefs.setStringPref(PREF + "strip.buttons", value);
    } catch (e) { /* the strip just stays as it is */ }
  },

  /** For the Settings page: every button, and whether it shows. */
  stripButtons() {
    let shown = this.shownStripButtons();
    return STRIP_BUTTONS.map(b => ({ key: b.key, label: b.label, shown: shown.has(b.key) }));
  },

  // -------------------------------------------------------------- page fullscreen
  //
  // A page's fullscreen request (a video's fullscreen button) runs
  // through SeijakuFullscreenParent; the window only hides its own
  // chrome (the inDOMFullscreen attribute, in CSS) and says how to
  // leave. Esc always leaves: the engine handles it, and keyboard
  // lock stays off. Switching tabs leaves too (see selectTab).

  onPageFullscreen(on, origin) {
    let panel = document.getElementById("fullscreen-note");
    clearTimeout(this._fullscreenNoteTimer);
    if (!on) {
      try {
        panel.hidePopup();
      } catch (e) { /* not open */ }
      return;
    }
    this.hideFloatingBar();
    this.hidePalette();
    if (!document.getElementById("findbar").hidden) {
      this.hideFindBar();
    }
    let host = "";
    try {
      host = origin ? Services.io.newURI(origin).host : "";
    } catch (e) { /* no host to name */ }
    document.getElementById("fullscreen-note-text").textContent =
      host ? `${host} is full screen — press Esc to leave` : "Full screen — press Esc to leave";
    try {
      let width = 340;
      panel.openPopupAtScreen(
        Math.round(window.screenX + (window.outerWidth - width) / 2),
        window.screenY + 24
      );
    } catch (e) {
      return;
    }
    this._fullscreenNoteTimer = setTimeout(() => {
      try {
        panel.hidePopup();
      } catch (e) { /* already closed */ }
    }, 3000);
  },

  // -------------------------------------------------------------- command palette
  //
  // Ctrl+K opens a searchable action palette: a XUL panel above the
  // page, like the floating bar. It searches commands, open tabs,
  // and bookmarks by substring as you type; arrows move, Enter runs
  // the command, switches to the tab, or opens the bookmark, Esc
  // closes. This is NOT a command bar: there is no `:` prompt and
  // no `:command` syntax — the list is picked from, not typed into.

  paletteCommands() {
    let copyUrl = () => {
      let url = this.selected?.url || "";
      if (!url) {
        return;
      }
      try {
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(url);
        this.showMessage("Address copied");
      } catch (e) {
        this.showMessage("Couldn't copy the address", "error");
      }
    };
    let setTheme = name => {
      try {
        Services.prefs.setStringPref(PREF + "theme", name);
      } catch (e) { /* the theme just doesn't change */ }
    };
    return [
      { title: "New tab", run: () => this.newTab() },
      { title: "New private window", run: () => this.openPrivateWindow() },
      { title: "Open settings", run: () => this.openPage("settings") },
      { title: "Open bookmarks", run: () => this.openPage("bookmarks") },
      { title: "Open history", run: () => this.openPage("history") },
      { title: "Open downloads", run: () => this.openPage("downloads") },
      { title: "Open extensions", run: () => this.openPage("extensions") },
      { title: "Switch to dark theme", run: () => setTheme("ink") },
      { title: "Switch to light theme", run: () => setTheme("paper") },
      { title: "Switch to System theme", run: () => setTheme("system") },
      { title: "Toggle tab autohide", run: () => this.toggleChromeAutohide() },
      { title: "Sleep current tab", run: () => this.sleepCurrentTab() },
      { title: "Mute current tab", run: () => { if (this.selected) { this.toggleMute(this.selected); } } },
      { title: "Reader view", run: () => this.openReader() },
      { title: "Copy page URL", run: copyUrl },
      { title: "Print page", run: () => this.printPage() },
      { title: "Full screen", run: () => this.toggleFullScreen() },
      { title: "Clear browsing data", run: () => this.openClearData() },
      { title: "Clear history", run: () => { this.clearHistory(); this.showMessage("History cleared"); } },
    ];
  },

  initPalette() {
    let panel = document.getElementById("palette-panel");
    let input = document.getElementById("palette-input");
    input.addEventListener("input", () => {
      this._paletteItems = this.paletteItems(input.value);
      this._paletteIndex = -1;
      this.showPaletteList();
    });
    input.addEventListener("keydown", event => {
      if (event.key == "ArrowDown") {
        this.movePalette(1);
        event.preventDefault();
        return;
      }
      if (event.key == "ArrowUp") {
        this.movePalette(-1);
        event.preventDefault();
        return;
      }
      if (event.key == "Escape") {
        this.hidePalette();
        return;
      }
      if (event.key != "Enter") {
        return;
      }
      let item = this._paletteItems[this._paletteIndex];
      if (item) {
        this.runPaletteItem(item);
      }
    });
    panel.addEventListener("popuphidden", () => {
      this._paletteItems = [];
      this._paletteIndex = -1;
      let box = document.getElementById("palette-list");
      if (box) {
        box.replaceChildren();
        box.hidden = true;
      }
    });
  },

  paletteItems(query) {
    query = (query || "").trim().toLowerCase();
    let out = [];
    let match = (title, url) => !query || `${title || ""} ${url || ""}`.toLowerCase().includes(query);
    for (let cmd of this.paletteCommands()) {
      if (match(cmd.title, "")) {
        out.push({ kind: "Command", title: cmd.title, run: cmd.run });
      }
    }
    for (let tab of this.tabs) {
      if (match(tab.title, tab.url)) {
        out.push({ kind: "Tab", title: tab.title || tab.url, url: tab.url, tab });
      }
    }
    if (this._data) {
      let marks = this._data.bookmarks;
      for (let i = marks.length - 1; i >= 0 && out.length < 12; i--) {
        if (match(marks[i].title, marks[i].url)) {
          out.push({ kind: "Bookmark", title: marks[i].title || marks[i].url, url: marks[i].url });
        }
      }
    }
    return out.slice(0, 12);
  },

  showPalette() {
    let panel = document.getElementById("palette-panel");
    let input = document.getElementById("palette-input");
    input.value = "";
    this._paletteItems = this.paletteItems("");
    this._paletteIndex = -1;
    try {
      let width = 560;
      let x = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
      panel.openPopupAtScreen(x, window.screenY + 48);
    } catch (e) {
      return;
    }
    this.showPaletteList();
    try {
      input.focus();
    } catch (e) { /* focus is best-effort */ }
  },

  hidePalette() {
    try {
      document.getElementById("palette-panel").hidePopup();
    } catch (e) { /* already closed */ }
  },

  showPaletteList() {
    let box = document.getElementById("palette-list");
    if (!box) {
      return;
    }
    box.replaceChildren();
    let items = this._paletteItems;
    if (!items.length) {
      box.hidden = true;
      this._paletteIndex = -1;
      return;
    }
    items.forEach((item, i) => {
      let row = document.createElement("div");
      row.className = "palette-row";
      if (i == this._paletteIndex) {
        row.setAttribute("selected", "true");
      }
      let kind = document.createElement("span");
      kind.className = "palette-kind";
      kind.textContent = item.kind;
      let title = document.createElement("span");
      title.className = "palette-title";
      title.textContent = item.title;
      row.append(kind, title);
      // Mousedown, not click: the panel would hide on blur first
      // and the click would never land (same as the URL bar).
      row.addEventListener("mousedown", event => {
        event.preventDefault();
        this.runPaletteItem(item);
      });
      box.append(row);
    });
    box.hidden = false;
  },

  movePalette(delta) {
    if (!this._paletteItems.length) {
      return;
    }
    if (this._paletteIndex < 0) {
      this._paletteIndex = delta > 0 ? 0 : this._paletteItems.length - 1;
    } else {
      this._paletteIndex =
        (this._paletteIndex + delta + this._paletteItems.length) % this._paletteItems.length;
    }
    this.showPaletteList();
  },

  runPaletteItem(item) {
    this.hidePalette();
    try {
      if (item.tab) {
        this.selectTab(item.tab);
      } else if (item.run) {
        item.run();
      } else if (item.url && this.selectedBrowser) {
        this.load(this.selectedBrowser, item.url);
        this.selectedBrowser.focus();
      }
    } catch (e) {
      this.showMessage(`Couldn't do that: ${e.message}`, "error");
    }
  },

  getHistory() {
    return (this._data?.history ?? []).slice().reverse();
  },

  clearHistory() {
    if (!this._data) {
      return;
    }
    this._data.history = [];
    this.saveData();
  },

  recordHistory(url, title = "") {
    // A private window records nothing.
    if (this.isPrivate) {
      return;
    }
    // Internal pages are never history: the home page, settings,
    // and the browser's own pages would otherwise drown real visits.
    if (!url || url == "about:blank" || /^(seijaku|about|chrome):/.test(url)) {
      return;
    }
    if (!this._data) {
      this._data = emptyData();
    }
    let last = this._data.history[this._data.history.length - 1];
    if (last && last.url == url) {
      if (title) {
        last.title = title;
      }
      last.at = Date.now();
      this.saveData();
      return;
    }
    this._data.history.push({ url, title, at: Date.now() });
    if (this._data.history.length > HISTORY_LIMIT) {
      this._data.history.splice(0, this._data.history.length - HISTORY_LIMIT);
    }
    this.saveData();
  },

  recordHistoryTitle(url, title) {
    if (!this._data || !title) {
      return;
    }
    // Titles arrive after the address does, so the newest entry for
    // this address gets the title when it shows up.
    for (let i = this._data.history.length - 1; i >= 0; i--) {
      if (this._data.history[i].url == url) {
        this._data.history[i].title = title;
        this.saveData();
        return;
      }
    }
  },

  updateBookmarkStar() {
    let star = document.getElementById("bookmark-star");
    if (!star) {
      return;
    }
    let marked = !!(this.selected?.url && this.isBookmarked(this.selected.url));
    star.toggleAttribute("bookmarked", marked);
    star.title = marked ? "Remove bookmark (Ctrl+D)" : "Bookmark this page (Ctrl+D)";
  },

  updateUndoButton() {
    let button = document.getElementById("tab-undo");
    if (button) {
      button.disabled = this.closed.length == 0;
    }
  },

  // -------------------------------------------------------------- launched links
  //
  // Why a default-browser link used to land on the home page: the
  // installer passes the address, but nothing in the shell ever read
  // it, so the window just opened its default page. A registered
  // command-line handler component would be the textbook fix, but
  // registering one in the shipped, signed engine is unconfirmed
  // (current docs call chrome.manifest registration deprecated), so
  // the shell reads the launch address itself instead. Every read
  // here is guarded: if none of these sources exists in the shipped
  // engine, the shell behaves exactly as before — it cannot fail to
  // start over a link it cannot read.

  /** A web address from a command line, or null. Engine flags, paths
     and option values can never pass: only a real web address, or a
     bare dotted address, counts. */
  launchURLFromCommandLine(cmdLine) {
    try {
      let urlFlag = cmdLine.findFlag("url", false);
      if (urlFlag >= 0 && urlFlag + 1 < cmdLine.length) {
        let value = cmdLine.getArgument(urlFlag + 1);
        if (/^(https?|ftp):\/\//i.test(value)) {
          return value;
        }
      }
      for (let i = 0; i < cmdLine.length; i++) {
        let value = cmdLine.getArgument(i);
        if (/^(https?|ftp):\/\//i.test(value)) {
          return value;
        }
        // A bare address (example.com, localhost:3000): paths are
        // excluded by the backslash test, flags by the dash test.
        if (
          !value.startsWith("-") &&
          !value.includes("\\") &&
          (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(value) ||
            /^localhost(:\d+)?(\/\S*)?$/.test(value))
        ) {
          return value;
        }
      }
    } catch (e) { /* no usable launch address */ }
    return null;
  },

  /** A web address this window was launched with, or null. */
  launchURL() {
    try {
      for (let arg of window.arguments || []) {
        let value = typeof arg == "string" ? arg : arg?.data;
        if (value && /^(https?|ftp):\/\//i.test(value)) {
          return value;
        }
      }
    } catch (e) { /* fall through to the command line */ }
    try {
      let cmdLine = Cc["@mozilla.org/toolkit/command-line;1"].getService(Ci.nsICommandLine);
      return this.launchURLFromCommandLine(cmdLine);
    } catch (e) {
      return null;
    }
  },

  newTab() {
    this.openTab(this.homepage());
  },

  openPage(name, hash = "") {
    let page = "seijaku:" + name;
    let url = hash ? page + "#" + hash : page;
    let tab = this.tabs.find(t => t.url?.split("#")[0] == page);
    if (!tab) {
      return this.openTab(url, { afterCurrent: true });
    }
    this.selectTab(tab);
    return tab;
  },

  // -------------------------------------------------------------- downloads
  //
  // The downloads page shows the engine's own download list, not a
  // second store: Downloads.jsm already tracks every download the
  // browser starts, so the page just renders what it reports. If the
  // module is missing in the shipped engine, the page says so and
  // nothing else breaks — downloads still land in the folder, the
  // way the prefs already arrange.

  async initDownloads() {
    try {
      let { Downloads } = ChromeUtils.importESModule(
        "resource://gre/modules/Downloads.sys.mjs"
      );
      // A private window reads the private downloads list, so its
      // downloads never appear on the main window's page.
      let list = await Downloads.getList(this.isPrivate ? Downloads.PRIVATE : Downloads.PUBLIC);
      this._downloadsList = list;
      this._downloads = [];
      this._downloadsReady = true;
      let keyFor = dl => {
        let path = "";
        try {
          path = dl.target?.path || "";
        } catch (e) { /* key stays path-less */ }
        let started = 0;
        try {
          started = dl.startTime?.getTime?.() ?? 0;
        } catch (e) { /* key stays time-less */ }
        return path + "|" + started;
      };
      await list.addView({
        onDownloadAdded: dl => {
          let key = keyFor(dl);
          if (!this._downloads.some(e => e.key == key)) {
            this._downloads.unshift(this.downloadData(dl, key));
          }
          this.updateDownloadsButton();
        },
        onDownloadChanged: dl => {
          let entry = this._downloads.find(e => e.key == keyFor(dl));
          if (entry) {
            let was = entry.state;
            Object.assign(entry, this.downloadData(dl, entry.key));
            // Only a live transition counts as a finish: downloads
            // already finished when the view attached (or enumerated
            // below) must not pop a note on every startup.
            if (was == "downloading" && entry.state == "finished") {
              this.noteDownloadFinished(entry);
            }
            this.updateDownloadsButton();
          }
        },
        onDownloadRemoved: dl => {
          let key = keyFor(dl);
          this._downloads = this._downloads.filter(e => e.key != key);
          this.updateDownloadsButton();
        },
      });
      // A view is told about downloads already in the list, but
      // enumerating once as well costs nothing and covers a view
      // that reports only new arrivals.
      let existing = await list.getAll();
      for (let dl of existing) {
        let key = keyFor(dl);
        if (!this._downloads.some(e => e.key == key)) {
          this._downloads.push(this.downloadData(dl, key));
        }
      }
      this.updateDownloadsButton();
    } catch (e) {
      this._downloadsReady = false;
    }
  },

  downloadData(dl, key) {
    let name = "";
    let path = "";
    try {
      path = dl.target?.path || "";
      name = path.split(/[\\/]/).pop() || "";
    } catch (e) { /* name stays empty */ }
    // The source address is what a retry re-downloads from, and what
    // the manager's search matches on besides the name.
    let source = "";
    try {
      source = dl.source?.url || "";
    } catch (e) { /* source stays empty */ }
    // Pause is not a Download method: the front end's pause is
    // cancel-keeping-partial-data, and resume is start() on the same
    // object (Range requests if the server supports them). So a
    // canceled download that still has partial data IS a paused one,
    // and resume is only offered when start() exists.
    let paused = false;
    let canResume = false;
    try {
      paused = !!(dl.canceled && dl.hasPartialData);
    } catch (e) { /* not paused */ }
    try {
      canResume = typeof dl.start == "function";
    } catch (e) { /* can't resume */ }
    let state = "downloading";
    try {
      if (dl.succeeded) {
        state = "finished";
      } else if (dl.canceled) {
        state = paused ? "paused" : "cancelled";
      } else if (dl.error) {
        state = "failed";
      }
    } catch (e) { /* keep downloading */ }
    let progress = 0;
    let current = 0;
    let total = -1;
    try {
      progress = Math.round(dl.progress ?? 0);
      current = dl.currentBytes ?? 0;
      total = dl.totalBytes ?? -1;
    } catch (e) { /* sizes stay unknown */ }
    // The live object stays on the entry so actions can reach it;
    // getDownloads strips it before anything crosses to a page.
    return { key, dl, name, path, source, state, progress, current, total, canResume };
  },

  downloadsReady() {
    return !!this._downloadsReady;
  },

  /** Plain data for the downloads page (no engine objects cross over).
      Live entries come first, then the stored history (see
      noteDownloadFinished): the engine list in this shell is
      session-only — the persistence wiring (DownloadStore, the
      downloads.json store) lives in Firefox's front end, which the
      packager drops — so without the store, history would vanish on
      every restart. A stored entry whose path matches a live entry is
      dropped (the live one wins), so a build whose list does persist
      can never double-list. */
  getDownloads() {
    let live = (this._downloads ?? []).map(({ dl, ...plain }) => plain);
    let stored = [];
    try {
      stored = (this._data?.downloadsHistory ?? [])
        .filter(e => e && typeof e.path == "string")
        .map(e => ({
          key: e.key,
          name: e.name || "",
          path: e.path,
          source: e.source || "",
          state: "finished",
          progress: 100,
          current: e.total > 0 ? e.total : 0,
          total: e.total ?? -1,
          canResume: false,
          stored: true,
          finishedAt: e.finishedAt || 0,
        }));
    } catch (e) { /* history is a nicety, never fatal */ }
    let livePaths = new Set(live.map(e => e.path));
    return [...live, ...stored.filter(e => !livePaths.has(e.path))];
  },

  /** The page acts by key (not path: two downloads of one file share
      a path but not a key); the shell finds the entry again here. */
  downloadAction(key, action) {
    let entry = (this._downloads ?? []).find(e => e.key == key);
    if (entry?.dl) {
      let dl = entry.dl;
      try {
        if (action == "pause") {
          // Cancel, but keep the partial data: that IS the pause.
          dl.cancel();
        } else if (action == "resume") {
          if (typeof dl.start == "function") {
            let done = dl.start();
            if (done && done.catch) {
              done.catch(() =>
                this.showMessage("Couldn't resume this download", "error")
              );
            }
          } else {
            this.showMessage("This download can't be resumed", "error");
          }
        } else if (action == "cancel") {
          // Cancel AND drop the partial data, so Cancel truly deletes
          // (plain cancel() alone would leave a .part file behind).
          dl.cancel();
          if (dl.removePartial) {
            let done = dl.removePartial();
            if (done && done.catch) {
              done.catch(() => {});
            }
          }
        } else if (action == "remove") {
          if (entry.state != "finished") {
            // Clear away a partial file too, where one exists.
            if (dl.removePartial) {
              let done = dl.removePartial();
              if (done && done.catch) {
                done.catch(() => {});
              }
            }
          }
          dl.remove();
        } else if (action == "open") {
          // launch() rejects (rather than throwing) when the file is
          // gone, so a bare call would leave an unhandled rejection.
          let done = dl.launch();
          if (done && done.catch) {
            done.catch(() =>
              this.showMessage("That file is no longer there", "error")
            );
          }
        } else if (action == "reveal") {
          let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(entry.path);
          file.reveal();
        } else if (action == "retry") {
          this.retryDownload(entry.source, entry.path);
        }
      } catch (e) {
        this.showMessage(`Couldn't do that with the download: ${e.message}`, "error");
      }
      this.updateDownloadsButton();
      return;
    }
    // No live object: a stored history entry. Open/reveal go through
    // the file itself, remove drops the record, retry re-downloads.
    let rec = (this._data?.downloadsHistory ?? []).find(e => e.key == key);
    if (!rec) {
      return;
    }
    try {
      if (action == "remove") {
        this._data.downloadsHistory = this._data.downloadsHistory.filter(e => e.key != key);
        this.saveData();
      } else if (action == "open") {
        this.launchFile(rec.path);
      } else if (action == "reveal") {
        let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(rec.path);
        file.reveal();
      } else if (action == "retry") {
        this.retryDownload(rec.source, rec.path);
      }
    } catch (e) {
      this.showMessage(`Couldn't do that with the download: ${e.message}`, "error");
    }
  },

  /** Open a file by path (stored entries have no live Download). */
  launchFile(path) {
    try {
      let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      file.launch();
    } catch (e) {
      this.showMessage("That file is no longer there", "error");
    }
  },

  /** Re-download from the source address into the same target path.
      A retry starts from scratch: it does not range-resume the old
      partial file (the new download's own saver overwrites it). */
  async retryDownload(sourceUrl, targetPath) {
    try {
      if (!sourceUrl) {
        this.showMessage("No source address was kept for this download", "error");
        return;
      }
      await this.startDownload({ url: sourceUrl }, targetPath);
    } catch (e) {
      this.showMessage(`Couldn't restart the download: ${e.message}`, "error");
    }
  },

  /** A live finish, recorded for history (private windows never record:
      their downloads list is private and the store is shared). The
      message line gets a note either way — that line belongs to this
      window alone. */
  noteDownloadFinished(entry) {
    try {
      if (!this.isPrivate && this._data) {
        if (!Array.isArray(this._data.downloadsHistory)) {
          this._data.downloadsHistory = [];
        }
        this._data.downloadsHistory.unshift({
          key: "stored|" + entry.path + "|" + Date.now(),
          name: entry.name,
          path: entry.path,
          source: entry.source || "",
          total: entry.total ?? -1,
          finishedAt: Date.now(),
          state: "finished",
        });
        if (this._data.downloadsHistory.length > 100) {
          this._data.downloadsHistory.length = 100;
        }
        this.saveData();
      }
    } catch (e) { /* history is a nicety, never fatal */ }
    try {
      this.showMessage(`Downloaded ${entry.name || "file"}`);
    } catch (e) {}
  },

  /** The strip button: the arrow alone when idle, the arrow plus the
      first active download's percentage while one runs. DOM writes
      only on a real change, because download-changed callbacks fire
      very often. */
  updateDownloadsButton() {
    let btn = document.getElementById("downloads-button");
    if (!btn) {
      return;
    }
    let active = (this._downloads ?? []).find(e => e.state == "downloading");
    // The arrow is drawn in CSS; the label is only the percentage.
    let label = "";
    let title = "Downloads (Ctrl+J)";
    if (active) {
      label = `${active.progress || 0}%`;
      title = `Downloading: ${active.progress || 0}% — Downloads (Ctrl+J)`;
    }
    if (btn.textContent != label) {
      btn.textContent = label;
    }
    if (btn.title != title) {
      btn.title = title;
    }
    btn.classList.toggle("downloading", !!active);
  },

  /** Clear finished, cancelled and failed entries (live ones via the
      engine, stored ones by dropping the record). Downloading and
      paused entries are left alone — pausing is not finishing. */
  clearFinishedDownloads() {
    try {
      for (let entry of [...(this._downloads ?? [])]) {
        if (entry.state == "downloading" || entry.state == "paused") {
          continue;
        }
        try {
          if (entry.state != "finished" && entry.dl?.removePartial) {
            let done = entry.dl.removePartial();
            if (done && done.catch) {
              done.catch(() => {});
            }
          }
          entry.dl?.remove();
        } catch (e) { /* one entry staying listed is fine */ }
      }
      this._downloads = this._downloads.filter(
        e => e.state == "downloading" || e.state == "paused"
      );
      if (this._data?.downloadsHistory) {
        this._data.downloadsHistory = [];
        this.saveData();
      }
    } catch (e) { /* clearing is a nicety, never fatal */ }
    this.updateDownloadsButton();
  },

  /** Clear everything: downloading entries are cancelled (and their
      partial data dropped) before removal, paused entries have their
      partial data dropped too, then every entry is removed. */
  clearAllDownloads() {
    try {
      for (let entry of [...(this._downloads ?? [])]) {
        try {
          if (entry.state == "downloading") {
            entry.dl?.cancel();
          }
          if (entry.dl?.removePartial) {
            let done = entry.dl.removePartial();
            if (done && done.catch) {
              done.catch(() => {});
            }
          }
          entry.dl?.remove();
        } catch (e) { /* one entry staying listed is fine */ }
      }
      this._downloads = [];
      if (this._data?.downloadsHistory) {
        this._data.downloadsHistory = [];
        this.saveData();
      }
    } catch (e) { /* clearing is a nicety, never fatal */ }
    this.updateDownloadsButton();
  },

  /** Apply the Settings download prefs to the engine's own prefs, so
      files downloaded from pages land in the chosen folder (or the
      system Downloads folder when it is empty), and ask-where-to-save
      behaves as the toggle says. Runs at startup; the settings page
      applies the same prefs on change. */
  applyDownloadPrefs() {
    try {
      let folder = this.pref("download.folder", "");
      if (folder) {
        Services.prefs.setStringPref("browser.download.dir", folder);
        Services.prefs.setIntPref("browser.download.folderList", 2);
      } else {
        Services.prefs.setIntPref("browser.download.folderList", 1);
      }
      Services.prefs.setBoolPref(
        "browser.download.useDownloadDir",
        !this.pref("download.ask", false)
      );
    } catch (e) { /* the engine's own defaults stand */ }
  },

  /** Directory picker for the Settings folder field. Returns the
      chosen path, or "" when cancelled or unavailable (the settings
      page then just keeps the typed path). */
  async pickDownloadFolder() {
    try {
      let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      fp.init(window, "Choose a download folder", Ci.nsIFilePicker.modeGetFolder);
      let rv = await fp.open();
      if (rv == Ci.nsIFilePicker.returnOK && fp.file) {
        return fp.file.path;
      }
    } catch (e) { /* typing the path by hand still works */ }
    return "";
  },

  /** Where the shell's own files go (annotated PDFs, bookmark
      exports): the Settings download folder when it is set and
      exists, else the engine's default Downloads folder. */
  downloadDir() {
    try {
      let folder = this.pref("download.folder", "");
      if (folder) {
        let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(folder);
        if (file.exists() && file.isDirectory()) {
          return file;
        }
      }
    } catch (e) { /* fall through to the engine default */ }
    return Services.dirsvc.get("DfltDwnld", Ci.nsIFile);
  },

  /** Protected video, for the Settings page: whether Widevine is
      installed and which version. The page never touches the GMP
      service itself — it asks here. */
  widevineStatus() {
    try {
      return { installed: Widevine.installed(), version: Widevine.version() };
    } catch (e) { /* an unreadable pref reads as not installed */ }
    return { installed: false, version: "" };
  },

  /** Protected video, for the Settings page: downloads Widevine on
      demand (the automatic check never fires on this shell's
      profiles, so the button forces it now). Throws the real error
      when the server offers nothing or the install doesn't stick;
      a second call while one is running just awaits the same
      download, so pressing the button twice is safe. */
  async installWidevine() {
    Widevine.allow(true);
    let ready = await Widevine.install();
    if (!ready) {
      throw new Error("Widevine downloaded but is still not ready");
    }
    return true;
  },

  // -------------------------------------------------------------- floating URL bar
  //
  // There is no persistent address bar: Ctrl+T opens a new tab and
  // summons this bar, Ctrl+L summons it for the current tab,
  // prefilled with that tab's address. It is a XUL panel, not a
  // plain div — the old suggest dropdown was a div and carried the
  // known risk of painting under page content; a panel is a native
  // popup and always renders above the page. Typing searches open
  // tabs first, then bookmarks, then history (substring, newest
  // first, at most eight); Enter opens the highlighted suggestion
  // (switching to a tab suggestion, navigating for the rest), Esc
  // closes the bar. The bar also carries a copy-URL button and a
  // reader-view button.

  initFloatingBar() {
    let panel = document.getElementById("urlbar-panel");
    let input = document.getElementById("urlbar-input");
    input.addEventListener("input", () => {
      this._suggestItems = this.suggestMatches(input.value);
      this._suggestIndex = -1;
      this.showSuggest();
    });
    input.addEventListener("keydown", event => {
      if (event.key == "ArrowDown") {
        this.moveSuggest(1);
        event.preventDefault();
        return;
      }
      if (event.key == "ArrowUp") {
        this.moveSuggest(-1);
        event.preventDefault();
        return;
      }
      if (event.key == "Escape") {
        this.hideFloatingBar();
        return;
      }
      if (event.key != "Enter") {
        return;
      }
      // A highlighted suggestion beats whatever was typed.
      if (this._suggestIndex >= 0 && this._suggestItems[this._suggestIndex]) {
        let item = this._suggestItems[this._suggestIndex];
        this.hideFloatingBar();
        if (item.tab) {
          this.selectTab(item.tab);
        } else if (this.selectedBrowser) {
          this.load(this.selectedBrowser, item.url);
          this.selectedBrowser.focus();
        }
        return;
      }
      let text = input.value.trim();
      if (!text) {
        return;
      }
      let url;
      try {
        url = this.urlFor(text);
      } catch (e) {
        this.showMessage(e.message, "error");
        return;
      }
      this.hideFloatingBar();
      if (event.ctrlKey || event.metaKey) {
        this.openTab(url, { afterCurrent: true });
      } else if (this.selectedBrowser) {
        this.load(this.selectedBrowser, url);
      }
      this.selectedBrowser?.focus();
    });
    document.getElementById("urlbar-copy").addEventListener("click", () => {
      let url = this.selected?.url || "";
      if (!url) {
        return;
      }
      try {
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(url);
        this.showMessage("Address copied");
      } catch (e) {
        this.showMessage("Couldn't copy the address", "error");
      }
    });
    document.getElementById("urlbar-reader").addEventListener("click", () => {
      this.hideFloatingBar();
      this.openReader();
    });
    panel.addEventListener("popuphidden", () => {
      this._suggestItems = [];
      this._suggestIndex = -1;
      let box = document.getElementById("urlbar-suggest");
      if (box) {
        box.replaceChildren();
        box.hidden = true;
      }
    });
  },

  showFloatingBar(prefill) {
    let panel = document.getElementById("urlbar-panel");
    let input = document.getElementById("urlbar-input");
    if (prefill === undefined) {
      let url = this.selected?.url ?? "";
      prefill = url == "seijaku:home" || url == "about:blank" ? "" : url;
    }
    input.value = prefill;
    this._suggestItems = prefill ? this.suggestMatches(prefill) : [];
    this._suggestIndex = -1;
    try {
      // Centred near the top of the window, over the page.
      let width = 560;
      let x = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
      panel.openPopupAtScreen(x, window.screenY + 48);
    } catch (e) {
      // A panel that won't open is not worth breaking navigation
      // for: the bar just stays closed.
      return;
    }
    this.showSuggest();
    try {
      input.focus();
      input.select();
    } catch (e) { /* focus is best-effort */ }
  },

  hideFloatingBar() {
    try {
      document.getElementById("urlbar-panel").hidePopup();
    } catch (e) { /* already closed */ }
  },

  /** Ctrl+T: a new tab, with the bar already open over it. */
  newTabWithBar() {
    this.newTab();
    this.showFloatingBar("");
  },

  // -------------------------------------------------------------- suggestions
  //
  // As you type, the bar offers your open tabs first, then your
  // bookmarks, then your history — substring matches on title or
  // address, newest first, at most eight. Nothing is fetched and
  // nothing leaves the machine: the only sources are the tabs and
  // the local data file.

  suggestMatches(query) {
    query = query.trim().toLowerCase();
    if (query.length < 2) {
      return [];
    }
    let seen = new Set();
    let out = [];
    let take = item => {
      if (out.length >= 8 || seen.has(item.url)) {
        return;
      }
      let hay = `${item.title || ""} ${item.url}`.toLowerCase();
      if (hay.includes(query)) {
        seen.add(item.url);
        out.push(item);
      }
    };
    for (let tab of this.tabs) {
      take({ url: tab.url, title: tab.title, tab });
    }
    if (this._data) {
      // Newest first, walking backwards instead of copying the lists:
      // this runs on every keystroke, and history holds 1000 entries.
      for (let list of [this._data.bookmarks, this._data.history]) {
        for (let i = list.length - 1; i >= 0 && out.length < 8; i--) {
          take(list[i]);
        }
      }
    }
    return out;
  },

  showSuggest() {
    let box = document.getElementById("urlbar-suggest");
    if (!box) {
      return;
    }
    box.replaceChildren();
    let items = this._suggestItems;
    if (!items.length) {
      box.hidden = true;
      this._suggestIndex = -1;
      return;
    }
    items.forEach((item, i) => {
      let row = document.createElement("div");
      row.className = "suggest-row";
      if (i == this._suggestIndex) {
        row.setAttribute("selected", "true");
      }
      let title = document.createElement("div");
      title.className = "suggest-title";
      title.textContent = item.title || item.url;
      let url = document.createElement("div");
      url.className = "suggest-url";
      url.textContent = item.url;
      row.append(title, url);
      // Mousedown, not click: the panel would hide on blur first
      // and the click would never land.
      row.addEventListener("mousedown", event => {
        event.preventDefault();
        this.hideFloatingBar();
        if (item.tab) {
          this.selectTab(item.tab);
        } else if (this.selectedBrowser) {
          this.load(this.selectedBrowser, item.url);
          this.selectedBrowser.focus();
        }
      });
      box.append(row);
    });
    box.hidden = false;
  },

  moveSuggest(delta) {
    if (!this._suggestItems.length) {
      return;
    }
    if (this._suggestIndex < 0) {
      this._suggestIndex = delta > 0 ? 0 : this._suggestItems.length - 1;
    } else {
      this._suggestIndex =
        (this._suggestIndex + delta + this._suggestItems.length) % this._suggestItems.length;
    }
    this.showSuggest();
    document.getElementById("urlbar-input").value = this._suggestItems[this._suggestIndex].url;
  },

  updateNavButtons() {
    let b = this.selectedBrowser;
    document.getElementById("nav-back").disabled = !b?.canGoBack;
    document.getElementById("nav-forward").disabled = !b?.canGoForward;
    this.updateReloadButton();
    this.updateSecLock();
  },

  /** The reload button is a stop button while its tab loads. */
  updateReloadButton() {
    let button = document.getElementById("nav-reload");
    if (!button) {
      return;
    }
    let loading = !!this.selected?.el.hasAttribute("busy");
    // The reload and stop glyphs are both drawn in CSS, so the swap
    // is one attribute and renders instantly.
    button.toggleAttribute("loading", loading);
    button.title = loading ? "Stop loading (click)" : "Reload (Ctrl+R)";
  },

  /** Stops the selected tab's load, through whatever stop the
     browser element offers on this engine. */
  stopLoad() {
    let b = this.selectedBrowser;
    if (!b) {
      return;
    }
    try {
      if (typeof b.stop == "function") {
        b.stop();
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      b.webNavigation?.stop(Ci.nsIWebNavigation.STOP_ALL);
    } catch (e) {
      try {
        b.docShell?.stop(Ci.nsIWebNavigation.STOP_ALL);
      } catch (_e) { /* nothing stopped; the load just finishes */ }
    }
  },

  updateTitle() {
    let tab = this.selected;
    let name = this.isPrivate ? "Seijaku (Private)" : "Seijaku";
    document.title = tab ? `${tab.title || tab.url} - ${name}` : name;
    this.updateBookmarkStar();
    this.updatePermLock();
  },

  /** Turns typed text into a URL: an address, or a search. */
  urlFor(text) {
    text = text.trim();
    if (!text) {
      return this.homepage();
    }
    if (PAGES[text]) {
      return text;
    }
    // view-source: is a trivial scheme addition: the engine renders
    // source itself, so it passes straight through (with the same
    // javascript:/data: refusal as every other typed address).
    if (/^view-source:/i.test(text)) {
      let inner = text.slice("view-source:".length);
      if (/^(javascript|data):/i.test(inner)) {
        throw new Error("javascript: and data: addresses can't be opened from the address bar");
      }
      return text;
    }
    let looksLikeAddress =
      /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]+:\s/i.test(text)
        ? true
        : !/\s/.test(text) && (/\./.test(text) || /^localhost(:\d+)?(\/|$)/.test(text));
    if (looksLikeAddress) {
      if (/^(javascript|data):/i.test(text)) {
        throw new Error("javascript: and data: addresses can't be opened from the address bar");
      }
      try {
        let info = Services.uriFixup.getFixupURIInfo(
          text,
          Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS
        );
        if (info.preferredURI) {
          return info.preferredURI.spec;
        }
      } catch (e) {
        // fall through to search
      }
    }
    return this.pref("searchUrl", "https://duckduckgo.com/?q=%s").replace(
      "%s",
      encodeURIComponent(text)
    );
  },

  // -------------------------------------------------------------- browsers

  createBrowser({ remoteType, openWindowInfo, name } = {}) {
    let b = document.createXULElement("browser");
    b.permanentKey = new (Cu.getGlobalForObject(Services).Object)();
    for (let [attr, value] of Object.entries({
      type: "content",
      message: "true",
      messagemanagergroup: "browsers",
      manualactiveness: "true",
      maychangeremoteness: "true",
    })) {
      b.setAttribute(attr, value);
    }
    if (remoteType && remoteType != E10SUtils.NOT_REMOTE) {
      b.setAttribute("remote", "true");
      b.setAttribute("remoteType", remoteType);
    }
    if (openWindowInfo) {
      b.openWindowInfo = openWindowInfo;
    }
    if (name) {
      b.setAttribute("name", name);
    }
    return b;
  },

  attachBrowser(tab, { url, openWindowInfo } = {}) {
    let remoteType = openWindowInfo && !openWindowInfo.isRemote
      ? E10SUtils.NOT_REMOTE
      : ChromeUtils.predictRemoteTypeForURI(realURL(url || tab.url), { window });
    let b = this.createBrowser({ remoteType, openWindowInfo });
    tab.browser = b;
    b.tab = tab;
    this.$content.append(b);
    this.listen(tab);
    if (tab === this.selected) {
      this.activate(tab);
    }
    tab.update();
    this.tabEvent("TabBrowserInserted", tab, { onCreation: !!tab._opening });
    return b;
  },

  listen(tab) {
    let b = tab.browser;
    let listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange(webProgress, request, flags, status) {
        if (!webProgress.isTopLevel || !(flags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) {
          return;
        }
        if (flags & Ci.nsIWebProgressListener.STATE_START) {
          tab.el.setAttribute("busy", "true");
          if (tab === Seijaku.selected) {
            Seijaku.updateReloadButton();
          }
        } else if (flags & Ci.nsIWebProgressListener.STATE_STOP) {
          // A stop is a stop, error or not: the loading mark clears
          // on every finish, never just on success.
          tab.el.removeAttribute("busy");
          if (tab === Seijaku.selected) {
            Seijaku.updateNavButtons();
          }
          Seijaku.fetchTabIcon(tab);
          Seijaku.saveSession();
        }
      },
      onLocationChange(webProgress, request, location, flags) {
        if (!webProgress.isTopLevel) {
          return;
        }
        // A different site's icon would be wrong here; the new page
        // reports its own once it is shown.
        let oldHost = "";
        try {
          oldHost = Services.io.newURI(tab.url).host;
        } catch (e) { /* no host before */ }
        tab.url = displayURL(location.spec);
        tab.title = b.contentTitle || "";
        Seijaku.tabEvent("TabAttrModified", tab, { changed: ["label"] });
        let newHost = "";
        try {
          newHost = location.host;
        } catch (e) { /* internal pages have no host */ }
        if (!newHost || newHost != oldHost) {
          tab.setIcon("");
        }
        // A new address resets the security mark (failing safe: a
        // fresh web address reads insecure until the security event
        // below says otherwise); the browser's own pages are neutral.
        tab.security = /^(seijaku|about|chrome):/.test(tab.url) || tab.url == "about:blank"
          ? "internal"
          : "insecure";
        tab.update();
        Seijaku.recordHistory(tab.url, tab.title);
        if (tab === Seijaku.selected) {
          Seijaku.updateTitle();
          Seijaku.updateNavButtons();
        }
        Seijaku.saveSession();
      },
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange(webProgress, request, state) {
        if (!webProgress.isTopLevel) {
          return;
        }
        // The browser's own pages stay neutral: the engine reports
        // them as not secure, which put a warning mark on Home.
        if (tab.security == "internal") {
          return;
        }
        try {
          if (state & Ci.nsIWebProgressListener.STATE_IS_SECURE) {
            tab.security = "secure";
          } else if (state & Ci.nsIWebProgressListener.STATE_IS_BROKEN) {
            tab.security = "broken";
          } else {
            tab.security = "insecure";
          }
        } catch (e) {
          tab.security = "insecure";
        }
        if (tab === Seijaku.selected) {
          Seijaku.updateSecLock();
        }
      },
      onContentBlockingEvent() {},
    };
    tab.progressListener = listener;
    b.addProgressListener(
      listener,
      Ci.nsIWebProgress.NOTIFY_STATE_NETWORK |
        Ci.nsIWebProgress.NOTIFY_LOCATION |
        Ci.nsIWebProgress.NOTIFY_SECURITY
    );
    b.addEventListener("pagetitlechanged", () => {
      tab.title = b.contentTitle || "";
      tab.update();
      Seijaku.tabEvent("TabAttrModified", tab, { changed: ["label"] });
      Seijaku.recordHistoryTitle(tab.url, tab.title);
      if (tab === Seijaku.selected) {
        Seijaku.updateTitle();
      }
    });
    // Sound: the engine tells chrome when a tab starts and stops
    // making noise; the strip shows a speaker mark while it does,
    // and clicking the mark mutes or unmutes the tab. If these
    // events never fire in the shipped engine, the mark just never
    // shows — muting from the mark is impossible, but nothing breaks.
    try {
      b.addEventListener("AudioPlayback", () => {
        tab._soundPlaying = true;
        Seijaku.updateSpeaker(tab);
      });
      b.addEventListener("DOMAudioPlaybackStarted", () => {
        tab._soundPlaying = true;
        Seijaku.updateSpeaker(tab);
      });
      b.addEventListener("DOMAudioPlaybackStopped", () => {
        tab._soundPlaying = false;
        Seijaku.updateSpeaker(tab);
      });
    } catch (e) { /* no sound marks on this engine */ }
  },

  activate(tab) {
    let b = tab.browser;
    if (!b) {
      return;
    }
    b.setAttribute("selected", "true");
    b.docShellIsActive = true;
  },

  deactivate(tab) {
    let b = tab.browser;
    if (!b) {
      return;
    }
    b.removeAttribute("selected");
    b.docShellIsActive = false;
  },

  openTab(url, options = {}) {
    let tab = new Tab();
    tab.url = url || "about:blank";
    tab.pinned = !!options.pinned;
    let index = options.index ?? (options.afterCurrent && this.selected
      ? this.tabs.indexOf(this.selected) + 1
      : this.tabs.length);
    this.tabs.splice(index, 0, tab);
    this.placeTabEl(tab);
    tab._opening = true;
    this.tabEvent("TabOpen", tab);
    if (options.asleep) {
      // A restored tab: no page loaded until it is clicked. This is the
      // lightest possible restore: ten tabs cost almost nothing at start.
      tab.title = options.title || "";
      tab.update();
    } else {
      let b = this.attachBrowser(tab, options);
      if (!options.skipLoad && tab.url != "about:blank") {
        this.load(b, tab.url, options);
      }
    }
    tab._opening = false;
    if (!options.asleep && (!options.background || !this.selected)) {
      this.selectTab(tab);
    }
    this.saveSession();
    return tab;
  },

  placeTabEl(tab) {
    let next =
      this.tabs[this.tabs.indexOf(tab) + 1]?.el ??
      document.getElementById("tab-new");
    this.$tabbar.insertBefore(tab.el, next?.parentNode == this.$tabbar ? next : null);
  },

  /** Moves a tab to another place in the strip (extensions use this).
      Pinned tabs stay first, so the place is kept within its kind. */
  moveTab(tab, index) {
    let from = this.tabs.indexOf(tab);
    let pinned = this.tabs.filter(t => t.pinned).length;
    let [lo, hi] = tab.pinned ? [0, pinned - 1] : [pinned, this.tabs.length - 1];
    let to = Math.max(lo, Math.min(index, hi));
    if (from < 0 || from == to) {
      return;
    }
    this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.placeTabEl(tab);
    this.tabEvent("TabMove", tab, { fromIndex: from, toIndex: to });
    this.saveSession();
  },

  /** Tells the extension system (ext/ext-seijaku.js) what happened to
      a tab. Nothing listens unless an extension asks to. */
  tabEvent(type, tab, detail = {}) {
    try {
      window.dispatchEvent(new CustomEvent("Seijaku" + type, { detail: { tab, ...detail } }));
    } catch (e) { /* an extension listener failed; the tab is fine */ }
  },

  load(browser, url, { triggeringPrincipal, referrerInfo } = {}) {
    // Extension files: a Firefox (.xpi) file installs through the
    // extension host; a Chrome (.crx) file genuinely cannot run in
    // Gecko, so it is still refused with a plain explanation.
    // (Files linked from a page just download and never run.)
    let bare = String(url).split(/[?#]/, 1)[0].toLowerCase();
    let isViewSource = /^view-source:/i.test(String(url));
    if (!isViewSource && bare.endsWith(".crx")) {
      this.showMessage("Chrome (.crx) extensions can't run in Seijaku — only Firefox (.xpi) extensions can", "error");
      return;
    }
    if (!isViewSource && bare.endsWith(".xpi")) {
      this.installXpiUrl(String(url));
      return;
    }
    // PDFs open in the built-in viewer instead of downloading — but
    // only for navigations the shell itself starts (typed, suggested,
    // bookmarked). A PDF link clicked inside a page still downloads:
    // intercepting that would need a stream-converter-level hook the
    // shell does not have. view-source: of a PDF is left alone.
    if (
      !isViewSource &&
      /\.pdf$/i.test(bare) &&
      /^(https?|file):/i.test(String(url)) &&
      !String(url).startsWith("seijaku:pdf")
    ) {
      url = "seijaku:pdf#url=" + encodeURIComponent(String(url));
    }
    url = realURL(url);
    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch (e) {
      this.showMessage(`Can't open ${url}`, "error");
      return;
    }
    try {
      let params = {
        triggeringPrincipal:
          triggeringPrincipal || Services.scriptSecurityManager.getSystemPrincipal(),
      };
      // A link opened from a page tells the site where it came from,
      // under the page's own referrer policy.
      if (referrerInfo) {
        try {
          params.referrerInfo = E10SUtils.deserializeReferrerInfo(referrerInfo);
        } catch (e) { /* no referrer, then */ }
      }
      browser.loadURI(uri, params);
    } catch (e) {
      this.showMessage(`Can't open ${url}: ${e.message}`, "error");
    }
  },

  selectTab(tab) {
    if (!tab) {
      return;
    }
    this.hideFloatingBar();
    // A page filling the screen gives it back when its tab is left.
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    let previous = this.selected;
    if (previous && previous !== tab) {
      previous.el.removeAttribute("selected");
      previous.lastActive = Date.now();
      this.deactivate(previous);
    }
    this.selected = tab;
    tab.lastActive = Date.now();
    tab.el.setAttribute("selected", "true");
    if (previous !== tab) {
      this.tabEvent("TabSelect", tab, { previous });
    }
    tab.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (tab.asleep) {
      this.wake(tab);
    }
    this.activate(tab);
    tab.browser?.focus();
    this.updateTitle();
    this.updateNavButtons();
  },

  closeTab(tab = this.selected, { force = false } = {}) {
    if (!tab) {
      return;
    }
    // A pinned tab cannot be closed by any means until it is
    // unpinned — double-click, middle-click, and Ctrl+W alike. Only
    // an extension (tabs.remove) or its own pages closing may.
    if (tab.pinned && !force) {
      this.showMessage("That tab is pinned — unpin it first (Ctrl+Shift+P)");
      return;
    }
    let index = this.tabs.indexOf(tab);
    if (this.tabs.length == 1) {
      // Closing the last tab closes the window; the session keeps
      // that tab, so the next start brings it back as before.
      this.saveSession();
      this.flushSession();
    }
    this.closed.push({ url: tab.url, title: tab.title, index });
    if (this.closed.length > 20) {
      this.closed.shift();
    }
    this.updateUndoButton();
    this.tabEvent("TabClose", tab);
    this.tabs.splice(index, 1);
    tab.el.remove();
    tab.browser?.remove();
    tab.browser = null;
    if (!this.tabs.length) {
      this.selected = null;
      window.close();
      return;
    }
    if (tab === this.selected) {
      this.selectTab(this.tabs[Math.min(index, this.tabs.length - 1)]);
    }
    this.saveSession();
  },

  undoCloseTab() {
    let last = this.closed.pop();
    this.updateUndoButton();
    if (!last) {
      this.showMessage("Nothing to undo");
      return;
    }
    this.openTab(last.url, { index: Math.min(last.index, this.tabs.length) });
  },

  // -------------------------------------------------------------- find, zoom
  //
  // Both ride on the page itself, so they cost nothing when unused.
  // Web pages live in a content process, so the chrome window cannot
  // search or zoom their document directly (contentWindow is null for
  // them): find goes through the browser's finder, which talks to the
  // page's Finder actor, and zoom sets the browsing context's zoom,
  // which works for every page in any process. No extra UI until
  // asked for.

  initFindBar() {
    let input = document.getElementById("find-input");
    input.addEventListener("keydown", event => {
      if (event.key == "Enter") {
        this.findInPage(event.shiftKey);
        event.preventDefault();
      }
    });
  },

  showFindBar() {
    let bar = document.getElementById("findbar");
    bar.hidden = false;
    let input = document.getElementById("find-input");
    input.focus();
    input.select();
  },

  hideFindBar() {
    document.getElementById("findbar").hidden = true;
    try {
      let finder = this.selectedBrowser?.finder;
      if (finder) {
        finder.removeSelection();
        finder.focusContent();
        return;
      }
    } catch (e) { /* fall through to the in-process selection */ }
    try {
      this.selectedBrowser?.contentWindow?.getSelection()?.removeAllRanges();
    } catch (e) { /* clearing a highlight is never worth an error */ }
  },

  /** The browser's finder, with Seijaku's result listener attached
      once (a "not found" note on the message line). */
  finderFor(browser) {
    let finder = null;
    try {
      finder = browser.finder;
    } catch (e) {
      return null;
    }
    if (finder && !finder._seijakuListening) {
      finder._seijakuListening = true;
      finder.addResultListener({
        onFindResult: data => {
          if (data.result == Ci.nsITypeAheadFind.FIND_NOTFOUND && data.searchString) {
            this.showMessage(`"${data.searchString}" not found`);
          }
        },
        onMatchesCountResult() {},
        onHighlightFinished() {},
        onCurrentSelection() {},
      });
    }
    return finder;
  },

  findInPage(backwards = false) {
    let term = document.getElementById("find-input").value;
    let browser = this.selectedBrowser;
    if (!term || !browser) {
      return;
    }
    let finder = this.finderFor(browser);
    if (finder) {
      try {
        // A new term starts from the top; the same term moves on.
        if (finder.searchString != term) {
          finder.fastFind(term, false, false);
        } else {
          finder.findAgain(term, backwards, false, false);
        }
        return;
      } catch (e) { /* fall through to the in-process search */ }
    }
    let win = browser.contentWindow;
    if (!win) {
      this.showMessage("Find isn't available on this page", "error");
      return;
    }
    let found = false;
    try {
      found = win.find(term, false, backwards, true, false, false, false);
    } catch (e) {
      this.showMessage("Find isn't available on this page", "error");
      return;
    }
    if (!found) {
      this.showMessage(`"${term}" not found`);
    }
  },

  zoom(step) {
    let b = this.selectedBrowser;
    if (!b) {
      return;
    }
    try {
      let context = b.browsingContext;
      let zoom = Math.min(3, Math.max(0.3, Math.round((context.fullZoom + step) * 10) / 10));
      context.fullZoom = zoom;
      this.showMessage(`Zoom ${Math.round(zoom * 100)}%`);
    } catch (e) {
      this.showMessage("Zoom isn't available on this page", "error");
    }
  },

  zoomReset() {
    let b = this.selectedBrowser;
    if (!b) {
      return;
    }
    try {
      b.browsingContext.fullZoom = 1;
      this.showMessage("Zoom 100%");
    } catch (e) { /* internal pages just stay as they are */ }
  },

  /** The speaker mark: sound, mute, and the mark's tooltip. */
  updateSpeaker(tab) {
    let muted = false;
    try {
      muted = !!tab.browser?.audioMuted;
    } catch (e) { /* mute state unknown */ }
    tab.el.toggleAttribute("muted", muted);
    tab.el.toggleAttribute("sound", !!tab._soundPlaying);
    tab.speakerEl.title = muted ? "Unmute this tab" : "Mute this tab";
    this.tabEvent("TabAttrModified", tab, { changed: ["muted", "soundplaying"] });
  },

  /** Clicking the speaker mark mutes or unmutes that tab. */
  toggleMute(tab) {
    let b = tab.browser;
    if (!b) {
      return;
    }
    try {
      b.audioMuted = !b.audioMuted;
      this.updateSpeaker(tab);
    } catch (e) {
      this.showMessage("Muting isn't available for this tab", "error");
    }
  },

  // -------------------------------------------------------------- sleeping

  /** Ctrl+Shift+S: sleeps the current tab now, using the same
     machinery as the 15-minute auto-sleep. The tab keeps its place
     and address and reloads when clicked. */
  sleepCurrentTab() {
    let tab = this.selected;
    if (!tab || tab.asleep || this.tabs.length < 2) {
      return;
    }
    if (tab.pinned) {
      this.showMessage("Pinned tabs don't sleep — unpin it first (Ctrl+Shift+P)");
      return;
    }
    let index = this.tabs.indexOf(tab);
    let neighbour = this.tabs[index > 0 ? index - 1 : 1];
    this.selectTab(neighbour);
    if (this.sleep(tab)) {
      this.showMessage(`"${tab.title || tab.url}" asleep — click it to wake it`);
    }
    this.saveSession();
  },

  /** Puts a tab to sleep: frees its page, keeps its place and address.
     Pinned tabs never sleep, by hand or by the timer. */
  sleep(tab) {
    if (!tab || tab.asleep || tab.pinned || tab === this.selected) {
      return false;
    }
    tab.browser.remove();
    tab.browser = null;
    tab.update();
    this.tabEvent("TabBrowserDiscarded", tab);
    return true;
  },

  wake(tab, { triggeringPrincipal } = {}) {
    if (!tab.asleep) {
      return;
    }
    let b = this.attachBrowser(tab, {});
    this.load(b, tab.url, { triggeringPrincipal });
  },

  sleepIdleTabs() {
    let minutes = this.pref("tabs.unloadAfterMinutes", 15);
    if (minutes <= 0) {
      return;
    }
    let now = Date.now();
    for (let tab of this.tabs) {
      if (!tab.asleep && now - tab.lastActive > minutes * 60 * 1000) {
        this.sleep(tab);
      }
    }
  },

  // -------------------------------------------------------------- session

  sessionPath() {
    try {
      return PathUtils.join(PathUtils.profileDir, SESSION_FILE);
    } catch (e) {
      return null;
    }
  },

  sessionData() {
    return {
      selected: this.tabs.indexOf(this.selected),
      tabs: this.tabs.map(t => ({ url: t.url, title: t.title, pinned: !!t.pinned, icon: t.icon || undefined })),
    };
  },

  /** Marks the session for writing; see flushSession. */
  saveSession() {
    // A private window never writes the shared session file.
    if (this.isPrivate) {
      return;
    }
    this._sessionDirty = true;
    if (!this._sessionTimer) {
      this._sessionTimer = setTimeout(() => this.flushSession(), SAVE_DELAY_MS);
    }
  },

  /** Writes the session now, if anything changed (atomically, as
      flushData does). */
  flushSession() {
    clearTimeout(this._sessionTimer);
    this._sessionTimer = null;
    let path = this.sessionPath();
    if (!path || !this._sessionDirty || this.isPrivate) {
      return;
    }
    this._sessionDirty = false;
    IOUtils.writeJSON(path, this.sessionData(), { tmpPath: path + ".tmp" }).catch(e =>
      console.error("Seijaku: saving session", e)
    );
  },

  restoreSession() {
    // A private window never reads the shared session file.
    if (this.isPrivate) {
      return Promise.resolve(false);
    }
    let path = this.sessionPath();
    if (!path) {
      return Promise.resolve(false);
    }
    return IOUtils.readJSON(path)
      .then(data => {
        let tabs = data?.tabs ?? [];
        if (!tabs.length) {
          return false;
        }
        for (let t of tabs) {
          let tab = this.openTab(t.url, { asleep: true, title: t.title, background: true, pinned: !!t.pinned });
          if (t.icon && this.iconsEnabled()) {
            tab.setIcon(t.icon);
          }
        }
        // Restored pinned tabs sit first, the way they were saved.
        this.orderTabs();
        // Only the selected tab loads now; the rest wake when clicked.
        let selected = this.tabs[Math.max(0, Math.min(data.selected ?? 0, this.tabs.length - 1))];
        this.selectTab(selected);
        return true;
      })
      .catch(() => false);
  },

  // -------------------------------------------------------------- messages

  showMessage(text, level = "info") {
    let el = document.getElementById("message");
    el.textContent = text;
    el.setAttribute("level", level);
    el.hidden = false;
    clearTimeout(this._messageTimer);
    this._messageTimer = setTimeout(() => this.hideMessage(), MESSAGE_MS);
  },

  hideMessage() {
    document.getElementById("message").hidden = true;
  },

  // -------------------------------------------------------------- private windows
  //
  // Ctrl+Shift+N opens a window that shares bookmarks but nothing
  // else: no restored session, no saved session, no history, the
  // private downloads list, and a Private badge in the strip. The
  // "private" window feature is what keeps it out of the singleton
  // main window's way (opening the same chrome URI without it would
  // just focus the existing window); the JSON argument carries the
  // URL and is read back by initPrivateFlag. Bookmarks stay shared,
  // the way Firefox does it.

  openPrivateWindow(url) {
    try {
      let arg = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
      arg.data = JSON.stringify({ url: url || this.homepage(), private: true });
      Services.ww.openWindow(null, window.location.href, "_blank", "chrome,all,dialog=no,private", arg);
    } catch (e) {
      this.showMessage("Couldn't open a private window", "error");
    }
  },

  // -------------------------------------------------------------- site permissions
  //
  // When a site asks for the camera, microphone, or notifications,
  // the engine's request reaches queuePermissionRequest here through
  // shell/modules/PermissionPrompt.sys.mjs (registered at the top of
  // this file). The prompt is a XUL panel at the top centre of the window
  // — where the floating bar appears — with the site, what it wants,
  // Allow / Block, and a remember checkbox. Remembered decisions
  // live in seijaku-data.json next to bookmarks and history, and
  // are also written to the engine's permission manager so the
  // engine itself enforces them. The Settings allow-switch overrides
  // everything: when it is on, sites get access at once with no
  // prompt. Location is denied outright, by pref (geo.enabled) and
  // again in the component — it never reaches a prompt.

  permissionTypeText(type) {
    return {
      camera: "use the camera",
      microphone: "use the microphone",
      "desktop-notification": "show notifications",
      geolocation: "know your location",
    }[type] || `use ${type}`;
  },

  permissionHost(url) {
    try {
      return Services.io.newURI(url).host || "";
    } catch (e) {
      return "";
    }
  },

  getPermissionsFor(host) {
    return (this._data?.permissions ?? {})[host] ?? {};
  },

  setPermission(host, type, value) {
    if (!host || !this._data) {
      return;
    }
    if (!this._data.permissions) {
      this._data.permissions = {};
    }
    if (!this._data.permissions[host]) {
      this._data.permissions[host] = {};
    }
    if (value) {
      this._data.permissions[host][type] = value;
    } else {
      delete this._data.permissions[host][type];
    }
    this.saveData();
    // The engine enforces remembered decisions itself too, so a
    // remembered Allow does not re-prompt even if the store is
    // somehow missed.
    try {
      let perms = Cc["@mozilla.org/permissionmanager;1"].getService(Ci.nsIPermissionManager);
      let uri = Services.io.newURI("https://" + host);
      if (value == "allow") {
        perms.add(uri, type, Ci.nsIPermissionManager.ALLOW_ACTION);
      } else if (value == "block") {
        perms.add(uri, type, Ci.nsIPermissionManager.DENY_ACTION);
      } else {
        perms.remove(uri, type);
      }
    } catch (e) { /* the store alone still gates future prompts */ }
    this.updatePermLock();
  },

  permissionAllowSwitchOn(type) {
    try {
      return Services.prefs.getIntPref(`permissions.default.${type}`, 0) == 1;
    } catch (e) {
      return false;
    }
  },

  /** The prompt component's entry point: answer or queue. */
  queuePermissionRequest(request, host, type) {
    try {
      if (!type) {
        request.cancel();
        return;
      }
      if (type == "geolocation") {
        request.cancel();
        return;
      }
      if (this.permissionAllowSwitchOn(type)) {
        request.allow();
        return;
      }
      let remembered = host ? this.getPermissionsFor(host)[type] : null;
      if (remembered == "allow") {
        request.allow();
        return;
      }
      if (remembered == "block") {
        request.cancel();
        return;
      }
      this._permQueue.push({ request, host, type });
      this.nextPermission();
    } catch (e) {
      try {
        request.cancel();
      } catch (_e) { /* already answered */ }
    }
  },

  nextPermission() {
    if (this._permActive || !this._permQueue.length) {
      return;
    }
    let entry = this._permQueue.shift();
    this._permActive = entry;
    this.showPermissionPrompt(entry);
  },

  initPermissionPanel() {
    document.getElementById("perm-allow").addEventListener("click", () =>
      this.answerPermission(true, document.getElementById("perm-remember").checked)
    );
    document.getElementById("perm-block").addEventListener("click", () =>
      this.answerPermission(false, document.getElementById("perm-remember").checked)
    );
    document.getElementById("perm-manage-close").addEventListener("click", () => {
      try {
        document.getElementById("perm-panel").hidePopup();
      } catch (e) { /* already closed */ }
    });
    document.getElementById("perm-panel").addEventListener("popuphidden", () => {
      // A panel closed without an answer (outside click) counts as
      // Block for this time only — a request must always get one.
      // _permActive is cleared before hidePopup in answerPermission,
      // so an answered prompt never double-answers here.
      if (this._permActive) {
        let entry = this._permActive;
        this._permActive = null;
        try {
          entry.request.cancel();
        } catch (e) { /* the request went away */ }
        this.nextPermission();
      }
    });
  },

  showPermissionPrompt(entry) {
    let panel = document.getElementById("perm-panel");
    document.getElementById("perm-prompt").hidden = false;
    document.getElementById("perm-manage").hidden = true;
    document.getElementById("perm-text").textContent =
      `${entry.host || "This site"} wants to ${this.permissionTypeText(entry.type)}.`;
    document.getElementById("perm-remember").checked = false;
    try {
      let width = 360;
      let x = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
      panel.openPopupAtScreen(x, window.screenY + 48);
    } catch (e) {
      // A prompt that cannot show must still answer, or the site
      // hangs: deny for this time.
      this.answerPermission(false, false);
    }
  },

  answerPermission(allow, remember) {
    let entry = this._permActive;
    if (!entry) {
      return;
    }
    this._permActive = null;
    try {
      document.getElementById("perm-panel").hidePopup();
    } catch (e) { /* already closed */ }
    if (remember && entry.host) {
      this.setPermission(entry.host, entry.type, allow ? "allow" : "block");
    }
    try {
      if (allow) {
        entry.request.allow();
      } else {
        entry.request.cancel();
      }
    } catch (e) { /* the request went away */ }
    this.nextPermission();
  },

  /** The lock button: what this site may use, with Revoke buttons. */
  updatePermLock() {
    let lock = document.getElementById("perm-lock");
    if (!lock) {
      return;
    }
    let host = this.selected ? this.permissionHost(this.selected.url) : "";
    let grants = host ? this.getPermissionsFor(host) : {};
    let hasAny = Object.keys(grants).length > 0;
    lock.hidden = !hasAny;
    lock.title = hasAny
      ? `Site permissions for ${host} — click to manage`
      : "Site permissions for this site";
  },

  showPermissionManage() {
    // A live prompt demands attention first; the lock waits.
    if (this._permActive) {
      return;
    }
    let host = this.selected ? this.permissionHost(this.selected.url) : "";
    if (!host) {
      return;
    }
    let panel = document.getElementById("perm-panel");
    document.getElementById("perm-prompt").hidden = true;
    let manage = document.getElementById("perm-manage");
    manage.hidden = false;
    document.getElementById("perm-manage-title").textContent = `Permissions for ${host}`;
    let list = document.getElementById("perm-manage-list");
    list.replaceChildren();
    let grants = this.getPermissionsFor(host);
    let types = Object.keys(grants);
    if (!types.length) {
      let empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Nothing granted or blocked yet.";
      list.append(empty);
    }
    for (let type of types) {
      let row = document.createElement("div");
      row.className = "perm-manage-row";
      let label = document.createElement("span");
      label.textContent = `${this.permissionTypeText(type)}: ${grants[type]}`;
      let revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => {
        this.setPermission(host, type, null);
        this.showPermissionManage();
      });
      row.append(label, revoke);
      list.append(row);
    }
    try {
      let width = 360;
      let x = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
      panel.openPopupAtScreen(x, window.screenY + 48);
    } catch (e) { /* the manage view just doesn't open */ }
  },

  // -------------------------------------------------------------- extensions
  //
  // The engine's own extension host, with the parts Firefox keeps in
  // its front end supplied by Seijaku:
  // - the tabs, windows and browserAction APIs (shell/chrome/content/
  //   ext/), which draw each extension's button, badge and popup in the
  //   strip and see Seijaku's tabs through the events tabEvent sends;
  // - start-up and install prompts (SeijakuExtensions.sys.mjs): the
  //   notifications that let background pages run, and the questions
  //   an install asks, answered by showExtensionPrompt below.
  // Installs come from addons.mozilla.org (allowed by
  // defaults/permissions), a .xpi link or address, or a file picked on
  // seijaku:extensions; every one shows the extension's permissions
  // first. Extensions must be signed by Mozilla, as in Firefox.
  // .crx files stay refused (see load). Every step is guarded, so a
  // missing extension system leaves startup untouched.

  async initExtensions() {
    try {
      let SeijakuExtensions = ChromeUtils.importESModule("resource://seijaku/SeijakuExtensions.sys.mjs");
      SeijakuExtensions.register();
      // After the first paint, as Firefox does: extension background
      // pages wait for this before they start.
      setTimeout(() => SeijakuExtensions.windowReady(window), 0);
    } catch (e) {
      console.error("Seijaku: starting extension support", e);
    }
    try {
      let { AddonManager } = ChromeUtils.importESModule(
        "resource://gre/modules/AddonManager.sys.mjs"
      );
      this._AddonManager = AddonManager;
      await AddonManager.startup();
      this._extReady = true;
    } catch (e) {
      this._extReady = false;
    }
  },

  async getExtensions() {
    try {
      let addons = await this._AddonManager.getAddonsByTypes(["extension"]);
      return addons
        .filter(a => !a.hidden)
        .map(a => ({
          id: a.id,
          name: a.name,
          version: a.version,
          description: a.description || "",
          enabled: !a.userDisabled,
          iconURL: a.iconURL || "",
          hasOptions: !!a.optionsURL,
        }));
    } catch (e) {
      return [];
    }
  },

  async extensionById(id) {
    try {
      return await this._AddonManager.getAddonByID(id);
    } catch (e) {
      return null;
    }
  },

  async setExtensionEnabled(id, enabled) {
    let addon = await this.extensionById(id);
    if (addon) {
      await (enabled ? addon.enable() : addon.disable());
    }
  },

  async uninstallExtension(id) {
    let addon = await this.extensionById(id);
    if (addon) {
      await addon.uninstall();
    }
  },

  /** The extension's options page, in a tab of its own. */
  async openExtensionOptions(id) {
    let addon = await this.extensionById(id);
    if (!addon?.optionsURL) {
      return;
    }
    let existing = this.tabs.find(t => t.browser?.currentURI?.spec == addon.optionsURL);
    if (existing) {
      this.selectTab(existing);
      return;
    }
    this.openTab(addon.optionsURL, {
      afterCurrent: true,
      triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(
        Services.io.newURI(addon.optionsURL),
        {}
      ),
    });
  },

  async installExtensionFromFile() {
    // The manager page calls this; the picker runs here so the
    // page never touches engine objects. The shipped engine's picker
    // is Promise-based; a cancel just rejects quietly.
    let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(window, "Install extension", Ci.nsIFilePicker.modeOpen);
    picker.appendFilter("Firefox extensions (*.xpi)", "*.xpi");
    let result = await picker.open();
    if (result != Ci.nsIFilePicker.returnOK || !picker.file) {
      // Worded so the manager page's quiet-cancel heuristic (it
      // silences rejections mentioning cancel/abort) treats a
      // dismissed picker as a non-error, not a failure.
      throw new Error("Install cancelled — no file chosen");
    }
    let install = await this._AddonManager.getInstallForFile(picker.file, null, {
      source: "file-url",
    });
    return this.runInstall(install, Services.io.newFileURI(picker.file));
  },

  /** A .xpi typed, bookmarked or opened by the shell (links clicked
      inside a page go through the engine's own web-install path). */
  async installXpiUrl(url) {
    try {
      let install = await this._AddonManager.getInstallForURL(url, {
        telemetryInfo: { source: "unknown" },
      });
      await this.runInstall(install, Services.io.newURI(url));
    } catch (e) {
      if (!/cancel/i.test(e?.message || "")) {
        this.showMessage(`Couldn't install that extension: ${e.message}`, "error");
      }
    }
  },

  /** Runs an install with the permission prompt, the way Firefox's
      "Install Add-on From File" does; resolves with the name. */
  runInstall(install, uri) {
    return new Promise((resolve, reject) => {
      install.addListener({
        onInstallEnded: (aInstall, addon) => resolve(addon?.name || "Extension"),
        onInstallCancelled: () => reject(new Error("Install cancelled")),
        onInstallFailed: () => reject(new Error(`install failed (error ${install.error})`)),
        onDownloadFailed: () => reject(new Error(`download failed (error ${install.error})`)),
        onDownloadCancelled: () => reject(new Error("Install cancelled")),
      });
      this._AddonManager.installAddonFromAOM(this.selectedBrowser || null, uri, install);
    });
  },

  // The extension prompt: a panel under the strip, like the site
  // permission prompt, asking whether to add an extension (with what
  // it will be able to do) or answering any other install question.
  // Questions queue; each gets exactly one answer, and closing the
  // panel any other way counts as Cancel.
  initExtensionPrompt() {
    let panel = document.getElementById("ext-prompt-panel");
    if (!panel || this._extPromptReady) {
      return;
    }
    this._extPromptReady = true;
    this._extPrompts = [];
    document.getElementById("ext-prompt-accept").addEventListener("click", () => this.answerExtensionPrompt(true));
    document.getElementById("ext-prompt-cancel").addEventListener("click", () => this.answerExtensionPrompt(false));
    panel.addEventListener("popuphidden", () => {
      if (this._extPromptHiding) {
        // Closed after an answer; a question that arrived meanwhile
        // still needs showing.
        this._extPromptHiding = false;
        this.renderExtensionPrompt();
      } else {
        this.answerExtensionPrompt(false);
      }
    });
  },

  showExtensionPrompt(prompt) {
    this.initExtensionPrompt();
    this._extPrompts.push(prompt);
    if (this._extPrompts.length == 1) {
      this.renderExtensionPrompt();
    }
  },

  renderExtensionPrompt() {
    let prompt = this._extPrompts[0];
    if (!prompt) {
      return;
    }
    document.getElementById("ext-prompt-title").textContent = prompt.title;
    document.getElementById("ext-prompt-intro").textContent = prompt.intro || "";
    let icon = document.getElementById("ext-prompt-icon");
    icon.hidden = !prompt.icon;
    if (prompt.icon) {
      icon.src = prompt.icon;
    }
    let list = document.getElementById("ext-prompt-list");
    list.replaceChildren(
      ...(prompt.lines || []).map(text => {
        let li = document.createElement("li");
        li.textContent = text;
        return li;
      })
    );
    document.getElementById("ext-prompt-accept").textContent = prompt.accept || "Add";
    let panel = document.getElementById("ext-prompt-panel");
    try {
      let width = 380;
      let x = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
      panel.openPopupAtScreen(x, window.screenY + 48);
    } catch (e) {
      this.answerExtensionPrompt(false);
    }
  },

  answerExtensionPrompt(accept) {
    let prompt = this._extPrompts?.shift();
    if (!prompt) {
      return;
    }
    try {
      (accept ? prompt.onAccept : prompt.onCancel)?.();
    } catch (e) {
      console.error("Seijaku: answering an extension prompt", e);
    }
    let panel = document.getElementById("ext-prompt-panel");
    if (this._extPrompts.length) {
      this.renderExtensionPrompt();
    } else if (panel.state != "closed") {
      this._extPromptHiding = true;
      panel.hidePopup();
    }
  },

  // -------------------------------------------------------------- reader view
  //
  // The reader button in the floating bar turns the current page
  // into a clean article: the engine's own Readability module does
  // the extraction (the same module Firefox's reader mode uses), and
  // seijaku:reader renders it with font-size controls. If Readability
  // is missing in the shipped engine, a naive fallback takes the
  // element with the most paragraph text. The article is held on the
  // shell for the reader page to read; it is never written to disk.

  async openReader() {
    let b = this.selectedBrowser;
    if (!b) {
      return;
    }
    let article = null;
    // A web page: ask Seijaku's reader actor, which runs inside the
    // page's own process (see SeijakuReaderChild.sys.mjs).
    try {
      let actor = b.browsingContext?.currentWindowGlobal?.getActor("SeijakuReader");
      article = actor ? await actor.sendQuery("Seijaku:Extract") : null;
    } catch (e) { /* not a page the actor runs in; try in-process */ }
    // A page in this process (the browser's own pages): read it here.
    if (!article?.content) {
      let doc = null;
      try {
        doc = b.contentWindow?.document ?? null;
      } catch (e) { /* no in-process document */ }
      if (doc) {
        try {
          article = this.naiveArticle(doc);
        } catch (e) {
          article = null;
        }
      }
    }
    if (!article?.content) {
      this.showMessage("No readable article on this page", "error");
      return;
    }
    // The article is the web page's own markup, and the reader page
    // that renders it is a privileged chrome page: strip scripts,
    // event handlers and forms before it gets anywhere near there.
    let content = "";
    try {
      content = Cc["@mozilla.org/parserutils;1"]
        .getService(Ci.nsIParserUtils)
        .sanitize(article.content, Ci.nsIParserUtils.SanitizerDropForms);
    } catch (e) {
      this.showMessage("Reader view couldn't clean up this page", "error");
      return;
    }
    this._readerArticle = {
      title: article.title || b.tab?.title || "",
      byline: article.byline || "",
      content,
      url: b.tab?.url || "",
    };
    // Always a fresh reader tab: openPage would select an existing
    // reader tab, which already rendered and would show the OLD
    // article. The old reader tab goes away once the new one exists
    // (closing it first could close the window if it was the only tab).
    let existing = this.tabs.find(t => t.url?.split("#")[0] == "seijaku:reader");
    this.openTab("seijaku:reader", { afterCurrent: true });
    if (existing && this.tabs.length > 1) {
      this.closeTab(existing);
    }
  },

  naiveArticle(doc) {
    let best = null;
    let bestText = 0;
    let candidates = doc.querySelectorAll("article, main, [role='main']");
    let roots = candidates.length ? [...candidates] : [doc.body];
    for (let root of roots) {
      let text = root?.textContent?.length ?? 0;
      if (text > bestText) {
        bestText = text;
        best = root;
      }
    }
    if (!best || bestText < 200) {
      return null;
    }
    return { title: doc.title || "", byline: "", content: best.innerHTML };
  },

  getReaderArticle() {
    return this._readerArticle;
  },

  // -------------------------------------------------------------- PDF bytes
  //
  // The viewer page never fetches a PDF itself: a chrome page
  // fetching an arbitrary http URL would hit CORS, and a file URL
  // would hit local-file rules. The shell fetches with the system
  // principal instead, which bypasses both, and hands the bytes to
  // the viewer. Saving goes the same way: the viewer builds the
  // annotated file with pdf-lib and the shell writes it into the
  // Downloads folder.

  async fetchPdfBytes(url) {
    let response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Couldn't fetch the PDF (${response.status})`);
    }
    let bytes = new Uint8Array(await response.arrayBuffer());
    // Plain data crosses compartments safely; the viewer page
    // normalizes with new Uint8Array() before handing the bytes to
    // pdf.js (whose instanceof checks would fail on a wrapped array).
    return bytes;
  },

  async downloadPdfBytes(filename, bytes) {
    let safe = String(filename).replace(/[\\/:*?"<>|]/g, "_") || "annotated.pdf";
    // Normalize into this compartment: bytes arriving from a page
    // fail instanceof checks here, but the constructor copies them.
    let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // The Settings download folder, when set (else the engine default).
    let dir = this.downloadDir();
    let file = dir.clone();
    file.append(safe);
    let { IOUtils } = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs");
    await IOUtils.write(file.path, data);
    this.showMessage(`Saved ${safe}`);
  },

  // -------------------------------------------------------------- events

  handleEvent(event) {
    switch (event.type) {
      case "mousedown": {
        // The speaker mark mutes without switching to the tab.
        if (event.target.closest(".tab-speaker")) {
          let tab = event.target.closest(".tab")?.tab;
          if (tab) {
            this.toggleMute(tab);
          }
          event.preventDefault();
          break;
        }
        let tab = event.target.closest(".tab")?.tab;
        if (tab && event.button == 0) {
          this.selectTab(tab);
          event.preventDefault();
          this.startTabDrag(tab, event);
        }
        break;
      }
      case "auxclick": {
        let tab = event.target.closest(".tab")?.tab;
        if (tab && event.button == 1) {
          this.closeTab(tab);
        }
        break;
      }
      case "dblclick": {
        let tab = event.target.closest(".tab")?.tab;
        if (tab) {
          this.closeTab(tab);
        }
        break;
      }
      case "keydown": {
        // Escape closes chrome UI, never a page: it is the one piece
        // of chrome UI that a page must never be able to swallow,
        // and it never reaches pages from here. A permission prompt
        // dismissed with Escape counts as Block for this time only
        // (never remembered) — a request must always get an answer.
        if (event.key == "Escape" && this._permActive) {
          this.answerPermission(false, false);
        }
        if (event.key == "Escape" && !document.getElementById("findbar").hidden) {
          this.hideFindBar();
        }
        if (event.key == "Escape") {
          try {
            document.getElementById("ext-popup-panel").hidePopup();
          } catch (e) { /* no popup open */ }
        }
        break;
      }
      case "mousemove": {
        // Fallback reveal only: the #edge-strip mouseenter in init
        // is the real reveal path, because page mouse events never
        // reach this window at all. This covers the pointer already
        // sitting over chrome at the placement edge.
        if (this._autohide) {
          let position = this._tabsPosition;
          let atEdge =
            (position == "top" && event.clientY <= 4) ||
            (position == "bottom" && event.clientY >= window.innerHeight - 4) ||
            (position == "left" && event.clientX <= 4) ||
            (position == "right" && event.clientX >= window.innerWidth - 4);
          if (atEdge) {
            this.showChrome();
          }
        }
        break;
      }
      case "unload":
        clearInterval(this._sleepTimer);
        // Pending writes go out now; the engine finishes them before
        // the process exits.
        if (this.tabs.length) {
          this.flushSession();
        }
        this.flushData();
        try {
          Services.prefs.removeObserver(PREF, this);
        } catch (e) { /* never registered */ }
        try {
          Services.obs.removeObserver(this, "commandline-args-changed");
        } catch (e) { /* never registered, or already gone */ }
        // A staged update installs now: the updater waits for this
        // process to be gone, installs silently, and restarts Seijaku.
        if (this._stagedUpdate && !this._updating) {
          try {
            this.launchUpdater(this._stagedUpdate);
          } catch (e) { /* the staged installer just stays in Temp */ }
        }
        break;
    }
  },
};

/** Keyboard shortcuts. Reserved, so pages can't take them over, except
    the few marked page: true, which a page may answer first. */
var Keys = {
  bindings: [
    ["t", "accel", () => Seijaku.newTabWithBar()],
    ["w", "accel", () => Seijaku.closeTab()],
    ["t", "accel,shift", () => Seijaku.undoCloseTab()],
    ["l", "accel", () => Seijaku.showFloatingBar()],
    ["k", "accel", () => Seijaku.showPalette()],
    ["p", "accel,shift", () => Seijaku.togglePinCurrent()],
    ["n", "accel,shift", () => Seijaku.openPrivateWindow()],
    ["s", "accel,shift", () => Seijaku.sleepCurrentTab()],
    ["r", "accel", () => Seijaku.selectedBrowser?.reload()],
    ["r", "accel,shift", () => Seijaku.hardReload()],
    ["VK_F5", "accel", () => Seijaku.hardReload()],
    ["VK_HOME", "alt", () => Seijaku.goHome()],
    // Not reserved: web editors (documents, code) save with Ctrl+S
    // themselves, and the page must get it first.
    ["s", "accel", () => Seijaku.savePage(), { page: true }],
    ["f", "accel", () => Seijaku.showFindBar()],
    ["=", "accel", () => Seijaku.zoom(0.1)],
    ["+", "accel", () => Seijaku.zoom(0.1)],
    ["-", "accel", () => Seijaku.zoom(-0.1)],
    ["0", "accel", () => Seijaku.zoomReset()],
    ["h", "accel,shift", () => Seijaku.toggleChromeAutohide()],
    ["d", "accel", () => Seijaku.toggleBookmark()],
    ["h", "accel", () => Seijaku.openPage("history")],
    ["j", "accel", () => Seijaku.openPage("downloads")],
    ["b", "accel,shift", () => Seijaku.openPage("bookmarks")],
    ["VK_TAB", "control", () => Seijaku.cycleTab(1)],
    ["VK_TAB", "control,shift", () => Seijaku.cycleTab(-1)],
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [String(n), "accel", () => Seijaku.selectTabNumber(n)]),
    ["VK_F5", "", () => Seijaku.selectedBrowser?.reload()],
    ["VK_F11", "", () => Seijaku.toggleFullScreen()],
    ["p", "accel", () => Seijaku.printPage()],
    ["VK_DELETE", "accel,shift", () => Seijaku.openClearData()],
    ["VK_LEFT", "alt", () => Seijaku.selectedBrowser?.goBack()],
    ["VK_RIGHT", "alt", () => Seijaku.selectedBrowser?.goForward()],
    [",", "accel", () => Seijaku.openPage("settings")],
  ],

  install() {
    let keyset = document.createXULElement("keyset");
    for (let [key, modifiers, action, options] of this.bindings) {
      let el = document.createXULElement("key");
      if (key.startsWith("VK_")) {
        el.setAttribute("keycode", key);
      } else {
        el.setAttribute("key", key);
      }
      if (modifiers) {
        el.setAttribute("modifiers", modifiers);
      }
      el.setAttribute("reserved", options?.page ? "false" : "true");
      el.addEventListener("command", () => {
        try {
          action();
        } catch (e) {
          console.error(e);
        }
      });
      keyset.append(el);
    }
    document.documentElement.append(keyset);
  },
};

window.addEventListener("load", () => Seijaku.init(), { once: true });
