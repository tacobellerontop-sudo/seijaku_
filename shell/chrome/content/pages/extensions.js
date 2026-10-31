/* Extensions manager: lists what the shell reports from AddonManager
   and asks the shell to enable, disable, remove or install an
   extension. The page itself only listens to AddonManager (so the list
   follows installs made elsewhere); every operation goes through the
   shell methods, and
   every failure lands in the visible error line instead of breaking
   the page. */

"use strict";

function getShell() {
  try {
    return window.browsingContext?.topChromeWindow?.Seijaku ?? null;
  } catch {
    return null;
  }
}

function showError(message) {
  let error = document.getElementById("error");
  error.textContent = message;
  error.hidden = false;
}

function clearError() {
  let error = document.getElementById("error");
  error.textContent = "";
  error.hidden = true;
}

function showStatus(message) {
  let status = document.getElementById("status");
  status.textContent = message;
  status.hidden = !message;
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function isCancel(error) {
  // The shell rejects on picker cancel too; that is not an error
  // worth alarming about, so it stays quiet.
  return /cancel|abort/i.test(errorMessage(error));
}

async function render() {
  let list = document.getElementById("list");
  let empty = document.getElementById("empty");
  let shell = getShell();
  list.replaceChildren();
  showStatus("");
  if (!shell) {
    showError("Extensions are unavailable: the browser shell is not reachable from this page.");
    empty.hidden = true;
    return;
  }
  let extensions;
  try {
    extensions = await shell.getExtensions();
  } catch (error) {
    showError(`Could not load extensions: ${errorMessage(error)}`);
    empty.hidden = true;
    return;
  }
  clearError();
  if (!Array.isArray(extensions)) {
    extensions = [];
  }
  empty.hidden = extensions.length != 0;
  for (let ext of extensions) {
    let row = document.createElement("div");
    row.className = "row";
    if (!ext.enabled) {
      row.classList.add("ext-disabled");
    }
    let icon = document.createElement("span");
    icon.className = "ext-icon";
    if (ext.iconURL) {
      let img = document.createElement("img");
      img.className = "ext-icon-img";
      img.src = ext.iconURL;
      img.alt = "";
      icon.append(img);
    } else {
      // Fallback glyph: the extension's initial, never a fake icon.
      icon.textContent = (ext.name || "?").charAt(0).toUpperCase();
    }
    let main = document.createElement("div");
    main.className = "row-main";
    let title = document.createElement("div");
    title.className = "row-title";
    title.textContent = ext.name || ext.id || "Extension";
    let meta = document.createElement("div");
    meta.className = "row-meta";
    let metaParts = [];
    if (ext.version) {
      metaParts.push(`v${ext.version}`);
    }
    metaParts.push(ext.enabled ? "Enabled" : "Disabled");
    meta.textContent = metaParts.join("  ·  ");
    let description = document.createElement("div");
    description.className = "row-url ext-desc";
    description.textContent = ext.description || "No description.";
    main.append(title, meta, description);
    let actions = document.createElement("div");
    actions.className = "ext-actions";
    let toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = ext.enabled ? "Disable" : "Enable";
    toggle.addEventListener("click", async () => {
      try {
        await shell.setExtensionEnabled(ext.id, !ext.enabled);
        await render();
      } catch (error) {
        showError(`Could not ${ext.enabled ? "disable" : "enable"} “${ext.name || ext.id}”: ${errorMessage(error)}`);
      }
    });
    let remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Remove “${ext.name || ext.id}”?`)) {
        return;
      }
      try {
        await shell.uninstallExtension(ext.id);
        await render();
      } catch (error) {
        showError(`Could not remove “${ext.name || ext.id}”: ${errorMessage(error)}`);
      }
    });
    actions.append(toggle, remove);
    if (ext.hasOptions && ext.enabled) {
      let options = document.createElement("button");
      options.type = "button";
      options.textContent = "Options";
      options.addEventListener("click", () => {
        shell.openExtensionOptions(ext.id).catch(error => {
          showError(`Could not open the options of “${ext.name || ext.id}”: ${errorMessage(error)}`);
        });
      });
      actions.prepend(options);
    }
    row.append(icon, main, actions);
    list.append(row);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("get").addEventListener("click", () => {
    getShell()?.openTab("https://addons.mozilla.org/firefox/extensions/", { afterCurrent: true });
  });
  // An install from addons.mozilla.org lands here too: the list
  // follows whatever the engine adds, enables or removes.
  try {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const refresh = () => render().catch(() => {});
    const listener = {
      onInstalled: refresh,
      onUninstalled: refresh,
      onEnabled: refresh,
      onDisabled: refresh,
    };
    AddonManager.addAddonListener(listener);
    window.addEventListener("unload", () => AddonManager.removeAddonListener(listener));
  } catch {
    // The list just refreshes when the page is reopened.
  }
  document.getElementById("install").addEventListener("click", async () => {
    let shell = getShell();
    if (!shell) {
      showError("Extensions are unavailable: the browser shell is not reachable from this page.");
      return;
    }
    clearError();
    showStatus("");
    try {
      let name = await shell.installExtensionFromFile();
      await render();
      if (name) {
        showStatus(`Installed “${name}”.`);
      }
    } catch (error) {
      if (isCancel(error)) {
        return;
      }
      showError(`Could not install extension: ${errorMessage(error)}`);
    }
  });
  // Never throw on load: render() handles a missing shell and every
  // failed shell call with a visible message, not an exception.
  render().catch((error) => {
    showError(`Could not load extensions: ${errorMessage(error)}`);
  });
});
