// meet/devices.js
// platform wrapper for device listing and ffmpeg input args
const os = require("os");
const platform = os.platform();

let platformModule;
try {
  if (platform === "win32") {
    platformModule = require("../platforms/windows");
  } else if (platform === "linux") {
    platformModule = require("../platforms/linux");
  } else if (platform === "darwin") {
    platformModule = require("../platforms/macos");
  } else {
    platformModule = require("../platforms/windows");
  }
} catch (e) {
  // fallback - assume windows module exists
  platformModule = require("../platforms/windows");
}

const { listDevices, getVideoInputArgs, getAudioInputArgs } = platformModule;

module.exports = { listDevices, getVideoInputArgs, getAudioInputArgs };
