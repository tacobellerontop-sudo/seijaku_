/* Seijaku tab icons, content side. Firefox finds a page's icon in its
   front end (LinkHandler), which the packager drops, so this small
   actor does the one part Seijaku needs: when the chrome window asks
   (once a page finishes loading), read the page's <link rel="icon">,
   or fall back to /favicon.ico, and answer with its address. It is
   only created when asked and reads a few attributes, so it costs
   nothing while a page runs. */

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
  receiveMessage(message) {
    if (message.name != "GetIcon") {
      return null;
    }
    let doc = this.document;
    let url = doc?.documentURIObject;
    if (!url || !/^https?$/.test(url.scheme)) {
      return null;
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
    return { href: best?.href || url.prePath + "/favicon.ico" };
  }
}
