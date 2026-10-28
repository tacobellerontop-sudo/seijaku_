/* Seijaku: a lean browser shell on Gecko. Tabs, an address line, a home
   page, settings, tab sleeping, and auto-update. Nothing else on
   purpose: no mods, no extensions host, no accounts, no services, no
   command bar. See docs/PLAN.md. */

"use strict";

const { E10SUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/E10SUtils.sys.mjs"
);
const Theme = ChromeUtils.importESModule("resource://seijaku/Theme.sys.mjs");

const PREF = "seijaku.";
const SESSION_FILE = "seijaku-session.json";
const MESSAGE_MS = 4000;
const SEIJAKU_VERSION = "0.1.8";
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
    this.closeEl = document.createElement("button");
    this.closeEl.className = "tab-close";
    this.closeEl.textContent = "\u00d7";
    this.closeEl.title = "Close tab (Ctrl+W)";
    this.closeEl.tabIndex = -1;
    this.closeEl.addEventListener("mousedown", event => event.stopPropagation());
    this.closeEl.addEventListener("click", event => {
      event.stopPropagation();
      Seijaku.closeTab(this);
    });
    this.el.append(this.labelEl, this.closeEl);
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
    this.$tabbar.addEventListener("mousedown", this);
    this.$tabbar.addEventListener("auxclick", this);
    document.getElementById("nav-back").addEventListener("click", () => this.selectedBrowser?.goBack());
    document.getElementById("nav-forward").addEventListener("click", () => this.selectedBrowser?.goForward());
    document.getElementById("nav-reload").addEventListener("click", () => this.selectedBrowser?.reload());
    document.getElementById("tab-new").addEventListener("click", () => this.newTab());
    document.getElementById("toolbar-menu").addEventListener("click", () => this.openPage("settings"));
    this.initAddressBar();
    window.addEventListener("keydown", this, true);
    window.addEventListener("unload", this);
    Keys.install();

    this.restoreSession().then(restored => {
      if (!restored) {
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
    if (topic == "nsPref:changed" && data.startsWith(PREF)) {
      this.applyTheme();
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
    Theme.applyColors(document.documentElement, this.pref("theme", "ink"));
  },

  initTitlebar() {
    // This is what hides the Windows title bar: without it Gecko draws
    // its own bar above ours (the double-bar bug in 0.1.0). The attribute
    // is also on the <html> element in seijaku.xhtml; setting it here too
    // covers the case where the document is reloaded.
    document.documentElement.setAttribute("customtitlebar", "true");
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
      case "unload":
        clearInterval(this._sleepTimer);
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
