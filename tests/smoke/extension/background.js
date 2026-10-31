/* Runs once the smoke test opens ext-target.html, then reports every
   result by opening ext-result.html#<json>, which the smoke test reads. */
"use strict";

const created = [];
const removed = [];
const activated = [];
browser.tabs.onCreated.addListener(tab => created.push(tab.id));
browser.tabs.onRemoved.addListener(id => removed.push(id));
browser.tabs.onActivated.addListener(info => activated.push(info.tabId));
browser.browserAction.setBadgeText({ text: "on" });

let ran = false;
browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (ran || info.status != "complete" || !tab.url?.includes("ext-target.html")) {
    return;
  }
  ran = true;
  let results = {};
  async function check(name, fn) {
    try {
      results[name] = "ok:" + ((await fn()) ?? "");
    } catch (e) {
      results[name] = "fail:" + (e?.message || e);
    }
  }
  function assert(cond, message) {
    if (!cond) {
      throw new Error(message);
    }
  }
  let base = tab.url.replace(/ext-target\.html.*$/, "");

  await check("query", async () => {
    let [active] = await browser.tabs.query({ active: true, currentWindow: true });
    assert(active?.id == tabId, `active tab is ${active?.id}, not ${tabId}`);
    return active.title;
  });
  await check("get", async () => {
    let t = await browser.tabs.get(tabId);
    assert(t.url == tab.url && t.windowId == tab.windowId, JSON.stringify(t));
    return t.index;
  });
  await check("windows", async () => {
    let win = await browser.windows.getCurrent({ populate: true });
    assert(win.tabs.some(t => t.id == tabId), "tab missing from its window");
    let all = await browser.windows.getAll();
    assert(all.length >= 1, "no windows");
    return `${win.tabs.length} tabs`;
  });
  await check("executeScript", async () => {
    let [title] = await browser.tabs.executeScript(tabId, { code: "document.title" });
    assert(title == "ext-target", title);
    return title;
  });
  await check("sendMessage", async () => {
    let answer = await browser.tabs.sendMessage(tabId, "ping");
    assert(answer == "pong:ext-target", answer);
    return answer;
  });
  await check("badge", async () => {
    await browser.browserAction.setBadgeText({ text: "42", tabId });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#336699", tabId });
    let text = await browser.browserAction.getBadgeText({ tabId });
    assert(text == "42", text);
    return text;
  });
  await check("create, update, move, remove", async () => {
    let t = await browser.tabs.create({ url: base + "article.html", active: false });
    assert(!t.active, "background tab became active");
    await new Promise(r => setTimeout(r, 300));
    assert(created.includes(t.id), "no onCreated");
    let pinned = await browser.tabs.update(t.id, { pinned: true });
    assert(pinned.pinned && pinned.index == 0, `pinned at ${pinned.index}`);
    await browser.tabs.update(t.id, { pinned: false });
    let [moved] = await browser.tabs.move(t.id, { index: -1 });
    let count = (await browser.tabs.query({ currentWindow: true })).length;
    assert(moved.index == count - 1, `moved to ${moved.index} of ${count}`);
    await browser.tabs.remove(t.id);
    await new Promise(r => setTimeout(r, 300));
    assert(removed.includes(t.id), "no onRemoved");
    return t.id;
  });
  await check("activate", async () => {
    await browser.tabs.update(tabId, { active: true });
    await new Promise(r => setTimeout(r, 300));
    let t = await browser.tabs.get(tabId);
    assert(t.active, "not active");
    return activated.length;
  });

  await browser.tabs.create({ url: base + "ext-result.html#" + encodeURIComponent(JSON.stringify(results)), active: false });
  await browser.tabs.update(tabId, { active: true });
});
