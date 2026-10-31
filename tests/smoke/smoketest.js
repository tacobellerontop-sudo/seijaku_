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
      // The same badge call as the background page's, from here, so a
      // failure shows its real error.
      try {
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        let extension = ExtensionParent.GlobalManager.getExtension("smoke-test@seijaku.browser");
        ExtensionParent.apiManager.global.browserActionFor(extension).setProperty(null, "badgeText", "on");
        // How the background page's own calls resolve.
        let { ParentAPIManager, apiManager } = ExtensionParent;
        let ctx = [...ParentAPIManager.proxyContexts.values()].find(c => c.extension === extension && c.isBackgroundContext);
        let can = ctx?.apiCan;
        let fn = can && (await can.asyncFindAPIPath("browserAction.setBadgeText"));
        const { Schemas } = ChromeUtils.importESModule("resource://gre/modules/Schemas.sys.mjs");
        var diag = (`ctx=${!!ctx} fn=${typeof fn} apis=${can && [...can.apis.keys()]} ` +
          `root.browserAction=${can && Object.keys(can.root.browserAction ?? {})} ` +
          `checkGet=${apiManager._checkGetAPI("browserAction", extension, "addon_parent")} ` +
          `schemaPerm=${Schemas.checkPermissions("browserAction", extension)} ` +
          `module=${JSON.stringify(apiManager.getModule("browserAction"))}`);
        try {
          let api = apiManager.getAPI("browserAction", extension, "addon_parent");
          diag += ` action=${!!api.action}`;
          diag += ` getAPI=${Object.keys(api.getAPI(ctx))}`;
        } catch (e) {
          diag += ` getAPI threw: ${e} | ${String(e?.stack).replace(/\n/g, " | ")}`;
        }
      } catch (e) {
        throw new Error(`direct badge call: ${e} | ${String(e?.stack).replace(/\n/g, " | ")}`);
      }
      try {
        await waitFor("the badge the background page sets", () => badgeOf(TEST_BUTTON) == "on");
      } catch (e) {
        throw new Error(`${e.message}; ${diag}`);
      }
      return diag;
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
      await waitFor(
        "the ad script to be blocked",
        async () => {
          if (ads) {
            Seijaku.closeTab(ads);
          }
          ads = await openAndLoad("ads.html");
          await sleep(500);
          return ads.title == "ads:blocked";
        },
        120000
      );
      let badge = await waitFor("a blocked count on the badge", () => /^[1-9]\d*$/.test(badgeOf(UBO_BUTTON)) && badgeOf(UBO_BUTTON), 20000);
      return `badge ${badge}`;
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
