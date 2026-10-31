/* Seijaku right-click menu, content side. Firefox builds its page menu
   in its front end (ContextMenuChild), which the packager drops, so
   without this a right-click on a page did nothing. This actor reads
   what was right-clicked (a link, an image, a video, a text box, a
   selection, or just the page) when the user asks for the menu, and
   sends that to the chrome window, which draws the menu (see
   showPageMenu in seijaku.js). It also runs the menu's edit commands
   (copy, paste, select all, copy image) here, next to the page.
   Nothing runs until a right-click. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  SelectionUtils: "resource://gre/modules/SelectionUtils.sys.mjs",
  SpellCheckHelper: "resource://gre/modules/InlineSpellChecker.sys.mjs",
});

const EDIT_COMMANDS = ["cmd_undo", "cmd_cut", "cmd_copy", "cmd_paste", "cmd_delete", "cmd_selectAll"];
const ALLOWED_COMMANDS = new Set([...EDIT_COMMANDS, "cmd_copyImage"]);

/** The nearest link around a node, through shadow trees. */
function linkFor(node, win) {
  for (let n = node; n; n = n.flattenedTreeParentNode) {
    if (n.nodeType != n.ELEMENT_NODE) {
      continue;
    }
    if ((win.HTMLAnchorElement.isInstance(n) || win.HTMLAreaElement.isInstance(n)) && n.href) {
      return { node: n, href: n.href, text: (n.textContent || "").trim() };
    }
    if (n.localName == "a" && n.namespaceURI == "http://www.w3.org/2000/svg") {
      let raw = n.getAttribute("href") ?? n.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      let href = typeof raw == "string" ? URL.parse(raw, n.baseURI)?.href : null;
      if (href) {
        return { node: n, href, text: (n.textContent || "").trim() };
      }
    }
  }
  return null;
}

function serializeReferrer(init) {
  try {
    let info = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
    init(info);
    return lazy.E10SUtils.serializeReferrerInfo(info);
  } catch (e) {
    return null;
  }
}

export class SeijakuContextMenuChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type != "contextmenu") {
      return;
    }
    let target = event.composedTarget;
    let doc = target?.ownerDocument;
    let win = this.contentWindow;
    if (!doc || !win) {
      return;
    }
    // A page that draws its own menu (a web app, a game) keeps it,
    // unless the engine's switch says pages may not.
    let prevented = event.defaultPrevented;
    if (!doc.nodePrincipal.isSystemPrincipal && !Services.prefs.getBoolPref("dom.event.contextmenu.enabled", true)) {
      prevented = false;
    }
    if (prevented) {
      return;
    }

    let data = {
      screenX: event.screenX * win.devicePixelRatio,
      screenY: event.screenY * win.devicePixelRatio,
      docURL: doc.documentURI,
      inFrame: !!this.browsingContext.parent,
      link: null,
      linkReferrerInfo: null,
      image: null,
      media: null,
      mediaKind: "",
      editFlags: 0,
      commands: {},
      selection: "",
    };

    let link = linkFor(target, win);
    if (link) {
      data.link = link.href;
      data.linkText = link.text.slice(0, 200);
      data.linkReferrerInfo = serializeReferrer(info => info.initWithElement(link.node));
    }

    if (win.HTMLImageElement.isInstance(target) && (target.currentSrc || target.src)) {
      data.image = target.currentSrc || target.src;
    } else if (win.HTMLVideoElement.isInstance(target) || win.HTMLAudioElement.isInstance(target)) {
      data.mediaKind = win.HTMLVideoElement.isInstance(target) ? "video" : "audio";
      let src = target.currentSrc || target.src;
      // A blob or stream address means nothing outside the page.
      data.media = /^(https?|file|data):/.test(src) ? src : null;
    }
    data.referrerInfo = serializeReferrer(info => info.initWithElement(target));

    try {
      data.editFlags = lazy.SpellCheckHelper.isEditable(target, win);
    } catch (e) {
      data.editFlags = 0;
    }

    try {
      data.selection = lazy.SelectionUtils.getSelectionDetails(win)?.fullText || "";
    } catch (e) {
      data.selection = String(win.getSelection() || "");
    }
    data.selection = data.selection.trim().slice(0, 2000);

    // The copy-image command acts on the node the menu was opened on.
    try {
      this.docShell.docViewer.QueryInterface(Ci.nsIDocumentViewerEdit).setCommandNode(target);
    } catch (e) { /* Copy image just stays disabled */ }
    for (let command of EDIT_COMMANDS) {
      try {
        data.commands[command] = this.docShell.isCommandEnabled(command);
      } catch (e) {
        data.commands[command] = false;
      }
    }

    // The page's own process stays quiet about it: the chrome window
    // draws the only menu.
    event.stopPropagation();
    this.sendAsyncMessage("ContextMenu", data);
  }

  receiveMessage(message) {
    if (message.name == "DoCommand" && ALLOWED_COMMANDS.has(message.data?.command)) {
      try {
        this.docShell.doCommand(message.data.command);
      } catch (e) { /* the page went away, or the command no longer applies */ }
    }
    return null;
  }
}
