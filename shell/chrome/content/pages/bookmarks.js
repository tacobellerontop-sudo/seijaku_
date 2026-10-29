/* Bookmarks manager: lists what the shell stored, nothing else.
   Clicking a row opens it in a new tab; Remove drops it from the
   store (the page itself never writes the file). Search filters by
   title or address, the folder filter groups by folder, and each
   row's folder dropdown moves it. Import merges, never wipes. */

"use strict";

const shellWindow = () => window.browsingContext.topChromeWindow;

function render() {
  let shell = shellWindow()?.Seijaku;
  let list = document.getElementById("list");
  let empty = document.getElementById("empty");
  list.replaceChildren();
  let query = (document.getElementById("search").value || "").trim().toLowerCase();
  let folder = document.getElementById("folder-filter").value || "all";
  let marks = shell?.getBookmarks() ?? [];
  if (folder != "all") {
    marks = marks.filter(m => (m.folder || "") == folder);
  }
  if (query) {
    marks = marks.filter(m =>
      `${m.title || ""} ${m.url}`.toLowerCase().includes(query)
    );
  }
  empty.hidden = marks.length != 0;
  // The folder dropdown lists All, then every folder the shell
  // knows (Reading list and Frequent are always offered).
  let filter = document.getElementById("folder-filter");
  let wanted = filter.value;
  let folders = shell?.getBookmarkFolders() ?? [];
  filter.replaceChildren();
  let all = document.createElement("option");
  all.value = "all";
  all.textContent = "All";
  filter.append(all);
  for (let f of folders) {
    let option = document.createElement("option");
    option.value = f;
    option.textContent = f;
    filter.append(option);
  }
  filter.value = ["all", ...folders].includes(wanted) ? wanted : "all";
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
    let move = document.createElement("select");
    move.title = "Move to a folder";
    let none = document.createElement("option");
    none.value = "";
    none.textContent = "All";
    move.append(none);
    for (let f of folders) {
      let option = document.createElement("option");
      option.value = f;
      option.textContent = f;
      move.append(option);
    }
    move.value = mark.folder || "";
    move.addEventListener("change", () => {
      shell.setBookmarkFolder(mark.url, move.value);
      render();
    });
    move.addEventListener("click", event => event.stopPropagation());
    let remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      shell.removeBookmark(mark.url);
      render();
    });
    row.append(main, move, remove);
    list.append(row);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  let shell = () => shellWindow()?.Seijaku;
  let status = document.getElementById("status");
  let say = text => (status.textContent = text);
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("folder-filter").addEventListener("change", render);
  document.getElementById("create-folder").addEventListener("click", () => {
    let input = document.getElementById("new-folder");
    let name = input.value.trim();
    if (!name) {
      return;
    }
    if (shell()?.createBookmarkFolder(name)) {
      input.value = "";
      say(`Folder "${name}" created.`);
    } else {
      say(`Couldn't create "${name}" — it may already exist.`);
    }
    render();
  });
  document.getElementById("export-html").addEventListener("click", async () => {
    try {
      let name = await shell()?.exportBookmarks("html");
      say(`Exported to Downloads as ${name}.`);
    } catch (e) {
      say(`Export failed: ${e.message}`);
    }
  });
  document.getElementById("export-json").addEventListener("click", async () => {
    try {
      let name = await shell()?.exportBookmarks("json");
      say(`Exported to Downloads as ${name}.`);
    } catch (e) {
      say(`Export failed: ${e.message}`);
    }
  });
  document.getElementById("import-file").addEventListener("click", async () => {
    try {
      let counts = await shell()?.importBookmarksFromFile();
      say(`Imported ${counts.added} bookmark${counts.added == 1 ? "" : "s"} (${counts.skipped} already here).`);
    } catch (e) {
      // A dismissed picker is not an error worth showing.
      if (!/cancel/i.test(e.message)) {
        say(`Import failed: ${e.message}`);
      }
    }
    render();
  });
  document.getElementById("import-browser-go").addEventListener("click", async () => {
    let browser = document.getElementById("import-browser").value;
    try {
      let counts = await shell()?.importBookmarksFromBrowser(browser);
      say(`Imported ${counts.added} bookmark${counts.added == 1 ? "" : "s"} (${counts.skipped} already here).`);
    } catch (e) {
      say(`Import failed: ${e.message}`);
    }
    render();
  });
  render();
});
