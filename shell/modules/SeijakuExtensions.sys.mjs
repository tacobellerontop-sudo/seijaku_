/* Seijaku's side of the engine's extension system, for the whole app
   (one copy, however many windows are open):

   - registers Seijaku's tabs, windows and browserAction APIs with the
     engine (chrome.manifest does this too; doing it here as well costs
     nothing and covers an engine that skips manifest categories);
   - tells the engine when the browser has started, which is what lets
     extension background pages run at all (Firefox's front end sends
     these notifications; without them uBlock Origin and the rest sit
     loaded but never start);
   - answers the engine's install and permission prompts. Firefox shows
     those from its front end, which Seijaku drops, so without this an
     install from addons.mozilla.org waits forever for an answer.
     The prompt itself is drawn by the window (Seijaku.showExtensionPrompt
     in seijaku.js); this module only routes each question to the window
     the install came from, or the front window. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ExtensionData: "resource://gre/modules/Extension.sys.mjs",
});

const WINDOW_TYPE = "seijaku:main";

const CATEGORIES = [
  ["webextension-modules", "seijaku", "chrome://seijaku/content/ext/ext-seijaku.json"],
  ["webextension-scripts", "c-seijaku", "chrome://seijaku/content/ext/ext-seijaku.js"],
  ["webextension-scripts-addon", "seijaku", "chrome://seijaku/content/ext/ext-c-seijaku.js"],
];

const PROMPT_TOPICS = [
  "webextension-permission-prompt",
  "webextension-update-permission-prompt",
  "webextension-optional-permission-prompt",
  "addon-install-blocked",
  "addon-install-failed",
  "addon-install-origin-blocked",
  "addon-install-disabled",
  "addon-install-policy-blocked",
  "addon-install-webapi-blocked",
  "addon-install-fullscreen-blocked",
  "webextension-install-notify",
];

let registered = false;
let startupSent = false;

function windowFor(browser) {
  let win = null;
  try {
    win = browser?.ownerDocument?.defaultView?.browsingContext?.topChromeWindow ?? null;
  } catch (e) { /* the browser is gone */ }
  if (win?.Seijaku && !win.closed) {
    return win;
  }
  return Services.wm.getMostRecentWindow(WINDOW_TYPE);
}

/** Readable lines for a set of permissions, from the engine's own
    wording when it loads, else the raw permission names. */
function permissionLines(addon, permissions) {
  try {
    let strings = lazy.ExtensionData.formatPermissionStrings({ addon, permissions }, {});
    if (strings?.msgs) {
      return strings.msgs;
    }
  } catch (e) { /* fall through to the raw names */ }
  let lines = [];
  let origins = permissions?.origins ?? [];
  if (origins.some(o => o == "<all_urls>" || o == "*://*/*")) {
    lines.push("Access your data for all websites");
  } else {
    lines.push(...origins.map(o => `Access your data for ${o}`));
  }
  lines.push(...(permissions?.permissions ?? []));
  return lines;
}

function addonName(info) {
  return info?.addon?.name || info?.name || "This extension";
}

const PromptObserver = {
  observe(subject, topic) {
    let data = subject?.wrappedJSObject ?? {};
    let browser = data.browser || data.target || null;
    let win = windowFor(browser);
    let shell = win?.Seijaku;
    if (!shell) {
      // No window to ask in: say no, rather than leave the engine waiting.
      data.info?.reject?.();
      data.reject?.();
      data.resolve?.(false);
      data.cancel?.();
      return;
    }
    switch (topic) {
      case "webextension-permission-prompt": {
        let { info } = data;
        let lines = permissionLines(info.addon, info.permissions);
        let updating = info.type == "update" || info.existingAddon;
        shell.showExtensionPrompt({
          title: updating ? `${addonName(info)} needs new permissions` : `Add ${addonName(info)}?`,
          intro: lines.length ? "It will be able to:" : "It asks for no special permissions.",
          lines,
          icon: info.icon || info.addon?.iconURL || "",
          accept: updating ? "Update" : "Add",
          onAccept: () => info.resolve(),
          onCancel: () => info.reject(),
        });
        break;
      }
      case "webextension-update-permission-prompt": {
        shell.showExtensionPrompt({
          title: `${addonName(data)} needs new permissions to update`,
          intro: "The update will be able to:",
          lines: permissionLines(data.addon, data.permissions),
          icon: data.addon?.iconURL || "",
          accept: "Update",
          onAccept: () => data.resolve(),
          onCancel: () => data.reject(),
        });
        break;
      }
      case "webextension-optional-permission-prompt": {
        shell.showExtensionPrompt({
          title: `${data.name || "An extension"} asks for more permissions`,
          intro: "It wants to:",
          lines: permissionLines(null, data.permissions),
          icon: data.icon || "",
          accept: "Allow",
          onAccept: () => data.resolve(true),
          onCancel: () => data.resolve(false),
        });
        break;
      }
      case "addon-install-blocked": {
        let host = "";
        try {
          host = data.originatingURI?.host || "";
        } catch (e) { /* no host */ }
        shell.showExtensionPrompt({
          title: `Allow ${host || "this site"} to install an extension?`,
          intro: "Only install extensions from sites you trust. addons.mozilla.org is always allowed.",
          lines: [],
          accept: "Continue",
          onAccept: () => data.install?.(),
          onCancel: () => data.cancel?.(),
        });
        break;
      }
      case "addon-install-failed": {
        let install = data.installs?.[0];
        let name = install?.addon?.name || install?.name || "The extension";
        let reason = {
          [-1]: ": the download failed",
          [-3]: ": the file is damaged or isn't an extension",
          [-5]: ": it isn't signed by Mozilla",
        }[install?.error] ?? (install?.error ? ` (error ${install.error})` : "");
        if (install?.addon?.appDisabled) {
          reason = ": it isn't compatible with this engine version";
        }
        shell.showMessage(`${name} couldn't be installed${reason}`, "error");
        break;
      }
      case "addon-install-origin-blocked":
      case "addon-install-webapi-blocked":
        shell.showMessage("This site isn't allowed to install extensions", "error");
        break;
      case "addon-install-disabled":
      case "addon-install-policy-blocked":
        shell.showMessage("Extension installs are turned off", "error");
        break;
      case "addon-install-fullscreen-blocked":
        shell.showMessage("Leave full screen to install extensions", "error");
        break;
      case "webextension-install-notify":
        shell.showMessage(`${data.addon?.name || "The extension"} was added`);
        break;
    }
  },
};

/** Once per app: categories and prompt observers. */
export function register() {
  if (registered) {
    return;
  }
  registered = true;
  for (let [category, key, value] of CATEGORIES) {
    try {
      Services.catMan.addCategoryEntry(category, key, value, false, true);
    } catch (e) { /* chrome.manifest registered it */ }
  }
  for (let topic of PROMPT_TOPICS) {
    Services.obs.addObserver(PromptObserver, topic);
  }
}

/** A window has finished starting: what Firefox's browser.js sends
    after its first paint. The first window also marks the end of
    browser startup, which releases the extensions' background pages. */
export function windowReady(win) {
  Services.obs.notifyObservers(win, "browser-delayed-startup-finished");
  if (!startupSent) {
    startupSent = true;
    Services.obs.notifyObservers(null, "extensions-late-startup");
  }
}
