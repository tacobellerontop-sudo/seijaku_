/* Bookmarks manager: lists what the shell stored, nothing else.
   Clicking a row opens it in a new tab; Remove drops it from the
   store (the page itself never writes the file). */

"use strict";

const shellWindow = () => window.browsingContext.topChromeWindow;

function render() {
  let shell = shellWindow()?.Seijaku;
  let list = document.getElementById("list");
  let empty = document.getElementById("empty");
  list.replaceChildren();
  let marks = shell?.getBookmarks() ?? [];
  empty.hidden = marks.length != 0;
  for (let mark of marks) {
    let row = document.createElement("div");
    row.className = "row";
    let main = document.createElement("div");
    main.className = "row-main";
    let title = document.createElement("div");
    title.className = "row-title";
    title.textContent = mark.title || mark.url;
    let url = document.createElement("div");
    url.className = "row-url";
    url.textContent = mark.url;
    main.append(title, url);
    main.addEventListener("click", () => shell.openTab(mark.url, { afterCurrent: true }));
    let remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      shell.removeBookmark(mark.url);
      render();
    });
    row.append(main, remove);
    list.append(row);
  }
}

window.addEventListener("DOMContentLoaded", render);
