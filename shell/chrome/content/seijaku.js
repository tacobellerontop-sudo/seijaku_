/* Seijaku: a lean browser shell on Gecko. Tabs, an address line, a home
   page, settings, tab sleeping, auto-update, find, zoom, and themes.
   Nothing else on purpose: no mods, no extensions host, no accounts,
   no services, no command bar. See docs/PLAN.md. */

"use strict";

const { E10SUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/E10SUtils.sys.mjs"
);
const Theme = ChromeUtils.importESModule("resource://seijaku/Theme.sys.mjs");

const PREF = "seijaku.";
const SESSION_FILE = "seijaku-session.json";
const MESSAGE_MS = 4000;
const SEIJAKU_VERSION = "0.2.0";
const UPDATE_REPO = "tacobellerontop-sudo/seijaku_";
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

const PAGES = {
  "seijaku:home": "chrome://seijaku/content/pages/home.html",
  "seijaku:settings": "chrome://seijaku/content/pages/settings.html",
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
    // No close button on purpose: a tab closes with a double-click
    // (or Ctrl+W, or middle-click). One less control per tab keeps the
    // strip quiet, and the strip is where the eye lives.
    this.el.append(this.labelEl);
    this.el.tab = this;
    Object.defineProperty(this.el, "linkedBrowser", { get: () => this.browser });
    this.browser = null;
    this.url = "about:blank";
    this.title = "";
    this.lastActive = Date.now();
  }

  get asleep() {
    return !this.browser;
  }

  update() {
    this.labelEl.textContent = this.title || this.url;
    this.el.title = this.url;
    this.el.toggleAttribute("asleep", this.asleep);
  }
}

var Seijaku = {
  version: SEIJAKU_VERSION,
  tabs: [],
  selected: null,
  closed: [],
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
  get $addressbar() {
    return document.getElementById("addressbar");
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
    this.applyTheme();
    Services.prefs.addObserver(PREF, this);
    this.initTitlebar();
    this.initBrowserDOMWindow();
    this.applyChromeAutohide();
    this.$tabbar.addEventListener("mousedown", this);
    this.$tabbar.addEventListener("auxclick", this);
    this.$tabbar.addEventListener("dblclick", this);
    this.initFindBar();
    document.getElementById("nav-back").addEventListener("click", () => this.selectedBrowser?.goBack());
    document.getElementById("nav-forward").addEventListener("click", () => this.selectedBrowser?.goForward());
    document.getElementById("nav-reload").addEventListener("click", () => this.selectedBrowser?.reload());
    document.getElementById("tab-new").addEventListener("click", () => this.newTab());
    document.getElementById("toolbar-menu").addEventListener("click", () => this.openPage("settings"));
    this.initAddressBar();
    window.addEventListener("keydown", this, true);
    window.addEventListener("mousemove", this);
    window.addEventListener("unload", this);
    Keys.install();
    // A link clicked elsewhere while Seijaku runs arrives as a remote
    // command line; without a handler of its own, the shell learns
    // about it here instead (see launchURL below).
    try {
      Services.obs.addObserver(this, "commandline-args-changed");
    } catch (e) { /* remote links just open a new window instead */ }

    // A launched link beats the home page: it opens as the first tab
    // on a cold start, or as a new tab after a restored session.
    let launch = this.launchURL();
    this.restoreSession().then(restored => {
      if (launch) {
        let target = launch;
        try {
          target = this.urlFor(launch);
        } catch (e) { /* keep the raw launch address */ }
        this.openTab(target, { afterCurrent: true });
      } else if (!restored) {
        this.openTab(this.homepage());
      }
    });
    this._sleepTimer = setInterval(() => this.sleepIdleTabs(), 60 * 1000);
    this.maybeCheckForUpdates();
  },

  // -------------------------------------------------------------- updates
  //
  // Auto-update, the small way: once a day at most, ask GitHub for the
  // latest release. If there is a newer one, download the installer in
  // the background and stage it; quitting the browser then hands it to
  // a tiny .bat that waits for this process to exit (so Inno is never
  // fighting a running browser), installs silently, and starts Seijaku
  // again. The Settings page has an Update button that does the same
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
    let batFile = tmp.clone();
    batFile.append("seijaku-update.bat");
    await this.writeTextFile(batFile, this.updaterBat(installerFile.path));
    this._stagedUpdate = batFile.path;
  },

  updaterBat(installerPath) {
    return [
      "@echo off",
      ":wait",
      'tasklist /FI "IMAGENAME eq seijaku.exe" 2>nul | find /I "seijaku.exe" >nul',
      "if not errorlevel 1 timeout /t 1 /nobreak >nul & goto wait",
      `"${installerPath}" /VERYSILENT /NORESTART /SUPPRESSMSGBOXES`,
      'start "" "%LOCALAPPDATA%\\Programs\\Seijaku\\seijaku.exe" -app "%LOCALAPPDATA%\\Programs\\Seijaku\\seijaku\\application.ini"',
      'del "%~f0"',
      "",
    ].join("\r\n");
  },

  launchUpdaterBat(batPath) {
    let cmd = Services.dirsvc.get("WinD", Ci.nsIFile);
    cmd.append("System32");
    cmd.append("cmd.exe");
    let process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    process.init(cmd);
    process.run(false, ["/c", batPath], 2);
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
    // The installer leaves unins000.exe next to the engine; the
    // portable zip has Seijaku.bat there instead.
    try {
      let dir = Services.dirsvc.get("CurProcD", Ci.nsIFile).clone();
      dir.append("unins000.exe");
      return dir.exists();
    } catch (e) {
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
      this.launchUpdaterBat(this._stagedUpdate);
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
        persist.saveURI(
          Services.io.newURI(url), null, null, null, null, file, null
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
      this.applyTheme();
      if (data == PREF + "chrome.autohide") {
        this.applyChromeAutohide();
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
    let custom = {
      barBg: this.pref("theme.custom.barBg", "#171310"),
      fg: this.pref("theme.custom.fg", "#ece4d3"),
      accent: this.pref("theme.custom.accent", "#d8442a"),
    };
    Theme.applyColors(document.documentElement, this.pref("theme", "ink"), custom);
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

  // -------------------------------------------------------------- auto-hide chrome
  //
  // An opt-in "just the page" mode: with seijaku.chrome.autohide on,
  // the three top rows (title bar, tab strip, address line) collapse
  // and only a 2px vermilion line stays at the very top edge — the
  // selected tab's underline colour, with nothing else. Moving the
  // mouse to the very top edge brings the rows back; moving it onto
  // the page hides them again. Ctrl+Shift+H flips the setting, so
  // the mode can always be left from the keyboard too.

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

  initTitlebar() {
    // This is what hides the Windows title bar: without it Gecko draws
    // its own bar above ours (the double-bar bug in 0.1.0). The attribute
    // is also on the <html> element in seijaku.xhtml; setting it here too
    // covers the case where the document is reloaded.
    document.documentElement.setAttribute("customtitlebar", "true");
    this.setAppUserModelId();
    // One chrome row, Ryoku-style: the tabs live in the title bar row,
    // after the seal and before the window buttons. The window title is
    // redundant once tabs carry their own titles, so it is hidden. If
    // the move fails for any reason, the old two-row layout stays intact.
    try {
      let tabbar = document.getElementById("tabbar");
      let content = document.getElementById("titlebar-content");
      let title = document.getElementById("titlebar-title");
      if (tabbar && content && tabbar.parentNode != content) {
        content.appendChild(tabbar);
        if (title) title.hidden = true;
      }
    } catch (e) { /* keep the two-row layout */ }
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

  // -------------------------------------------------------------- address

  initAddressBar() {
    let input = this.$addressbar;
    input.addEventListener("focus", () => input.select());
    input.addEventListener("keydown", event => {
      if (event.key != "Enter") {
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
      if (event.ctrlKey || event.metaKey) {
        this.openTab(url, { afterCurrent: true });
      } else if (this.selectedBrowser) {
        this.load(this.selectedBrowser, url);
      }
      this.selectedBrowser?.focus();
    });
  },

  updateAddressBar() {
    let input = this.$addressbar;
    if (!input || document.activeElement == input) {
      return;
    }
    let url = this.selected?.url ?? "";
    input.value = url == "seijaku:home" || url == "about:blank" ? "" : url;
    let lock = document.getElementById("address-lock");
    lock.textContent = url.startsWith("https://")
      ? "\u{1f512}"
      : url.startsWith("http://")
        ? "\u{1f513}"
        : "\u2315";
    lock.title = url.startsWith("https://")
      ? "Secure connection"
      : url.startsWith("http://")
        ? "Not secure"
        : "Seijaku page";
  },

  updateNavButtons() {
    let b = this.selectedBrowser;
    document.getElementById("nav-back").disabled = !b?.canGoBack;
    document.getElementById("nav-forward").disabled = !b?.canGoForward;
  },

  updateTitle() {
    let tab = this.selected;
    document.title = tab ? `${tab.title || tab.url} - Seijaku` : "Seijaku";
    document.getElementById("titlebar-title").textContent = document.title;
    this.updateAddressBar();
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
        } else if (flags & Ci.nsIWebProgressListener.STATE_STOP) {
          tab.el.removeAttribute("busy");
          if (tab === Seijaku.selected) {
            Seijaku.updateNavButtons();
          }
          Seijaku.saveSession();
        }
      },
      onLocationChange(webProgress, request, location, flags) {
        if (!webProgress.isTopLevel) {
          return;
        }
        tab.url = displayURL(location.spec);
        tab.title = b.contentTitle || "";
        tab.update();
        if (tab === Seijaku.selected) {
          Seijaku.updateTitle();
          Seijaku.updateNavButtons();
        }
        Seijaku.saveSession();
      },
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };
    tab.progressListener = listener;
    b.addProgressListener(
      listener,
      Ci.nsIWebProgress.NOTIFY_STATE_NETWORK | Ci.nsIWebProgress.NOTIFY_LOCATION
    );
    b.addEventListener("pagetitlechanged", () => {
      tab.title = b.contentTitle || "";
      tab.update();
      if (tab === Seijaku.selected) {
        Seijaku.updateTitle();
      }
    });
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
    let index = options.index ?? (options.afterCurrent && this.selected
      ? this.tabs.indexOf(this.selected) + 1
      : this.tabs.length);
    this.tabs.splice(index, 0, tab);
    this.placeTabEl(tab);
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

  load(browser, url, { triggeringPrincipal } = {}) {
    // Extension filter, kept tiny: Seijaku has no extension host, so
    // an extension could never run here — it would only be dead
    // weight. Direct loads of extension files are refused with a plain
    // explanation instead of pretending to install them. (Files linked
    // from a page just download and never run, for the same reason.)
    let bare = String(url).split(/[?#]/, 1)[0].toLowerCase();
    if (bare.endsWith(".xpi") || bare.endsWith(".crx")) {
      this.showMessage("Extensions don't run in Seijaku — there is no extension host to run them in", "error");
      return;
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
      browser.loadURI(uri, {
        triggeringPrincipal:
          triggeringPrincipal || Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (e) {
      this.showMessage(`Can't open ${url}: ${e.message}`, "error");
    }
  },

  selectTab(tab) {
    if (!tab) {
      return;
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
    tab.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (tab.asleep) {
      this.wake(tab);
    }
    this.activate(tab);
    tab.browser?.focus();
    this.updateTitle();
    this.updateNavButtons();
  },

  closeTab(tab = this.selected) {
    if (!tab) {
      return;
    }
    let index = this.tabs.indexOf(tab);
    this.closed.push({ url: tab.url, title: tab.title, index });
    if (this.closed.length > 20) {
      this.closed.shift();
    }
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
    if (!last) {
      this.showMessage("Nothing to undo");
      return;
    }
    this.openTab(last.url, { index: Math.min(last.index, this.tabs.length) });
  },

  // -------------------------------------------------------------- find, zoom
  //
  // Both ride on the page itself, so they cost nothing when unused:
  // find uses the content window's own text search, zoom uses the
  // page's document viewer. No extra processes, no extra UI until
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
      this.selectedBrowser?.contentWindow?.getSelection()?.removeAllRanges();
    } catch (e) { /* clearing a highlight is never worth an error */ }
  },

  findInPage(backwards = false) {
    let term = document.getElementById("find-input").value;
    if (!term) {
      return;
    }
    let win = this.selectedBrowser?.contentWindow;
    if (!win) {
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
      let viewer = b.markupDocumentViewer;
      viewer.fullZoom = Math.min(3, Math.max(0.3, Math.round((viewer.fullZoom + step) * 10) / 10));
      this.showMessage(`Zoom ${Math.round(viewer.fullZoom * 100)}%`);
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
      b.markupDocumentViewer.fullZoom = 1;
    } catch (e) { /* internal pages just stay as they are */ }
  },

  // -------------------------------------------------------------- sleeping

  /** Puts a tab to sleep: frees its page, keeps its place and address. */
  sleep(tab) {
    if (!tab || tab.asleep || tab === this.selected) {
      return false;
    }
    tab.browser.remove();
    tab.browser = null;
    tab.update();
    return true;
  },

  wake(tab) {
    if (!tab.asleep) {
      return;
    }
    let b = this.attachBrowser(tab, {});
    this.load(b, tab.url);
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
      tabs: this.tabs.map(t => ({ url: t.url, title: t.title })),
    };
  },

  saveSession() {
    let path = this.sessionPath();
    if (!path) {
      return;
    }
    IOUtils.writeJSON(path, this.sessionData()).catch(e => console.error("Seijaku: saving session", e));
  },

  restoreSession() {
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
          this.openTab(t.url, { asleep: true, title: t.title, background: true });
        }
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

  // -------------------------------------------------------------- events

  handleEvent(event) {
    switch (event.type) {
      case "mousedown": {
        let tab = event.target.closest(".tab")?.tab;
        if (tab && event.button == 0) {
          this.selectTab(tab);
          event.preventDefault();
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
        // Escape closes the find bar, and only the find bar: it is the
        // one piece of chrome UI that a page must never be able to
        // swallow, and it never reaches pages from here.
        if (event.key == "Escape" && !document.getElementById("findbar").hidden) {
          this.hideFindBar();
        }
        break;
      }
      case "mousemove": {
        // Auto-hide chrome: the top edge reveals, the page hides.
        // Only acts when the state would change, so the steady
        // stream of moves costs nothing.
        if (this._autohide) {
          if (event.clientY <= 4) {
            this.showChrome();
          } else if (document.getElementById("content")?.contains(event.target)) {
            this.hideChrome();
          }
        }
        break;
      }
      case "unload":
        clearInterval(this._sleepTimer);
        try {
          Services.obs.removeObserver(this, "commandline-args-changed");
        } catch (e) { /* never registered, or already gone */ }
        // A staged update installs now: the .bat waits for this
        // process to be gone, installs silently, and restarts Seijaku.
        if (this._stagedUpdate && !this._updating) {
          try {
            this.launchUpdaterBat(this._stagedUpdate);
          } catch (e) { /* the staged installer just stays in Temp */ }
        }
        break;
    }
  },
};

/** Keyboard shortcuts. Reserved, so pages can't take them over. */
var Keys = {
  bindings: [
    ["t", "accel", () => Seijaku.newTab()],
    ["w", "accel", () => Seijaku.closeTab()],
    ["t", "accel,shift", () => Seijaku.undoCloseTab()],
    ["l", "accel", () => Seijaku.$addressbar.focus()],
    ["r", "accel", () => Seijaku.selectedBrowser?.reload()],
    ["f", "accel", () => Seijaku.showFindBar()],
    ["=", "accel", () => Seijaku.zoom(0.1)],
    ["+", "accel", () => Seijaku.zoom(0.1)],
    ["-", "accel", () => Seijaku.zoom(-0.1)],
    ["0", "accel", () => Seijaku.zoomReset()],
    ["h", "accel,shift", () => Seijaku.toggleChromeAutohide()],
    ["VK_LEFT", "alt", () => Seijaku.selectedBrowser?.goBack()],
    ["VK_RIGHT", "alt", () => Seijaku.selectedBrowser?.goForward()],
    [",", "accel", () => Seijaku.openPage("settings")],
  ],

  install() {
    let keyset = document.createXULElement("keyset");
    for (let [key, modifiers, action] of this.bindings) {
      let el = document.createXULElement("key");
      if (key.startsWith("VK_")) {
        el.setAttribute("keycode", key);
      } else {
        el.setAttribute("key", key);
      }
      if (modifiers) {
        el.setAttribute("modifiers", modifiers);
      }
      el.setAttribute("reserved", "true");
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
