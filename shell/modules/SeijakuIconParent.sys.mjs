/* Seijaku tab icons, chrome side: hands the address the page reported
   to the window that owns the tab (see SeijakuIconChild). */

export class SeijakuIconParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "Icon") {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    browser?.ownerGlobal?.Seijaku?.setTabIcon(browser, message.data.href);
  }
}
