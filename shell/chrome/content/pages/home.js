/* Seijaku home page, per the sketch: a greeting by the time of day,
   the search box, a BOOKMARKS row, counts down the left, and weather
   at the top right — all in the existing dot-art language.
   The row is user-chosen, not most-visited: it shows bookmarks (the
   "Frequent" folder first, + adds there), so the page never queries
   history to build itself (the stance this page has always kept). Counts come from
   the shell's in-memory data, again with no history query to build
   the row; they wait briefly for the data file to load. Weather
   comes from the shell too (Open-Meteo, no key); a failed fetch
   hides the widget quietly, and cached data keeps showing. */

"use strict";

const shellWindow = () => window.browsingContext.topChromeWindow;

function shell() {
  return shellWindow()?.Seijaku;
}

function go(text) {
  let s = shell();
  if (!s) {
    return;
  }
  let url;
  try {
    url = s.urlFor(text);
  } catch (e) {
    s.showMessage(e.message, "error");
    return;
  }
  s.load(window.browsingContext.top.embedderElement, url);
}

function showSleeping() {
  let s = shell();
  let el = document.getElementById("sleeping");
  let asleep = s?.tabs?.filter(tab => tab.asleep).length ?? 0;
  el.hidden = asleep == 0;
  if (asleep) {
    el.textContent = `${asleep} tab${asleep == 1 ? "" : "s"} asleep`;
  }
}

function renderGreeting() {
  let hour = new Date().getHours();
  let greeting = "Good morning.";
  let jp = "おはようございます";
  if (hour >= 22 || hour < 5) {
    greeting = "Good night.";
    jp = "おやすみなさい";
  } else if (hour >= 18) {
    greeting = "Good evening.";
    jp = "こんばんは";
  } else if (hour >= 12) {
    greeting = "Good afternoon.";
    jp = "こんにちは";
  }
  document.getElementById("greeting").textContent = greeting;
  document.getElementById("greeting-jp").textContent = jp;
}

function renderCounts() {
  let s = shell();
  if (!s) {
    return;
  }
  // The data file loads asynchronously; counts wait for it (a few
  // short retries) rather than flashing zeroes.
  if (!s.dataReady()) {
    if (renderCounts.tries < 20) {
      renderCounts.tries++;
      setTimeout(renderCounts, 150);
    }
    return;
  }
  document.getElementById("count-tabs").textContent = String(s.tabs?.length ?? 0);
  document.getElementById("count-bookmarks").textContent = String(s.getBookmarks().length);
  document.getElementById("count-history").textContent = String(s.getHistory().length);
  // FREQUENT also waits for the data file: re-render it now that
  // the bookmarks are actually loaded.
  renderFrequent();
}
renderCounts.tries = 0;

// The row under the search box: your bookmarks as shortcuts. Ones in
// the "Frequent" folder come first (that is where + puts them), then
// the newest of the rest, up to FREQUENT_MAX in all.
const FREQUENT_MAX = 8;

function renderFrequent() {
  let s = shell();
  if (!s) {
    return;
  }
  let list = document.getElementById("frequent-list");
  list.replaceChildren();
  let pinned = s.getFrequentBookmarks();
  let rest = s.getBookmarks().filter(b => (b.folder || "") != "Frequent");
  let marks = [...pinned, ...rest].slice(0, FREQUENT_MAX);
  for (let mark of marks) {
    let wrap = document.createElement("span");
    wrap.className = "freq-wrap";
    let item = document.createElement("button");
    item.type = "button";
    item.className = "freq-item";
    item.title = mark.url;
    let tile = document.createElement("span");
    tile.className = "freq-tile";
    tile.textContent = (mark.title || mark.url).trim().slice(0, 1).toUpperCase();
    let name = document.createElement("span");
    name.className = "freq-name";
    try {
      name.textContent = mark.title || new URL(mark.url).host || mark.url;
    } catch (e) {
      name.textContent = mark.title || mark.url;
    }
    item.append(tile, name);
    item.addEventListener("click", () => go(mark.url));
    let remove = document.createElement("button");
    remove.type = "button";
    remove.className = "freq-remove";
    remove.title = "Remove this bookmark";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      s.removeBookmark(mark.url);
      s.showMessage("Bookmark removed");
    });
    wrap.append(item, remove);
    list.append(wrap);
  }
  let add = document.createElement("button");
  add.type = "button";
  add.className = "freq-item";
  add.id = "frequent-add";
  add.title = "Add a bookmark here";
  let tile = document.createElement("span");
  tile.className = "freq-tile";
  tile.textContent = "+";
  add.append(tile);
  add.addEventListener("click", () => showAddForm(true));
  list.append(add);
}

/* The + button's small form: an address (and an optional name),
   saved as a bookmark in the Frequent folder. */
function showAddForm(open) {
  let form = document.getElementById("frequent-form");
  form.hidden = !open;
  if (open) {
    document.getElementById("frequent-url").value = "";
    document.getElementById("frequent-title").value = "";
    document.getElementById("frequent-url").focus();
  } else {
    document.getElementById("search").focus();
  }
}

function submitAddForm() {
  let s = shell();
  if (!s) {
    return;
  }
  let url = document.getElementById("frequent-url").value;
  let title = document.getElementById("frequent-title").value.trim();
  if (!url.trim()) {
    return;
  }
  try {
    s.addBookmark(url, title, "Frequent");
  } catch (e) {
    s.showMessage(e.message, "error");
    return;
  }
  showAddForm(false);
}

function refreshBookmarks() {
  let s = shell();
  if (s?.dataReady()) {
    document.getElementById("count-bookmarks").textContent = String(s.getBookmarks().length);
  }
  renderFrequent();
}

function renderWeather(data) {
  let widget = document.getElementById("weather");
  if (!data) {
    widget.hidden = true;
    return;
  }
  let days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  let months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  let now = new Date();
  document.getElementById("weather-date").textContent =
    `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]}`;
  document.getElementById("weather-temp").textContent = `${data.temp}°C ${data.mark || ""}`.trim();
  document.getElementById("weather-cond").textContent = data.word || "";
  document.getElementById("weather-city").textContent = data.city || "";
  widget.hidden = false;
}

function loadWeather() {
  let s = shell();
  if (!s || !s.weatherEnabled()) {
    document.getElementById("weather").hidden = true;
    return;
  }
  let cached = null;
  try {
    cached = s.getWeather();
  } catch (e) { /* no cached weather, the fetch below decides */ }
  if (cached) {
    renderWeather(cached);
  }
  try {
    let done = s.refreshWeather();
    if (done && done.then) {
      done.then(data => {
        if (data) {
          renderWeather(data);
        } else if (!cached) {
          document.getElementById("weather").hidden = true;
        }
      }).catch(() => {
        if (!cached) {
          document.getElementById("weather").hidden = true;
        }
      });
    }
  } catch (e) {
    if (!cached) {
      document.getElementById("weather").hidden = true;
    }
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
  input.focus();
  renderGreeting();
  renderCounts();
  renderFrequent();
  loadWeather();
  showSleeping();
  document.getElementById("frequent-form").addEventListener("submit", event => {
    event.preventDefault();
    submitAddForm();
  });
  document.getElementById("frequent-cancel").addEventListener("click", () => showAddForm(false));
  document.getElementById("frequent-form").addEventListener("keydown", event => {
    if (event.key == "Escape") {
      showAddForm(false);
    }
  });
  // The shell says when bookmarks change (Ctrl+D in another tab, the
  // bookmarks page, the + form), so the row is never stale.
  window.addEventListener("seijaku-bookmarks", refreshBookmarks);
  document.getElementById("count-bookmarks-row").addEventListener("click", () => shell()?.openPage("bookmarks"));
  document.getElementById("count-history-row").addEventListener("click", () => shell()?.openPage("history"));
  document.getElementById("count-settings-row").addEventListener("click", () => shell()?.openPage("settings"));
});
