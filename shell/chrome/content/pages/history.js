/* History manager: the shell's own visit log, searchable. Clicking
   a row opens it in a new tab; Clear wipes the log (bookmarks are
   separate and stay). */

"use strict";

const shellWindow = () => window.browsingContext.topChromeWindow;

function render() {
  let shell = shellWindow()?.Seijaku;
  let list = document.getElementById("list");
  let empty = document.getElementById("empty");
  list.replaceChildren();
  let query = (document.getElementById("search").value || "").trim().toLowerCase();
  let entries = shell?.getHistory() ?? [];
  if (query) {
    entries = entries.filter(e =>
      `${e.title || ""} ${e.url}`.toLowerCase().includes(query)
    );
  }
  empty.hidden = entries.length != 0;
  for (let entry of entries) {
    let row = document.createElement("div");
    row.className = "row";
    let main = document.createElement("div");
    main.className = "row-main";
    let title = document.createElement("div");
    title.className = "row-title";
    title.textContent = entry.title || entry.url;
    let url = document.createElement("div");
    url.className = "row-url";
    url.textContent = entry.url;
    main.append(title, url);
    main.addEventListener("click", () => shell.openTab(entry.url, { afterCurrent: true }));
    let when = document.createElement("div");
    when.className = "row-meta";
    try {
      when.textContent = new Date(entry.at).toLocaleString();
    } catch (e) {
      when.textContent = "";
    }
    row.append(main, when);
    list.append(row);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("clear").addEventListener("click", () => {
    shellWindow()?.Seijaku?.clearHistory();
    render();
  });
  render();
});
