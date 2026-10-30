/* Seijaku tab icons, content side. Firefox finds a page's icon in its
   front end (LinkHandler), which the packager drops, so this small
   actor does the one part Seijaku needs: when a page is shown, read
   its <link rel="icon"> (or fall back to /favicon.ico) and send the
   address to the chrome window. It wakes only on pageshow, reads two
   attributes and sends one short message, so it costs nothing while
   a page runs. */

// Prefer an icon near the strip's 16px (32px for high-DPI screens);
// "any" (an SVG) scales, so it is as good as an exact size.
function score(link) {
  let sizes = (link.getAttribute("sizes") || "").toLowerCase();
  if (sizes == "any") {
    return 0;
  }
  let size = parseInt(sizes, 10);
  if (!size) {
    return 1;
  }
  return Math.abs(size - 32) / 32 + 0.5;
}

export class SeijakuIconChild extends JSWindowActorChild {
  handleEvent(event) {
    let doc = this.document;
    if (event.type != "pageshow" || !doc || event.target != doc) {
      return;
    }
    let url = doc.documentURIObject;
    if (!url || !/^https?$/.test(url.scheme)) {
      return;
    }
    let best = null;
    let bestScore = Infinity;
    for (let link of doc.querySelectorAll("link[rel][href]")) {
      let rel = link.rel.toLowerCase().split(/\s+/);
      if (!rel.includes("icon")) {
        continue;
      }
      let s = score(link);
      if (s < bestScore) {
        best = link;
        bestScore = s;
      }
    }
    let href = best?.href || url.prePath + "/favicon.ico";
    this.sendAsyncMessage("Icon", { href });
  }
}
