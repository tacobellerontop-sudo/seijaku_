/* Seijaku page fullscreen, chrome side. A port of Firefox's
   DOMFullscreenParent (browser/actors, MPL 2.0) together with the
   parts of its window-side FullScreen object (browser-fullScreenAnd
   PointerLock.js) that move a fullscreen request through the window:
   both live in the front end the packager drops. What is left out is
   Firefox UI: the toolbars, the permission doorhangers, the warning
   panel and telemetry. The window is told through
   Seijaku.onPageFullscreen, which hides the strip and shows a short
   "press Esc" note.

   The shape of it: a page asks (DOMFullscreen:Request), the window
   makes the page's <browser> fullscreen, and the engine fires
   MozDOMFullscreen:Entered on the window; this actor then tells each
   process between the window and the asking frame to go fullscreen in
   turn (a YouTube player inside another site's page can be several
   processes deep). Leaving runs the same chain backwards. */

/** The first ancestor of the actor's frame in another process, and
    the in-process frame below it; or [request origin, null]. */
function nextRecipient(actor, useCache) {
  if (useCache && actor.nextMsgRecipient) {
    let next = actor.nextMsgRecipient;
    while (next) {
      let [candidate] = next;
      if (!candidate.hasBeenDestroyed() && candidate.windowContext && !candidate.windowContext.isInBFCache) {
        return next;
      }
      next = candidate.nextMsgRecipient;
    }
  }
  if (actor.hasBeenDestroyed()) {
    return [null, null];
  }
  let childBC = actor.browsingContext;
  let parentBC = childBC.parent;
  while (parentBC) {
    if (!childBC.currentWindowGlobal || !parentBC.currentWindowGlobal) {
      break;
    }
    if (childBC.currentWindowGlobal.osPid == parentBC.currentWindowGlobal.osPid) {
      childBC = parentBC;
      parentBC = childBC.parent;
    } else {
      break;
    }
  }
  let target = null;
  let inProcessBC = null;
  if (parentBC && parentBC.currentWindowGlobal) {
    target = parentBC.currentWindowGlobal.getActor("SeijakuFullscreen");
    inProcessBC = childBC;
    actor.nextMsgRecipient = [target, inProcessBC];
  } else {
    target = actor.requestOrigin;
  }
  if (!target || target.hasBeenDestroyed() || target.windowContext?.isInBFCache) {
    return [null, null];
  }
  return [target, inProcessBC];
}

function abortEnter(window) {
  // Called from inside a fullscreen change, so never synchronously.
  window.setTimeout(() => window.document.exitFullscreen().catch(() => {}), 0);
}

function enterDomFullscreen(window, browser, actor) {
  if (!window.document.fullscreenElement) {
    actor.requestOrigin = null;
    return;
  }
  if (browser?.isRemoteBrowser) {
    let [target, inProcessBC] = nextRecipient(actor, false);
    if (!target) {
      abortEnter(window);
      return;
    }
    target.waitingForChildEnterFullscreen = true;
    target.sendAsyncMessage("DOMFullscreen:Entered", { remoteFrameBC: inProcessBC });
    if (inProcessBC) {
      return;
    }
  }
  // Only the tab on screen, in the window in front, may fill the
  // screen: a background page must never take it over.
  if (
    !browser ||
    window.Seijaku?.selectedBrowser != browser ||
    Services.focus.activeWindow != window
  ) {
    abortEnter(window);
    return;
  }
  window.document.documentElement.setAttribute("inDOMFullscreen", "true");
  window.Seijaku?.onPageFullscreen(true);
}

/** Returns whether a child still has to answer before cleanup ends. */
function cleanupDomFullscreen(window, actor) {
  let [target, inProcessBC] = nextRecipient(actor, true);
  let wait = false;
  if (target) {
    wait = true;
    target.waitingForChildExitFullscreen = true;
    target.sendAsyncMessage("DOMFullscreen:CleanUp", { remoteFrameBC: inProcessBC });
    if (inProcessBC) {
      return wait;
    }
  }
  window.document.documentElement.removeAttribute("inDOMFullscreen");
  window.Seijaku?.onPageFullscreen(false);
  return wait;
}

export class SeijakuFullscreenParent extends JSWindowActorParent {
  waitingForChildEnterFullscreen = false;
  waitingForChildExitFullscreen = false;
  nextMsgRecipient = null;

  updateFullscreenWindowReference(window) {
    if (window.document.documentElement.hasAttribute("inDOMFullscreen")) {
      this._fullscreenWindow = window;
    } else {
      delete this._fullscreenWindow;
    }
  }

  cleanupDomFullscreen(window) {
    if (!cleanupDomFullscreen(window, this) && !window.document.fullscreen) {
      Services.obs.notifyObservers(window, "fullscreen-painted");
    }
  }

  _cleanupFullscreenStateAndResumeChromeUI(window) {
    this.cleanupDomFullscreen(window);
    if (this.requestOrigin == this && window.document.fullscreen) {
      window.windowUtils.remoteFrameFullscreenReverted();
    }
  }

  didDestroy() {
    this._didDestroy = true;
    let window = this._fullscreenWindow;
    if (!window) {
      let browser = this.browsingContext.top.embedderElement;
      if (!browser) {
        return;
      }
      if (this.waitingForChildExitFullscreen || this.waitingForChildEnterFullscreen) {
        this.waitingForChildExitFullscreen = false;
        this.waitingForChildEnterFullscreen = false;
        this._cleanupFullscreenStateAndResumeChromeUI(browser.ownerDocument.defaultView);
      }
      if (this != this.requestOrigin) {
        this.removeListeners(browser.ownerDocument.defaultView);
      }
      return;
    }
    if (this.waitingForChildEnterFullscreen) {
      this.waitingForChildEnterFullscreen = false;
      if (window.document.fullscreen) {
        // Gone halfway into fullscreen: back out entirely rather than
        // leave the window stuck half there.
        window.document.exitFullscreen().catch(() => {});
        return;
      }
      this.cleanupDomFullscreen(window);
    }
    if (window.document.documentElement.hasAttribute("inDOMFullscreen")) {
      this.cleanupDomFullscreen(window);
      window.windowUtils?.remoteFrameFullscreenReverted();
    } else if (this.waitingForChildExitFullscreen) {
      this.waitingForChildExitFullscreen = false;
      this._cleanupFullscreenStateAndResumeChromeUI(window);
    }
    this.updateFullscreenWindowReference(window);
  }

  receiveMessage(message) {
    let browser = this.browsingContext.top.embedderElement;
    if (!browser) {
      return;
    }
    let window = browser.ownerDocument.defaultView;
    switch (message.name) {
      case "DOMFullscreen:Request": {
        // Keyboard lock stays off: Esc must always leave fullscreen.
        this.manager.fullscreen = true;
        this.waitingForChildExitFullscreen = false;
        this.requestOrigin = this;
        this.addListeners(window);
        window.windowUtils.remoteFrameFullscreenChanged(browser, false);
        break;
      }
      case "DOMFullscreen:NewOrigin": {
        if (window.document.fullscreen) {
          window.Seijaku?.onPageFullscreen(true, message.data?.originNoSuffix);
        }
        this.updateFullscreenWindowReference(window);
        break;
      }
      case "DOMFullscreen:Entered": {
        this.manager.fullscreen = true;
        this.nextMsgRecipient = null;
        this.waitingForChildEnterFullscreen = false;
        enterDomFullscreen(window, browser, this);
        this.updateFullscreenWindowReference(window);
        break;
      }
      case "DOMFullscreen:Exit": {
        this.manager.fullscreen = false;
        this.waitingForChildEnterFullscreen = false;
        window.windowUtils.remoteFrameFullscreenReverted();
        break;
      }
      case "DOMFullscreen:Exited": {
        this.manager.fullscreen = false;
        this.waitingForChildExitFullscreen = false;
        this.cleanupDomFullscreen(window);
        this.updateFullscreenWindowReference(window);
        break;
      }
      case "DOMFullscreen:Painted": {
        this.waitingForChildExitFullscreen = false;
        Services.obs.notifyObservers(window, "fullscreen-painted");
        this.sendAsyncMessage("DOMFullscreen:Painted", {});
        break;
      }
    }
  }

  handleEvent(event) {
    let window = event.currentTarget;
    let requestOrigin = window.browsingContext.fullscreenRequestOrigin?.get();
    if (this != requestOrigin) {
      // Only the frame that asked handles the window's events.
      this.removeListeners(window);
      return;
    }
    switch (event.type) {
      case "MozDOMFullscreen:Entered": {
        // The target is the <browser> the window made fullscreen, or,
        // for an in-process page, an element inside it.
        let browser = event.target.ownerDocument.defaultView == window
          ? event.target
          : event.target.ownerDocument.defaultView.docShell.chromeEventHandler;
        enterDomFullscreen(window, browser, this);
        this.updateFullscreenWindowReference(window);
        break;
      }
      case "MozDOMFullscreen:Exited": {
        if (!this.hasBeenDestroyed() && !this.requestOrigin) {
          this.requestOrigin = this;
        }
        this.cleanupDomFullscreen(window);
        this.updateFullscreenWindowReference(window);
        if (!this.manager.fullscreen) {
          this.removeListeners(window);
        }
        break;
      }
    }
  }

  addListeners(window) {
    window.addEventListener("MozDOMFullscreen:Entered", this, true, false);
    window.addEventListener("MozDOMFullscreen:Exited", this, true, false);
  }

  removeListeners(window) {
    window.removeEventListener("MozDOMFullscreen:Entered", this, true);
    window.removeEventListener("MozDOMFullscreen:Exited", this, true);
  }

  /** The actor whose frame asked for fullscreen, kept on the window. */
  get requestOrigin() {
    let chromeBC = this.browsingContext.topChromeWindow?.browsingContext;
    return chromeBC?.fullscreenRequestOrigin?.get();
  }

  set requestOrigin(actor) {
    let chromeBC = this.browsingContext.topChromeWindow?.browsingContext;
    if (!chromeBC) {
      return;
    }
    if (actor) {
      chromeBC.fullscreenRequestOrigin = Cu.getWeakReference(actor);
    } else {
      delete chromeBC.fullscreenRequestOrigin;
    }
  }

  hasBeenDestroyed() {
    if (this._didDestroy) {
      return true;
    }
    try {
      return !this.browsingContext;
    } catch {
      return true;
    }
  }
}
