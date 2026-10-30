/* Seijaku screenshots. The Screenshots workflow copies this into a
   packaged build, adds it to seijaku.xhtml after seijaku.js, and starts
   the browser in a real (not headless) window. It sets up a few scenes
   (home, the floating bar, the palette, settings, lists, the paper
   theme) and, for each one, asks run.ps1 to capture the screen through
   a request file in the profile. It is never part of a release. */

"use strict";

(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const request = () => PathUtils.join(PathUtils.profileDir, "shot-request.txt");

  /** Asks run.ps1 for a capture and waits until it is taken. */
  async function shot(name) {
    await sleep(900);
    await IOUtils.writeUTF8(request(), name);
    let start = Date.now();
    while (await IOUtils.exists(request())) {
      if (Date.now() - start > 20000) {
        throw new Error(`no capture for ${name}`);
      }
      await sleep(150);
    }
  }

  function seed() {
    let now = Date.now();
    let marks = [
      ["https://en.wikipedia.org/", "Wikipedia"],
      ["https://github.com/", "GitHub"],
      ["https://news.ycombinator.com/", "Hacker News"],
      ["https://www.youtube.com/", "YouTube"],
    ];
    for (let [url, title] of marks) {
      Seijaku._data.bookmarks.push({ url, title, added: now, folder: "Frequent" });
    }
    let visits = [
      ["https://en.wikipedia.org/wiki/Seijaku", "Seijaku - Wikipedia"],
      ["https://en.wikipedia.org/wiki/Wabi-sabi", "Wabi-sabi - Wikipedia"],
      ["https://github.com/mozilla-firefox/firefox", "mozilla-firefox/firefox"],
      ["https://developer.mozilla.org/en-US/docs/Web/CSS", "CSS: Cascading Style Sheets | MDN"],
      ["https://www.aozora.gr.jp/", "青空文庫 Aozora Bunko"],
    ];
    for (let [url, title] of visits) {
      Seijaku.recordHistory(url, title);
    }
    Seijaku.saveData();
  }

  async function run() {
    window.moveTo(0, 0);
    window.maximize();
    await sleep(1500);
    await waitForData();
    seed();
    for (let [title, body] of [
      ["Wabi-sabi - Wikipedia", "Wabi-sabi"],
      ["The quiet web", "A note"],
      ["mozilla-firefox/firefox", "Gecko"],
    ]) {
      Seijaku.openTab(`data:text/html,<title>${encodeURIComponent(title)}</title><p>${body}`, {
        asleep: true,
        title,
      });
    }
    let home = Seijaku.openTab("seijaku:home");
    await sleep(2500);
    await shot("01-home");

    Seijaku.showFloatingBar("wiki");
    await shot("02-floating-bar");
    Seijaku.hideFloatingBar();

    Seijaku.showPalette();
    let input = document.getElementById("palette-input");
    input.value = "se";
    input.dispatchEvent(new Event("input"));
    Seijaku.movePalette(1);
    await shot("03-palette");
    Seijaku.hidePalette();

    Seijaku.openPage("settings");
    await sleep(1500);
    await shot("04-settings");

    Seijaku.openPage("history");
    await sleep(1500);
    await shot("05-history");

    Seijaku.openPage("bookmarks");
    await sleep(1500);
    await shot("06-bookmarks");

    Services.prefs.setStringPref("seijaku.theme", "paper");
    Seijaku.selectTab(home);
    await sleep(1500);
    await shot("07-home-paper");

    Seijaku.showFloatingBar("wiki");
    await shot("08-floating-bar-paper");
    Seijaku.hideFloatingBar();

    Services.prefs.setStringPref("seijaku.theme", "ink");
    Services.prefs.setStringPref("seijaku.tabs.position", "left");
    await sleep(1500);
    await shot("09-tabs-left");
  }

  async function waitForData() {
    for (let i = 0; i < 100 && !Seijaku._data; i++) {
      await sleep(100);
    }
    if (!Seijaku._data) {
      Seijaku._data = { bookmarks: [], history: [], permissions: {}, folders: [], downloadsHistory: [] };
    }
  }

  window.addEventListener("load", () => {
    setTimeout(async () => {
      try {
        await run();
      } catch (e) {
        await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "shots-error.txt"), String(e?.stack || e));
      } finally {
        await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "shots-done.txt"), "done");
        Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
      }
    }, 0);
  }, { once: true });
})();
