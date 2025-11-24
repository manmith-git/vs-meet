// extension.js - MERGED: Meet (top) + Collaborative Coding (bottom)
// Meet section unchanged (logic preserved) aside from wrapping into activateMeet/deactivateMeet
// Collab section unchanged (logic preserved) aside from renames to avoid collisions
// Single entrypoint: activate(context) registers both commands

const vscode = require("vscode");
const { exec, spawn } = require("child_process");
const path = require("path");
const os = require("os");
const http = require("http");
const WebSocket = require("ws");

/* ---------------------------
   MEET (Audio + Video) SECTION
   (kept at top; original logic preserved)
   --------------------------- */

let ffmpegProcess = null;
let previewProcess = null;
let isRecording = false;
let currentRecordingPath = null;
let audioWsServer = null;
let audioHttpServer = null;
let audioWsPort = null;

const platform = os.platform();
let platformModule;

// Use your platform-specific module; fallback to windows one if others not provided
if (platform === "win32") {
  platformModule = require("./platforms/windows");
} else {
  platformModule = require("./platforms/windows");
}

const { listDevices, getVideoInputArgs, getAudioInputArgs } = platformModule;

function checkFfmpegInstalled() {
  return new Promise((resolve) => {
    exec("ffmpeg -version", (error) => {
      resolve(!error);
    });
  });
}

function startLocalAudioWsServer() {
  return new Promise((resolve, reject) => {
    if (audioWsServer && audioHttpServer && audioWsPort)
      return resolve(audioWsPort);

    audioHttpServer = http.createServer((req, res) => {
      res.writeHead(200);
      res.end("OK");
    });

    audioHttpServer.listen(0, "127.0.0.1", () => {
      const addr = audioHttpServer.address();
      audioWsPort = addr.port;
      audioWsServer = new WebSocket.Server({ server: audioHttpServer });
      audioWsServer.on("connection", (ws) => {
        console.log("[audio-ws] client connected");
        ws.on("close", () => console.log("[audio-ws] client disconnected"));
      });
      console.log("[audio-ws] listening on port", audioWsPort);
      resolve(audioWsPort);
    });

    audioHttpServer.on("error", (err) => {
      console.error("[audio-ws] http server error", err);
      reject(err);
    });
  });
}

function broadcastAudioChunk(chunk) {
  if (!audioWsServer) return;
  for (const client of audioWsServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(chunk);
    }
  }
}

function stopLocalAudioWsServer() {
  if (audioWsServer) {
    try {
      audioWsServer.close();
    } catch (e) {
      console.warn(e);
    }
    audioWsServer = null;
  }
  if (audioHttpServer) {
    try {
      audioHttpServer.close();
    } catch (e) {
      console.warn(e);
    }
    audioHttpServer = null;
    audioWsPort = null;
  }
}

function activateMeet(context) {
  console.log("Camera Recorder + Meet extension activated");

  const disposable = vscode.commands.registerCommand(
    "meetup.openRecorder",
    async () => {
      const panel = vscode.window.createWebviewPanel(
        "cameraRecorder",
        "VS Code Meet",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [],
        }
      );

      let isDisposed = false;

      // set webview content
      panel.webview.html = getWebviewContent();

      // handle messages from webview (UI)
      panel.webview.onDidReceiveMessage(
        async (message) => {
          if (!message || !message.command) return;
          try {
            switch (message.command) {
              case "checkRequirements": {
                const ffmpeg = await checkFfmpegInstalled();
                panel.webview.postMessage({
                  command: "requirementsStatus",
                  ffmpeg,
                });
                break;
              }

              case "turnCameraOn": {
                if (previewProcess) {
                  panel.webview.postMessage({
                    command: "previewAlreadyRunning",
                  });
                  break;
                }

                // spin up local audio WS so webview can connect and receive raw PCM
                const port = await startLocalAudioWsServer();
                panel.webview.postMessage({ command: "audioWsPort", port });

                // list devices
                const devices = await listDevices();
                if (!devices || devices.videoDevices.length === 0) {
                  vscode.window.showErrorMessage(
                    "No video devices found. Please connect a camera."
                  );
                  break;
                }
                const videoDevice = devices.videoDevices[0];
                const audioDevice =
                  devices.audioDevices && devices.audioDevices.length
                    ? devices.audioDevices[0]
                    : null;

                const videoArgs = getVideoInputArgs(videoDevice);
                const audioArgs = audioDevice
                  ? getAudioInputArgs(audioDevice)
                  : [];

                // build ffmpeg args for preview: video -> pipe:1 (mjpeg); audio -> pipe:3 (s16le)
                const args = [
                  ...videoArgs,
                  ...(audioArgs.length ? audioArgs : []),
                  "-map",
                  "0:v",
                  "-f",
                  "image2pipe",
                  "-vcodec",
                  "mjpeg",
                  "-q:v",
                  "3",
                  "pipe:1",
                ];

                if (audioArgs.length) {
                  args.push(
                    "-map",
                    "0:a",
                    "-f",
                    "s16le",
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    "pipe:3"
                  );
                }

                console.log("[ffmpeg] starting preview:", args.join(" "));
                // spawn with fd3 pipe for audio
                previewProcess = spawn("ffmpeg", args, {
                  stdio: ["ignore", "pipe", "pipe", "pipe"],
                });

                // parse mjpeg from stdout
                let frameBuffer = Buffer.alloc(0);
                const JPEG_START = Buffer.from([0xff, 0xd8]);
                const JPEG_END = Buffer.from([0xff, 0xd9]);

                previewProcess.stdout.on("data", (data) => {
                  if (isDisposed) return;
                  frameBuffer = Buffer.concat([frameBuffer, data]);
                  while (true) {
                    const startIdx = frameBuffer.indexOf(JPEG_START);
                    if (startIdx === -1) break;
                    const endIdx = frameBuffer.indexOf(JPEG_END, startIdx + 2);
                    if (endIdx === -1) break;
                    const frame = frameBuffer.slice(startIdx, endIdx + 2);
                    frameBuffer = frameBuffer.slice(endIdx + 2);
                    const base64 = frame.toString("base64");
                    panel.webview.postMessage({
                      command: "frameUpdate",
                      frame: `data:image/jpeg;base64,${base64}`,
                    });
                  }
                  if (frameBuffer.length > 1024 * 1024)
                    frameBuffer = Buffer.alloc(0);
                });

                if (previewProcess.stdio && previewProcess.stdio[3]) {
                  previewProcess.stdio[3].on("data", (chunk) => {
                    broadcastAudioChunk(chunk);
                  });
                  previewProcess.stdio[3].on("end", () => {
                    console.log("[ffmpeg] audio pipe ended");
                  });
                }

                previewProcess.stderr.on("data", (d) => {
                  // forward ffmpeg stderr to webview (webview may ignore or log)
                  panel.webview.postMessage({ command: "ffmpegLog", text: d.toString() });
                });

                previewProcess.on("exit", (code) => {
                  console.log("[ffmpeg] preview exited", code);
                  previewProcess = null;
                });

                panel.webview.postMessage({ command: "previewStarted" });
                break;
              }

              case "turnCameraOff": {
                if (previewProcess) {
                  try {
                    previewProcess.stdin && previewProcess.stdin.write("q");
                  } catch (e) {}
                  try {
                    previewProcess.kill("SIGTERM");
                  } catch (e) {}
                  previewProcess = null;
                }
                stopLocalAudioWsServer();
                panel.webview.postMessage({ command: "previewStopped" });
                break;
              }

              case "startRecording": {
                if (isRecording) return;
                const devices = await listDevices();
                if (!devices || devices.videoDevices.length === 0) {
                  vscode.window.showErrorMessage(
                    "No video devices found. Please connect a camera."
                  );
                  break;
                }
                const videoDeviceName = devices.videoDevices[0];
                const audioDeviceName =
                  devices.audioDevices && devices.audioDevices.length
                    ? devices.audioDevices[0]
                    : null;

                const workspaceFolders = vscode.workspace.workspaceFolders;
                const outputDir = workspaceFolders
                  ? workspaceFolders[0].uri.fsPath
                  : require("os").homedir();
                const timestamp = new Date()
                  .toISOString()
                  .replace(/[:.]/g, "-");
                const outputPath = path.join(
                  outputDir,
                  `recording-${timestamp}.mp4`
                );

                const videoArgs = getVideoInputArgs(videoDeviceName);
                const audioArgs = audioDeviceName
                  ? getAudioInputArgs(audioDeviceName)
                  : [];

                // ensure audio WS server running
                const port = await startLocalAudioWsServer();
                panel.webview.postMessage({ command: "audioWsPort", port });

                const args = [
                  ...videoArgs,
                  ...(audioArgs.length ? audioArgs : []),
                  "-map",
                  "0:v",
                  "-f",
                  "image2pipe",
                  "-vcodec",
                  "mjpeg",
                  "-q:v",
                  "3",
                  "pipe:1",
                ];

                if (audioArgs.length > 0) {
                  args.push(
                    "-map",
                    "1:a", // microphone is input #1
                    "-f",
                    "s16le",
                    "-ar",
                    "48000", // resample → 48kHz
                    "-ac",
                    "1", // downmix stereo → mono
                    "pipe:3"
                  );
                }

                // add mp4 output mapping
                if (audioArgs.length) {
                  args.push(
                    "-map",
                    "0:v",
                    "-map",
                    "1:a",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "23",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-y",
                    outputPath
                  );
                } else {
                  args.push(
                    "-map",
                    "0:v",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "23",
                    "-y",
                    outputPath
                  );
                }

                console.log("[ffmpeg] starting recording:", args.join(" "));
                isRecording = true;
                currentRecordingPath = outputPath;
                previewProcess = spawn("ffmpeg", args, {
                  stdio: ["ignore", "pipe", "pipe", "pipe"],
                });

                // frames for preview (still used for offscreen canvas)
                let frameBuf = Buffer.alloc(0);
                const JPEG_S = Buffer.from([0xff, 0xd8]);
                const JPEG_E = Buffer.from([0xff, 0xd9]);
                previewProcess.stdout.on("data", (data) => {
                  if (isDisposed) return;
                  frameBuf = Buffer.concat([frameBuf, data]);
                  while (true) {
                    const sIdx = frameBuf.indexOf(JPEG_S);
                    if (sIdx === -1) break;
                    const eIdx = frameBuf.indexOf(JPEG_E, sIdx + 2);
                    if (eIdx === -1) break;
                    const frame = frameBuf.slice(sIdx, eIdx + 2);
                    frameBuf = frameBuf.slice(eIdx + 2);
                    const base64 = frame.toString("base64");
                    panel.webview.postMessage({
                      command: "frameUpdate",
                      frame: `data:image/jpeg;base64,${base64}`,
                    });
                  }
                  if (frameBuf.length > 1024 * 1024) frameBuf = Buffer.alloc(0);
                });

                if (previewProcess.stdio && previewProcess.stdio[3]) {
                  previewProcess.stdio[3].on("data", (chunk) =>
                    broadcastAudioChunk(chunk)
                  );
                }

                previewProcess.stderr.on("data", (d) => {
                  panel.webview.postMessage({
                    command: "ffmpegLog",
                    text: d.toString(),
                  });
                });

                previewProcess.on("exit", (code) => {
                  console.log("[ffmpeg] recording exited", code);
                  isRecording = false;
                  panel.webview.postMessage({ command: "recordingStopped" });
                  if (code === 0 || code === 255) {
                    vscode.window.showInformationMessage(
                      `Recording saved: ${currentRecordingPath}`
                    );
                  } else {
                    vscode.window.showErrorMessage(
                      `Recording failed with code ${code}`
                    );
                  }
                });

                panel.webview.postMessage({
                  command: "recordingStarted",
                  path: outputPath,
                });
                break;
              }

              case "stopRecording": {
                if (!isRecording || !previewProcess) return;
                isRecording = false;
                try {
                  previewProcess.stdin && previewProcess.stdin.write("q");
                } catch (e) {}
                setTimeout(() => {
                  if (previewProcess) {
                    try {
                      previewProcess.kill("SIGTERM");
                    } catch (e) {}
                    previewProcess = null;
                  }
                }, 1000);
                panel.webview.postMessage({ command: "recordingStopped" });
                break;
              }

              default:
                console.log("[webview] unknown command", message.command);
            }
          } catch (err) {
            console.error("[webview message handler] error:", err);
          }
        },
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(
        () => {
          isDisposed = true;
          if (previewProcess) {
            try {
              previewProcess.kill("SIGTERM");
            } catch (e) {}
            previewProcess = null;
          }
          if (ffmpegProcess) {
            try {
              ffmpegProcess.kill("SIGINT");
            } catch (e) {}
            ffmpegProcess = null;
          }
          stopLocalAudioWsServer();
        },
        undefined,
        context.subscriptions
      );
    }
  );

  context.subscriptions.push(disposable);
}

// getWebviewContent: final cleaned UI & JS (unchanged)
function getWebviewContent() {
  const SIGNALING_SERVER = "https://voice-collab-room.onrender.com";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VS Code Meet</title>

<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --card: var(--vscode-sideBar-background);
    --panel-border: var(--vscode-panel-border);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --surface: #1c1c1c;
  }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--fg);
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial;
  }

  /* --- HEADER BAR --- */
  .header {
    padding: 12px 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    background: rgba(0,0,0,0.25);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--panel-border);
    align-items: center;
  }

  .header input {
    background: #222;
    border: 1px solid #444;
    padding: 7px 10px;
    color: var(--fg);
    border-radius: 6px;
  }

  .header button {
    padding: 7px 14px;
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }

  .header button:hover {
    background: var(--btn-hover);
  }

  /* --- LAYOUT GRID --- */
  .main {
    display: flex;
    height: calc(100vh - 70px);
    overflow: hidden;
  }

  .left-panel {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }

  .right-panel {
    width: 320px;
    padding: 16px;
    border-left: 1px solid var(--panel-border);
    background: #181818;
  }

  /* --- CARDS --- */
  .card {
    background: #202020;
    padding: 14px;
    border-radius: 8px;
    border: 1px solid var(--panel-border);
    margin-bottom: 16px;
  }

  .card h3 {
    margin: 0 0 8px 0;
    font-size: 15px;
  }

  /* --- PARTICIPANT GRID --- */
  #videoGrid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(1,1fr);
  }

  .tile {
    background: #111;
    border-radius: 10px;
    overflow: hidden;
    aspect-ratio: 16/9;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #333;
  }

  .tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .label {
    position: absolute;
    bottom: 10px;
    left: 10px;
    padding: 5px 8px;
    font-size: 12px;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(4px);
    border-radius: 5px;
    color: #fff;
  }

  /* SCROLLBARS */
  *::-webkit-scrollbar { width: 8px; }
  *::-webkit-scrollbar-thumb { background: #444; border-radius: 8px; }

  @media (max-width: 900px) {
    .main {
      flex-direction: column;
    }

    .right-panel {
      width: 100%;
      border-left: none;
      border-top: 1px solid var(--panel-border);
    }
  }
</style>
</head>

<body>

  <!-- HEADER -->
  <div class="header">
      <input id="nameInput" placeholder="Your name" style="width:150px;">
      <input id="roomInput" placeholder="Room code…" style="width:150px;">
      <button id="createRoomBtn">Create</button>
      <button id="joinRoomBtn">Join</button>

      <div style="flex:1"></div>

      <button id="turnOnCamBtn">Camera On</button>
      <button id="turnOffCamBtn">Camera Off</button>
      <button id="startRecBtn">Start Recording</button>
      <button id="stopRecBtn" disabled>Stop</button>
  </div>

  <!-- BODY -->
  <div class="main">

      <!-- LEFT: PARTICIPANTS -->
      <div class="left-panel">
          <div class="card">
              <h3>Participants</h3>
              <div id="videoGrid"></div>
          </div>
      </div>

      <!-- RIGHT: STATUS -->
      <div class="right-panel">
          <div class="card">
              <h3>System Status</h3>
              <div>FFmpeg: <span id="ffmpegStatus">Checking…</span></div>
          </div>

          <div class="card">
              <h3>Information</h3>
              <p style="font-size:13px;color:var(--muted);">
                This panel provides real-time audio/video collaboration.<br><br>
                Use <b>Camera On</b> to start preview, <b>Create/Join</b> to enter a room.<br>
                Recording saves automatically in your workspace.
              </p>
          </div>
      </div>
  </div>

  <!-- ORIGINAL JS (unchanged) -->
  <script src="${SIGNALING_SERVER}/socket.io/socket.io.js"></script>

  <script>
  (function () {
    const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
    const SIGNALING_SERVER = "${SIGNALING_SERVER}";
    const nameInput = document.getElementById('nameInput');
    const roomInput = document.getElementById('roomInput');
    const createRoomBtn = document.getElementById('createRoomBtn');
    const joinRoomBtn = document.getElementById('joinRoomBtn');
    const turnOnCamBtn = document.getElementById('turnOnCamBtn');
    const turnOffCamBtn = document.getElementById('turnOffCamBtn');
    const startRecBtn = document.getElementById('startRecBtn');
    const stopRecBtn = document.getElementById('stopRecBtn');
    const videoGrid = document.getElementById('videoGrid');
    const ffmpegStatus = document.getElementById('ffmpegStatus');

    const offscreenCanvas = document.createElement('canvas');
    const ctxOff = offscreenCanvas.getContext('2d');
    const devicePixel = window.devicePixelRatio || 1;

    // map socketId -> displayName
    const peerNames = {};

    let socket = null;
    try {
      if (typeof io === 'function') {
        socket = io(SIGNALING_SERVER);
      } else {
        console.warn('[webview] socket.io client (io) not found - signaling disabled');
      }
    } catch (e) {
      console.warn('[webview] socket.io init failed', e);
      socket = null;
    }

    if (!socket) {
      createRoomBtn.disabled = true;
      joinRoomBtn.disabled = true;
      const msg = document.createElement('div');
      msg.style.color = '#f88';
      msg.textContent = 'Signaling client failed to load. Check network or server.';
      document.querySelector('.topbar').appendChild(msg);
    }

    const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

    let localCanvasStream = null;
    let localAudioStreamTrack = null;
    let combinedLocalStream = null;
    let audioWs = null;
    let audioWsPort = null;
    let gotFrame = false;

    // audio pipeline (worklet preferred)
    async function createAudioPipelineSampleRate(sampleRate = 48000) {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
      const workletCode = \`
      class PCMPlayerProcessor extends AudioWorkletProcessor {
        constructor() { super(); this._buffer = []; this._readIndex = 0; this.port.onmessage = (ev) => { const data = ev.data; if (data && data.buffer) this._buffer.push(data); }; }
        process(inputs, outputs) {
          const output = outputs[0];
          if (this._buffer.length === 0) { for (let ch = 0; ch < output.length; ch++) output[ch].fill(0); return true; }
          const framesNeeded = output[0].length;
          for (let ch = 0; ch < output.length; ch++) {
            const out = output[ch];
            let written = 0;
            while (written < framesNeeded && this._buffer.length > 0) {
              const front = this._buffer[0];
              const avail = front.length - this._readIndex;
              const toCopy = Math.min(avail, framesNeeded - written);
              for (let i = 0; i < toCopy; i++) out[written + i] = front[this._readIndex + i];
              this._readIndex += toCopy;
              written += toCopy;
              if (this._readIndex >= front.length) { this._buffer.shift(); this._readIndex = 0; }
            }
            for (let i = written; i < framesNeeded; i++) out[i] = 0;
          }
          return true;
        }
      }
      registerProcessor('pcm-player-processor', PCMPlayerProcessor);
      \`;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try { await audioContext.audioWorklet.addModule(url); } catch (e) { console.warn('[audio] worklet add failed', e); }
      const node = new AudioWorkletNode(audioContext, 'pcm-player-processor');
      node.port.start();
      const destination = audioContext.createMediaStreamDestination();
      node.connect(destination);
      return { audioContext, destination, node, pushFloat32Array: (f32) => { try { node.port.postMessage(f32, [f32.buffer]); } catch (e) { node.port.postMessage(f32); } } };
    }

    async function createFallbackAudioPipeline(sampleRate = 48000) {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
      const destination = audioContext.createMediaStreamDestination();
      const bufferSize = 4096;
      const sp = audioContext.createScriptProcessor(bufferSize, 0, 1);
      const queue = [];
      let queueReadIndex = 0;
      sp.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        let written = 0;
        while (written < out.length && queue.length > 0) {
          const front = queue[0];
          const avail = front.length - queueReadIndex;
          const toCopy = Math.min(avail, out.length - written);
          out.set(front.subarray(queueReadIndex, queueReadIndex + toCopy), written);
          queueReadIndex += toCopy;
          written += toCopy;
          if (queueReadIndex >= front.length) { queue.shift(); queueReadIndex = 0; }
        }
        if (written < out.length) for (let i = written; i < out.length; i++) out[i] = 0;
      };
      sp.connect(destination);
      return { audioContext, destination, sp, pushFloat32Array: (f32) => queue.push(f32) };
    }

    let audioPipeline = null;
    async function ensureAudioPipeline() {
      if (audioPipeline) return audioPipeline;
      try { audioPipeline = await createAudioPipelineSampleRate(48000); console.log('[audio] using worklet'); }
      catch (e) { console.warn('[audio] worklet failed, fallback', e); audioPipeline = await createFallbackAudioPipeline(48000); }
      return audioPipeline;
    }

    function connectLocalAudioWs(port) {
      if (!port) return console.warn('[audio-ws] no port provided');
      if (audioWs && audioWs.readyState === WebSocket.OPEN) return;
      const url = 'ws://127.0.0.1:' + port;
      console.log('[audio-ws] connecting to', url);
      audioWs = new WebSocket(url);
      audioWs.binaryType = 'arraybuffer';
      audioWs.onopen = () => console.log('[audio-ws] open');
      audioWs.onmessage = async (ev) => {
        const ab = ev.data;
        const s16 = new Int16Array(ab);
        const f32 = new Float32Array(s16.length);
        for (let i = 0; i < s16.length; i++) f32[i] = s16[i] / 32768;
        const pipeline = await ensureAudioPipeline();
        pipeline.pushFloat32Array(f32);
      };
      audioWs.onclose = () => { console.log('[audio-ws] closed'); audioWs = null; };
      audioWs.onerror = (e) => console.warn('[audio-ws] error', e);
    }

    // draw incoming base64 frames into offscreen canvas
    function handleFrameDataURL(dataUrl) {
      const img = new Image();
      img.onload = () => {
        const targetW = img.width || 640;
        offscreenCanvas.width = targetW * devicePixel;
        offscreenCanvas.height = (offscreenCanvas.width * img.height / img.width) | 0;
        ctxOff.drawImage(img, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

        if (!gotFrame) {
          gotFrame = true;
          startLocalCaptureIfReady();
        }
      };
      img.src = dataUrl;
    }

    async function startLocalCaptureIfReady() {
      if (localCanvasStream) return;
      try {
        localCanvasStream = offscreenCanvas.captureStream(30);
      } catch (e) {
        console.warn('[capture] offscreen captureStream failed', e);
        return;
      }
      const pipeline = await ensureAudioPipeline();
      const audioDestStream = pipeline.destination.stream || pipeline.destination;
      const audioTrack = audioDestStream.getAudioTracks()[0];
      if (audioTrack) {
        localAudioStreamTrack = audioTrack;
        try { localCanvasStream.addTrack(localAudioStreamTrack); } catch (e) { console.warn('[capture] addTrack failed', e); }
      } else console.warn('[capture] no audio track from pipeline');
      combinedLocalStream = localCanvasStream;
      addOrUpdateTile('local', combinedLocalStream, nameInput.value || 'Me (VS Code)', true);
    }

    // tiles and grid
    const tiles = {};
    function adjustGridLayout() {
      const ids = Object.keys(tiles);
      const n = ids.length || 1;
      const cols = Math.ceil(Math.sqrt(n));
      videoGrid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    }

    // flexible extraction of display name fields
    function extractNameFromPayload(obj) {
      if (!obj) return null;
      if (typeof obj === 'string') return null;
      return (
        obj.name ||
        obj.displayName ||
        obj.username ||
        obj.label ||
        (obj.meta && (obj.meta.name || obj.meta.displayName)) ||
        null
      );
    }

    // compute label, prefer peerNames map
    function computeLabel(passedLabel, id) {
      if (peerNames[id]) return peerNames[id];
      if (passedLabel && passedLabel !== id) return String(passedLabel).trim();
      if (id && id.length > 4) return 'Guest-' + id.slice(0,4);
      return passedLabel || id || 'Guest';
    }

    // update tile label if tile exists
    function updateTileLabelIfExists(id) {
      const tile = tiles[id];
      if (!tile) return;
      const lab = tile.querySelector('.video-label');
      const newLabel = computeLabel(null, id);
      if (lab && lab.textContent !== newLabel) lab.textContent = newLabel;
    }

    function addOrUpdateTile(id, stream, label, isLocal) {
      // don't create remote tile for our own socket id
      if (socket && id === socket.id && !isLocal) return;

      const hasTracks = stream && ((stream.getVideoTracks && stream.getVideoTracks().length) || (stream.getAudioTracks && stream.getAudioTracks().length));
      if (!isLocal && !hasTracks) return;

      let tile = tiles[id];
      if (!tile) {
        tile = document.createElement('div'); tile.className = 'video-tile';
        const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = !!isLocal;
        v.setAttribute('data-peer-id', id);
        tile.appendChild(v);
        const lab = document.createElement('div'); lab.className = 'video-label';
        lab.textContent = computeLabel(label, id);
        tile.appendChild(lab);
        videoGrid.appendChild(tile);
        tiles[id] = tile;
        adjustGridLayout();
      } else {
        const lab = tile.querySelector('.video-label');
        const newLabel = computeLabel(label, id);
        if (lab && lab.textContent !== newLabel) lab.textContent = newLabel;
      }
      const videoEl = tile.querySelector('video');
      if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
      videoEl.play().catch(()=>{});
    }
    function removeTile(id) {
      const t = tiles[id];
      if (t) {
        t.remove();
        delete tiles[id];
        adjustGridLayout();
      }
    }

    const pcs = {};
    let wired = false;

    function wireSignalingHandlers() {
      if (wired) return;
      if (!socket) { console.warn('[signal] socket missing'); return; }
      wired = true;

      socket.on('connect', () => console.log('[signal] connected', socket.id));

      // new-peer: populate peerNames and update tile label if present
      socket.on('new-peer', (payload) => {
        const socketId = payload && (payload.socketId || payload.id || payload);
        const name = extractNameFromPayload(payload) || null;
        if (socketId && name) {
          peerNames[socketId] = name;
          updateTileLabelIfExists(socketId);
        }
      });

      // room-info: handle possible members list
      socket.on('room-info', (payload) => {
        const others = payload && (payload.others || payload.peers || payload.participants || payload.members);
        if (Array.isArray(others)) {
          for (const o of others) {
            if (!o) continue;
            if (typeof o === 'object') {
              const id = o.id || o.socketId || o.s || null;
              const nm = extractNameFromPayload(o);
              if (id && nm) {
                peerNames[id] = nm;
                updateTileLabelIfExists(id);
              }
            }
          }
        }
      });

      socket.on("signal", async ({ from, data }) => {
        if (socket && from === socket.id) return;
        let pc = pcs[from];
        if (!pc) pc = await createPeerConnection(from, false);
        if (!pc) return;

        if (data.type === "offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit("signal", { to: from, from: socket.id, data: answer });
        }
        else if (data.type === "answer") {
            if (!pc.currentRemoteDescription) {
                await pc.setRemoteDescription(new RTCSessionDescription(data));
            }
        }
        else if (data.candidate) {
            if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        }
      });

      socket.on('peer-left', ({ socketId }) => {
        if (pcs[socketId]) { try { pcs[socketId].close(); } catch {} delete pcs[socketId]; }
        delete peerNames[socketId];
        removeTile(socketId);
      });
    }

    async function createPeerConnection(remoteId, initiator) {
      if (!remoteId || (socket && remoteId === socket.id)) {
        return null;
      }

      const pc = new RTCPeerConnection(pcConfig);
      pcs[remoteId] = pc;

      if (combinedLocalStream) {
          combinedLocalStream.getTracks().forEach(t => pc.addTrack(t, combinedLocalStream));
      }

      pc.ontrack = (ev) => {
          const incoming = ev.streams && ev.streams[0] ? ev.streams[0] : null;
          const hasTracks = incoming && ((incoming.getVideoTracks && incoming.getVideoTracks().length) || (incoming.getAudioTracks && incoming.getAudioTracks().length));
          if (hasTracks) {
            addOrUpdateTile(remoteId, incoming, peerNames[remoteId] || remoteId, false);
          } else {
            let tries = 0;
            const iv = setInterval(() => {
              tries++;
              const s = ev.streams && ev.streams[0] ? ev.streams[0] : null;
              if (s && ((s.getVideoTracks && s.getVideoTracks().length) || (s.getAudioTracks && s.getAudioTracks().length))) {
                clearInterval(iv);
                addOrUpdateTile(remoteId, s, peerNames[remoteId] || remoteId, false);
              } else if (tries > 10) {
                clearInterval(iv);
              }
            }, 100);
          }
      };

      pc.onicecandidate = (ev) => {
          if (ev.candidate) {
              socket.emit("signal", { to: remoteId, from: socket.id, data: { candidate: ev.candidate } });
          }
      };

      if (initiator) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("signal", { to: remoteId, from: socket.id, data: offer });
      }

      return pc;
    }

    async function createOfferTo(remoteId) {
      if (!remoteId || (socket && remoteId === socket.id)) return;
      const pc = await createPeerConnection(remoteId, true);
      if (!pc) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: remoteId, from: socket.id, data: pc.localDescription });
    }

    function waitForPreviewFrame(timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        if (gotFrame) return resolve(true);
        const start = Date.now();
        const iv = setInterval(() => {
          if (gotFrame) {
            clearInterval(iv);
            clearTimeout(to);
            resolve(true);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(iv);
            reject(new Error('Preview frame timeout'));
          }
        }, 200);
        const to = setTimeout(() => {
          clearInterval(iv);
          reject(new Error('Preview frame timeout'));
        }, timeoutMs);
      });
    }

    // create room: auto-start recording + auto join; parse meta/others for names
    createRoomBtn.addEventListener('click', async () => {
      if (!socket) return alert('Signaling unavailable');
      const roomId = (Math.random().toString(36).slice(2,8)).toUpperCase();
      roomInput.value = roomId;
      wireSignalingHandlers();
      socket.emit('create-room', { roomId, name: nameInput.value }, async (res) => {
        if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not create room');

        // server may return meta mapping like { id: name }
        if (res.meta && typeof res.meta === 'object') {
          for (const k of Object.keys(res.meta)) {
            peerNames[k] = res.meta[k];
            updateTileLabelIfExists(k);
          }
        }

        // parse others if present (objects or ids)
        const others = res.others || res.peers || res.participants || res.members || null;
        if (Array.isArray(others)) {
          for (const item of others) {
            if (!item) continue;
            if (typeof item === 'object') {
              const id = item.id || item.socketId || item.s || null;
              const nm = extractNameFromPayload(item);
              if (id && nm) {
                peerNames[id] = nm;
                updateTileLabelIfExists(id);
              }
            }
          }
        }

        try {
          if (vscode) {
            vscode.postMessage({ command: 'startRecording' });
          }
        } catch (e) { console.warn('[create] could not post startRecording', e); }

        try {
          await waitForPreviewFrame(10000);
        } catch (err) {
          alert('Preview/recording did not start in time. Please ensure FFmpeg is available and your camera is connected. Auto-join aborted.');
          return;
        }

        try { await ensureAudioPipeline(); } catch (e) { console.warn('[auto-join] ensureAudioPipeline failed', e); }

        socket.emit('join-room', { roomId, name: nameInput.value }, async (joinRes) => {
          if (!joinRes || !joinRes.ok) {
            return alert(joinRes && joinRes.message ? joinRes.message : 'Could not join room automatically');
          }
          const list = joinRes.others || joinRes.peers || joinRes.participants || joinRes.members || [];
          // apply meta mapping if present
          if (joinRes.meta && typeof joinRes.meta === 'object') {
            for (const k of Object.keys(joinRes.meta)) {
              peerNames[k] = joinRes.meta[k];
              updateTileLabelIfExists(k);
            }
          }
          for (const item of list) {
            if (!item) continue;
            if (typeof item === 'object') {
              const id = item.id || item.socketId || item.s || null;
              const nm = extractNameFromPayload(item);
              if (id && nm) { peerNames[id] = nm; updateTileLabelIfExists(id); }
              if (socket && id === socket.id) continue;
              if (id) await createOfferTo(id);
            } else {
              const id = String(item);
              if (socket && id === socket.id) continue;
              await createOfferTo(id);
            }
          }
        });
      });
    });

    // join room: flexible parsing
    joinRoomBtn.addEventListener('click', async () => {
      if (!socket) return alert('Signaling unavailable');
      const roomId = (roomInput.value || '').trim().toUpperCase();
      if (!roomId) return alert('Enter room code');
      wireSignalingHandlers();
      if (!gotFrame) return alert('Start FFmpeg preview/recording first (Turn Camera On or Start Recording) then join the room.');
      await ensureAudioPipeline();
      socket.emit('join-room', { roomId, name: nameInput.value }, async (res) => {
        if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not join room');
        if (res.meta && typeof res.meta === 'object') {
          for (const k of Object.keys(res.meta)) {
            peerNames[k] = res.meta[k];
            updateTileLabelIfExists(k);
          }
        }
        const others = res.others || res.peers || res.participants || res.members || [];
        for (const item of others) {
          if (!item) continue;
          if (typeof item === 'object') {
            const id = item.id || item.socketId || item.s || null;
            const nm = extractNameFromPayload(item);
            if (id && nm) { peerNames[id] = nm; updateTileLabelIfExists(id); }
            if (socket && id === socket.id) continue;
            if (id) await createOfferTo(id);
          } else {
            const id = String(item);
            if (socket && id === socket.id) continue;
            await createOfferTo(id);
          }
        }
      });
    });

    // extension messaging buttons
    turnOnCamBtn.addEventListener('click', () => {
      if (!vscode) return alert('VS Code API unavailable');
      vscode.postMessage({ command: 'turnCameraOn' });
    });
    turnOffCamBtn.addEventListener('click', () => {
      if (!vscode) return alert('VS Code API unavailable');
      vscode.postMessage({ command: 'turnCameraOff' });
      try { if (audioWs) audioWs.close(); } catch (e) {}
    });

    startRecBtn.addEventListener('click', () => {
      if (!vscode) return alert('VS Code API unavailable');
      vscode.postMessage({ command: 'startRecording' });
      stopRecBtn.disabled = false;
      startRecBtn.disabled = true;
    });
    stopRecBtn.addEventListener('click', () => {
      if (!vscode) return alert('VS Code API unavailable');
      vscode.postMessage({ command: 'stopRecording' });
      stopRecBtn.disabled = true;
      startRecBtn.disabled = false;
    });

    // messages from extension host
    window.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.command === 'frameUpdate' && msg.frame) handleFrameDataURL(msg.frame);
      else if (msg.command === 'requirementsStatus') ffmpegStatus.textContent = msg.ffmpeg ? 'Installed ✓' : 'Missing ✗';
      else if (msg.command === 'audioWsPort') { audioWsPort = msg.port; connectLocalAudioWs(audioWsPort); }
      else if (msg.command === 'previewStarted') { /* no visible preview UI to update */ }
      else if (msg.command === 'previewStopped') { /* no visible preview UI to update */ }
      else if (msg.command === 'recordingStarted') { stopRecBtn.disabled = false; startRecBtn.disabled = true; }
      else if (msg.command === 'recordingStopped') { stopRecBtn.disabled = true; startRecBtn.disabled = false; }
      // ffmpegLog messages intentionally ignored (no visible log)
    });

    // initial check
    try { if (vscode) vscode.postMessage({ command: 'checkRequirements' }); } catch (e) {}

    window.__internal = { connectLocalAudioWs, ensureAudioPipeline, createOfferTo, createPeerConnection, pcs, combinedLocalStream, peerNames };
  })();
  </script>
</body>
</html>
`;
}

function deactivateMeet() {
  if (ffmpegProcess) {
    try {
      ffmpegProcess.kill("SIGINT");
    } catch (e) {}
    ffmpegProcess = null;
  }
  if (previewProcess) {
    try {
      previewProcess.kill("SIGINT");
    } catch (e) {}
    previewProcess = null;
  }
  stopLocalAudioWsServer();
}

/* ---------------------------
   COLLAB (Yjs + WebRTC DataChannel) SECTION
   (kept at bottom; original logic preserved; collab-specific vars renamed to avoid collisions)
   --------------------------- */

let collabPanel = null;
let collabApplyingRemote = false;
let collabSubs = [];

let collabMyId = "";
let collabMyName = "";
let collabMyColor = "";

// Reuse cursor decorations per remote user to avoid lag
const collabCursorDecorations = new Map();

// Autosave timer for Yjs-applied changes
let collabAutosaveTimer = null;
const COLLAB_AUTOSAVE_DELAY_MS = 2000;

const COLORS = [
  "#ff5555",
  "#55ff55",
  "#5599ff",
  "#ffb86c",
  "#bd93f9",
  "#f1fa8c",
  "#ff79c6",
];

function activateCollab(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("webrtcCollab.start", () => {
      openCollabPanel(context);
    })
  );
}

function deactivateCollab() {
  collabCleanup();
}

function collabMakeId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.floor(Math.random() * 0xffff).toString(16)
  );
}

function collabHexToRgba(hex, alpha = 0.22) {
  if (!hex || hex[0] !== "#" || (hex.length !== 7 && hex.length !== 4))
    return `rgba(0,0,0,${alpha})`;

  if (hex.length === 4) {
    const r = parseInt(hex[1] + hex[1], 16);
    const g = parseInt(hex[2] + hex[2], 16);
    const b = parseInt(hex[3] + hex[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function collabScheduleAutosave(document) {
  if (!document) return;
  if (collabAutosaveTimer) {
    clearTimeout(collabAutosaveTimer);
  }
  collabAutosaveTimer = setTimeout(() => {
    collabAutosaveTimer = null;
    if (document.isDirty) {
      document.save().catch(() => {});
    }
  }, COLLAB_AUTOSAVE_DELAY_MS);
}

function openCollabPanel(context) {
  if (collabPanel) {
    collabPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  vscode.window
    .showInputBox({
      prompt: "Enter display name for collaboration",
      placeHolder: "e.g. Anubhav",
    })
    .then((typed) => {
      collabMyName =
        (typed && typed.trim()) ||
        `User-${Math.floor(Math.random() * 9000 + 1000)}`;
      collabMyId = collabMakeId();
      collabMyColor = COLORS[Math.floor(Math.random() * COLORS.length)];

      collabPanel = vscode.window.createWebviewPanel(
        "webrtcCollab",
        "WebRTC Collab (Yjs)",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      const yjsOnDisk = path.join(context.extensionPath, "media", "yjs.js");
      const yjsUri = collabPanel.webview.asWebviewUri(vscode.Uri.file(yjsOnDisk));

      collabPanel.webview.html = collabGetHtml(collabPanel.webview, yjsUri);

      const recv = collabPanel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg || typeof msg.type !== "string") return;

        // Color / profile change from webview
        if (msg.type === "profile-update" && msg.profile) {
          collabMyColor = msg.profile.color || collabMyColor;

          // Update my presence and broadcast to peers
          collabPanel.webview.postMessage({
            type: "presence",
            id: collabMyId,
            name: collabMyName,
            color: collabMyColor,
            forward: true, // forward via DC to others
          });

          // Update my local user list
          collabPanel.webview.postMessage({
            type: "user-list",
            users: [{ id: collabMyId, name: collabMyName, color: collabMyColor }],
          });
          return;
        }

        if (msg.type === "copy") {
          try {
            await vscode.env.clipboard.writeText(msg.text || "");
          } catch {}
          return;
        }

        // DataChannel just opened → send presence always
        // Only HOST also pushes initial file into Yjs
        if (msg.type === "dc-open") {
          const editor = vscode.window.activeTextEditor;
          try {
            // Send my presence (color / name) and forward to peers
            collabPanel.webview.postMessage({
              type: "presence",
              id: collabMyId,
              name: collabMyName,
              color: collabMyColor,
              forward: true,
            });

            // If I am host, push current editor text into Yjs
            if (msg.role === "host" && editor) {
              const full = editor.document.getText();
              collabPanel.webview.postMessage({
                type: "editor-change",
                text: full,
                forward: false, // do not re-forward; Yjs handles sync
                source: "vscode-initial",
              });
            }
          } catch {}
          return;
        }

        if (msg.type === "presence") {
          if (!msg.id || msg.id === collabMyId) return;
          collabPanel.webview.postMessage({
            type: "user-list",
            users: [{ id: msg.id, name: msg.name, color: msg.color }],
          });
          return;
        }

        if (msg.type === "editor-change") {
          // This comes from Yjs (CRDT result) → apply to VS Code editor
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;
          try {
            collabApplyingRemote = true;
            const newText = typeof msg.text === "string" ? msg.text : "";
            const fullRange = new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length)
            );
            editor.edit((ed) => {
              ed.replace(fullRange, newText);
            }).then(() => {
              // Autosave after remote/Yjs-driven changes
              collabScheduleAutosave(editor.document);
            });
          } finally {
            collabApplyingRemote = false;
          }
          return;
        }

        if (msg.type === "cursor") {
          if (!msg.id || msg.id === collabMyId) return;
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;

          const pos = editor.document.positionAt(msg.pos || 0);
          const range = new vscode.Range(pos, pos);

          // Reuse one decoration per remote user; colored caret only (no label)
          let dec = collabCursorDecorations.get(msg.id);
          if (!dec) {
            dec = vscode.window.createTextEditorDecorationType({
              border: `2px solid ${msg.color || "#ff79c6"}`,
              backgroundColor: collabHexToRgba(msg.color || "#ff79c6", 0.15),
            });
            collabCursorDecorations.set(msg.id, dec);
          }

          editor.setDecorations(dec, [range]);
          return;
        }

        if (msg.type === "presence-leave") {
          // clear all remote decorations
          for (const [, dec] of collabCursorDecorations.entries()) {
            try {
              dec.dispose();
            } catch {}
          }
          collabCursorDecorations.clear();
          collabPanel.webview.postMessage({ type: "user-list", users: [] });
          return;
        }
      });

      collabSubs.push(recv);

      // Throttled local-cursor sending to avoid lag
      let lastCursorSentTime = 0;
      let lastCursorOffset = -1;

      // Local VS Code edits → push into Yjs (webview), but avoid loops
      const send = vscode.workspace.onDidChangeTextDocument((ev) => {
        if (!collabPanel || collabApplyingRemote) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor || ev.document !== editor.document) return;

        const full = ev.document.getText();
        collabPanel.webview.postMessage({
          type: "editor-change",
          text: full,
          forward: true, // Yjs will broadcast to peers
          source: "vscode",
        });
      });

      collabSubs.push(send);

      const cursorSend = vscode.window.onDidChangeTextEditorSelection((ev) => {
        if (!collabPanel || collabApplyingRemote) return;
        const editor = ev.textEditor;
        if (!editor) return;
        const pos = editor.document.offsetAt(editor.selection.active);

        const now = Date.now();
        if (
          now - lastCursorSentTime < 80 &&
          Math.abs(pos - lastCursorOffset) < 1
        ) {
          return; // throttle
        }
        lastCursorSentTime = now;
        lastCursorOffset = pos;

        collabPanel.webview.postMessage({
          type: "cursor",
          pos,
          id: collabMyId,
          name: collabMyName,
          color: collabMyColor,
          forward: true,
        });
      });

      collabSubs.push(cursorSend);

      collabPanel.onDidDispose(() => collabCleanup());

      collabPanel.webview.postMessage({
        type: "user-list",
        users: [{ id: collabMyId, name: collabMyName, color: collabMyColor }],
      });
    });
}

function collabCleanup() {
  while (collabSubs.length) {
    try {
      collabSubs.pop().dispose();
    } catch {}
  }
  for (const [, dec] of collabCursorDecorations.entries()) {
    try {
      dec.dispose();
    } catch {}
  }
  collabCursorDecorations.clear();

  if (collabPanel) {
    try {
      collabPanel.dispose();
    } catch {}
    collabPanel = null;
  }
}

function collabRandRoom(len = 9) {
  const chars =
    "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++)
    s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function collabGetHtml(webview, yjsUri) {
  const DEFAULT_WSS = "wss://vscode-webrtc-signaling.onrender.com";


  const csp = `
    default-src 'none';
    img-src ${webview.cspSource};
    style-src 'unsafe-inline' ${webview.cspSource};
    script-src 'unsafe-inline' ${webview.cspSource} ${yjsUri};
    connect-src ws: wss: https:;
  `;

  const defaultRoom = collabRandRoom();

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">

<style>
  body {
    font-family: Segoe UI, Arial, system-ui;
    margin: 0;
    padding: 0;
    background: #1e1e1e;
    color: #e5e5e5;
  }

  .container {
    padding: 16px;
    max-width: 780px;
    margin: auto;
  }

  h2 {
    margin-top: 0;
    text-align: center;
    font-weight: 600;
    letter-spacing: .5px;
  }

  .card {
    background: #252526;
    padding: 14px 18px;
    border-radius: 8px;
    margin-bottom: 18px;
    border: 1px solid #3a3a3a;
  }

  .row {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  input {
    background: #333;
    border: 1px solid #555;
    color: #fff;
    padding: 8px;
    border-radius: 6px;
  }

  button {
    background: #0e639c;
    border: none;
    color: #fff;
    padding: 7px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 500;
  }

  button:hover {
    background: #1177bb;
  }

  button:disabled {
    background: #666;
    cursor: not-allowed;
  }

  #users {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  }

  .user {
    padding: 5px 10px;
    border-radius: 14px;
    font-size: 13px;
    color: black;
    font-weight: 600;
    display: flex;
    align-items: center;
    opacity: 0.9;
    transition: 0.15s;
  }

  .user.active {
    transform: scale(1.06);
    opacity: 1;
  }

  #log {
    background: #111;
    padding: 10px;
    border-radius: 6px;
    height: 140px;
    overflow-y: auto;
    font-size: 12px;
    border: 1px solid #333;
  }

  .section-title {
    font-size: 14px;
    font-weight: bold;
    margin-bottom: 6px;
    opacity: 0.9;
  }

  .btn-secondary {
    background: #444 !important;
  }

  .btn-secondary:hover {
    background: #555 !important;
  }
</style>
</head>

<body>
<div class="container">

  <h2>⚡ Real-time Collaborative Coding</h2>

  <div class="card">
    <div class="section-title">Session Room</div>
    <div class="row">
      <input id="room" value="${defaultRoom}" style="flex:1" />
      <button class="btn-secondary" id="regen">New</button>
      <button class="btn-secondary" id="copy">Copy</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Your Profile</div>
    <div class="row">
      <label style="min-width:80px;">Color:</label>
      <input id="color" type="color" value="#ff79c6" style="width:50px;padding:0;">
      <button id="applyProfile">Apply</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Connection</div>
    <div class="row">
      <button id="host" style="flex:1;">Host Session</button>
      <button id="join" style="flex:1;">Join Session</button>
      <button id="disc" disabled style="flex:1;" class="btn-secondary">Disconnect</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Connected Users</div>
    <div id="users"></div>
  </div>

  <div class="card">
    <div class="section-title">Logs</div>
    <div id="log"></div>
  </div>
</div>

<script src="${yjsUri}"></script>

<script>
(function(){
const vscode = acquireVsCodeApi();
const logEl = document.getElementById("log");
const usersEl = document.getElementById("users");

const hostBtn = document.getElementById("host");
const joinBtn = document.getElementById("join");
const discBtn = document.getElementById("disc");

const roomInput = document.getElementById("room");
const regenBtn = document.getElementById("regen");
const copyBtn = document.getElementById("copy");

const colorInp = document.getElementById("color");
const applyProfile = document.getElementById("applyProfile");

const Y = window.Y;
if (!Y) {
  log("ERROR: Yjs did NOT load from local UMD.");
  return;
}

let pc=null, dc=null, socket=null, role=null, room=null, pending=[];
let offerSent=false;

// Yjs state
const ydoc = new Y.Doc();
const ytext = ydoc.getText("codetext");
let isApplyingRemoteY = false;
let lastTextSentFromY = "";

// UI helpers
function log(m){
  logEl.textContent += m + "\\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function setState(s){
  if(s==="idle"){ hostBtn.disabled=false; joinBtn.disabled=false; discBtn.disabled=true; }
  if(s==="connecting"){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
  if(s==="connected"){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
}
function updateUserList(users){
  usersEl.innerHTML="";
  if(!Array.isArray(users)) return;
  for(const u of users){
    const el=document.createElement("div");
    el.className="user";
    el.style.background=u.color||"#ddd";
    el.innerHTML="<span>"+(u.name||"User")+"</span>";
    el.dataset.id = u.id || "";
    usersEl.appendChild(el);
  }
}
function pulseUser(id){
  const el = [...usersEl.children].find(c => c.dataset.id === id);
  if (!el) return;
  el.classList.add("active");
  setTimeout(() => el.classList.remove("active"), 200);
}

// Broadcast local Yjs updates over DataChannel
ydoc.on("update", (update) => {
  if (isApplyingRemoteY) return;
  if (!dc || dc.readyState !== "open") return;

  try {
    dc.send(JSON.stringify({
      type: "y-update",
      data: Array.from(update)
    }));
  } catch {}
});

// When Yjs text changes, tell extension (but avoid echo spam)
ytext.observe(() => {
  try {
    const t = ytext.toString();
    if (t === lastTextSentFromY) return;
    lastTextSentFromY = t;
    vscode.postMessage({
      type: "editor-change",
      text: t,
      forward: false
    });
  } catch {}
});

// WebRTC
function ensurePC(){
  pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  pc.onicecandidate=e=>{
    if(e.candidate && socket && room){
      socket.send(JSON.stringify({
        type:"candidate",
        room,
        candidate:e.candidate
      }));
    }
  };
  pc.onconnectionstatechange=()=>{
    log("RTC: " + pc.connectionState);
    if(pc.connectionState==="connected") setState("connected");
    if(["failed","disconnected","closed"].includes(pc.connectionState)){
      log("RTC ended");
      reset();
    }
  };
}

function wire(ch){
  dc=ch;
  dc.onopen=()=>{
    log("DataChannel open");
    // Tell extension that DC is open and whether we're host or join
    vscode.postMessage({ type:"dc-open", role });

    // send current Yjs state to peer
    try {
      const full = Y.encodeStateAsUpdate(ydoc);
      dc.send(JSON.stringify({
        type:"y-update",
        data:Array.from(full)
      }));
    } catch {}
  };

  dc.onmessage=e=>{
    let msg;
    try{ msg = JSON.parse(e.data); }catch{ return; }

    if (msg.type === "y-update" && msg.data) {
      try{
        isApplyingRemoteY = true;
        Y.applyUpdate(ydoc, new Uint8Array(msg.data));
      } finally {
        isApplyingRemoteY = false;
      }
      return;
    }

    if (msg.type === "cursor" && msg.id) {
      // ghost caret pulse in user list
      pulseUser(msg.id);
    }

    // forward presence/cursor/editor messages to extension
    vscode.postMessage(msg);
  };

  dc.onclose=()=>log("DC closed");
}

async function start(r){
  reset();
  offerSent=false;
  role=r;

  room=(roomInput.value||"").trim();
  if(!room){
    log("Room cannot be empty");
    return;
  }

  setState("connecting");
  ensurePC();

  if(role==="host"){
    wire(pc.createDataChannel("code"));
  } else {
    pc.ondatachannel = e => wire(e.channel);
  }

  socket = new WebSocket("${DEFAULT_WSS}");
  socket.onopen = () => {
    log("WS connected");
    socket.send(JSON.stringify({
      type: (role === "host") ? "create" : "join",
      room
    }));
  };

  socket.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "room-state") {
      log("Room state count=" + msg.count);
      if (role === "host" && !offerSent && msg.count > 1) {
        offerSent = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({
          type:"offer",
          room,
          sdp:offer
        }));
      }
      return;
    }

    if (msg.type === "peer-joined") {
      log("Peer joined");
      if (role === "host" && !offerSent) {
        offerSent = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({
          type:"offer",
          room,
          sdp:offer
        }));
      }
      return;
    }

    if (msg.type === "offer" && role === "join") {
      await pc.setRemoteDescription(msg.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.send(JSON.stringify({
        type:"answer",
        room,
        sdp:ans
      }));
      for (const c of pending) {
        try { await pc.addIceCandidate(c); } catch {}
      }
      pending = [];
      return;
    }

    if (msg.type === "answer" && role === "host") {
      await pc.setRemoteDescription(msg.sdp);
      for (const c of pending) {
        try { await pc.addIceCandidate(c); } catch {}
      }
      pending = [];
      return;
    }

    if (msg.type === "candidate") {
      if (!pc.remoteDescription) {
        pending.push(msg.candidate);
      } else {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      }
    }
  };

  socket.onerror = () => log("WS error");
  socket.onclose = () => log("WS closed");
}

function reset(){
  try{ dc && dc.close(); }catch{}
  try{ pc && pc.close(); }catch{}
  try{ socket && socket.close(); }catch{}
  pc = dc = socket = null;
  pending = [];
  setState("idle");
  log("Disconnected");
  vscode.postMessage({ type:"presence-leave" });
}

// Messages from extension → into Yjs / DC
window.addEventListener("message", ev => {
  const m = ev.data;
  if (!m) return;

  if (m.type === "user-list") {
    updateUserList(m.users);
    return;
  }

  // Forward presence/cursor/editor to peer via DC when needed
  if (m.forward && dc && dc.readyState === "open") {
    try { dc.send(JSON.stringify(m)); } catch {}
  }

  if (m.type === "editor-change" && typeof m.text === "string") {
    // Avoid echo loops: only update Yjs if text actually differs
    const current = ytext.toString();
    if (current === m.text) return;

    ydoc.transact(() => {
      try { ytext.delete(0, ytext.length); } catch {}
      ytext.insert(0, m.text);
    });

    lastTextSentFromY = m.text;
  }
});

// UI controls
regenBtn.onclick = () => {
  roomInput.value = (Math.random().toString(36).substr(2,9)).toUpperCase();
};
copyBtn.onclick = () => {
  vscode.postMessage({ type:"copy", text: roomInput.value });
};
applyProfile.onclick = () => {
  vscode.postMessage({
    type:"profile-update",
    profile:{ color: colorInp.value }
  });
};

hostBtn.onclick = () => start("host");
joinBtn.onclick = () => start("join");
discBtn.onclick = reset;

setState("idle");
log("Ready. Yjs loaded & WebRTC idle");
})();
</script>

</body>
</html>
`;
}

/* ---------------------------
   Combined activation & deactivation
   --------------------------- */

function activate(context) {
  // initialize both features
  activateMeet(context);
  activateCollab(context);
}

function deactivate() {
  try { deactivateMeet(); } catch {}
  try { deactivateCollab(); } catch {}
}

module.exports = { activate, deactivate };
