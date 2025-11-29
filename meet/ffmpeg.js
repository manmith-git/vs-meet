// meet/ffmpeg.js
const { spawn, exec } = require("child_process");
const path = require("path");
const state = require("../state");
const { broadcastAudioChunk } = require("./audio-ws");

function checkFfmpegInstalled() {
  return new Promise((resolve) => {
    exec("ffmpeg -version", (error) => {
      resolve(!error);
    });
  });
}

function spawnPreview(panel, videoArgs = [], audioArgs = [], isDisposedRef = { val: false }) {
  // Build args like original monolith for preview
  const args = [
    ...videoArgs,
    ...(audioArgs.length ? audioArgs : []),
    "-map", "0:v",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", "3",
    "pipe:1",
  ];

  if (audioArgs.length) {
    args.push("-map", "0:a", "-f", "s16le", "-ar", "48000", "-ac", "1", "pipe:3");
  }

  console.log("[ffmpeg] starting preview:", args.join(" "));
  state.previewProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });

  // parse mjpeg frames
  let frameBuffer = Buffer.alloc(0);
  const JPEG_START = Buffer.from([0xff, 0xd8]);
  const JPEG_END = Buffer.from([0xff, 0xd9]);

  state.previewProcess.stdout.on("data", (data) => {
    if (isDisposedRef.val) return;
    frameBuffer = Buffer.concat([frameBuffer, data]);
    while (true) {
      const startIdx = frameBuffer.indexOf(JPEG_START);
      if (startIdx === -1) break;
      const endIdx = frameBuffer.indexOf(JPEG_END, startIdx + 2);
      if (endIdx === -1) break;
      const frame = frameBuffer.slice(startIdx, endIdx + 2);
      frameBuffer = frameBuffer.slice(endIdx + 2);
      const base64 = frame.toString("base64");
      panel.webview.postMessage({ command: "frameUpdate", frame: `data:image/jpeg;base64,${base64}` });
    }
    if (frameBuffer.length > 1024 * 1024) frameBuffer = Buffer.alloc(0);
  });

  if (state.previewProcess.stdio && state.previewProcess.stdio[3]) {
    state.previewProcess.stdio[3].on("data", (chunk) => {
      broadcastAudioChunk(chunk);
    });
    state.previewProcess.stdio[3].on("end", () => {
      console.log("[ffmpeg] audio pipe ended");
    });
  }

  state.previewProcess.stderr.on("data", (d) => {
    panel.webview.postMessage({ command: "ffmpegLog", text: d.toString() });
  });

  state.previewProcess.on("exit", (code) => {
    console.log("[ffmpeg] preview exited", code);
    state.previewProcess = null;
  });

  panel.webview.postMessage({ command: "previewStarted" });
  return state.previewProcess;
}

function spawnRecording(panel, outputPath, videoArgs = [], audioArgs = [], isDisposedRef = { val: false }) {
  // Build args like original monolith for recording + preview frames
  const args = [
    ...videoArgs,
    ...(audioArgs.length ? audioArgs : []),
    "-map", "0:v",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", "3",
    "pipe:1",
  ];

  if (audioArgs.length > 0) {
    args.push("-map", "1:a", "-f", "s16le", "-ar", "48000", "-ac", "1", "pipe:3");
  }

  // add mp4 output mapping
  if (audioArgs.length) {
    args.push(
      "-map", "0:v",
      "-map", "1:a",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-y",
      outputPath
    );
  } else {
    args.push(
      "-map", "0:v",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-y",
      outputPath
    );
  }

  console.log("[ffmpeg] starting recording:", args.join(" "));
  state.isRecording = true;
  state.currentRecordingPath = outputPath;
  state.previewProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });

  // frames for preview
  let frameBuf = Buffer.alloc(0);
  const JPEG_S = Buffer.from([0xff, 0xd8]);
  const JPEG_E = Buffer.from([0xff, 0xd9]);
  state.previewProcess.stdout.on("data", (data) => {
    if (isDisposedRef.val) return;
    frameBuf = Buffer.concat([frameBuf, data]);
    while (true) {
      const sIdx = frameBuf.indexOf(JPEG_S);
      if (sIdx === -1) break;
      const eIdx = frameBuf.indexOf(JPEG_E, sIdx + 2);
      if (eIdx === -1) break;
      const frame = frameBuf.slice(sIdx, eIdx + 2);
      frameBuf = frameBuf.slice(eIdx + 2);
      const base64 = frame.toString("base64");
      panel.webview.postMessage({ command: "frameUpdate", frame: `data:image/jpeg;base64,${base64}` });
    }
    if (frameBuf.length > 1024 * 1024) frameBuf = Buffer.alloc(0);
  });

  if (state.previewProcess.stdio && state.previewProcess.stdio[3]) {
    state.previewProcess.stdio[3].on("data", (chunk) => broadcastAudioChunk(chunk));
  }

  state.previewProcess.stderr.on("data", (d) => {
    panel.webview.postMessage({ command: "ffmpegLog", text: d.toString() });
  });

  state.previewProcess.on("exit", (code) => {
    console.log("[ffmpeg] recording exited", code);
    state.isRecording = false;
    panel.webview.postMessage({ command: "recordingStopped" });
    if (code === 0 || code === 255) {
      try { const vscode = require("vscode"); vscode.window.showInformationMessage(`Recording saved: ${state.currentRecordingPath}`); } catch {}
    } else {
      try { const vscode = require("vscode"); vscode.window.showErrorMessage(`Recording failed with code ${code}`); } catch {}
    }
    state.previewProcess = null;
  });

  panel.webview.postMessage({ command: "recordingStarted", path: outputPath });
  return state.previewProcess;
}

function stopPreview() {
  if (state.previewProcess) {
    try { state.previewProcess.stdin && state.previewProcess.stdin.write("q"); } catch (e) {}
    try { state.previewProcess.kill("SIGTERM"); } catch (e) {}
    state.previewProcess = null;
  }
}

function stopRecordingGraceful() {
  if (!state.isRecording || !state.previewProcess) return;
  state.isRecording = false;
  try { state.previewProcess.stdin && state.previewProcess.stdin.write("q"); } catch (e) {}
  setTimeout(() => {
    if (state.previewProcess) {
      try { state.previewProcess.kill("SIGTERM"); } catch (e) {}
      state.previewProcess = null;
    }
  }, 1000);
}

module.exports = {
  checkFfmpegInstalled,
  spawnPreview,
  spawnRecording,
  stopPreview,
  stopRecordingGraceful,
};
