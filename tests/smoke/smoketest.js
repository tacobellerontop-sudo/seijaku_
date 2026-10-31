/* Seijaku smoke test. The Windows smoke workflow copies this into a
   packaged build, adds it to seijaku.xhtml after seijaku.js, and starts
   the browser headless. It drives the real shell against the pages in
   tests/smoke/pages (served on 127.0.0.1), writes smoke-results.json
   into the profile, and quits. It is never part of a release. */

"use strict";

(() => {
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

  async function check(name, fn) {
    try {
      let detail = await fn();
      results.push({ name, ok: true, detail: detail ?? "" });
    } catch (e) {
      results.push({ name, ok: false, detail: String(e?.message || e) });
    }
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

  /** Synthesizes mouse events inside a web page's own process, the way
      the engine's tests do (a chrome-side event does not reach a
      headless remote page): a frame script calls the page's
      windowUtils, so the page sees trusted events at x, y. */
  function pageMouse(browser, events) {
    let code = `(${(list => {
      for (let [type, x, y, button, modifiers] of list) {
        content.windowUtils.sendMouseEvent(type, x, y, button, 1, modifiers || 0);
      }
    }).toString()})(${JSON.stringify(events)});`;
    browser.messageManager.loadFrameScript("data:," + encodeURIComponent(code), false);
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
  }

  window.addEventListener("load", () => {
    setTimeout(async () => {
      try {
        await run();
      } catch (e) {
        results.push({ name: "smoke test harness", ok: false, detail: String(e?.message || e) });
      }
      try {
        await IOUtils.writeJSON(PathUtils.join(PathUtils.profileDir, "smoke-results.json"), results);
      } finally {
        Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
      }
    }, 0);
  }, { once: true });
})();
