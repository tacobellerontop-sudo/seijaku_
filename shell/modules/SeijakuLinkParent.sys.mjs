/* Seijaku link clicks, chrome side: opens the link the page reported
   in a new tab of the window that holds the page (see SeijakuLinkChild
   and openLinkFromPage in seijaku.js). */

export class SeijakuLinkParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "OpenLink") {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    let win = browser?.ownerGlobal;
    // The page's principal comes from this side, never from the page:
    // links open with what the page itself may load, nothing more.
    message.data.principal = this.manager.documentPrincipal;
    try {
      win?.Seijaku?.openLinkFromPage(browser, message.data);
    } catch (e) {
      console.error("Seijaku: opening a link", e);
    }
  }
}
