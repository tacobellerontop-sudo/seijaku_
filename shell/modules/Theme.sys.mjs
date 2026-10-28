/* Seijaku themes. Two only, on purpose: ink (dark, default) and paper
   (light). One accent in both: vermilion. */

export const THEMES = {
  ink: {
    barBg: "#14161c",
    fg: "#e8e6df",
    tab: "#1a1d24",
    tabSelected: "#23262f",
    tabSelectedFg: "#ffffff",
    accent: "#d8442a",
    muted: "#8a8d96",
    error: "#e07b7b",
  },
  paper: {
    barBg: "#f4f1e8",
    fg: "#1c1a17",
    tab: "#ece8db",
    tabSelected: "#ffffff",
    tabSelectedFg: "#1c1a17",
    accent: "#c23a22",
    muted: "#7a766c",
    error: "#b3261e",
  },
};

export function applyColors(element, theme = "ink") {
  let t = THEMES[theme] ?? THEMES.ink;
  element.style.setProperty("--bar-bg", t.barBg);
  element.style.setProperty("--fg", t.fg);
  element.style.setProperty("--tab", t.tab);
  element.style.setProperty("--tab-selected", t.tabSelected);
  element.style.setProperty("--tab-selected-fg", t.tabSelectedFg);
  element.style.setProperty("--accent", t.accent);
  element.style.setProperty("--muted", t.muted);
  element.style.setProperty("--error", t.error);
  element.style.setProperty("color-scheme", theme == "paper" ? "light" : "dark");
}
