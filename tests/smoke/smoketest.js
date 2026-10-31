/* Seijaku smoke test. The Windows smoke workflow copies this into a
   packaged build, adds it to seijaku.xhtml after seijaku.js, and starts
   the browser headless. It drives the real shell against the pages in
   tests/smoke/pages (served on 127.0.0.1), writes smoke-results.json
   into the profile, and quits. It is never part of a release. */

"use strict";

(() => {
  // Only the first window runs the test: others (an extension's popup
  // window) are part of it.
  for (let win of Services.wm.getEnumerator("seijaku:main")) {
    if (win != window) {
      return;
    }
  }
  const BASE = Services.prefs.getStringPref("seijaku.smoke.base", "http://127.0.0.1:8765/");
  const results = [];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitFor(what, test, timeoutMs = 15000) {
    let start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let value;
      try {
        value = await test();
      } catch (e) {
        value = null;
      }
      if (value) {
        return value;
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const RESULTS_FILE = PathUtils.join(PathUtils.profileDir, "smoke-results.json");

  // Each check has a time limit, and results are written after every
  // check, so one check that hangs can't hide the others.
  async function check(name, fn, limitMs = 180000) {
    dump(`Seijaku smoke: ${name}\n`);
    let timer;
    try {
      let detail = await Promise.race([
        fn(),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no result in ${limitMs / 1000} s`)), limitMs))),
      ]);
      results.push({ name, ok: true, detail: detail ?? "" });
    } catch (e) {
      results.push({ name, ok: false, detail: String(e?.message || e) });
      dump(`Seijaku smoke: FAILED ${name}: ${e?.message || e}\n`);
    } finally {
      clearTimeout(timer);
    }
    await IOUtils.writeJSON(RESULTS_FILE, results).catch(() => {});
  }

  function assert(cond, message) {
    if (!cond) {
      throw new Error(message);
    }
  }

  async function openAndLoad(path) {
    let url = BASE + path;
    let tab = Seijaku.openTab(url);
    await waitFor(`${path} to load`, () =>
      tab.browser?.currentURI?.spec == url && !tab.el.hasAttribute("busy")
    );
    return tab;
  }

  /** Synthesizes mouse events at x, y inside a page's <browser>. The
      window routes them to the page like a real click. Current Gecko
      has Window.synthesizeMouseEvent; older ones windowUtils'
      sendMouseEvent. */
  function pageMouse(browser, events) {
    let rect = browser.getBoundingClientRect();
    for (let [type, x, y, button] of events) {
      let cx = rect.left + x;
      let cy = rect.top + y;
      if (typeof window.synthesizeMouseEvent == "function") {
        window.synthesizeMouseEvent(type, cx, cy, { button, clickCount: 1 });
      } else {
        window.windowUtils.sendMouseEvent(type, cx, cy, button, 1, 0);
      }
    }
  }

  /** Answers the next permission prompt the shell puts up. */
  async function answerPrompt(type, allow) {
    await waitFor(`a ${type} prompt`, () => Seijaku._permActive?.type == type);
    Seijaku.answerPermission(allow, false);
  }

  function finderResult(browser, start) {
    return new Promise((resolve, reject) => {
      let finder = browser.finder;
      let timer = setTimeout(() => reject(new Error("no find result")), 10000);
      let listener = {
        onFindResult(data) {
          clearTimeout(timer);
          finder.removeResultListener(listener);
          resolve(data);
        },
        onMatchesCountResult() {},
        onHighlightFinished() {},
        onCurrentSelection() {},
      };
      finder.addResultListener(listener);
      start();
    });
  }

  async function run() {
    await waitFor("the shell to start", () => Seijaku.tabs.length && Seijaku.dataReady());

    let tab;
    await check("web page loads in a content process", async () => {
      tab = await openAndLoad("article.html");
      assert(tab.browser.isRemoteBrowser, "the page is not remote");
      return tab.browser.remoteType;
    });

    await check("engine page actors are registered", () => {
      let wg = tab.browser.browsingContext.currentWindowGlobal;
      let names = [
        "Select", "Finder", "UAWidgets", "AudioPlayback", "SeijakuReader",
        "SeijakuContextMenu", "SeijakuLink", "SeijakuFullscreen",
      ];
      for (let name of names) {
        wg.getActor(name);
      }
      return names.join(", ");
    });

    await check("a page's icon reaches its tab", async () => {
      try {
        await waitFor("the tab icon", () => tab.icon == BASE + "icon.svg" && !tab.iconEl.hidden);
      } catch (e) {
        let actor = "ok";
        try {
          tab.browser.browsingContext.currentWindowGlobal.getActor("SeijakuIcon");
        } catch (err) {
          actor = String(err?.message || err);
        }
        throw new Error(
          `${e.message} (icon=${tab.icon || "none"}, hidden=${tab.iconEl.hidden}, ` +
          `complete=${tab.iconEl.complete}, width=${tab.iconEl.naturalWidth}, actor=${actor})`
        );
      }
      return tab.icon;
    });

    await check("tab switching: Ctrl+Tab, Ctrl+number, drag order", async () => {
      Seijaku.selectTab(tab);
      let i = Seijaku.tabs.indexOf(tab);
      Seijaku.cycleTab(1);
      assert(Seijaku.selected === Seijaku.tabs[(i + 1) % Seijaku.tabs.length], "Ctrl+Tab went elsewhere");
      Seijaku.cycleTab(-1);
      assert(Seijaku.selected === tab, "Ctrl+Shift+Tab did not come back");
      Seijaku.selectTabNumber(9);
      assert(Seijaku.selected === Seijaku.tabs[Seijaku.tabs.length - 1], "Ctrl+9 is not the last tab");
      Seijaku.selectTabNumber(1);
      assert(Seijaku.selected === Seijaku.tabs[0], "Ctrl+1 is not the first tab");
      Seijaku.selectTab(tab);
      let order = [...Seijaku.$tabbar.querySelectorAll(".tab")].map(el => el.tab);
      assert(order.every((t, n) => t === Seijaku.tabs[n]), "strip order differs from the tab list");
    });

    await check("find locates text on a web page", async () => {
      document.getElementById("find-input").value = "needle";
      let data = await finderResult(tab.browser, () => Seijaku.findInPage());
      assert(data.result == Ci.nsITypeAheadFind.FIND_FOUND, `result ${data.result}`);
      document.getElementById("find-input").value = "zzqqnotthere";
      data = await finderResult(tab.browser, () => Seijaku.findInPage());
      assert(data.result == Ci.nsITypeAheadFind.FIND_NOTFOUND, `missing word gave ${data.result}`);
      Seijaku.hideFindBar();
    });

    await check("zoom changes a web page", () => {
      Seijaku.zoom(0.1);
      let zoom = tab.browser.browsingContext.fullZoom;
      assert(Math.abs(zoom - 1.1) < 0.01, `zoom is ${zoom}`);
      Seijaku.zoomReset();
      assert(tab.browser.browsingContext.fullZoom == 1, "zoom did not reset");
    });

    await check("reader view extracts and sanitises the article", async () => {
      Seijaku.selectTab(tab);
      let before = Seijaku.tabs.length;
      await Seijaku.openReader();
      let article = Seijaku.getReaderArticle();
      assert(article?.content?.includes("needle"), "article text missing");
      assert(!/onerror|<script/i.test(article.content), "unsafe markup survived");
      assert(Seijaku.tabs.length == before + 1, "no reader tab opened");
      let reader = Seijaku.selected;
      await waitFor("the reader page to render", () =>
        reader.browser?.contentDocument?.getElementById("reader-content")?.textContent.includes("needle")
      );
      Seijaku.closeTab(reader);
      return article.title;
    });

    await check("camera and microphone prompt and grant", async () => {
      let gum = Seijaku.openTab(BASE + "gum.html");
      await answerPrompt("camera", true);
      await answerPrompt("microphone", true);
      await waitFor("getUserMedia to resolve", () => gum.title.startsWith("gum:") && gum.title != "gum:waiting");
      assert(gum.title.startsWith("gum:ok"), gum.title);
      Seijaku.closeTab(gum);
      return gum.title;
    });

    await check("camera denial reaches the page", async () => {
      let gum = Seijaku.openTab(BASE + "gum.html");
      await answerPrompt("camera", false);
      await waitFor("getUserMedia to reject", () => gum.title != "gum:waiting" && gum.title.startsWith("gum:"));
      assert(gum.title == "gum:error:NotAllowedError", gum.title);
      Seijaku.closeTab(gum);
    });

    await check("peer connection offer does not hang", async () => {
      let pc = Seijaku.openTab(BASE + "pc.html");
      await waitFor("createOffer", () => pc.title != "pc:waiting" && pc.title.startsWith("pc:"));
      assert(pc.title == "pc:ok", pc.title);
      Seijaku.closeTab(pc);
    });

    await check("notification permission prompts", async () => {
      let n = Seijaku.openTab(BASE + "notify.html");
      await answerPrompt("desktop-notification", true);
      await waitFor("requestPermission", () => n.title != "notify:waiting" && n.title.startsWith("notify:"));
      assert(n.title == "notify:granted", n.title);
      Seijaku.closeTab(n);
    });

    await check("strip buttons follow the setting", () => {
      let before = Services.prefs.getStringPref("seijaku.strip.buttons");
      try {
        assert(document.getElementById("nav-home").hasAttribute("strip-off"), "Home shows by default");
        assert(!document.getElementById("downloads-button").hasAttribute("strip-off"), "Downloads hidden by default");
        Seijaku.setStripButton("home", true);
        Seijaku.setStripButton("downloads", false);
        assert(!document.getElementById("nav-home").hasAttribute("strip-off"), "Home did not appear");
        assert(document.getElementById("downloads-button").hasAttribute("strip-off"), "Downloads did not hide");
        assert(Seijaku.stripButtons().some(b => b.key == "home" && b.shown), "the Settings list disagrees");
      } finally {
        Services.prefs.setStringPref("seijaku.strip.buttons", before);
      }
      assert(!document.getElementById("downloads-button").hasAttribute("strip-off"), "Downloads did not come back");
    });

    await check("the page menu offers the right items", async () => {
      let popup = document.getElementById("seijaku-menu");
      let labels = async data => {
        let shown = new Promise(r => popup.addEventListener("popupshown", r, { once: true }));
        Seijaku.showPageMenu(tab.browser, { screenX: 100, screenY: 100, commands: {}, editFlags: 0, ...data }, null);
        await shown;
        let out = [...popup.children].map(el => el.getAttribute("label") || "-");
        let hidden = new Promise(r => popup.addEventListener("popuphidden", r, { once: true }));
        popup.hidePopup();
        await hidden;
        return out;
      };
      let link = await labels({ link: BASE + "article.html" });
      assert(link.includes("Open link in new tab") && link.includes("Copy link address"), link.join("|"));
      let page = await labels({ docURL: BASE + "article.html" });
      assert(page.includes("Back") && page.includes("View page source"), page.join("|"));
      let edit = await labels({ editFlags: 0x1 | 0x8, commands: { cmd_paste: true } });
      assert(edit.includes("Paste") && edit.includes("Select all"), edit.join("|"));
      let image = await labels({ image: BASE + "icon.svg", selection: "needle" });
      assert(image.includes("Save image as…") && image.some(l => l.startsWith("Search for")), image.join("|"));
      return `${link.length}, ${page.length}, ${edit.length}, ${image.length} items`;
    });

    await check("right-click on a page link opens the menu", async () => {
      let links = await openAndLoad("links.html");
      let popup = document.getElementById("seijaku-menu");
      let shown = new Promise(r => popup.addEventListener("popupshown", r, { once: true }));
      await waitFor("the page menu", async () => {
        pageMouse(links.browser, [["contextmenu", 40, 40, 2]]);
        return Promise.race([shown.then(() => true), sleep(1000).then(() => false)]);
      });
      let labels = [...popup.children].map(el => el.getAttribute("label") || "-");
      popup.hidePopup();
      assert(labels.includes("Open link in new tab"), labels.join("|"));
      Seijaku.closeTab(links);
      return labels.join(" | ");
    });

    await check("middle-click on a link opens a background tab", async () => {
      let links = await openAndLoad("links.html");
      let before = Seijaku.tabs.length;
      let target = BASE + "article.html?from=links";
      let tries = 0;
      await waitFor("a new tab for the link", () => {
        if (Seijaku.tabs.length == before && tries++ % 10 == 0) {
          pageMouse(links.browser, [["mousedown", 40, 40, 1], ["mouseup", 40, 40, 1]]);
        }
        return Seijaku.tabs.some(t => t.url == target);
      });
      let opened = Seijaku.tabs.find(t => t.url == target);
      assert(Seijaku.selected === links, "the new tab took the focus");
      assert(Seijaku.tabs.indexOf(opened) == Seijaku.tabs.indexOf(links) + 1, "the new tab is not beside its page");
      Seijaku.closeTab(opened);
      Seijaku.closeTab(links);
    });

    await check("a target=_blank link opens a tab beside its page", async () => {
      let page = await openAndLoad("popup-opener.html");
      let target = BASE + "popup-child.html?via=link";
      let tries = 0;
      await waitFor("a tab for the link", () => {
        if (!Seijaku.tabs.some(t => t.url == target) && tries++ % 10 == 0) {
          pageMouse(page.browser, [["mousedown", 40, 40, 0], ["mouseup", 40, 40, 0]]);
        }
        return Seijaku.tabs.some(t => t.url == target);
      });
      let child = Seijaku.tabs.find(t => t.url == target);
      assert(Seijaku.tabs.indexOf(child) == Seijaku.tabs.indexOf(page) + 1, "the new tab is not beside its page");
      await waitFor("the link's page to load", () => child.title.startsWith("child:"));
      // A plain _blank link gets no opener (the web's rule since 2021).
      assert(child.title == "child:noopener", child.title);
      Seijaku.closeTab(child);
      Seijaku.closeTab(page);
    });

    await check("a sign-in popup (window.open) opens, messages its opener and closes", async () => {
      let page = await openAndLoad("popup-opener.html");
      let target = BASE + "popup-child.html?via=open";
      let tries = 0;
      await waitFor("a tab for the popup", () => {
        if (!Seijaku.tabs.some(t => t.url == target) && tries++ % 10 == 0) {
          pageMouse(page.browser, [["mousedown", 40, 300, 0], ["mouseup", 40, 300, 0]]);
        }
        return Seijaku.tabs.some(t => t.url == target);
      });
      assert(page.title != "opener:blocked", "the popup was blocked");
      let child = Seijaku.tabs.find(t => t.url == target);
      assert(child.openerTab === page, "the popup doesn't know its opener's tab");
      assert(Seijaku.tabs.indexOf(child) == Seijaku.tabs.indexOf(page) + 1, "the popup is not beside its page");
      await waitFor("the opener to get the popup's message", () => page.title == "opener:hello-open");
      await waitFor("the popup to close itself", () => !Seijaku.tabs.includes(child));
      assert(Seijaku.selected === page, "closing the popup didn't return to its page");
      Seijaku.closeTab(page);
      return page.title;
    });

    await check("a sign-in button in another site's frame opens its popup", async () => {
      let page = await openAndLoad("popup-frame-host.html");
      let target = "http://localhost:8765/popup-child.html?via=frame";
      await waitFor("the sign-in frame", () => page.browser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec?.includes("popup-frame.html"));
      let tries = 0;
      await waitFor("a tab for the frame's popup", () => {
        if (!Seijaku.tabs.some(t => t.url == target) && tries++ % 10 == 0) {
          pageMouse(page.browser, [["mousedown", 40, 40, 0], ["mouseup", 40, 40, 0]]);
        }
        return Seijaku.tabs.some(t => t.url == target);
      });
      let child = Seijaku.tabs.find(t => t.url == target);
      assert(child.openerTab === page, "the popup doesn't know its opener's tab");
      await waitFor("the frame to get the popup's message", () => page.title == "host:hello-frame");
      await waitFor("the popup to close itself", () => !Seijaku.tabs.includes(child));
      assert(Seijaku.selected === page, "closing the popup didn't return to its page");
      let remote = page.browser.browsingContext.children[0]?.currentWindowGlobal?.domProcess?.remoteType;
      Seijaku.closeTab(page);
      return `frame in ${remote}`;
    });

    await check("a blocked pop-up is offered on the message line", async () => {
      let page = await openAndLoad("popup-noclick.html");
      await waitFor("the page to try", () => page.title.startsWith("noclick:"));
      assert(page.title == "noclick:blocked", `the pop-up was not blocked (${page.title})`);
      let button = await waitFor("the message line's Open button", () => document.querySelector("#message:not([hidden]) .message-action"));
      let text = document.getElementById("message").textContent;
      let target = BASE + "popup-child.html?via=noclick";
      button.click();
      await waitFor("the pop-up's tab", () => Seijaku.tabs.some(t => t.url == target));
      Seijaku.closeTab(Seijaku.tabs.find(t => t.url == target));
      Seijaku.closeTab(page);
      return text;
    });

    await check("a page can go full screen and back", async () => {
      let fs = Seijaku.openTab(BASE + "fullscreen.html");
      await waitFor("the page to go full screen", () => fs.title != "fs:waiting" && fs.title.startsWith("fs:"));
      assert(fs.title == "fs:ok", fs.title);
      assert(document.fullscreenElement === fs.browser, "the window did not make the page fullscreen");
      assert(document.documentElement.hasAttribute("inDOMFullscreen"), "the strip did not step away");
      await document.exitFullscreen();
      await waitFor("the page to leave full screen", () => fs.title == "fs:exited");
      await waitFor("the strip to come back", () => !document.documentElement.hasAttribute("inDOMFullscreen"));
      Seijaku.closeTab(fs);
    });

    await pdfChecks();

    await check("history, bookmark and session are saved atomically", async () => {
      Seijaku.selectTab(tab);
      Seijaku.toggleBookmark();
      Seijaku.flushData();
      Seijaku.saveSession();
      Seijaku.flushSession();
      let dataPath = PathUtils.join(PathUtils.profileDir, "seijaku-data.json");
      let data = await waitFor("the data file", async () => {
        let d = await IOUtils.readJSON(dataPath);
        return d.bookmarks?.some(b => b.url == tab.url) ? d : null;
      });
      assert(data.history.some(h => h.url == tab.url), "visit not in history");
      let session = await waitFor("the session file", () =>
        IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, "seijaku-session.json"))
      );
      assert(session.tabs.some(t => t.url == tab.url), "tab not in session");
      assert(!(await IOUtils.exists(dataPath + ".tmp")), "temporary file left behind");
    });

    await extensionChecks();
  }

  /* PDFs: they open in the engine's PDF viewer (pdf.js) — typed, from
     a link in a page, and from an old seijaku:pdf address — instead of
     downloading, and Seijaku's find, zoom and save keys reach it. */
  async function pdfChecks() {
    const PDF = BASE + "hello.pdf";
    let { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    let list = await Downloads.getList(Downloads.ALL);
    let downloadsBefore = (await list.getAll()).length;

    async function viewerShows(tab, what) {
      await waitFor(`${what} in the PDF viewer`, () => Seijaku.pdfActor(tab) && tab.browser.currentURI?.spec == PDF, 30000);
      // The viewer names the tab after the file once the PDF has loaded.
      await waitFor(`${what}: the PDF to load`, () => /hello\.pdf/i.test(tab.title || ""), 30000);
    }

    let pdf;
    await check("a typed PDF address opens in the PDF viewer", async () => {
      pdf = Seijaku.openTab(PDF);
      Seijaku.selectTab(pdf);
      await viewerShows(pdf, "a typed PDF");
      return `${pdf.title} (${pdf.browser.remoteType})`;
    });

    await check("find searches the PDF", async () => {
      let bar = await waitFor("the viewer to take the find bar", () => Seijaku.pdfFindBar(pdf));
      let results = [];
      let original = bar.updateControlState.bind(bar);
      bar.updateControlState = (result, previous) => {
        results.push(result);
        original(result, previous);
      };
      let input = document.getElementById("find-input");
      Seijaku.showFindBar();
      input.value = "Seijaku";
      Seijaku.findInPage(false);
      await waitFor("a find result", () => results.some(r => r == Ci.nsITypeAheadFind.FIND_FOUND || r == Ci.nsITypeAheadFind.FIND_WRAPPED));
      results.length = 0;
      input.value = "zzqqxx";
      Seijaku.findInPage(false);
      await waitFor("a not-found result", () => results.includes(Ci.nsITypeAheadFind.FIND_NOTFOUND));
      Seijaku.hideFindBar();
      bar.updateControlState = original;
    });

    await check("zoom goes to the PDF viewer", () => {
      Seijaku.zoom(0.1);
      Seijaku.zoomReset();
      let zoom = pdf.browser.browsingContext.fullZoom;
      assert(zoom == 1, `the page itself was zoomed (${zoom})`);
    });

    await check("a PDF link clicked in a page opens in the PDF viewer", async () => {
      let page = await openAndLoad("pdf-link.html");
      let tries = 0;
      await waitFor("the link to open the PDF", () => {
        if (page.browser.currentURI?.spec != PDF && tries++ % 20 == 0) {
          pageMouse(page.browser, [["mousedown", 40, 40, 0], ["mouseup", 40, 40, 0]]);
        }
        return page.browser.currentURI?.spec == PDF;
      }, 30000);
      await viewerShows(page, "a clicked PDF link");
      Seijaku.closeTab(page);
    });

    await check("an old seijaku:pdf address opens the PDF itself", async () => {
      let old = Seijaku.openTab("seijaku:pdf#url=" + encodeURIComponent(PDF));
      await viewerShows(old, "an old seijaku:pdf address");
      Seijaku.closeTab(old);
    });

    await check("no PDF went to the downloads", async () => {
      let added = (await list.getAll()).slice(downloadsBefore).map(d => d.source.url);
      assert(!added.length, added.join(", "));
    });

    if (pdf) {
      Seijaku.closeTab(pdf);
    }
  }

  /* Extensions: a test extension (tests/smoke/extension, installed as
     a temporary add-on, so it needs no signature) drives the tabs,
     windows and browserAction APIs and reports back; then uBlock
     Origin is installed from addons.mozilla.org the way the site's
     "Add to Firefox" button does it, and has to block an ad. */
  async function extensionChecks() {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const TEST_BUTTON = "ext-btn-smoke-test_seijaku_browser";
    const UBO_BUTTON = "ext-btn-ublock0_raymondhill_net";
    const badgeOf = id => document.getElementById(id)?.querySelector(".ext-badge")?.textContent ?? "";
    const popupBrowser = () => document.getElementById("ext-popup-browser");

    async function closePopup() {
      document.getElementById("ext-popup-panel").hidePopup();
      await waitFor("the popup to close", () => !popupBrowser());
    }

    // Engine errors behind an extension's "An unexpected error occurred"
    // only reach the console service; copy them into the log.
    let seen = new Set();
    Services.console.registerListener({
      observe(message) {
        let text = message.message ?? "";
        if (message instanceof Ci.nsIScriptError) {
          text = `${message.errorMessage} (${message.sourceName}:${message.lineNumber})`;
          if (message.stack) {
            text += `\n${message.stack}`;
          }
        }
        if (/extension|ext-|seijaku/i.test(text) && !seen.has(text)) {
          seen.add(text);
          dump(`Seijaku smoke console: ${text.replace(/\n/g, " | ")}\n`);
        }
      },
    });

    await check("an extension's background page starts and its button appears", async () => {
      let dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      dir.initWithPath(Services.prefs.getStringPref("seijaku.smoke.extension"));
      await AddonManager.installTemporaryAddon(dir);
      await waitFor("the extension's button", () => document.getElementById(TEST_BUTTON));
      await waitFor("the badge the background page sets", () => badgeOf(TEST_BUTTON) == "on");
    });

    let target;
    await check("extension tabs and windows APIs", async () => {
      target = await openAndLoad("ext-target.html");
      let resultTab = await waitFor(
        "the extension's report",
        () => Seijaku.tabs.find(t => t.url.startsWith(BASE + "ext-result.html#")),
        30000
      );
      let report = JSON.parse(decodeURIComponent(resultTab.url.split("#")[1]));
      Seijaku.closeTab(resultTab);
      let failed = Object.entries(report).filter(([, v]) => !v.startsWith("ok"));
      assert(Object.keys(report).length >= 8, `only ${Object.keys(report).length} results`);
      assert(!failed.length, failed.map(([k, v]) => `${k}: ${v}`).join("; "));
      return Object.keys(report).join(", ");
    });

    await check("an extension's badge and popup in the strip", async () => {
      Seijaku.selectTab(target);
      await waitFor("the tab's own badge", () => badgeOf(TEST_BUTTON) == "42");
      document.getElementById(TEST_BUTTON).click();
      let popup = await waitFor("the popup page", () => popupBrowser()?.contentTitle?.startsWith("popup:") && popupBrowser(), 20000);
      let title = popup.contentTitle;
      await closePopup();
      assert(title == "popup:ok", title);
      return title;
    });

    await check("addons.mozilla.org is allowed to install extensions", () => {
      let amo = Services.scriptSecurityManager.createContentPrincipalFromOrigin("https://addons.mozilla.org");
      assert(
        Services.perms.testPermissionFromPrincipal(amo, "install") == Services.perms.ALLOW_ACTION,
        "no install permission (defaults/permissions not read)"
      );
      assert(AddonManager.isInstallAllowed("application/x-xpinstall", amo), "AddonManager refuses AMO");
    });

    await check("uBlock Origin installs from addons.mozilla.org, after its prompt", async () => {
      let amo = Seijaku.openTab("https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/");
      await waitFor(
        "addons.mozilla.org to load",
        () => amo.browser?.currentURI?.host == "addons.mozilla.org" && !amo.el.hasAttribute("busy"),
        60000
      );
      // What the site's button does through navigator.mozAddonManager.
      let { id } = await AddonManager.webAPI.createInstall(amo.browser, {
        url: "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi",
        triggeringPrincipal: amo.browser.contentPrincipal,
        sourceHost: "addons.mozilla.org",
        sourceURL: amo.browser.currentURI.spec,
      });
      let done = AddonManager.webAPI.addonInstallDoInstall(amo.browser, id);
      done.catch(() => {});
      let prompt = await waitFor("the permission prompt", () => Seijaku._extPrompts?.[0], 120000);
      assert(/uBlock/.test(prompt.title), prompt.title);
      Seijaku.answerExtensionPrompt(true);
      await done;
      let addon = await AddonManager.getAddonByID("uBlock0@raymondhill.net");
      assert(addon?.isActive, "uBlock Origin is not active");
      Seijaku.closeTab(amo);
      return `${addon.version}; prompt listed ${prompt.lines.length} permissions`;
    });

    let ads;
    await check("uBlock Origin blocks an ad and counts it on its badge", async () => {
      await waitFor("uBlock Origin's button", () => document.getElementById(UBO_BUTTON), 30000);
      // Its filter lists compile on first run; until then, try again.
      // uBlock Origin swaps adsbygoogle.js for its own stand-in rather
      // than failing it, so the proof is its count of blocked requests.
      let badge = await waitFor(
        "a blocked count on uBlock Origin's badge",
        async () => {
          if (ads) {
            Seijaku.closeTab(ads);
          }
          ads = await openAndLoad("ads.html");
          for (let i = 0; i < 10; i++) {
            await sleep(500);
            let count = badgeOf(UBO_BUTTON);
            if (/^[1-9]\d*$/.test(count)) {
              return count;
            }
          }
          return false;
        },
        120000
      );
      return `badge ${badge}, page says ${ads.title}`;
    });

    await check("uBlock Origin's popup opens", async () => {
      Seijaku.selectTab(ads);
      document.getElementById(UBO_BUTTON).click();
      let popup = await waitFor(
        "the popup to lay out",
        () => {
          let b = popupBrowser();
          return b?.currentURI?.spec.includes("popup") && parseInt(b.style.width) > 160 && b;
        },
        30000
      );
      let size = `${popup.style.width} × ${popup.style.height}`;
      await closePopup();
      return size;
    });
  }

  window.addEventListener("load", () => {
    setTimeout(async () => {
      try {
        await run();
      } catch (e) {
        results.push({ name: "smoke test harness", ok: false, detail: String(e?.message || e) });
      }
      try {
        await IOUtils.writeJSON(RESULTS_FILE, results);
      } finally {
        Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
      }
    }, 0);
  }, { once: true });
})();
