/* Seijaku's site permission prompts, registered at runtime.

   Two engine paths ask the browser for permission, and Firefox's
   front end (which the packager drops) normally answers both:

   1. nsIContentPermissionPrompt: notifications, persistent storage
      and the like. Older shells registered this with a "component"
      line in chrome.manifest; current Gecko no longer reads those
      lines, so the prompt was never registered and every such request
      was silently denied. It is registered from here instead, through
      the component registrar, once per process.

   2. getUserMedia (camera, microphone) and RTCPeerConnection never go
      through that prompt: the engine posts an observer notification
      in the page's content process and waits for an answer. With
      nobody listening, a video call page waited forever. The
      SeijakuMedia process actor (SeijakuMediaChild.sys.mjs) listens
      there and asks the shell through SeijakuMediaParent below.

   Either way the shell window's panel asks the user (see
   queuePermissionRequest in seijaku.js), and any failure denies the
   request instead of hanging it. Location is denied outright, as the
   geo.enabled=false pref already does. */

const CONTRACT = "@mozilla.org/content-permission/prompt;1";
const CID = Components.ID("{2cb09dc6-60e9-450e-b2c7-258a9ae0bd57}");

/** The Seijaku window to prompt in (the most recent main window). */
export function findShellWindow() {
  try {
    let win = Services.wm.getMostRecentWindow("seijaku:main");
    if (win?.Seijaku) {
      return win;
    }
    for (let candidate of Services.wm.getEnumerator(null)) {
      if (candidate?.Seijaku) {
        return candidate;
      }
    }
  } catch (e) { /* no shell window to prompt in */ }
  return null;
}

function requestType(request) {
  try {
    return request.types.queryElementAt(0, Ci.nsIContentPermissionType).type;
  } catch (e) {
    return "";
  }
}

function principalHost(principal) {
  try {
    return principal?.host || principal?.URI?.host || "";
  } catch (e) {
    return "";
  }
}

const prompter = {
  QueryInterface: ChromeUtils.generateQI(["nsIContentPermissionPrompt"]),

  prompt(request) {
    try {
      let type = requestType(request);
      if (!type || type == "geolocation") {
        request.cancel();
        return;
      }
      let win = findShellWindow();
      if (!win?.Seijaku?.queuePermissionRequest) {
        request.cancel();
        return;
      }
      win.Seijaku.queuePermissionRequest(request, principalHost(request.principal), type);
    } catch (e) {
      try {
        request.cancel();
      } catch (_e) { /* already answered */ }
    }
  },
};

const factory = {
  QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
  createInstance(iid) {
    return prompter.QueryInterface(iid);
  },
};

let registered = false;

/** Registers the prompt and the media actor; safe to call per window. */
export function register() {
  if (registered) {
    return;
  }
  registered = true;
  try {
    Components.manager
      .QueryInterface(Ci.nsIComponentRegistrar)
      .registerFactory(CID, "Seijaku permission prompt", CONTRACT, factory);
  } catch (e) {
    console.error("Seijaku: registering the permission prompt", e);
  }
  try {
    ChromeUtils.registerProcessActor("SeijakuMedia", {
      parent: { esModuleURI: "resource://seijaku/PermissionPrompt.sys.mjs" },
      child: {
        esModuleURI: "resource://seijaku/SeijakuMediaChild.sys.mjs",
        observers: ["getUserMedia:request", "PeerConnection:request"],
      },
      // These requests come from web pages, so the actor has to run in
      // web processes. The parent half trusts nothing the child says
      // about which site is asking: it looks the page up itself.
      safeForUntrustedWebProcess: true,
    });
  } catch (e) {
    console.error("Seijaku: registering the camera and microphone actor", e);
  }
}

/** Parent half of the SeijakuMedia actor: one camera or microphone
    request from a page, answered through the shell's prompt. Resolves
    true for Allow. Camera and microphone together are asked one after
    the other, and both must be allowed. */
export class SeijakuMediaParent extends JSProcessActorParent {
  async receiveMessage(message) {
    if (message.name != "Seijaku:MediaRequest") {
      return false;
    }
    let { innerWindowId, types } = message.data;
    // The asking page, looked up here rather than taken from the
    // child: a compromised content process must not be able to claim
    // another site's remembered Allow. It has to be a page that really
    // lives in the process that sent the request.
    let host = "";
    try {
      let page = WindowGlobalParent.getByInnerWindowId(innerWindowId);
      if (!page || page.domProcess?.childID != this.manager.childID) {
        return false;
      }
      host = page.documentPrincipal.host || "";
    } catch (e) {
      return false;
    }
    types = (Array.isArray(types) ? types : []).filter(t => t == "camera" || t == "microphone");
    if (!types.length) {
      return false;
    }
    for (let type of types) {
      let allowed = await new Promise(resolve => {
        let win = findShellWindow();
        if (!win?.Seijaku?.queuePermissionRequest) {
          resolve(false);
          return;
        }
        win.Seijaku.queuePermissionRequest(
          { allow: () => resolve(true), cancel: () => resolve(false) },
          host,
          type
        );
      });
      if (!allowed) {
        return false;
      }
    }
    return true;
  }
}
