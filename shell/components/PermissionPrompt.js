/* Seijaku's content permission prompt, the standard XUL-shell way:
   a JS component registered in chrome.manifest under the contract
   the engine looks up when a site asks for something (geolocation,
   notifications, and whatever else the engine routes through the
   prompt service). The component itself shows no UI: it hands the
   request to the shell window, whose panel asks the user, and the
   shell answers the request later with allow() or cancel(). That
   late answer is how Firefox's own prompts work too — the request
   object stays alive until answered.
   Safety: every step is guarded, and any failure denies the request
   instead of hanging it. Location is denied outright here as well
   as by pref (geo.enabled=false). This component loads lazily on
   the first permission request, never at startup, so a broken
   registration cannot break startup — it can only leave prompts
   unanswered, which the allow-switch still covers.
   UNVERIFIED ON WINDOWS: no Windows run has yet shown a prompt from
   a real camera test page. */

const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

/** The Seijaku window to prompt in (the most recent main window). */
function findShellWindow() {
  try {
    let wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(
      Ci.nsIWindowMediator
    );
    let win = wm.getMostRecentWindow("seijaku:main");
    if (win?.Seijaku) {
      return win;
    }
    let enumerator = wm.getEnumerator(null);
    while (enumerator.hasMoreElements()) {
      let candidate = enumerator.getNext();
      if (candidate?.Seijaku) {
        return candidate;
      }
    }
  } catch (e) { /* no shell window to prompt in */ }
  return null;
}

function PermissionPrompt() {}

PermissionPrompt.prototype = {
  classID: Components.ID("{2cb09dc6-60e9-450e-b2c7-258a9ae0bd57}"),
  QueryInterface: ChromeUtils.generateQI(["nsIContentPermissionPrompt"]),

  prompt(request) {
    try {
      let type = "";
      try {
        type = request.type;
      } catch (e) { /* typeless requests are denied below */ }
      if (!type || type == "geolocation") {
        request.cancel();
        return;
      }
      let host = "";
      try {
        host = request.principal?.URI?.host || request.principal?.host || "";
      } catch (e) { /* host stays empty; the panel says "This site" */ }
      let win = findShellWindow();
      if (!win?.Seijaku?.queuePermissionRequest) {
        request.cancel();
        return;
      }
      win.Seijaku.queuePermissionRequest(request, host, type);
    } catch (e) {
      try {
        request.cancel();
      } catch (_e) { /* already answered */ }
    }
  },
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([PermissionPrompt]);
