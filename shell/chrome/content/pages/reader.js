/* Reader view: renders the article the shell extracted with the
   engine's Readability module (or its naive fallback), with
   font-size controls. The article lives on the shell, never on disk,
   so this page just reads it and renders it. */

"use strict";

const shellWindow = () => window.browsingContext.topChromeWindow;

let fontSize = 17;

function applySize() {
  document.getElementById("article").style.fontSize = `${fontSize}px`;
}

window.addEventListener("DOMContentLoaded", () => {
  let shell = shellWindow()?.Seijaku;
  let article = null;
  try {
    article = shell?.getReaderArticle() ?? null;
  } catch (e) {
    article = null;
  }
  if (!article?.content) {
    document.getElementById("reader-error").hidden = false;
    document.getElementById("reader-back").addEventListener("click", () => {
      // Nothing to go back to: the bar button just closes this tab.
      try {
        shell?.closeTab();
      } catch (e) { /* staying put is fine */ }
    });
    return;
  }
  document.getElementById("reader-title").textContent = article.title || "Reader";
  if (article.byline) {
    let byline = document.getElementById("reader-byline");
    byline.textContent = article.byline;
    byline.hidden = false;
  }
  // Readability's output is already cleaned; it is the article's own
  // markup, not anything the user typed.
  document.getElementById("reader-content").innerHTML = article.content;
  document.getElementById("article").hidden = false;
  applySize();
  document.getElementById("reader-smaller").addEventListener("click", () => {
    fontSize = Math.max(13, fontSize - 1);
    applySize();
  });
  document.getElementById("reader-larger").addEventListener("click", () => {
    fontSize = Math.min(26, fontSize + 1);
    applySize();
  });
  document.getElementById("reader-back").addEventListener("click", () => {
    if (!article.url) {
      return;
    }
    try {
      shell.load(window.browsingContext.top.embedderElement, article.url);
    } catch (e) { /* staying put is fine */ }
  });
});
