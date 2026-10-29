/* Seijaku themes. Ink (dark, default) and paper (light) first, then
   three more in the same language, then "custom": three colours the
   user picks in Settings, with everything else falling back to ink so
   a custom theme can never come out unreadable. One accent per theme,
   always. */

export const THEMES = {
  ink: {
    barBg: "#171310",
    fg: "#ece4d3",
    tabSelectedFg: "#fff8ea",
    accent: "#d8442a",
    muted: "#9a9082",
    line: "#2e2620",
    error: "#e07b7b",
  },
  paper: {
    barBg: "#f4f1e8",
    fg: "#1c1a17",
    tabSelectedFg: "#1c1a17",
    accent: "#c23a22",
    muted: "#7a766c",
    line: "#d8d0bd",
    error: "#b3261e",
  },
  matcha: {
    barBg: "#161a13",
    fg: "#e6ead9",
    tabSelectedFg: "#f6f9ec",
    accent: "#a3b86b",
    muted: "#8d9482",
    line: "#2a2f22",
    error: "#e07b7b",
  },
  sakura: {
    barBg: "#faf3f0",
    fg: "#2b1d1d",
    tabSelectedFg: "#2b1d1d",
    accent: "#d4626e",
    muted: "#8a7a76",
    line: "#e0d2cc",
    error: "#b3261e",
  },
  ai: {
    barBg: "#12141f",
    fg: "#e2e6f2",
    tabSelectedFg: "#ffffff",
    accent: "#6f7fd4",
    muted: "#8a8fa8",
    line: "#262a3d",
    error: "#e07b7b",
  },
};

export function applyColors(element, theme = "ink", custom = null) {
  let t = THEMES[theme] ?? THEMES.ink;
  if (theme == "custom" && custom) {
    // Only the colours the user actually picked; the rest stay ink.
    t = { ...THEMES.ink, ...custom };
  }
  element.style.setProperty("--bar-bg", t.barBg);
  element.style.setProperty("--fg", t.fg);
  element.style.setProperty("--tab-selected-fg", t.tabSelectedFg);
  element.style.setProperty("--accent", t.accent);
  element.style.setProperty("--muted", t.muted);
  element.style.setProperty("--line", t.line);
  element.style.setProperty("--error", t.error);
  // Light or dark follows the bar colour itself, so a light custom
  // theme gets light form controls without a special case per theme.
  let light = false;
  let hex = /^#([0-9a-f]{6})$/i.exec(t.barBg || "");
  if (hex) {
    let r = parseInt(hex[1].slice(0, 2), 16);
    let g = parseInt(hex[1].slice(2, 4), 16);
    let b = parseInt(hex[1].slice(4, 6), 16);
    light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
  }
  element.style.setProperty("color-scheme", light ? "light" : "dark");
}
