/* browserAction / action: an extension's button in the strip, with its
   icon, badge and popup. The per-tab state (icon, title, badge, popup,
   enabled) is the engine's own BrowserActionBase; this file only draws
   it into #ext-buttons of every Seijaku window and opens the popup in
   #ext-popup-panel. Modelled on Firefox's ext-browserAction.js and
   ExtensionPopups.sys.mjs and GeckoView's ext-browserAction.js (Mozilla
   Public License 2.0). The popup's <browser> exists only while the popup
   is open, so a closed popup costs nothing. */

"use strict";

var { ExtensionError } = ExtensionUtils;
var { ExtensionParent } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionParent.sys.mjs"
);
var { BrowserActionBase } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionActions.sys.mjs"
);

const seijakuActions = new WeakMap();

/** CSS colour from a [r, g, b, a] badge colour. */
function seijakuBadgeColor(color) {
  if (!color) {
    return "";
  }
  let [r, g, b, a = 255] = color;
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

/* The one open popup of a window: a <browser> for the extension page,
   made when the popup opens and removed when it closes. */
class SeijakuPopup {
  constructor(action, window, anchor, url) {
    this.action = action;
    this.extension = action.extension;
    this.window = window;
    this.anchor = anchor;
    this.url = url;
    this.panel = window.document.getElementById("ext-popup-panel");
    this.closed = false;
  }

  open() {
    let { document } = this.window;
    let { extension, panel } = this;
    let browser = document.createXULElement("browser");
    this.browser = browser;
    for (let [name, value] of Object.entries({
      id: "ext-popup-browser",
      type: "content",
      disableglobalhistory: "true",
      messagemanagergroup: "webext-browsers",
      "webextension-view-type": "popup",
      constrainpopups: "false",
      // In the same group as the extension's other pages.
      initialBrowsingContextGroupId: String(extension.policy.browsingContextGroupId),
    })) {
      browser.setAttribute(name, value);
    }
    if (extension.remote) {
      browser.setAttribute("remote", "true");
      browser.setAttribute("remoteType", extension.remoteType);
      browser.setAttribute("maychangeremoteness", "true");
      panel.setAttribute("remote", "true");
    } else {
      panel.removeAttribute("remote");
    }

    let ready = extension.remote
      ? new Promise(resolve => browser.addEventListener("XULFrameLoaderCreated", resolve, { once: true }))
      : Promise.resolve();

    panel.replaceChildren(browser);
    if (!extension.remote) {
      // A non-remote browser makes its frame loader when touched.
      browser.contentWindow; // eslint-disable-line no-unused-expressions
    }

    this.onHidden = event => {
      if (event.target == panel) {
        this.destroy();
      }
    };
    panel.addEventListener("popuphidden", this.onHidden);
    browser.addEventListener("DOMWindowClose", () => this.close());

    let init = () => {
      let mm = browser.messageManager;
      mm.addMessageListener("Extension:BrowserResized", this);
      mm.addMessageListener("Extension:BrowserBackgroundChanged", this);
      ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
      mm.loadFrameScript("chrome://extensions/content/ext-browser-content.js", false, true);
      mm.sendAsyncMessage("Extension:InitBrowser", {
        allowScriptsToClose: true,
        maxWidth: 800,
        maxHeight: 600,
        stylesheets: [],
      });
    };
    browser.addEventListener("DidChangeBrowserRemoteness", init);

    ready.then(() => {
      if (this.closed) {
        return;
      }
      init();
      browser.fixupAndLoadURIString(this.url, { triggeringPrincipal: extension.principal });
    });

    try {
      panel.openPopup(this.anchor, "after_start");
    } catch (e) {
      this.destroy();
    }
  }

  receiveMessage({ name, data }) {
    if (this.closed) {
      return;
    }
    if (name == "Extension:BrowserResized") {
      let { width, height } = data;
      let style = this.browser.style;
      style.width = style.minWidth = `${Math.max(width, 30)}px`;
      style.height = style.minHeight = `${Math.max(height, 10)}px`;
    } else if (name == "Extension:BrowserBackgroundChanged") {
      // Extensions are built against a light panel; keep theirs or white.
      this.panel.style.setProperty("--panel-background-color", data.background || "#fff");
    }
  }

  close() {
    try {
      this.panel.hidePopup();
    } catch (e) {
      this.destroy();
    }
  }

  destroy() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.panel.removeEventListener("popuphidden", this.onHidden);
    this.panel.style.removeProperty("--panel-background-color");
    try {
      this.browser.messageManager?.removeMessageListener("Extension:BrowserResized", this);
      this.browser.messageManager?.removeMessageListener("Extension:BrowserBackgroundChanged", this);
    } catch (e) { /* already gone */ }
    this.browser.remove();
    if (SeijakuPopup.open.get(this.window) === this) {
      SeijakuPopup.open.delete(this.window);
    }
  }
}
SeijakuPopup.open = new WeakMap();

class SeijakuBrowserAction extends BrowserActionBase {
  constructor(extension, api) {
    let tabContext = new TabContext(target => {
      // A window's values fall back to the global ones; a tab's to its
      // window's.
      if (!target.el) {
        return this.getContextData(null);
      }
      return tabContext.get(target.el.ownerDocument.defaultView);
    });
    super(tabContext, extension);
    this.extensionApi = api;
    this.widgetId = `ext-btn-${makeWidgetId(extension.id)}`;
    this.onWindowOpen = window => this.addButton(window);
  }

  build() {
    for (let window of windowTracker.browserWindows()) {
      this.addButton(window);
    }
    windowTracker.addOpenListener(this.onWindowOpen);
  }

  addButton(window) {
    let container = window.document.getElementById("ext-buttons");
    if (!container || window.document.getElementById(this.widgetId)) {
      return;
    }
    if (!this.extension.canAccessWindow(window)) {
      return;
    }
    let button = window.document.createElement("button");
    button.id = this.widgetId;
    button.className = "ext-button";
    button.setAttribute("tabindex", "-1");
    let img = window.document.createElement("img");
    img.alt = "";
    let badge = window.document.createElement("span");
    badge.className = "ext-badge";
    button.append(img, badge);
    button.addEventListener("click", event => this.onButtonClick(window, button, event));
    container.append(button);
    this.updateWindow(window);
  }

  updateWindow(window) {
    let button = window.document.getElementById(this.widgetId);
    let selected = shellOf(window)?.selected;
    if (!button) {
      return;
    }
    let values = selected ? this.getContextData(selected) : this.getContextData(window);
    button.title = values.title || this.extension.name;
    button.disabled = !values.enabled;
    let img = button.firstChild;
    let { icon } = ExtensionParent.IconDetails.getPreferredIcon(
      values.icon || {},
      this.extension,
      16 * window.devicePixelRatio
    );
    if (icon && img.getAttribute("src") != icon) {
      img.setAttribute("src", icon);
    }
    let badge = button.lastChild;
    badge.textContent = values.badgeText || "";
    badge.hidden = !values.badgeText;
    badge.style.backgroundColor = seijakuBadgeColor(values.badgeBackgroundColor);
    badge.style.color = seijakuBadgeColor(this.getTextColor(values));
  }

  updateOnChange(target) {
    if (!target) {
      for (let window of windowTracker.browserWindows()) {
        this.updateWindow(window);
      }
    } else if (target.el) {
      let window = target.el.ownerDocument.defaultView;
      if (shellOf(window)?.selected === target) {
        this.updateWindow(window);
      }
    } else {
      this.updateWindow(target);
    }
  }

  onButtonClick(window, button, event) {
    let tab = shellOf(window)?.selected;
    if (!tab) {
      return;
    }
    // A click while any popup is open just closes it, as a click
    // anywhere outside a panel does.
    let current = SeijakuPopup.open.get(window);
    if (current) {
      current.close();
      return;
    }
    let popupURL = this.triggerClickOrPopup(tab, {
      button: event.button,
      modifiers: clickModifiersFromEvent(event),
    });
    if (popupURL) {
      this.openPopupIn(window, button, popupURL);
    }
  }

  openPopupIn(window, button, url) {
    let popup = new SeijakuPopup(this, window, button, url);
    SeijakuPopup.open.set(window, popup);
    popup.open();
  }

  /** action.openPopup(): the popup of the window's own button. */
  openPopup(window) {
    let tab = shellOf(window)?.selected;
    let button = window.document.getElementById(this.widgetId);
    let url = tab && this.getPopupUrl(tab, true);
    if (button && url) {
      this.throwIfOpenPopupIsBlockedByAnyAction(window);
      this.extension.tabManager.addActiveTabPermission(tab);
      this.openPopupIn(window, button, url);
    }
  }

  getTab(tabId) {
    let tab = tabTracker.getTab(tabId);
    if (!this.extension.tabManager.canAccessTab(tab)) {
      throw new ExtensionError(`Invalid tab ID: ${tabId}`);
    }
    return tab;
  }

  getWindow(windowId) {
    return windowTracker.getWindow(windowId);
  }

  dispatchClick(tab, clickInfo) {
    this.extensionApi.emit("click", tab, clickInfo);
  }

  isPanelShownBlockingOpenPopup(window) {
    return !!SeijakuPopup.open.get(window);
  }

  onShutdown() {
    windowTracker.removeOpenListener(this.onWindowOpen);
    for (let window of windowTracker.browserWindows()) {
      let popup = SeijakuPopup.open.get(window);
      if (popup?.action === this) {
        popup.close();
      }
      window.document.getElementById(this.widgetId)?.remove();
    }
    super.onShutdown();
  }
}

global.clickModifiersFromEvent ??= event => {
  const map = { shiftKey: "Shift", altKey: "Alt", metaKey: "Command", ctrlKey: "Ctrl" };
  return Object.keys(map).filter(key => event[key]).map(key => map[key]);
};

this.browserAction = class extends ExtensionAPIPersistent {
  static for(extension) {
    return seijakuActions.get(extension);
  }

  async onManifestEntry() {
    let { extension } = this;
    this.action = new SeijakuBrowserAction(extension, this);
    await this.action.loadIconData();
    seijakuActions.set(extension, this.action);
    this.action.build();
  }

  onShutdown() {
    this.action?.onShutdown();
    seijakuActions.delete(this.extension);
  }

  PERSISTENT_EVENTS = {
    onClicked({ context, fire }) {
      let { tabManager } = this.extension;
      async function listener(_event, tab, clickInfo) {
        if (fire.wakeup) {
          await fire.wakeup();
        }
        let call = () => fire.sync(tabManager.convert(tab), clickInfo);
        if (context && tab.browser) {
          context.withPendingBrowser(tab.browser, call);
        } else {
          call();
        }
      }
      this.on("click", listener);
      return {
        unregister: () => this.off("click", listener),
        convert(newFire, extContext) {
          fire = newFire;
          context = extContext;
        },
      };
    },
    onUserSettingsChanged() {
      // Every button sits in the strip; nothing to report.
      return { unregister() {}, convert() {} };
    },
  };

  getAPI(context) {
    let { extension } = context;
    let { action } = this;
    let namespace = extension.manifestVersion < 3 ? "browserAction" : "action";

    return {
      [namespace]: {
        ...action.api(context),

        onClicked: new EventManager({
          context,
          module: "browserAction",
          event: "onClicked",
          inputHandling: true,
          extensionApi: this,
        }).api(),

        onUserSettingsChanged: new EventManager({
          context,
          module: "browserAction",
          event: "onUserSettingsChanged",
          extensionApi: this,
        }).api(),

        getUserSettings: () => ({ isOnToolbar: true }),

        openPopup: options => {
          let window =
            typeof options?.windowId === "number"
              ? windowTracker.getWindow(options.windowId, context)
              : windowTracker.getTopWindow(context);
          if (!window || window !== windowTracker.topWindow) {
            throw new ExtensionError(BrowserActionBase.ERROR_WIN_NOT_FOCUSED);
          }
          action.openPopup(window);
        },
      },
    };
  }
};

global.browserActionFor = this.browserAction.for;
