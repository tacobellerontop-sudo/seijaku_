/* Seijaku update test hook. tests/update/run.ps1 copies this into a
   packaged build next to seijaku.js, builds installers from that build,
   installs one, and starts it with seijaku.test.updateInstaller set to a
   newer installer. The hook then runs the real update path against that
   local file instead of GitHub. seijaku.test.updateMode picks which:
   "button" (default) is Settings' Update button (download, run the
   installer, quit); "quit" stages the download the way the daily check
   does and then quits like the user closing Seijaku.
   Without the pref it does nothing. It is never part of a release. */

"use strict";

(() => {
  let installer = Services.prefs.getStringPref("seijaku.test.updateInstaller", "");
  if (!installer) {
    return;
  }
  window.addEventListener("load", () => {
    setTimeout(() => {
      let version = Services.prefs.getStringPref("seijaku.test.updateVersion", "99.0.0");
      let showMessage = Seijaku.showMessage.bind(Seijaku);
      Seijaku.showMessage = (text, kind) => {
        dump(`Seijaku update test: ${text}\n`);
        return showMessage(text, kind);
      };
      let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(installer);
      Seijaku._pendingUpdate = {
        version,
        url: Services.io.newFileURI(file).spec,
        page: "about:blank",
      };
      let mode = Services.prefs.getStringPref("seijaku.test.updateMode", "button");
      dump(`Seijaku update test: installing ${version} from ${installer} (${mode})\n`);
      if (mode == "quit") {
        Seijaku.downloadAndStageUpdate(Seijaku._pendingUpdate).then(() => {
          dump(`Seijaku update test: staged ${Seijaku._stagedUpdate}, quitting\n`);
          Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
        }, e => dump(`Seijaku update test: staging failed: ${e}\n`));
      } else {
        Seijaku.installUpdate();
      }
    }, 3000);
  }, { once: true });
})();
