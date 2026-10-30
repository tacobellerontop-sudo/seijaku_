/* Downloads manager: renders the engine's own download list plus the
   shell's stored history (see seijaku.js: the engine list in this
   shell is session-only, so finished downloads are recorded in
   seijaku-data.json and merged here), polled so progress moves while
   the page is open. Remove takes a download off this list only — it
   never deletes the finished file (for unfinished entries it also
   drops the partial file). Speed and time left come from the change
   in bytes between polls, page-side. */

"use strict";

const shellWindow = () => window.browsingContext.topChromeWindow;

// Last poll's { time, current } per download key, for speed/ETA.
// Kept outside the render key on purpose: speed changes must not
// rebuild rows (and steal focus) by themselves.
let prev = new Map();

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
    case "paused":
      return "Paused";
    default:
      return "Downloading…";
  }
}

function etaText(seconds) {
  if (!isFinite(seconds) || seconds < 0) {
    return "";
  }
  seconds = Math.round(seconds);
  if (seconds < 60) {
    return `${seconds}s left`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m left`;
}

// The meta line under each row, by download key, so a progress-only
// change rewrites text instead of rebuilding the rows.
let metaEls = new Map();

function metaText(dl, now) {
  let parts = [stateText(dl.state)];
  if (dl.state == "downloading") {
    parts.push(`${dl.progress}%`);
    // Speed from this poll's delta; ETA from speed and remainder.
    let last = prev.get(dl.key);
    prev.set(dl.key, { time: now, current: dl.current });
    if (last) {
      let dt = (now - last.time) / 1000;
      let db = dl.current - last.current;
      if (dt > 0 && db > 0) {
        let speed = db / dt;
        parts.push(`${sizeText(speed)}/s`);
        if (dl.total > 0) {
          let eta = etaText((dl.total - dl.current) / speed);
          if (eta) {
            parts.push(eta);
          }
        }
      }
    }
  } else {
    prev.delete(dl.key);
  }
  let sizes = [sizeText(dl.current), dl.total > 0 ? sizeText(dl.total) : ""]
    .filter(Boolean)
    .join(" of ");
  if (sizes) {
    parts.push(sizes);
  }
  return parts.join("  ·  ");
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
  let query = (document.getElementById("search").value || "").trim().toLowerCase();
  let shown = query
    ? downloads.filter(d =>
        `${d.name || ""} ${d.path || ""} ${d.source || ""}`.toLowerCase().includes(query)
      )
    : downloads;
  let now = Date.now();
  // Rows are rebuilt only when the list itself changes (an entry, a
  // state, the search). Progress alone just rewrites each meta line:
  // rebuilding every half second while a download ran replaced the
  // buttons under the pointer, so a click on Pause or Cancel could
  // land on a row that no longer existed.
  let key = JSON.stringify([query, shell.downloadsReady(), shown.map(({ progress, current, ...rest }) => rest)]);
  if (key == render._last) {
    for (let dl of shown) {
      let meta = metaEls.get(dl.key);
      let text = metaText(dl, now);
      if (meta && meta.textContent != text) {
        meta.textContent = text;
      }
    }
    return;
  }
  render._last = key;
  list.replaceChildren();
  metaEls.clear();
  empty.hidden = shown.length != 0 || !shell.downloadsReady();
  empty.textContent = query ? "Nothing matches that search." : "No downloads yet.";
  for (let dl of shown) {
    let row = document.createElement("div");
    row.className = "row";
    let main = document.createElement("div");
    main.className = "row-main";
    let name = document.createElement("div");
    name.className = "row-title";
    name.textContent = dl.name || dl.path || "Download";
    let meta = document.createElement("div");
    meta.className = "row-meta";
    meta.textContent = metaText(dl, now);
    metaEls.set(dl.key, meta);
    main.append(name, meta);
    row.append(main);
    let act = (label, action) => {
      let button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => shell.downloadAction(dl.key, action));
      row.append(button);
    };
    if (dl.state == "downloading") {
      // No Remove while active: Cancel stops it, and Remove appears
      // once it has stopped (removing a live transfer is the
      // engine's call, not a list edit).
      act("Pause", "pause");
      act("Cancel", "cancel");
    } else if (dl.state == "paused") {
      if (dl.canResume) {
        act("Resume", "resume");
      } else {
        act("Restart", "retry");
      }
      act("Cancel", "cancel");
      act("Remove", "remove");
    } else if (dl.state == "failed" || dl.state == "cancelled") {
      act("Retry", "retry");
      act("Remove", "remove");
    } else if (dl.state == "finished") {
      act("Open", "open");
      act("Show in folder", "reveal");
      // A stored entry's file may be gone; re-downloading it is the
      // point of keeping its source address.
      if (dl.stored) {
        act("Retry", "retry");
      }
      act("Remove", "remove");
    }
    list.append(row);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  let shell = shellWindow()?.Seijaku;
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("clear-finished").addEventListener("click", () => {
    shell?.clearFinishedDownloads();
    render();
  });
  document.getElementById("clear-all").addEventListener("click", () => {
    shell?.clearAllDownloads();
    render();
  });
  render();
  // Polling only matters while the page is on screen; a background
  // downloads tab stops working until it is selected again.
  setInterval(() => {
    if (!document.hidden) {
      render();
    }
  }, 500);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      render();
    }
  });
});
