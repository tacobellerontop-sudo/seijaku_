/* The windows API on Seijaku's windows. Follows Firefox's
   browser/components/extensions/parent/ext-windows.js (Mozilla Public
   License 2.0). Seijaku keeps one normal window (plus private ones), so
   windows.create opens its tabs in the window that is already there
   (or a private window when asked for incognito) instead of starting a
   second main window. A popup window (type "popup", like Bitwarden's
   passkey prompt) is a window of its own: one page, no strip, no frame,
   and closing it closes only it. */

"use strict";

var { ExtensionError } = ExtensionUtils;

/** A popup window for windows.create: a Seijaku window in popup mode
    (see isPopup in seijaku.js), sized and placed as asked, or centred
    on the front window. Resolves once its page has started loading. */
async function openPopupWindow(createData, urls, incognito, principalFor) {
  let opener = windowTracker.topTabWindow(incognito) || windowTracker.topWindow;
  if (!opener) {
    throw new ExtensionError("No Seijaku window is open");
  }
  let width = createData.width ?? 400;
  let height = createData.height ?? 520;
  let left = createData.left ?? Math.round(opener.screenX + (opener.outerWidth - width) / 2);
  let top = createData.top ?? Math.round(opener.screenY + (opener.outerHeight - height) / 2);
  let features = [
    "chrome",
    "dialog=no",
    "resizable",
    incognito ? "private" : "non-private",
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
  ];
  let arg = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  arg.data = JSON.stringify({ popup: true, private: incognito });
  let window = Services.ww.openWindow(null, opener.location.href, "_blank", features.join(","), arg);
  // Seijaku.init runs on the window's load; wait for it to finish.
  await new Promise((resolve, reject) => {
    let start = Date.now();
    let poll = () => {
      if (window.closed) {
        reject(new ExtensionError("The popup window was closed"));
      } else if (shellOf(window)?._initDone) {
        resolve();
      } else if (Date.now() - start > 20000) {
        reject(new ExtensionError("The popup window didn't open"));
      } else {
        window.setTimeout(poll, 20);
      }
    };
    poll();
  });
  // A popup window holds one page: the first address.
  let url = urls[0];
  shellOf(window).openTab(url ?? "about:blank", url ? { triggeringPrincipal: principalFor(url) } : {});
  if (createData.focused !== false) {
    window.focus();
  }
  return windowManager.convert(window, { populate: true });
}

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
          let principalFor = url =>
            context.checkLoadURL(url, { dontReportErrors: true })
              ? context.principal
              : Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(url), {
                  privateBrowsingId: incognito ? 1 : 0,
                });
          if (createData.type && createData.type != "normal") {
            return openPopupWindow(createData, urls, incognito, principalFor);
          }
          let window = windowTracker.topTabWindow(incognito);
          let shell = shellOf(window);
          if (!shell) {
            // No window of that kind yet: a private one is opened with
            // the first address; anything else rides the top window.
            let top = shellOf(windowTracker.topTabWindow());
            if (!top) {
              throw new ExtensionError("No Seijaku window is open");
            }
            if (incognito) {
              top.openPrivateWindow(urls.shift());
              throw new ExtensionError("The private window is opening; its id isn't known yet");
            }
            shell = top;
            window = windowTracker.topTabWindow();
          }
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
