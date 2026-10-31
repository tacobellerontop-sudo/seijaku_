/* tabs.connect and tabs.sendMessage, child side. Adapted from
   GeckoView's mobile/shared/components/extensions/ext-c-tabs.js
   (Mozilla Public License 2.0). */

"use strict";

this.tabs = class extends ExtensionAPI {
  getAPI(context) {
    return {
      tabs: {
        connect(tabId, options) {
          let { frameId = null, name = "", documentId = null } = options || {};
          return context.messenger.connect({ name, tabId, frameId, documentId });
        },

        sendMessage(tabId, message, options, callback) {
          let arg = {
            tabId,
            frameId: options?.frameId,
            documentId: options?.documentId,
            message,
            callback,
          };
          return context.messenger.sendRuntimeMessage(arg);
        },
      },
    };
  }
};
