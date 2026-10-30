/* Camera, microphone and peer connections, content side. The engine
   posts these requests as observer notifications in the page's own
   process and waits for an answer; Firefox's front end answers them,
   and Seijaku has no front end, so this actor does (see
   PermissionPrompt.sys.mjs for the whole picture).

   Peer connections are allowed at once, as Firefox does: the camera
   and microphone prompt is the real gate. Camera and microphone
   requests take the first matching device and ask the shell. Screen
   and tab sharing are not offered (there is no picker for them), so
   those requests are denied rather than left waiting. */

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
      let sharing =
        (video && typeof video != "boolean" && video.mediaSource != "camera") ||
        (audio && typeof audio != "boolean" && audio.mediaSource != "microphone");
      if (sharing) {
        deny();
        return;
      }
      let camera = null;
      let microphone = null;
      for (let device of request.devices) {
        device = device.QueryInterface(Ci.nsIMediaDevice);
        if (video && !camera && device.type == "videoinput" && device.mediaSource == "camera") {
          camera = device;
        }
        if (audio && !microphone && device.type == "audioinput" && device.mediaSource == "microphone") {
          microphone = device;
        }
      }
      let types = [];
      if (camera) {
        types.push("camera");
      }
      if (microphone) {
        types.push("microphone");
      }
      if (!types.length) {
        deny();
        return;
      }
      // The parent finds the asking page (and its site) from this id.
      let win = Services.wm.getOuterWindowWithId(request.windowID);
      let innerWindowId = win.windowGlobalChild.innerWindowId;
      let allowed = await this.sendQuery("Seijaku:MediaRequest", { innerWindowId, types });
      if (!allowed) {
        deny();
        return;
      }
      let devices = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
      for (let device of [camera, microphone]) {
        if (device) {
          devices.appendElement(device);
        }
      }
      Services.obs.notifyObservers(devices, "getUserMedia:response:allow", callID);
    } catch (e) {
      deny();
    }
  }
}
