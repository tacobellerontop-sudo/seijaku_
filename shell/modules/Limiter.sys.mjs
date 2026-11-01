/* Seijaku's RAM and CPU limiter (Settings > Performance), both off by
   default. One limiter for the whole browser: memory and processor
   time are counted across every Seijaku process (the main one, each
   page's, the GPU's), not per window.

   What Gecko can and can't enforce, honestly:
   - The engine has no switch to cap a process's memory or processor
     share. So the limiter measures (ChromeUtils.requestProcInfo, the
     numbers about:processes shows) and acts the one way a browser
     can: it puts background tabs to sleep, exactly like the 15-minute
     idle sleep, least recently used first. A sleeping tab keeps its
     place and address and reloads when clicked.
   - RAM: while the total is over the cap, one background tab sleeps
     per check (every 10 seconds), until the total is under it.
   - CPU: while the limiter is on, background tabs' timers get a much
     smaller time budget than the engine's default (pages you aren't
     looking at may run their scripts at most about 0.5% of the time,
     instead of 1%). If the total stays over the cap for 30 seconds,
     the busiest background page's tab goes to sleep.
   - The tab you're looking at is never slowed or slept, nor are
     pinned tabs, tabs playing sound, a sign-in popup and its page,
     or a tab you left less than 30 seconds ago. If those alone are
     over the cap, the limiter can't do anything about it. */

import { setInterval, clearInterval } from "resource://gre/modules/Timer.sys.mjs";

const PREF = "seijaku.limiter.";
const TICK_MS = 10 * 1000;
// Checks in a row over the CPU cap before a tab is slept.
const CPU_STRIKES = 3;
// At most one "put to sleep" message per window per this long.
const NOTICE_MS = 60 * 1000;

// Background timer budget while the CPU limiter is on (engine defaults
// in brackets): a background page earns 1 ms of script time per 200 ms
// [100], may bank at most 10 ms [50], and is throttled 5 s after it
// loads [30 s]. The engine applies these to tabs that are not visible
// and aren't playing sound or holding a live connection.
const THROTTLE_PREFS = {
  "dom.timeout.background_budget_regeneration_rate": 200,
  "dom.timeout.background_throttling_max_budget": 10,
  "dom.timeout.throttling_delay": 5000,
};

export const RAM_CHOICES_MB = [1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384];
export const CPU_CHOICES = [10, 20, 30, 40, 50, 60, 70, 80, 90];

/** Logical processors, for turning processor time into a share. */
export function cpuCount() {
  try {
    return Math.max(1, Services.sysinfo.getProperty("cpucount"));
  } catch (e) {
    return 1;
  }
}

/** Physical memory in bytes, or 0 if unknown. */
export function systemMemory() {
  try {
    return Number(Services.sysinfo.getProperty("memsize")) || 0;
  } catch (e) {
    return 0;
  }
}

/** One reading: total memory (bytes), total processor time (ns) and
    each child process's processor time, across all of Seijaku. */
export async function measure() {
  let info = await ChromeUtils.requestProcInfo();
  let memory = info.memory;
  let cpuTime = info.cpuTime;
  let perPid = new Map();
  for (let child of info.children) {
    memory += child.memory;
    cpuTime += child.cpuTime;
    perPid.set(child.pid, child.cpuTime);
  }
  return { at: Date.now(), memory, cpuTime, perPid };
}

/** The share of the whole machine's processor Seijaku used between two
    readings, 0–100. Processes that quit in between can make the total
    drop; that reads as 0, never negative. */
export function cpuPercent(prev, cur) {
  let wallNs = prev ? (cur.at - prev.at) * 1e6 : 0;
  if (wallNs <= 0) {
    return 0;
  }
  let used = Math.max(0, cur.cpuTime - prev.cpuTime);
  return Math.min(100, (used / (wallNs * cpuCount())) * 100);
}

export const Limiter = {
  _started: false,
  _timer: null,
  _last: null,
  _strikes: 0,
  _busy: false,
  // A tab left less than this long ago is never slept (the smoke test
  // lowers it).
  minIdleMs: 30 * 1000,

  /** Called by every window; only the first call does anything. */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    Services.prefs.addObserver(PREF, this);
    this.apply();
  },

  observe(subject, topic, data) {
    if (topic == "nsPref:changed") {
      this.apply();
    }
  },

  enabled(kind) {
    return Services.prefs.getBoolPref(PREF + kind + ".enabled", false);
  },

  ramCapBytes() {
    return Math.max(1, Services.prefs.getIntPref(PREF + "ram.mb", 2048)) * 1024 * 1024;
  },

  cpuCap() {
    return Math.min(100, Math.max(1, Services.prefs.getIntPref(PREF + "cpu.percent", 50)));
  },

  /** Follows the prefs: the background timer budget, and the check
      timer, which only runs while a limit is on. */
  apply() {
    let ram = this.enabled("ram");
    let cpu = this.enabled("cpu");
    for (let [name, value] of Object.entries(THROTTLE_PREFS)) {
      try {
        if (cpu) {
          Services.prefs.setIntPref(name, value);
        } else if (Services.prefs.prefHasUserValue(name)) {
          Services.prefs.clearUserPref(name);
        }
      } catch (e) { /* that one budget just stays the engine's */ }
    }
    if ((ram || cpu) && !this._timer) {
      this._timer = setInterval(() => this.tick().catch(e => console.error("Seijaku limiter", e)), TICK_MS);
    } else if (!ram && !cpu && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._last = null;
    this._strikes = 0;
  },

  /** Every background tab the limiter may sleep, across all ordinary
      windows, with the process its page runs in. */
  candidates() {
    let now = Date.now();
    let list = [];
    for (let win of Services.wm.getEnumerator("seijaku:main")) {
      let S = win.Seijaku;
      if (!S || S.isPopup || !S._initDone || win.closed) {
        continue;
      }
      let linked = S.linkedTabs();
      for (let tab of S.tabs) {
        if (!S.mayAutoSleep(tab, linked) || now - tab.lastActive < this.minIdleMs) {
          continue;
        }
        let pid = 0;
        try {
          pid = tab.browser.browsingContext?.currentWindowGlobal?.osPid ?? 0;
        } catch (e) { /* no process known: only the RAM limit may pick it */ }
        list.push({ win, tab, pid });
      }
    }
    return list;
  },

  /** Sleeps the least recently used tab of the list. */
  sleepOne(list, reason) {
    list.sort((a, b) => a.tab.lastActive - b.tab.lastActive);
    for (let { win, tab } of list) {
      let S = win.Seijaku;
      if (S.sleep(tab)) {
        S.saveSession();
        let now = Date.now();
        if (!(now - (S._limiterNoticeAt || 0) < NOTICE_MS)) {
          S._limiterNoticeAt = now;
          S.showMessage(`"${tab.title || tab.url}" asleep to keep Seijaku under its ${reason} limit`);
        }
        return tab;
      }
    }
    return null;
  },

  /** One check: measures, and sleeps at most one tab. Returns the tab
      it slept, if any. */
  async tick() {
    if (this._busy) {
      return null;
    }
    this._busy = true;
    try {
      let ram = this.enabled("ram");
      let cpu = this.enabled("cpu");
      if (!ram && !cpu) {
        return null;
      }
      let cur = await measure();
      let prev = this._last;
      this._last = cur;
      if (ram && cur.memory > this.ramCapBytes()) {
        let slept = this.sleepOne(this.candidates(), "RAM");
        if (slept) {
          this._strikes = 0;
          return slept;
        }
      }
      if (!cpu || !prev) {
        return null;
      }
      if (cpuPercent(prev, cur) <= this.cpuCap()) {
        this._strikes = 0;
        return null;
      }
      if (++this._strikes < CPU_STRIKES) {
        return null;
      }
      this._strikes = 0;
      // The busiest page process first; its least recently used
      // background tab goes to sleep (pages of one site share a
      // process, so the process is as close as the engine can say).
      let busiest = [...cur.perPid]
        .map(([pid, t]) => [pid, t - (prev.perPid.get(pid) ?? 0)])
        .filter(([, used]) => used > 0)
        .sort((a, b) => b[1] - a[1]);
      let list = this.candidates();
      for (let [pid] of busiest) {
        let inProcess = list.filter(c => c.pid == pid);
        if (inProcess.length) {
          return this.sleepOne(inProcess, "CPU");
        }
      }
      return null;
    } finally {
      this._busy = false;
    }
  },
};
