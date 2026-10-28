/* Seijaku themes. Two only, on purpose: ink (dark, default) and paper
   (light). One accent in both: vermilion. Ink is warm, like sumi on
   washi, not the cold blue-grey of 0.1.0. */

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
};

export function applyColors(element, theme = "ink") {
  let t = THEMES[theme] ?? THEMES.ink;
  element.style.setProperty("--bar-bg", t.barBg);
  element.style.setProperty("--fg", t.fg);
  element.style.setProperty("--tab-selected-fg", t.tabSelectedFg);
  element.style.setProperty("--accent", t.accent);
  element.style.setProperty("--muted", t.muted);
  element.style.setProperty("--line", t.line);
  element.style.setProperty("--error", t.error);
  element.style.setProperty("color-scheme", theme == "paper" ? "light" : "dark");
}
