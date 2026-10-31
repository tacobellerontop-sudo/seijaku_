/* Seijaku's extension APIs, child side: the parts of the tabs API that
   run in the extension's own process (messaging a tab's content
   scripts). Everything else is proxied to the parent (ext-seijaku.js). */

"use strict";

extensions.registerModules({
  tabs: {
    url: "chrome://seijaku/content/ext/ext-c-tabs.js",
    scopes: ["addon_child"],
    paths: [["tabs"]],
  },
});
