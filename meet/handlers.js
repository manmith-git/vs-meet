// meet/handlers.js
const path = require("path");
const os = require("os");
const vscode = require("vscode");
const state = require("../state");
const devices = require("./devices");
const { startLocalAudioWsServer, stopLocalAudioWsServer, broadcastAudioChunk } = require("./audio-ws");
const ffmpeg = require("./ffmpeg");

// keep an isDisposed flag per panel usage; we store a simple map from panel -> flag
const panelDisposedMap = new WeakMap();

async function handleMessage(message, panel, context) {
  if (!message || !message.command) return;
  const isDisposedRef = { val: panelDisposedMap.get(panel) || false };

  try {
    switch (message.command) {
      case "checkRequirements": {
        const ffmpegInstalled = await ffmpeg.checkFfmpegInstalled();
        panel.webview.postMessage({ command: "requirementsStatus", ffmpeg: ffmpegInstalled });
        break;
      }

      case "turnCameraOn": {
        if (state.previewProcess) {
          panel.webview.postMessage({ command: "previewAlreadyRunning" });
          break;
        }

        const port = await startLocalAudioWsServer();
        panel.webview.postMessage({ command: "audioWsPort", port });

        const devs = await devices.listDevices();
        if (!devs || devs.videoDevices.length === 0) {
          vscode.window.showErrorMessage("No video devices found. Please connect a camera.");
          break;
        }
        const videoDevice = devs.videoDevices[0];
        const audioDevice = (devs.audioDevices && devs.audioDevices.length) ? devs.audioDevices[0] : null;

        const videoArgs = devices.getVideoInputArgs(videoDevice);
        const audioArgs = audioDevice ? devices.getAudioInputArgs(audioDevice) : [];

        // start preview
        ffmpeg.spawnPreview(panel, videoArgs, audioArgs, isDisposedRef);
        // track disposed reference so preview stops when panel disposed
        panelDisposedMap.set(panel, false);
        break;
      }

      case "turnCameraOff": {
        ffmpeg.stopPreview();
        stopLocalAudioWsServer();
        panel.webview.postMessage({ command: "previewStopped" });
        break;
      }

      case "startRecording": {
        if (state.isRecording) return;
        const devs = await devices.listDevices();
        if (!devs || devs.videoDevices.length === 0) {
          vscode.window.showErrorMessage("No video devices found. Please connect a camera.");
          break;
        }

        const videoDeviceName = devs.videoDevices[0];
        const audioDeviceName = (devs.audioDevices && devs.audioDevices.length) ? devs.audioDevices[0] : null;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const outputDir = workspaceFolders ? workspaceFolders[0].uri.fsPath : require("os").homedir();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outputPath = path.join(outputDir, `recording-${timestamp}.mp4`);

        const videoArgs = devices.getVideoInputArgs(videoDeviceName);
        const audioArgs = audioDeviceName ? devices.getAudioInputArgs(audioDeviceName) : [];

        // ensure audio WS running
        const port = await startLocalAudioWsServer();
        panel.webview.postMessage({ command: "audioWsPort", port });

        ffmpeg.spawnRecording(panel, outputPath, videoArgs, audioArgs, isDisposedRef);
        panelDisposedMap.set(panel, false);
        break;
      }

      case "stopRecording": {
        ffmpeg.stopRecordingGraceful();
        panel.webview.postMessage({ command: "recordingStopped" });
        break;
      }

      default:
        console.log("[meet] unknown command", message.command);
    }
  } catch (err) {
    console.error("[meet handler] error:", err);
  }
}

function onPanelDispose(panel) {
  panelDisposedMap.set(panel, true);
  // stop preview/recording and audio ws
  try { ffmpeg.stopPreview(); } catch (e) {}
  try { ffmpeg.stopRecordingGraceful(); } catch (e) {}
  try { stopLocalAudioWsServer(); } catch (e) {}
}

function cleanup() {
  try { ffmpeg.stopPreview(); } catch (e) {}
  try { ffmpeg.stopRecordingGraceful(); } catch (e) {}
  try { stopLocalAudioWsServer(); } catch (e) {}
}

module.exports = { handleMessage, onPanelDispose, cleanup };
