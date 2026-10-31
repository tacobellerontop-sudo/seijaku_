/* Seijaku link clicks, content side. The engine follows a plain click
   on a link by itself, but a middle-click, Ctrl+click or Shift+click
   it only reports, as a "chromelinkclick" event, for the front end to
   handle; Firefox's front end is dropped, so those clicks did nothing.
   This actor checks the click the way Firefox does (a real click, a
   link the page may load, no javascript:) and asks the chrome window
   to open the link in a new tab. Plain clicks are left to the engine. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
});

export class SeijakuLinkChild extends JSWindowActorChild {
  handleEvent(wrapper) {
    let event = wrapper.sourceEvent;
    if (!event || event.defaultPrevented || event.button == 2) {
      return;
    }
    let middle = event.button == 1;
    let accel = event.ctrlKey || event.metaKey;
    if (!middle && !accel && !event.shiftKey) {
      return;
    }
    // Text fields keep their own clicks (a middle-click there pastes).
    let composed = event.composedTarget;
    let name = ChromeUtils.getClassName(composed);
    if (
      composed.isContentEditable ||
      composed.ownerDocument?.designMode == "on" ||
      name == "HTMLInputElement" ||
      name == "HTMLTextAreaElement"
    ) {
      return;
    }
    let doc = event.originalTarget?.ownerDocument;
    if (!doc) {
      return;
    }
    // A click the page made up itself must ride on a real gesture.
    if (!event.isTrusted && !doc.hasValidTransientUserGestureActivation) {
      return;
    }
    let [href, node, principal] = lazy.BrowserUtils.hrefAndLinkNodeForClickEvent(event) || [];
    if (!href) {
      return;
    }
    try {
      if (Services.io.extractScheme(href) == "javascript") {
        return;
      }
      Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(principal, href);
    } catch (e) {
      return;
    }
    if (!event.isTrusted) {
      doc.consumeTransientUserGestureActivation();
    }
    let referrerInfo = null;
    try {
      let info = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
      if (node) {
        info.initWithElement(node);
      } else {
        info.initWithDocument(doc);
      }
      referrerInfo = lazy.E10SUtils.serializeReferrerInfo(info);
    } catch (e) { /* no referrer, then */ }
    event.preventMultipleActions();
    // Firefox's rule: a middle-click or Ctrl+click opens behind, and
    // Shift brings it to the front; Shift+click alone opens in front.
    let background = (middle || accel) && !event.shiftKey;
    this.sendAsyncMessage("OpenLink", { href, referrerInfo, background });
  }
}
