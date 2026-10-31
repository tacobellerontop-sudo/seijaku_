/* The tabs API on Seijaku's tabs. Follows Firefox's
   browser/components/extensions/parent/ext-tabs.js (Mozilla Public
   License 2.0) for behaviour and event shapes, rebuilt on the shell's
   own tab calls (openTab, closeTab, selectTab, moveTab, sleep). Tab
   groups, hiding, successors, reader mode and capture are not part of
   Seijaku, so they are left out of the schema rather than faked. */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

var { ExtensionError } = ExtensionUtils;

const ALL_PROPERTIES = new Set([
  "attention",
  "audible",
  "autoDiscardable",
  "discarded",
  "favIconUrl",
  "hidden",
  "isArticle",
  "mutedInfo",
  "pinned",
  "sharingState",
  "status",
  "title",
  "url",
]);
const RESTRICTED = new Set(["url", "favIconUrl", "title"]);

// What the window's SeijakuTabAttrModified "changed" names mean here.
const ATTR_PROPERTIES = {
  label: "title",
  image: "favIconUrl",
  muted: "mutedInfo",
  soundplaying: "audible",
  pinned: "pinned",
};

this.tabs = class extends ExtensionAPIPersistent {
  tabEventRegistrar({ event, listener }) {
    let { extension } = this;
    let { tabManager } = extension;
    return ({ fire }) => {
      let listener2 = (eventName, eventData, ...args) => {
        if (!tabManager.canAccessTab(eventData.nativeTab)) {
          return;
        }
        listener(fire, eventData, ...args);
      };
      tabTracker.on(event, listener2);
      return {
        unregister() {
          tabTracker.off(event, listener2);
        },
        convert(_fire) {
          fire = _fire;
        },
      };
    };
  }

  PERSISTENT_EVENTS = {
    onActivated: this.tabEventRegistrar({
      event: "tab-activated",
      listener: (fire, event) => {
        let { tabId, windowId, previousTabId, previousTabIsPrivate } = event;
        if (previousTabIsPrivate && !this.extension.privateBrowsingAllowed) {
          previousTabId = undefined;
        }
        fire.async({ tabId, previousTabId, windowId });
      },
    }),
    onCreated: this.tabEventRegistrar({
      event: "tab-created",
      listener: (fire, event) => {
        fire.async(this.extension.tabManager.convert(event.nativeTab));
      },
    }),
    onRemoved: this.tabEventRegistrar({
      event: "tab-removed",
      listener: (fire, event) => {
        fire.async(event.tabId, {
          windowId: event.windowId,
          isWindowClosing: event.isWindowClosing,
        });
      },
    }),
    // Seijaku has one strip per window and no tab tear-off, so tabs
    // never change windows; these exist so listeners can be added.
    onAttached({ fire }) {
      return { unregister() {}, convert(_fire) { fire = _fire; } };
    },
    onDetached({ fire }) {
      return { unregister() {}, convert(_fire) { fire = _fire; } };
    },
    onMoved({ fire }) {
      let { tabManager } = this.extension;
      let listener = event => {
        let { tab: nativeTab, fromIndex, toIndex } = event.detail;
        if (fromIndex !== toIndex && tabManager.canAccessTab(nativeTab)) {
          fire.async(tabTracker.getId(nativeTab), {
            windowId: windowTracker.getId(nativeTab.el.ownerDocument.defaultView),
            fromIndex,
            toIndex,
          });
        }
      };
      windowTracker.addListener("SeijakuTabMove", listener);
      return {
        unregister() {
          windowTracker.removeListener("SeijakuTabMove", listener);
        },
        convert(_fire) {
          fire = _fire;
        },
      };
    },
    onHighlighted({ fire, context }) {
      let listener = (eventName, event) => {
        let window = windowTracker.getWindow(event.windowId, context, false);
        if (window && this.extension.canAccessWindow(window)) {
          fire.async({ tabIds: event.tabIds, windowId: event.windowId });
        }
      };
      tabTracker.on("tabs-highlighted", listener);
      return {
        unregister() {
          tabTracker.off("tabs-highlighted", listener);
        },
        convert(_fire, _context) {
          fire = _fire;
          context = _context;
        },
      };
    },
    onUpdated({ fire, context }, params) {
      let { extension } = this;
      let { tabManager } = extension;
      let [filterProps] = params;
      let filter = { ...filterProps };
      if (filter.urls) {
        filter.urls = new MatchPatternSet(filter.urls, { restrictSchemes: false });
      }
      filter.properties = filter.properties ? new Set(filter.properties) : ALL_PROPERTIES;

      function matchFilters(tab) {
        if (!filterProps) {
          return true;
        }
        if (filter.tabId != null && tab.id != filter.tabId) {
          return false;
        }
        if (filter.windowId != null) {
          let windowId = filter.windowId;
          if (windowId === Window.WINDOW_ID_CURRENT) {
            let window = windowTracker.getTopWindow(context);
            windowId = window ? windowTracker.getId(window) : undefined;
          }
          if (tab.windowId != windowId) {
            return false;
          }
        }
        if (filter.cookieStoreId != null && filter.cookieStoreId !== tab.cookieStoreId) {
          return false;
        }
        if (filter.urls) {
          return filter.urls.matches(tab._uri) && tab.hasTabPermission;
        }
        return true;
      }

      let fireForTab = (tab, changed) => {
        if (!tab || !matchFilters(tab)) {
          return;
        }
        let changeInfo = {};
        let nonempty = false;
        for (let prop in changed) {
          if (!RESTRICTED.has(prop) || tab.hasTabPermission) {
            nonempty = true;
            changeInfo[prop] = changed[prop];
          }
        }
        if (nonempty) {
          fire.async(tab.id, changeInfo, tab.convert());
        }
      };

      let attrListener = event => {
        let nativeTab = event.detail.tab;
        if (!tabManager.canAccessTab(nativeTab)) {
          return;
        }
        let needed = [];
        if (event.type == "SeijakuTabAttrModified") {
          for (let name of event.detail.changed) {
            let prop = ATTR_PROPERTIES[name];
            if (prop && filter.properties.has(prop)) {
              needed.push(prop);
            }
          }
        } else if (filter.properties.has("discarded")) {
          // SeijakuTabBrowserInserted / SeijakuTabBrowserDiscarded.
          if (event.detail.onCreation) {
            return;
          }
          needed.push("discarded");
        }
        if (!needed.length) {
          return;
        }
        let tab = tabManager.getWrapper(nativeTab);
        let changeInfo = {};
        for (let prop of needed) {
          changeInfo[prop] = tab[prop];
        }
        fireForTab(tab, changeInfo);
      };

      let statusListener = ({ browser, status, url }) => {
        let nativeTab = browser.tab;
        if (!nativeTab || !tabManager.canAccessTab(nativeTab)) {
          return;
        }
        let changed = {};
        if (filter.properties.has("status")) {
          changed.status = status;
        }
        if (url && filter.properties.has("url")) {
          changed.url = url;
        }
        fireForTab(tabManager.wrapTab(nativeTab), changed);
      };

      let listeners = new Map([
        ["SeijakuTabAttrModified", attrListener],
        ["SeijakuTabBrowserInserted", attrListener],
        ["SeijakuTabBrowserDiscarded", attrListener],
      ]);
      if (filter.properties.has("status") || filter.properties.has("url")) {
        listeners.set("status", statusListener);
      }
      for (let [name, listener] of listeners) {
        windowTracker.addListener(name, listener);
      }
      return {
        unregister() {
          for (let [name, listener] of listeners) {
            windowTracker.removeListener(name, listener);
          }
        },
        convert(_fire, _context) {
          fire = _fire;
          context = _context;
        },
      };
    },
  };

  getAPI(context) {
    let { extension } = context;
    let { tabManager } = extension;
    let extensionApi = this;
    let module = "tabs";

    function getTabOrActive(tabId) {
      let tab = tabId !== null ? tabTracker.getTab(tabId) : tabTracker.activeTab;
      if (!tab || !tabManager.canAccessTab(tab)) {
        throw new ExtensionError(tabId === null ? "Cannot access activeTab" : `Invalid tab ID: ${tabId}`);
      }
      return tab;
    }

    function getNativeTabsFromIDArray(tabIds) {
      return [].concat(tabIds).map(tabId => getTabOrActive(tabId));
    }

    async function promiseTabWhenReady(tabId) {
      let tab = tabId !== null ? tabManager.get(tabId) : tabManager.getWrapper(tabTracker.activeTab);
      if (!tab) {
        throw new ExtensionError(tabId == null ? "Cannot access activeTab" : `Invalid tab ID: ${tabId}`);
      }
      if (!tab.browser) {
        throw new ExtensionError("The tab is asleep");
      }
      await tabTracker.awaitTabReady(tab.nativeTab);
      return tab;
    }

    // Some addresses an extension may open but not otherwise load
    // (its own pages, about:) get a content principal of their own.
    function triggeringPrincipalFor(url, window) {
      if (context.checkLoadURL(url, { dontReportErrors: true })) {
        return context.principal;
      }
      if (ExtensionUtils.isExtensionUrl(url) || url.startsWith("about:")) {
        return Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(url), {
          privateBrowsingId: PrivateBrowsingUtils.isWindowPrivate(window) ? 1 : 0,
        });
      }
      throw new ExtensionError(`Illegal URL: ${url}`);
    }

    function zoomOf(browser) {
      return browser?.browsingContext?.fullZoom ?? 1;
    }

    let eventApi = event =>
      new EventManager({ context, module, event, extensionApi }).api();

    return {
      tabs: {
        onActivated: eventApi("onActivated"),
        onCreated: eventApi("onCreated"),
        onHighlighted: eventApi("onHighlighted"),
        onAttached: eventApi("onAttached"),
        onDetached: eventApi("onDetached"),
        onRemoved: eventApi("onRemoved"),
        onMoved: eventApi("onMoved"),
        onUpdated: eventApi("onUpdated"),
        onReplaced: new EventManager({
          context,
          name: "tabs.onReplaced",
          register: () => () => {},
        }).api(),

        async get(tabId) {
          return tabManager.get(tabId).convert();
        },

        async getCurrent() {
          if (context.tabId) {
            return tabManager.get(context.tabId).convert();
          }
          return undefined;
        },

        async query(queryInfo) {
          return Array.from(tabManager.query(queryInfo, context), tab => tab.convert());
        },

        async create(createProperties) {
          let window =
            createProperties.windowId !== null
              ? windowTracker.getWindow(createProperties.windowId, context)
              : windowTracker.getTopWindow(context);
          let shell = shellOf(window);
          if (!shell || !context.canAccessWindow(window)) {
            throw new ExtensionError("Not allowed to create tabs on the target window");
          }
          let url = createProperties.url !== null
            ? context.uri.resolve(createProperties.url)
            : shell.homepage();
          let options = {};
          if (createProperties.url !== null) {
            options.triggeringPrincipal = triggeringPrincipalFor(url, window);
          }
          if (createProperties.index !== null) {
            options.index = Math.max(0, Math.min(createProperties.index, shell.tabs.length));
          } else {
            options.afterCurrent = true;
          }
          if (createProperties.pinned) {
            options.pinned = true;
          }
          let active = createProperties.active ?? !createProperties.discarded;
          if (createProperties.discarded) {
            if (active || createProperties.pinned) {
              throw new ExtensionError("Active or pinned tabs cannot be created discarded");
            }
            options.asleep = true;
            options.title = createProperties.title || "";
          } else if (createProperties.title) {
            throw new ExtensionError("Title may only be set for discarded tabs.");
          }
          options.background = !active;
          let nativeTab = shell.openTab(url, options);
          if (createProperties.pinned) {
            shell.orderTabs();
          }
          if (nativeTab.browser) {
            tabTracker.addTabReadyBlocker(nativeTab);
            if (createProperties.muted) {
              nativeTab.browser.audioMuted = true;
              shell.updateSpeaker(nativeTab);
            }
          }
          return tabManager.convert(nativeTab);
        },

        async duplicate(tabId, duplicateProperties) {
          let nativeTab = getTabOrActive(tabId);
          let shell = shellOf(nativeTab.el.ownerDocument.defaultView);
          let index = duplicateProperties?.index ?? shell.tabs.indexOf(nativeTab) + 1;
          let active = duplicateProperties?.active ?? true;
          let copy = shell.openTab(nativeTab.url, {
            index: Math.max(0, Math.min(index, shell.tabs.length)),
            background: !active,
          });
          return tabManager.convert(copy);
        },

        async remove(tabIds) {
          for (let nativeTab of getNativeTabsFromIDArray(tabIds)) {
            shellOf(nativeTab.el.ownerDocument.defaultView)?.closeTab(nativeTab, { force: true });
          }
        },

        async discard(tabIds) {
          for (let nativeTab of getNativeTabsFromIDArray(tabIds)) {
            shellOf(nativeTab.el.ownerDocument.defaultView)?.sleep(nativeTab);
          }
        },

        async update(tabId, updateProperties) {
          let nativeTab = getTabOrActive(tabId);
          let window = nativeTab.el.ownerDocument.defaultView;
          let shell = shellOf(window);
          if (updateProperties.url !== null) {
            let url = context.uri.resolve(updateProperties.url);
            let triggeringPrincipal = triggeringPrincipalFor(url, window);
            if (nativeTab.asleep) {
              nativeTab.url = url;
              shell.wake(nativeTab, { triggeringPrincipal });
            } else {
              shell.load(nativeTab.browser, url, { triggeringPrincipal });
            }
          }
          if (updateProperties.active || updateProperties.highlighted) {
            shell.selectTab(nativeTab);
          }
          if (updateProperties.muted !== null && nativeTab.browser) {
            if (!!nativeTab.browser.audioMuted != updateProperties.muted) {
              shell.toggleMute(nativeTab);
            }
          }
          if (updateProperties.pinned !== null && updateProperties.pinned != nativeTab.pinned) {
            shell.togglePin(nativeTab, { quiet: true });
          }
          return tabManager.convert(nativeTab);
        },

        async reload(tabId, reloadProperties) {
          let nativeTab = getTabOrActive(tabId);
          if (nativeTab.asleep) {
            shellOf(nativeTab.el.ownerDocument.defaultView).wake(nativeTab);
            return;
          }
          let flags = Ci.nsIWebNavigation.LOAD_FLAGS_NONE;
          if (reloadProperties?.bypassCache) {
            flags |= Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE;
          }
          nativeTab.browser.reloadWithFlags(flags);
        },

        async highlight(highlightInfo) {
          let { windowId, tabs } = highlightInfo;
          let window = windowTracker.getWindow(windowId, context);
          let first = [].concat(tabs)[0];
          let nativeTab = shellOf(window)?.tabs[first];
          if (!nativeTab) {
            throw new ExtensionError(`No tab at index: ${first}`);
          }
          shellOf(window).selectTab(nativeTab);
          return extension.windowManager.convert(window, { populate: true });
        },

        async move(tabIds, moveProperties) {
          let moved = [];
          let index = moveProperties.index;
          for (let nativeTab of getNativeTabsFromIDArray(tabIds)) {
            let window = nativeTab.el.ownerDocument.defaultView;
            if (moveProperties.windowId !== null && windowTracker.getId(window) != moveProperties.windowId) {
              throw new ExtensionError("Seijaku can't move tabs between windows");
            }
            let shell = shellOf(window);
            let to = index == -1 ? shell.tabs.length - 1 : Math.min(index, shell.tabs.length - 1);
            shell.moveTab(nativeTab, to);
            moved.push(nativeTab);
            if (index != -1) {
              index++;
            }
          }
          return moved.map(nativeTab => tabManager.convert(nativeTab));
        },

        async executeScript(tabId, details) {
          let tab = await promiseTabWhenReady(tabId);
          return tab.executeScript(context, details);
        },

        async insertCSS(tabId, details) {
          let tab = await promiseTabWhenReady(tabId);
          return tab.insertCSS(context, details);
        },

        async removeCSS(tabId, details) {
          let tab = await promiseTabWhenReady(tabId);
          return tab.removeCSS(context, details);
        },

        async getZoom(tabId) {
          return zoomOf(getTabOrActive(tabId).browser);
        },

        async setZoom(tabId, zoomFactor) {
          let nativeTab = getTabOrActive(tabId);
          let bc = nativeTab.browser?.browsingContext;
          if (!bc) {
            throw new ExtensionError("The tab is asleep");
          }
          bc.fullZoom = zoomFactor > 0 ? Math.max(0.3, Math.min(zoomFactor, 5)) : 1;
        },

        async goBack(tabId) {
          getTabOrActive(tabId).browser?.goBack();
        },

        async goForward(tabId) {
          getTabOrActive(tabId).browser?.goForward();
        },
      },
    };
  }
};
