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
      for (let name of ["Select", "Finder", "UAWidgets", "AudioPlayback", "SeijakuReader"]) {
        wg.getActor(name);
      }
      return "Select, Finder, UAWidgets, AudioPlayback, SeijakuReader";
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
