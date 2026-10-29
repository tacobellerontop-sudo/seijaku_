/* Downloads manager: renders the engine's own download list,
   polled so progress moves while the page is open. Remove takes a
   download off this list only — it never deletes the file. */

"use strict";

const shellWindow = () => window.browsingContext.topChromeWindow;

function sizeText(bytes) {
  if (bytes == null || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1048576) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function stateText(state) {
  switch (state) {
    case "finished":
      return "Finished";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return "Downloading…";
  }
}

function render() {
  let shell = shellWindow()?.Seijaku;
  if (!shell) {
    return;
  }
  let list = document.getElementById("list");
  let empty = document.getElementById("empty");
  let note = document.getElementById("unavailable");
  note.hidden = shell.downloadsReady();
  let downloads = shell.getDownloads();
  // Only rebuild when something changed, so progress updates don't
  // tear the list down (and steal focus) every half second.
  let key = JSON.stringify(downloads);
  if (key == render._last) {
    return;
  }
  render._last = key;
  list.replaceChildren();
  empty.hidden = downloads.length != 0 || !shell.downloadsReady();
  for (let dl of downloads) {
    let row = document.createElement("div");
    row.className = "row";
    let main = document.createElement("div");
    main.className = "row-main";
    let name = document.createElement("div");
    name.className = "row-title";
    name.textContent = dl.name || dl.path || "Download";
    let meta = document.createElement("div");
    meta.className = "row-meta";
    let parts = [stateText(dl.state)];
    if (dl.state == "downloading") {
      parts.push(`${dl.progress}%`);
    }
    let sizes = [sizeText(dl.current), dl.total > 0 ? sizeText(dl.total) : ""]
      .filter(Boolean)
      .join(" of ");
    if (sizes) {
      parts.push(sizes);
    }
    meta.textContent = parts.join("  ·  ");
    main.append(name, meta);
    row.append(main);
    let act = (label, action) => {
      let button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => shell.downloadAction(dl.path, action));
      row.append(button);
    };
    if (dl.state == "downloading") {
      act("Cancel", "cancel");
    }
    if (dl.state == "finished") {
      act("Open", "open");
      act("Show in folder", "reveal");
    }
    act("Remove", "remove");
    list.append(row);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  render();
  setInterval(render, 500);
});
