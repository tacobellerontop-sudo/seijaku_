/* Seijaku home page, per the sketch: a greeting by the time of day,
   the search box, a FREQUENT row, counts down the left, and weather
   at the top right — all in the existing dot-art language.
   FREQUENT is user-chosen, not most-visited: it shows bookmarks in
   the "Frequent" folder, so the page never queries history to build
   itself (the stance this page has always kept). Counts come from
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

function renderFrequent() {
  let s = shell();
  if (!s) {
    return;
  }
  let list = document.getElementById("frequent-list");
  list.replaceChildren();
  let marks = s.getFrequentBookmarks();
  for (let mark of marks) {
    let item = document.createElement("button");
    item.type = "button";
    item.className = "freq-item";
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
    list.append(item);
  }
  let add = document.createElement("button");
  add.type = "button";
  add.className = "freq-item";
  add.title = "Add to Frequent from the bookmarks page";
  let tile = document.createElement("span");
  tile.className = "freq-tile";
  tile.textContent = "+";
  let name = document.createElement("span");
  name.className = "freq-name";
  name.textContent = "";
  add.append(tile, name);
  add.addEventListener("click", () => s.openPage("bookmarks"));
  list.append(add);
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
  document.getElementById("count-bookmarks-row").addEventListener("click", () => shell()?.openPage("bookmarks"));
  document.getElementById("count-history-row").addEventListener("click", () => shell()?.openPage("history"));
  document.getElementById("count-settings-row").addEventListener("click", () => shell()?.openPage("settings"));
});
