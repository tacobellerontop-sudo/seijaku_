/* Opening things from outside Seijaku: a web link clicked in another
   app, or a file opened with Seijaku from Explorer ("Open with", or
   Seijaku as the default app for PDFs and web pages).

   Windows starts seijaku.exe with the address or the file's path, as
   `-osint -url <address or path>`. The engine's built-in handlers
   (Firefox's, compiled into the engine) take -url for themselves and
   try to open a Firefox window that Seijaku doesn't have, so the
   launcher passes the value on as `-seijaku-open <value>`, which they
   ignore, and also in the SEIJAKU_OPEN environment variable:

   - On a cold start no handler of Seijaku's exists yet (this module is
     registered by the first window), so that window reads SEIJAKU_OPEN
     (launchURLs below) and clears it.
   - When Seijaku already runs, the new engine process hands its command
     line to the running one, where this module's handler opens each
     address or file as a tab in the main window. It runs before the
     engine's default handler ("m-" sorts before "x-default"), takes the
     arguments it used so nothing else acts on them, and stops the
     default handler from just bringing the window forward. It lives in
     a module, not in a window, so closing the window that registered
     it can't break it. */

const CONTRACT = "@seijaku/command-line-handler;1";
const CID = Components.ID("{4c1f7a52-9b3e-4e0d-8f6a-2d5c7e9b1a63}");

// Flags whose next argument is not something to open.
const FLAGS_WITH_VALUE = new Set(["app", "profile", "p", "remote-debugging-port", "marionette-port"]);
// The flag the launcher passes an address or file under.
const OPEN_FLAG = "seijaku-open";
const OPEN_ENV = "SEIJAKU_OPEN";

/** A file path as a file:/// address, when the file exists. */
function fileURL(cmdLine, value) {
  try {
    let file;
    if (cmdLine) {
      file = cmdLine.resolveFile(value);
    } else {
      file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(value);
    }
    if (file?.exists() && !file.isDirectory()) {
      return Services.io.newFileURI(file).spec;
    }
  } catch (e) { /* not a file */ }
  return null;
}

/** What one argument opens: a web address, a file:// address, a file
    path (made a file:// address), a bare dotted address, or null. */
function openable(cmdLine, value) {
  if (!value || value.startsWith("-")) {
    return null;
  }
  if (/^(https?|ftp):\/\//i.test(value) || /^file:\/\//i.test(value)) {
    return value;
  }
  // A path: C:\..., \\server\share\..., or anything with a backslash.
  if (/^[a-z]:[\\/]/i.test(value) || value.includes("\\")) {
    return fileURL(cmdLine, value);
  }
  if (/\.ini$/i.test(value)) {
    return null; // the shell's own application.ini
  }
  // A bare address (example.com, localhost:3000).
  if (
    /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(value) ||
    /^localhost(:\d+)?(\/\S*)?$/.test(value)
  ) {
    return value;
  }
  // A relative file name (a file dropped on seijaku.exe).
  return fileURL(cmdLine, value);
}

/** Every address or file a command line asks to open, in order. */
export function urlsFromCommandLine(cmdLine) {
  let urls = [];
  try {
    for (let i = 0; i < cmdLine.length; i++) {
      let arg = cmdLine.getArgument(i);
      if (/^--?[\w-]+$/.test(arg)) {
        let flag = arg.replace(/^--?/, "").toLowerCase();
        if (flag == OPEN_FLAG && i + 1 < cmdLine.length) {
          let url = openable(cmdLine, cmdLine.getArgument(++i));
          if (url) {
            urls.push(url);
          }
          continue;
        }
        if (FLAGS_WITH_VALUE.has(flag)) {
          i++;
        }
        continue;
      }
      let url = openable(cmdLine, arg);
      if (url) {
        urls.push(url);
      }
    }
  } catch (e) { /* nothing usable */ }
  return urls;
}

/** What a cold start was asked to open (from the launcher's
    SEIJAKU_OPEN), taken once: the variable is cleared, so a restart
    (an update) or a later window doesn't open it again. */
export function takeLaunchURLs() {
  let urls = [];
  try {
    let value = Services.env.get(OPEN_ENV);
    if (value) {
      Services.env.set(OPEN_ENV, "");
      let url = openable(null, value);
      if (url) {
        urls.push(url);
      }
    }
  } catch (e) { /* nothing to open */ }
  return urls;
}

/** The ordinary window links go to: not private, not an extension popup. */
function mainWindow() {
  let fallback = null;
  for (let win of Services.wm.getEnumerator("seijaku:main")) {
    let shell = win.Seijaku;
    if (!shell || win.closed) {
      continue;
    }
    if (!shell.isPrivate && !shell.isPopup) {
      fallback = win;
    }
  }
  return fallback;
}

const handler = {
  QueryInterface: ChromeUtils.generateQI(["nsICommandLineHandler", "nsIFactory"]),

  createInstance(iid) {
    return this.QueryInterface(iid);
  },

  handle(cmdLine) {
    // A cold start's own command line is read by the first window.
    if (
      cmdLine.state != Ci.nsICommandLine.STATE_REMOTE_AUTO &&
      cmdLine.state != Ci.nsICommandLine.STATE_REMOTE_EXPLICIT
    ) {
      return;
    }
    let win = mainWindow();
    let urls = urlsFromCommandLine(cmdLine);
    if (!win || !urls.length) {
      return; // the engine's handler brings a window forward
    }
    // Taken: the engine's own handlers would try to open them in a
    // Firefox window.
    cmdLine.removeArguments(0, cmdLine.length - 1);
    cmdLine.preventDefault = true;
    let tab = null;
    for (let url of urls) {
      try {
        tab = win.Seijaku.openTab(win.Seijaku.urlFor(url), { afterCurrent: true });
      } catch (e) {
        console.error("Seijaku: opening", url, e);
      }
    }
    if (tab) {
      win.Seijaku.selectTab(tab);
    }
    win.focus();
  },

  helpInfo: "",
};

/** Registers the handler once per run of the app. */
export function register() {
  let registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  if (registrar.isCIDRegistered(CID)) {
    return;
  }
  registrar.registerFactory(CID, "Seijaku command line handler", CONTRACT, handler);
  Services.catMan.addCategoryEntry("command-line-handler", "m-seijaku", CONTRACT, false, true);
}

export const SeijakuCommandLine = { register, urlsFromCommandLine, takeLaunchURLs, handler, CONTRACT };
