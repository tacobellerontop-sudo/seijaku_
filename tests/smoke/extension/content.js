"use strict";
browser.runtime.onMessage.addListener(message => {
  if (message == "ping") {
    return Promise.resolve("pong:" + document.title);
  }
});
