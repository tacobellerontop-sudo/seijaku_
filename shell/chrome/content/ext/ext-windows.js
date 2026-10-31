/* The windows API on Seijaku's windows. Follows Firefox's
   browser/components/extensions/parent/ext-windows.js (Mozilla Public
   License 2.0). Seijaku keeps one normal window (plus private ones), so
   windows.create opens its tabs in the window that is already there
   (or a private window when asked for incognito) instead of starting a
   second main window. */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

var { ExtensionError } = ExtensionUtils;

this.windows = class extends ExtensionAPIPersistent {
  windowEventRegistrar(event, listener) {
    let { extension } = this;
    return ({ fire }) => {
      let listener2 = (window, ...args) => {
        if (extension.canAccessWindow(window)) {
          listener(fire, window, ...args);
        }
      };
      windowTracker.addListener(event, listener2);
      return {
        unregister() {
          windowTracker.removeListener(event, listener2);
        },
        convert(_fire) {
          fire = _fire;
        },
      };
    };
  }

  PERSISTENT_EVENTS = {
    onCreated: this.windowEventRegistrar("domwindowopened", (fire, window) => {
      fire.async(this.extension.windowManager.convert(window));
    }),
    onRemoved: this.windowEventRegistrar("domwindowclosed", (fire, window) => {
      fire.async(windowTracker.getId(window));
    }),
    onFocusChanged({ fire }) {
      let { extension } = this;
      let last;
      let listener = () => {
        Promise.resolve().then(() => {
          let windowId = Window.WINDOW_ID_NONE;
          let window = Services.focus.activeWindow;
          if (window && extension.canAccessWindow(window) && windowTracker.isBrowserWindow(window)) {
            windowId = windowTracker.getId(window);
          }
          if (windowId !== last) {
            fire.async(windowId);
            last = windowId;
          }
        });
      };
      windowTracker.addListener("focus", listener);
      windowTracker.addListener("blur", listener);
      return {
        unregister() {
          windowTracker.removeListener("focus", listener);
          windowTracker.removeListener("blur", listener);
        },
        convert(_fire) {
          fire = _fire;
        },
      };
    },
  };

  getAPI(context) {
    let { extension } = context;
    let { windowManager } = extension;
    let extensionApi = this;

    let eventApi = event =>
      new EventManager({ context, module: "windows", event, extensionApi }).api();

    function accessible(window) {
      if (!window || !context.canAccessWindow(window)) {
        throw new ExtensionError("Invalid window");
      }
      return window;
    }

    return {
      windows: {
        onCreated: eventApi("onCreated"),
        onRemoved: eventApi("onRemoved"),
        onFocusChanged: eventApi("onFocusChanged"),

        async get(windowId, getInfo) {
          let window = accessible(windowTracker.getWindow(windowId, context));
          return windowManager.convert(window, getInfo);
        },

        async getCurrent(getInfo) {
          let window = accessible(context.currentWindow || windowTracker.getTopWindow(context));
          return windowManager.convert(window, getInfo);
        },

        async getLastFocused(getInfo) {
          let window = accessible(windowTracker.getTopWindow(context));
          return windowManager.convert(window, getInfo);
        },

        async getAll(getInfo) {
          let types = getInfo?.windowTypes;
          return Array.from(windowManager.getAll(context))
            .filter(win => !types || types.includes(win.type))
            .map(win => win.convert(getInfo));
        },

        async create(createData) {
          if (createData.incognito && !context.privateBrowsingAllowed) {
            throw new ExtensionError("Extension does not have permission for incognito mode");
          }
          let urls = createData.url === null ? [] : [].concat(createData.url);
          urls = urls.map(url => context.uri.resolve(url));
          for (let url of urls) {
            if (!ExtensionUtils.isExtensionUrl(url) && !context.checkLoadURL(url, { dontReportErrors: true })) {
              throw new ExtensionError(`Illegal URL: ${url}`);
            }
          }
          let incognito = !!createData.incognito;
          let window = incognito
            ? [...windowTracker.browserWindows()].find(w => PrivateBrowsingUtils.isWindowPrivate(w))
            : windowTracker.topNonPBWindow;
          let shell = shellOf(window);
          if (!shell) {
            // No window of that kind yet: a private one is opened with
            // the first address; anything else rides the top window.
            let top = shellOf(windowTracker.topWindow);
            if (!top) {
              throw new ExtensionError("No Seijaku window is open");
            }
            if (incognito) {
              top.openPrivateWindow(urls.shift());
              throw new ExtensionError("The private window is opening; its id isn't known yet");
            }
            shell = top;
            window = windowTracker.topWindow;
          }
          let principalFor = url =>
            context.checkLoadURL(url, { dontReportErrors: true })
              ? context.principal
              : Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(url), {
                  privateBrowsingId: incognito ? 1 : 0,
                });
          if (createData.tabId !== null) {
            let nativeTab = tabTracker.getTab(createData.tabId);
            shellOf(nativeTab.el.ownerDocument.defaultView)?.selectTab(nativeTab);
          }
          for (let url of urls) {
            shell.openTab(url, { afterCurrent: true, triggeringPrincipal: principalFor(url) });
          }
          if (createData.focused !== false) {
            window.focus();
          }
          return windowManager.convert(window, { populate: true });
        },

        async update(windowId, updateInfo) {
          let window = accessible(windowTracker.getWindow(windowId, context));
          let win = windowManager.getWrapper(window);
          if (updateInfo.state !== null) {
            await win.setState(updateInfo.state);
          }
          if (updateInfo.focused) {
            window.focus();
          } else if (updateInfo.focused === false) {
            window.minimize();
          }
          if (updateInfo.drawAttention) {
            window.getAttention();
          }
          win.updateGeometry(updateInfo);
          return win.convert();
        },

        async remove(windowId) {
          let window = accessible(windowTracker.getWindow(windowId, context));
          window.close();
        },
      },
    };
  }
};
