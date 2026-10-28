/* Seijaku home page: a search box, and nothing else that costs anything.
   No pinned sites, no most-visited list: both query history on every
   new tab, which is exactly the kind of quiet cost this browser refuses. */

"use strict";

const shellWindow = () => window.browsingContext.topChromeWindow;

function go(text) {
  let shell = shellWindow()?.Seijaku;
  if (!shell) {
    return;
  }
  let url;
  try {
    url = shell.urlFor(text);
  } catch (e) {
    shell.showMessage(e.message, "error");
    return;
  }
  shell.load(window.browsingContext.top.embedderElement, url);
}

function showSleeping() {
  let shell = shellWindow()?.Seijaku;
  let el = document.getElementById("sleeping");
  let asleep = shell?.tabs?.filter(tab => tab.asleep).length ?? 0;
  el.hidden = asleep == 0;
  if (asleep) {
    el.textContent = `${asleep} tab${asleep == 1 ? "" : "s"} asleep`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  let input = document.getElementById("search");
  document.getElementById("search-form").addEventListener("submit", event => {
    event.preventDefault();
    if (input.value.trim()) {
      go(input.value);
    }
  });
  document.getElementById("settings-link").addEventListener("click", event => {
    event.preventDefault();
    shellWindow()?.Seijaku?.openPage("settings");
  });
  input.focus();
  showSleeping();
});
