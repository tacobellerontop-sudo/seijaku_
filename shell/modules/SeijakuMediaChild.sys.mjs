/* Camera, microphone, screen sharing and peer connections, content
   side. The engine posts these requests as observer notifications in
   the page's own process and waits for an answer; Firefox's front end
   answers them, and Seijaku has no front end, so this actor does (see
   PermissionPrompt.sys.mjs for the whole picture).

   Peer connections are allowed at once, as Firefox does: the camera,
   microphone and screen prompt is the real gate. A camera and
   microphone request lists the matching devices and asks the shell
   once for both, with a choice of device when there is more than one.
   A screen sharing request (getDisplayMedia) lists the screens and
   windows the engine offers and the user picks one. Sharing a tab's
   or the system's sound is not offered, as in Firefox on Windows. */

const MAX_CHOICES = 64;

function deviceLabel(device, kind) {
  let name = "";
  try {
    name = device.rawName || device.name || "";
  } catch (e) { /* unnamed device */ }
  name = String(name).slice(0, 200);
  if (kind == "screen") {
    let source = device.mediaSource;
    if (source == "screen") {
      return name ? `Entire screen: ${name}` : "Entire screen";
    }
    if (source == "browser") {
      return name ? `Tab: ${name}` : "A tab";
    }
    return name ? `Window: ${name}` : "A window";
  }
  return name || (kind == "camera" ? "Camera" : "Microphone");
}

function deviceId(device) {
  try {
    return String(device.rawId || device.id || "").slice(0, 400);
  } catch (e) {
    return "";
  }
}

export class SeijakuMediaChild extends JSProcessActorChild {
  observe(subject, topic) {
    if (topic == "PeerConnection:request") {
      Services.obs.notifyObservers(null, "PeerConnection:response:allow", subject.callID);
      return;
    }
    if (topic == "getUserMedia:request") {
      this.handleMediaRequest(subject);
    }
  }

  async handleMediaRequest(request) {
    let callID = request.callID;
    let deny = () =>
      Services.obs.notifyObservers(null, "getUserMedia:response:deny", callID);
    try {
      if (request.type == "selectaudiooutput") {
        deny();
        return;
      }
      let constraints = request.getConstraints();
      let video = constraints.video || constraints.picture;
      let audio = constraints.audio;
      let sharingScreen = !!video && typeof video != "boolean" && video.mediaSource != "camera";
      let sharingAudio = !!audio && typeof audio != "boolean" && audio.mediaSource != "microphone";

      // Devices by kind, in the engine's order (its first is the
      // system default, or the one the page asked for by id).
      let lists = { camera: [], microphone: [], screen: [] };
      for (let device of request.devices) {
        device = device.QueryInterface(Ci.nsIMediaDevice);
        if (device.type == "videoinput" && video) {
          let isCamera = device.mediaSource == "camera";
          if (isCamera && !sharingScreen) {
            lists.camera.push(device);
          } else if (!isCamera && sharingScreen) {
            lists.screen.push(device);
          }
        } else if (device.type == "audioinput" && audio && !sharingAudio) {
          if (device.mediaSource == "microphone") {
            lists.microphone.push(device);
          }
        }
      }
      let types = Object.keys(lists).filter(kind => lists[kind].length);
      if (!types.length) {
        deny();
        return;
      }
      let choices = {};
      for (let kind of types) {
        lists[kind] = lists[kind].slice(0, MAX_CHOICES);
        choices[kind] = lists[kind].map(device => ({
          id: deviceId(device),
          label: deviceLabel(device, kind),
        }));
      }

      // The parent finds the asking page (and its site) from this id.
      let win = Services.wm.getOuterWindowWithId(request.windowID);
      let innerWindowId = win.windowGlobalChild.innerWindowId;
      let answer = await this.sendQuery("Seijaku:MediaRequest", { innerWindowId, types, choices });
      if (!answer || typeof answer != "object" || !answer.picks) {
        deny();
        return;
      }
      let devices = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
      for (let kind of types) {
        let index = answer.picks[kind];
        if (Number.isInteger(index) && lists[kind][index]) {
          devices.appendElement(lists[kind][index]);
        }
      }
      if (!devices.length) {
        deny();
        return;
      }
      Services.obs.notifyObservers(devices, "getUserMedia:response:allow", callID);
    } catch (e) {
      deny();
    }
  }
}
