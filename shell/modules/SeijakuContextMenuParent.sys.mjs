/* Seijaku right-click menu, chrome side: hands what the page reported
   to the window that holds the page (see SeijakuContextMenuChild and
   showPageMenu in seijaku.js). */

export class SeijakuContextMenuParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "ContextMenu") {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    let win = browser?.ownerGlobal;
    // The page's principal comes from this side, never from the page:
    // links open with what the page itself may load, nothing more.
    message.data.principal = this.manager.documentPrincipal;
    try {
      win?.Seijaku?.showPageMenu(browser, message.data, this);
    } catch (e) {
      console.error("Seijaku: page menu", e);
    }
  }
}
