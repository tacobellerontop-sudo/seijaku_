/* Seijaku's extension APIs, parent side: the shared plumbing behind
   tabs, windows and browserAction. Firefox keeps this in its front end
   (browser/components/extensions/parent/ext-browser.js), which the
   packager drops; this is the same design rebuilt on Seijaku's own
   tabs. Structure and names follow ext-browser.js and GeckoView's
   ext-android.js (Mozilla Public License 2.0) so the engine's base
   classes (ext-tabs-base.js) fit unchanged.

   A native tab here is the shell's own Tab object (seijaku.js). The
   window tells this file what happens to its tabs through events it
   dispatches on itself (SeijakuTabOpen, SeijakuTabClose, SeijakuTabSelect,
   SeijakuTabMove, SeijakuTabAttrModified, SeijakuTabBrowserInserted,
   SeijakuTabBrowserDiscarded), each with the tab in event.detail.tab.
   A sleeping tab has no <browser>: it reads as discarded, keeps its id,
   and answers url/title from what the strip remembers. */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

var { ExtensionError, DefaultWeakMap } = ExtensionUtils;
var { defineLazyGetter } = ExtensionCommon;

const WINDOW_TYPE = "seijaku:main";

const BrowserStatusFilter = Components.Constructor(
  "@mozilla.org/appshell/component/browser-status-filter;1",
  "nsIWebProgress",
  "addProgressListener"
);

const PROGRESS_FLAGS =
  Ci.nsIWebProgress.NOTIFY_STATE_ALL | Ci.nsIWebProgress.NOTIFY_LOCATION;

let tabTracker;
let windowTracker;

/** The shell object of a Seijaku window. */
function shellOf(window) {
  return window?.Seijaku ?? null;
}

function windowOfTab(nativeTab) {
  return nativeTab.el.ownerDocument.defaultView;
}

function isPrivateWindow(window) {
  return PrivateBrowsingUtils.isWindowPrivate(window);
}

/* Passes one browser's progress to a tabs progress listener, with the
   browser prepended, the way Firefox's addTabsProgressListener does. */
class BrowserProgressListener {
  constructor(browser, listener) {
    this.browser = browser;
    this.listener = listener;
    this.filter = new BrowserStatusFilter(this, PROGRESS_FLAGS);
    browser.addProgressListener(this.filter, PROGRESS_FLAGS);
  }

  destroy() {
    try {
      this.browser.removeProgressListener(this.filter);
      this.filter.removeProgressListener(this);
    } catch (e) { /* the browser is already gone */ }
  }

  onLocationChange(...args) {
    this.listener.onLocationChange?.(this.browser, ...args);
  }

  onStateChange(...args) {
    this.listener.onStateChange?.(this.browser, ...args);
  }

  onProgressChange() {}
  onStatusChange() {}
  onSecurityChange() {}
  onContentBlockingEvent() {}
}
BrowserProgressListener.prototype.QueryInterface = ChromeUtils.generateQI([
  "nsIWebProgressListener",
  "nsISupportsWeakReference",
]);

/* Every awake tab of one window, followed as tabs wake, sleep and close. */
class WindowProgress {
  constructor(window, listener) {
    this.window = window;
    this.listener = listener;
    this.wrappers = new Map();
    for (let tab of shellOf(window)?.tabs ?? []) {
      this.add(tab);
    }
    this.handleEvent = this.handleEvent.bind(this);
    for (let type of ["SeijakuTabBrowserInserted", "SeijakuTabBrowserDiscarded", "SeijakuTabClose"]) {
      window.addEventListener(type, this.handleEvent);
    }
  }

  add(tab) {
    if (tab.browser && !this.wrappers.has(tab)) {
      this.wrappers.set(tab, new BrowserProgressListener(tab.browser, this.listener));
    }
  }

  remove(tab) {
    this.wrappers.get(tab)?.destroy();
    this.wrappers.delete(tab);
  }

  handleEvent(event) {
    let { tab } = event.detail;
    if (event.type == "SeijakuTabBrowserInserted") {
      this.remove(tab);
      this.add(tab);
    } else {
      this.remove(tab);
    }
  }

  destroy() {
    for (let type of ["SeijakuTabBrowserInserted", "SeijakuTabBrowserDiscarded", "SeijakuTabClose"]) {
      this.window.removeEventListener(type, this.handleEvent);
    }
    for (let tab of [...this.wrappers.keys()]) {
      this.remove(tab);
    }
  }
}

class WindowTracker extends WindowTrackerBase {
  constructor() {
    super();
    this.progress = new DefaultWeakMap(() => new Map());
  }

  isBrowserWindow(window) {
    return window.document.documentElement.getAttribute("windowtype") === WINDOW_TYPE;
  }

  get topWindow() {
    return Services.wm.getMostRecentWindow(WINDOW_TYPE);
  }

  get topNonPBWindow() {
    return Services.wm.getMostRecentNonPBWindow(WINDOW_TYPE);
  }

  getTopNormalWindow(context) {
    return this.getTopWindow(context);
  }

  /** The front-most window tabs can open in: not an extension's popup
      window, and private or not as asked (null: either). */
  topTabWindow(isPrivate = null) {
    let fits = win =>
      win && !win.closed && shellOf(win) && !shellOf(win).isPopup &&
      (isPrivate === null || isPrivateWindow(win) == isPrivate);
    let top = this.topWindow;
    if (fits(top)) {
      return top;
    }
    let found = null;
    for (let win of Services.wm.getEnumerator(WINDOW_TYPE)) {
      if (fits(win)) {
        found = win;
      }
    }
    return found;
  }

  addProgressListener(window, listener) {
    let listeners = this.progress.get(window);
    if (!listeners.has(listener)) {
      listeners.set(listener, new WindowProgress(window, listener));
    }
  }

  removeProgressListener(window, listener) {
    let listeners = this.progress.get(window);
    listeners.get(listener)?.destroy();
    listeners.delete(listener);
  }
}

class TabTracker extends TabTrackerBase {
  constructor() {
    super();
    this._tabs = new WeakMap();
    this._tabIds = new Map();
    this._nextId = 1;
  }

  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    windowTracker.addListener("SeijakuTabOpen", this);
    windowTracker.addListener("SeijakuTabClose", this);
    windowTracker.addListener("SeijakuTabSelect", this);
    windowTracker.addOpenListener(window => this._handleWindowOpen(window));
    windowTracker.addCloseListener(window => this._handleWindowClose(window));

    /* eslint-disable mozilla/balanced-listeners */
    this.on("tab-removed", (event, { nativeTab, tabId }) => {
      this._tabs.delete(nativeTab);
      if (this._tabIds.get(tabId) === nativeTab) {
        this._tabIds.delete(tabId);
      }
    });
    /* eslint-enable mozilla/balanced-listeners */
  }

  getId(nativeTab) {
    let id = this._tabs.get(nativeTab);
    if (id) {
      return id;
    }
    this.init();
    id = this._nextId++;
    this._tabs.set(nativeTab, id);
    this._tabIds.set(id, nativeTab);
    return id;
  }

  getTab(tabId, default_ = undefined) {
    let nativeTab = this._tabIds.get(tabId);
    if (nativeTab) {
      return nativeTab;
    }
    if (default_ !== undefined) {
      return default_;
    }
    throw new ExtensionError(`Invalid tab ID: ${tabId}`);
  }

  getTabForBrowser(browser) {
    return browser?.tab ?? null;
  }

  handleEvent(event) {
    let { tab: nativeTab, previous } = event.detail;
    switch (event.type) {
      case "SeijakuTabOpen":
        // A tick later, as Firefox does: a new tab is usually selected
        // right after it opens, and onCreated should already say so.
        Promise.resolve().then(() => {
          if (nativeTab.el.parentNode) {
            this.emit("tab-created", { nativeTab });
          }
        });
        break;
      case "SeijakuTabClose":
        this.emitRemoved(nativeTab, false);
        break;
      case "SeijakuTabSelect":
        Promise.resolve().then(() => {
          if (nativeTab.el.parentNode) {
            this.emitActivated(nativeTab, previous);
          }
        });
        break;
    }
  }

  _handleWindowOpen(window) {
    let shell = shellOf(window);
    for (let nativeTab of shell?.tabs ?? []) {
      this.emit("tab-created", { nativeTab });
    }
    if (shell?.selected) {
      this.emitActivated(shell.selected);
    }
  }

  _handleWindowClose(window) {
    for (let nativeTab of shellOf(window)?.tabs ?? []) {
      this.emitRemoved(nativeTab, true);
    }
  }

  emitActivated(nativeTab, previousTab = undefined) {
    let window = windowOfTab(nativeTab);
    let previousTabId;
    if (previousTab && previousTab.el.parentNode) {
      previousTabId = this.getId(previousTab);
    }
    this.emit("tab-activated", {
      tabId: this.getId(nativeTab),
      previousTabId,
      previousTabIsPrivate: isPrivateWindow(window),
      windowId: windowTracker.getId(window),
      nativeTab,
    });
    this.emit("tabs-highlighted", {
      tabIds: [this.getId(nativeTab)],
      windowId: windowTracker.getId(window),
    });
  }

  emitRemoved(nativeTab, isWindowClosing) {
    this.emit("tab-removed", {
      nativeTab,
      tabId: this.getId(nativeTab),
      windowId: windowTracker.getId(windowOfTab(nativeTab)),
      isWindowClosing,
    });
  }

  getBrowserData(browser) {
    let window = browser.ownerDocument?.defaultView;
    if (!window) {
      return { tabId: -1, windowId: -1 };
    }
    let nativeTab = this.getTabForBrowser(browser);
    if (!nativeTab) {
      // Popups belong to a window but no tab; background pages to neither.
      window = window.browsingContext.topChromeWindow;
      if (!window || !windowTracker.isBrowserWindow(window)) {
        return { tabId: -1, windowId: -1 };
      }
    }
    return {
      tabId: nativeTab ? this.getId(nativeTab) : -1,
      windowId: windowTracker.getId(window),
    };
  }

  get activeTab() {
    return shellOf(windowTracker.topWindow)?.selected ?? null;
  }
}

windowTracker = new WindowTracker();
tabTracker = new TabTracker();

Object.assign(global, { tabTracker, windowTracker, shellOf });

class Tab extends TabBase {
  get browser() {
    return this.nativeTab.browser;
  }

  get frameLoader() {
    return this.browser?.frameLoader || { lazyWidth: 0, lazyHeight: 0 };
  }

  get browsingContext() {
    return this.browser?.browsingContext ?? null;
  }

  get innerWindowID() {
    return this.browser?.innerWindowID ?? null;
  }

  get _incognito() {
    return isPrivateWindow(this.window);
  }

  get _uri() {
    if (this.browser) {
      return this.browser.currentURI;
    }
    try {
      return Services.io.newURI(this.window.realURL(this.nativeTab.url));
    } catch (e) {
      return Services.io.newURI("about:blank");
    }
  }

  get _url() {
    return this._uri.spec;
  }

  get _title() {
    return this.browser?.contentTitle || this.nativeTab.title || this._url;
  }

  get _favIconUrl() {
    return this.nativeTab.icon || undefined;
  }

  get attention() {
    return false;
  }

  get audible() {
    return !!this.nativeTab._soundPlaying;
  }

  get autoDiscardable() {
    return !this.nativeTab.pinned;
  }

  get discarded() {
    return !this.browser;
  }

  get hidden() {
    return false;
  }

  get sharingState() {
    return { screen: undefined, microphone: false, camera: false };
  }

  get cookieStoreId() {
    return getCookieStoreIdForTab(this, this.nativeTab);
  }

  get openerTabId() {
    return null;
  }

  get width() {
    return this.frameLoader.lazyWidth || this.browser?.clientWidth || 0;
  }

  get height() {
    return this.frameLoader.lazyHeight || this.browser?.clientHeight || 0;
  }

  get index() {
    return shellOf(this.window).tabs.indexOf(this.nativeTab);
  }

  get mutedInfo() {
    let muted = false;
    try {
      muted = !!this.browser?.audioMuted;
    } catch (e) { /* not known */ }
    return muted ? { muted, reason: "user" } : { muted };
  }

  get lastAccessed() {
    return this.nativeTab.lastActive;
  }

  get pinned() {
    return !!this.nativeTab.pinned;
  }

  get active() {
    return shellOf(this.window).selected === this.nativeTab;
  }

  get highlighted() {
    return this.active;
  }

  get status() {
    return this.nativeTab.el.hasAttribute("busy") ? "loading" : "complete";
  }

  get window() {
    return windowOfTab(this.nativeTab);
  }

  get windowId() {
    return windowTracker.getId(this.window);
  }

  get isArticle() {
    return false;
  }

  get isInReaderMode() {
    return this.nativeTab.url.startsWith("seijaku:reader");
  }

  get successorTabId() {
    return -1;
  }

  get groupId() {
    return -1;
  }

  get splitViewId() {
    return -1;
  }
}

/* Per-tab and per-window values for browserAction (icon, badge, …). */
class TabContext extends EventEmitter {
  constructor(getDefaultPrototype) {
    super();
    this.getDefaultPrototype = getDefaultPrototype;
    this.tabData = new WeakMap();
    windowTracker.addListener("progress", this);
    windowTracker.addListener("SeijakuTabSelect", this);
  }

  get(keyObject) {
    if (!this.tabData.has(keyObject)) {
      this.tabData.set(keyObject, Object.create(this.getDefaultPrototype(keyObject)));
    }
    return this.tabData.get(keyObject);
  }

  clear(keyObject) {
    this.tabData.delete(keyObject);
  }

  handleEvent(event) {
    if (event.type == "SeijakuTabSelect") {
      let nativeTab = event.detail.tab;
      this.emit("tab-select", nativeTab);
      this.emit("location-change", nativeTab);
    }
  }

  onLocationChange(browser, webProgress, request, locationURI, flags) {
    if (!webProgress.isTopLevel || !browser.tab) {
      return;
    }
    let fromBrowse = !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT);
    this.emit("location-change", browser.tab, fromBrowse);
  }

  shutdown() {
    windowTracker.removeListener("progress", this);
    windowTracker.removeListener("SeijakuTabSelect", this);
  }
}

class Window extends WindowBase {
  get type() {
    return shellOf(this.window)?.isPopup ? "popup" : "normal";
  }

  get focused() {
    return this.window.document.hasFocus();
  }

  get top() {
    return this.window.screenY;
  }

  get left() {
    return this.window.screenX;
  }

  get width() {
    return this.window.outerWidth;
  }

  get height() {
    return this.window.outerHeight;
  }

  get incognito() {
    return isPrivateWindow(this.window);
  }

  get alwaysOnTop() {
    return false;
  }

  get isLastFocused() {
    return this.window === windowTracker.topWindow;
  }

  get state() {
    let w = this.window;
    if (w.fullScreen) {
      return "fullscreen";
    }
    switch (w.windowState) {
      case w.STATE_MAXIMIZED:
        return "maximized";
      case w.STATE_MINIMIZED:
        return "minimized";
    }
    return "normal";
  }

  async setState(state) {
    let w = this.window;
    if (state != "fullscreen" && w.fullScreen) {
      w.fullScreen = false;
    }
    switch (state) {
      case "maximized":
        w.maximize();
        break;
      case "minimized":
      case "docked":
        w.minimize();
        break;
      case "normal":
        w.restore();
        break;
      case "fullscreen":
        w.fullScreen = true;
        break;
    }
  }

  updateGeometry({ left, top, width, height }) {
    if (left !== null || top !== null) {
      this.window.moveTo(left ?? this.window.screenX, top ?? this.window.screenY);
    }
    if (width !== null || height !== null) {
      this.window.resizeTo(width ?? this.window.outerWidth, height ?? this.window.outerHeight);
    }
  }

  *getTabs() {
    let { tabManager } = this.extension;
    for (let nativeTab of shellOf(this.window)?.tabs ?? []) {
      let tab = tabManager.getWrapper(nativeTab);
      if (tab) {
        yield tab;
      }
    }
  }

  *getHighlightedTabs() {
    let tab = this.activeTab;
    if (tab) {
      yield tab;
    }
  }

  get activeTab() {
    let selected = shellOf(this.window)?.selected;
    return selected ? this.extension.tabManager.getWrapper(selected) : null;
  }

  getTabAtIndex(index) {
    let nativeTab = shellOf(this.window)?.tabs[index];
    return nativeTab ? this.extension.tabManager.getWrapper(nativeTab) : undefined;
  }
}

Object.assign(global, { Tab, TabContext, Window });

class TabManager extends TabManagerBase {
  get(tabId, default_ = undefined) {
    let nativeTab = tabTracker.getTab(tabId, default_);
    if (nativeTab) {
      if (!this.canAccessTab(nativeTab)) {
        throw new ExtensionError(`Invalid tab ID: ${tabId}`);
      }
      return this.getWrapper(nativeTab);
    }
    return default_;
  }

  addActiveTabPermission(nativeTab = tabTracker.activeTab) {
    return super.addActiveTabPermission(nativeTab);
  }

  revokeActiveTabPermission(nativeTab = tabTracker.activeTab) {
    return super.revokeActiveTabPermission(nativeTab);
  }

  canAccessTab(nativeTab) {
    return this.extension.canAccessWindow(windowOfTab(nativeTab));
  }

  wrapTab(nativeTab) {
    return new Tab(this.extension, nativeTab, tabTracker.getId(nativeTab));
  }
}

class WindowManager extends WindowManagerBase {
  get(windowId, context) {
    return this.getWrapper(windowTracker.getWindow(windowId, context));
  }

  *getAll(context) {
    for (let window of windowTracker.browserWindows()) {
      if (!this.canAccessWindow(window, context)) {
        continue;
      }
      let wrapped = this.getWrapper(window);
      if (wrapped) {
        yield wrapped;
      }
    }
  }

  wrapWindow(window) {
    return new Window(this.extension, window, windowTracker.getId(window));
  }
}

/* eslint-disable mozilla/balanced-listeners */
extensions.on("startup", (type, extension) => {
  defineLazyGetter(extension, "tabManager", () => new TabManager(extension));
  defineLazyGetter(extension, "windowManager", () => new WindowManager(extension));
});

// An extension's own tabs close with it (when it is disabled or removed).
extensions.on("page-shutdown", (type, context) => {
  if (context.viewType != "tab") {
    return;
  }
  let browser = context.xulBrowser;
  if (browser?.tab && context.extension.id === browser.contentPrincipal?.addonId) {
    shellOf(browser.ownerDocument?.defaultView)?.closeTab(browser.tab, { force: true });
  }
});

extensions.on("uninstalling", (msg, extension) => {
  if (extension.uninstallURL) {
    shellOf(windowTracker.topTabWindow(false))?.openTab(extension.uninstallURL, { afterCurrent: true });
  }
});
/* eslint-enable mozilla/balanced-listeners */

/* runtime.openOptionsPage: Seijaku has no add-ons manager to embed the
   page in, so options always open in a tab of their own. */
global.openOptionsPage = extension => {
  let shell = shellOf(windowTracker.topTabWindow(false) || windowTracker.topTabWindow());
  let page = extension.optionsPageProperties?.page;
  if (!shell || !page) {
    return Promise.reject({ message: "No options page" });
  }
  let existing = shell.tabs.find(t => t.browser?.currentURI?.spec == page);
  if (existing) {
    shell.selectTab(existing);
  } else {
    shell.openTab(page, { afterCurrent: true, triggeringPrincipal: extension.principal });
  }
  return Promise.resolve();
};

global.makeWidgetId = id => id.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
