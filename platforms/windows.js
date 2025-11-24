const { exec } = require("child_process");

/**
 * Windows platform implementation using DirectShow (dshow)
 * Audio detection is working correctly on Windows
 */

function listDevices() {
  return new Promise((resolve) => {
    exec(
      "ffmpeg -list_devices true -f dshow -i dummy 2>&1",
      (error, stdout, stderr) => {
        const output = stderr || stdout || "";
        const videoDevices = [];
        const audioDevices = [];

        const lines = output.split("\n");
        for (const line of lines) {
          const videoMatch = line.match(
            /\[dshow[^\]]*\]\s+"([^"]+)"\s+\(video\)/
          );
          const audioMatch = line.match(
            /\[dshow[^\]]*\]\s+"([^"]+)"\s+\(audio\)/
          );

          if (videoMatch) {
            videoDevices.push(videoMatch[1]);
          }
          if (audioMatch) {
            audioDevices.push(audioMatch[1]);
          }
        }

        resolve({ videoDevices, audioDevices });
      }
    );
  });
}

function getVideoInputArgs(deviceName) {
  const device = deviceName || "Integrated Camera";
  return ["-f", "dshow", "-i", `video=${device}`];
}

function getAudioInputArgs(deviceName) {
  const device = deviceName || "Microphone";
  return ["-f", "dshow", "-i", `audio=${device}`];
}

module.exports = {
  listDevices,
  getVideoInputArgs,
  getAudioInputArgs,
};
