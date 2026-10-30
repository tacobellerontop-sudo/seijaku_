/* Seijaku reader view, content side. Web pages run in a content
   process, so the article is extracted here, next to the document,
   and only the result crosses to the chrome window. Readability comes
   from the engine's own ReaderMode module (the one Firefox's reader
   view uses); if that module is missing or finds nothing, the element
   with the most text stands in, the way the shell always fell back. */

const READER_MODE_URIS = [
  "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  "resource://gre/modules/ReaderMode.sys.mjs",
];

function readerMode() {
  for (let uri of READER_MODE_URIS) {
    try {
      return ChromeUtils.importESModule(uri).ReaderMode;
    } catch (e) { /* try the next location */ }
  }
  return null;
}

function naiveArticle(doc) {
  let best = null;
  let bestText = 0;
  let candidates = doc.querySelectorAll("article, main, [role='main']");
  let roots = candidates.length ? [...candidates] : [doc.body];
  for (let root of roots) {
    let text = root?.textContent?.length ?? 0;
    if (text > bestText) {
      bestText = text;
      best = root;
    }
  }
  if (!best || bestText < 200) {
    return null;
  }
  return { title: doc.title || "", byline: "", content: best.innerHTML };
}

export class SeijakuReaderChild extends JSWindowActorChild {
  async receiveMessage(message) {
    if (message.name != "Seijaku:Extract") {
      return null;
    }
    let doc = this.document;
    let article = null;
    try {
      article = await readerMode()?.parseDocument(doc);
    } catch (e) { /* fall through to the naive extraction */ }
    if (!article?.content) {
      try {
        article = naiveArticle(doc);
      } catch (e) {
        article = null;
      }
    }
    if (!article?.content) {
      return null;
    }
    return {
      title: article.title || doc.title || "",
      byline: article.byline || "",
      content: article.content,
    };
  }
}
