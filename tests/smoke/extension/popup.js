"use strict";
browser.tabs.query({ active: true, currentWindow: true }).then(
  tabs => (document.title = tabs[0]?.url?.includes("ext-target.html") ? "popup:ok" : `popup:bad:${tabs[0]?.url}`),
  e => (document.title = `popup:error:${e.message}`)
);
