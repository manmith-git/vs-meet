// extension.js - FIXED VERSION
// Fixed issues: 
// - Join button double-press requirement
// - Inconsistent camera visibility
// - Camera stream stability
// - WebRTC connection reliability

const vscode = require("vscode");
const { exec, spawn } = require("child_process");
const path = require("path");
const os = require("os");
const http = require("http");
const WebSocket = require("ws");

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

// Track camera state globally
let isCameraOn = false;
let currentPanel = null;

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

function activate(context) {
  console.log("Camera Recorder + Meet extension activated");

  const disposable = vscode.commands.registerCommand(
    "meetup.openRecorder",
    async () => {
      // Close existing panel if any
      if (currentPanel) {
        currentPanel.dispose();
      }

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

      currentPanel = panel;
      let isDisposed = false;

      // set webview content
      panel.webview.html = getWebviewContent();

      // Initialize camera state
      isCameraOn = false;

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
                if (isCameraOn) {
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
                  isCameraOn = false;
                  panel.webview.postMessage({ command: "previewStopped" });
                });

                isCameraOn = true;
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
                isCameraOn = false;
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
                isCameraOn = true;
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
                  isCameraOn = false;
                  previewProcess = null;
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
                isCameraOn = false;
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
          isCameraOn = false;
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
          currentPanel = null;
        },
        undefined,
        context.subscriptions
      );
    }
  );

  context.subscriptions.push(disposable);
}

// getWebviewContent: FIXED WebRTC implementation
function getWebviewContent() {
  const SIGNALING_SERVER = "https://voice-collab-room.onrender.com";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VS Code Meet — WebView</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --card: var(--vscode-sideBar-background);
    --panel-border: var(--vscode-panel-border);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
  }
  html,body{ height:100%; margin:0; padding:0; font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial; background:var(--bg); color:var(--fg); }
  .topbar{ display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.04); position:sticky; top:0; z-index:5; background:linear-gradient(180deg, rgba(20,20,20,0.6), rgba(20,20,20,0.2)); backdrop-filter: blur(4px); }
  .topbar input{ padding:6px 8px; border-radius:6px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:var(--fg); min-width:140px; }
  .topbar button{ padding:6px 10px; border-radius:6px; background:var(--btn-bg); color:var(--btn-fg); border:none; cursor:pointer; }
  .topbar button:disabled{ opacity:0.5; cursor:not-allowed; }
  .container{ display:flex; gap:12px; padding:12px; height: calc(100vh - 56px); box-sizing:border-box; overflow:hidden; }
  .left{ flex:1 1 auto; display:flex; flex-direction:column; gap:12px; min-width:0; }
  .card{ background:var(--card); border:1px solid var(--panel-border); border-radius:10px; padding:12px; box-sizing:border-box; overflow:hidden; }
  .participants-card{ display:flex; flex-direction:column; height:100%; min-height:0; }
  .video-grid{ display:grid; gap:10px; grid-template-columns: repeat(1, 1fr); align-content:start; width:100%; padding:6px; box-sizing:border-box; overflow:auto; }
  .video-tile{ background: #0b0b0b; border-radius:10px; overflow:hidden; position:relative; display:flex; flex-direction:column; align-items:stretch; justify-content:center; aspect-ratio: 16 / 9; min-height: 80px; box-shadow: 0 1px 0 rgba(0,0,0,0.4) inset; }
  .video-tile video{ width:100%; height:100%; object-fit:cover; display:block; background:#000; }
  .video-label{ position:absolute; left:8px; bottom:8px; padding:4px 8px; font-size:12px; color:#fff; background:linear-gradient(90deg, rgba(0,0,0,0.6), rgba(0,0,0,0.3)); border-radius:6px; backdrop-filter: blur(2px); }
  .right{ width:320px; display:flex; flex-direction:column; gap:12px; min-width:220px; }
  .status{ font-size:13px; color:var(--muted); margin-top:6px; }
  .small { font-size:12px; color: #bbb; word-break:break-all; }
  @media (max-width:900px){ .container{ flex-direction:column; height: calc(100vh - 56px); overflow:auto; } .right{ width:100%; } }
  .video-grid::-webkit-scrollbar{ height:8px; width:8px; }
  .video-grid::-webkit-scrollbar-thumb{ background: rgba(255,255,255,0.06); border-radius:8px; }
</style>
</head>
<body>
  <div class="topbar">
    <input id="nameInput" placeholder="Your name" />
    <input id="roomInput" placeholder="Room code (6 chars) or leave blank to create" />
    <button id="createRoomBtn">Create</button>
    <button id="joinRoomBtn">Join</button>
    <div style="flex:1"></div>
    <button id="turnOnCamBtn">Turn Camera On</button>
    <button id="turnOffCamBtn" disabled>Turn Camera Off</button>
    <button id="startRecBtn">Start Recording</button>
    <button id="stopRecBtn" disabled>Stop Recording</button>
  </div>

  <div class="container">
    <div class="left">
      <div class="card participants-card" style="flex:1; min-height:0;">
        <h3 style="margin:0 0 8px 0">Participants</h3>
        <div id="videoGrid" class="video-grid" role="list" aria-label="Video tiles"></div>
      </div>
    </div>

    <div class="right">
      <div class="card">
        <h3 style="margin:0 0 8px 0">Requirements</h3>
        <div>FFmpeg status: <span id="ffmpegStatus">Checking...</span></div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 8px 0">Info</h3>
        <div class="small">Preview removed from UI. Offscreen capture continues to work.</div>
      </div>
    </div>
  </div>

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
    let isSocketConnected = false;
    let isCameraReady = false;
    let joinInProgress = false;

    try {
      if (typeof io === 'function') {
        socket = io(SIGNALING_SERVER, {
          transports: ['websocket', 'polling'],
          timeout: 10000
        });
        
        socket.on('connect', () => {
          console.log('[signal] connected', socket.id);
          isSocketConnected = true;
          updateButtonStates();
        });
        
        socket.on('disconnect', () => {
          console.log('[signal] disconnected');
          isSocketConnected = false;
          updateButtonStates();
        });
        
        socket.on('connect_error', (error) => {
          console.warn('[signal] connection error', error);
          isSocketConnected = false;
          updateButtonStates();
        });
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

    const pcConfig = { 
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };

    let localCanvasStream = null;
    let localAudioStreamTrack = null;
    let combinedLocalStream = null;
    let audioWs = null;
    let audioWsPort = null;
    let gotFrame = false;

    function updateButtonStates() {
      const canJoin = isSocketConnected && isCameraReady && !joinInProgress;
      joinRoomBtn.disabled = !canJoin;
      createRoomBtn.disabled = !canJoin;
      
      // Update button text during join process
      if (joinInProgress) {
        joinRoomBtn.textContent = 'Joining...';
        createRoomBtn.textContent = 'Creating...';
      } else {
        joinRoomBtn.textContent = 'Join';
        createRoomBtn.textContent = 'Create';
      }
    }

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
          isCameraReady = true;
          updateButtonStates();
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
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
        // Ensure video plays consistently
        videoEl.play().catch(e => {
          console.warn(\`[video] play failed for \${id}:\`, e);
          // Retry play after a short delay
          setTimeout(() => {
            videoEl.play().catch(console.warn);
          }, 100);
        });
      }
    }
    
    function removeTile(id) {
      const t = tiles[id];
      if (t) {
        const videoEl = t.querySelector('video');
        if (videoEl && videoEl.srcObject) {
          videoEl.srcObject.getTracks().forEach(track => track.stop());
          videoEl.srcObject = null;
        }
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
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(data));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit("signal", { to: from, from: socket.id, data: answer });
            } catch (e) {
                console.error('[webrtc] error handling offer:', e);
            }
        }
        else if (data.type === "answer") {
            if (!pc.currentRemoteDescription) {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data));
                } catch (e) {
                    console.error('[webrtc] error setting remote description:', e);
                }
            }
        }
        else if (data.candidate) {
            if (pc.remoteDescription) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (e) {
                    console.warn('[webrtc] error adding ice candidate:', e);
                }
            }
        }
      });

      socket.on('peer-left', ({ socketId }) => {
        if (pcs[socketId]) { 
          try { 
            pcs[socketId].close(); 
          } catch (e) {} 
          delete pcs[socketId]; 
        }
        delete peerNames[socketId];
        removeTile(socketId);
      });
    }

    async function createPeerConnection(remoteId, initiator) {
      if (!remoteId || (socket && remoteId === socket.id)) {
        return null;
      }

      // Clean up existing connection if any
      if (pcs[remoteId]) {
        try {
          pcs[remoteId].close();
        } catch (e) {}
        delete pcs[remoteId];
      }

      const pc = new RTCPeerConnection(pcConfig);
      pcs[remoteId] = pc;

      // Set connection state handlers
      pc.onconnectionstatechange = () => {
        console.log(\`[webrtc] \${remoteId} connection state: \${pc.connectionState}\`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setTimeout(() => {
            if (pc.connectionState !== 'connected') {
              removeTile(remoteId);
            }
          }, 2000);
        }
      };

      pc.onsignalingstatechange = () => {
        console.log(\`[webrtc] \${remoteId} signaling state: \${pc.signalingState}\`);
      };

      if (combinedLocalStream) {
          combinedLocalStream.getTracks().forEach(t => {
            try {
              pc.addTrack(t, combinedLocalStream);
            } catch (e) {
              console.warn(\`[webrtc] error adding track to \${remoteId}:\`, e);
            }
          });
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
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("signal", { to: remoteId, from: socket.id, data: offer });
          } catch (e) {
            console.error('[webrtc] error creating offer:', e);
          }
      }

      return pc;
    }

    async function createOfferTo(remoteId) {
      if (!remoteId || (socket && remoteId === socket.id)) return;
      const pc = await createPeerConnection(remoteId, true);
      if (!pc) return;
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
      if (!socket || !isSocketConnected) return alert('Signaling unavailable or not connected');
      if (joinInProgress) return;
      
      joinInProgress = true;
      updateButtonStates();
      
      try {
        const roomId = (Math.random().toString(36).slice(2,8)).toUpperCase();
        roomInput.value = roomId;
        wireSignalingHandlers();
        
        socket.emit('create-room', { roomId, name: nameInput.value }, async (res) => {
          if (!res || !res.ok) {
            joinInProgress = false;
            updateButtonStates();
            return alert(res && res.message ? res.message : 'Could not create room');
          }

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
            joinInProgress = false;
            updateButtonStates();
            alert('Preview/recording did not start in time. Please ensure FFmpeg is available and your camera is connected. Auto-join aborted.');
            return;
          }

          try { await ensureAudioPipeline(); } catch (e) { console.warn('[auto-join] ensureAudioPipeline failed', e); }

          socket.emit('join-room', { roomId, name: nameInput.value }, async (joinRes) => {
            joinInProgress = false;
            updateButtonStates();
            
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
      } catch (error) {
        joinInProgress = false;
        updateButtonStates();
        console.error('[create] error:', error);
        alert('Error creating room: ' + error.message);
      }
    });

    // join room: flexible parsing
    joinRoomBtn.addEventListener('click', async () => {
      if (!socket || !isSocketConnected) return alert('Signaling unavailable or not connected');
      if (joinInProgress) return;
      
      const roomId = (roomInput.value || '').trim().toUpperCase();
      if (!roomId) return alert('Enter room code');
      
      if (!gotFrame) return alert('Start FFmpeg preview/recording first (Turn Camera On or Start Recording) then join the room.');
      
      joinInProgress = true;
      updateButtonStates();
      
      try {
        wireSignalingHandlers();
        await ensureAudioPipeline();
        
        socket.emit('join-room', { roomId, name: nameInput.value }, async (res) => {
          joinInProgress = false;
          updateButtonStates();
          
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
      } catch (error) {
        joinInProgress = false;
        updateButtonStates();
        console.error('[join] error:', error);
        alert('Error joining room: ' + error.message);
      }
    });

    // extension messaging buttons
    turnOnCamBtn.addEventListener('click', () => {
      if (!vscode) return alert('VS Code API unavailable');
      vscode.postMessage({ command: 'turnCameraOn' });
      turnOnCamBtn.disabled = true;
      turnOffCamBtn.disabled = false;
    });
    
    turnOffCamBtn.addEventListener('click', () => {
      if (!vscode) return alert('VS Code API unavailable');
      vscode.postMessage({ command: 'turnCameraOff' });
      turnOnCamBtn.disabled = false;
      turnOffCamBtn.disabled = true;
      isCameraReady = false;
      updateButtonStates();
      try { if (audioWs) audioWs.close(); } catch (e) {}
      // Clean up local stream
      if (combinedLocalStream) {
        combinedLocalStream.getTracks().forEach(track => track.stop());
        combinedLocalStream = null;
      }
      localCanvasStream = null;
      removeTile('local');
      gotFrame = false;
    });

    startRecBtn.addEventListener('click', () => {
      if (!vscode) return alert('VS Code API unavailable');
      vscode.postMessage({ command: 'startRecording' });
      stopRecBtn.disabled = false;
      startRecBtn.disabled = true;
      turnOnCamBtn.disabled = true;
      turnOffCamBtn.disabled = false;
    });
    
    stopRecBtn.addEventListener('click', () => {
      if (!vscode) return alert('VS Code API unavailable');
      vscode.postMessage({ command: 'stopRecording' });
      stopRecBtn.disabled = true;
      startRecBtn.disabled = false;
      turnOnCamBtn.disabled = false;
      turnOffCamBtn.disabled = true;
    });

    // messages from extension host
    window.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.command === 'frameUpdate' && msg.frame) handleFrameDataURL(msg.frame);
      else if (msg.command === 'requirementsStatus') ffmpegStatus.textContent = msg.ffmpeg ? 'Installed ✓' : 'Missing ✗';
      else if (msg.command === 'audioWsPort') { audioWsPort = msg.port; connectLocalAudioWs(audioWsPort); }
      else if (msg.command === 'previewStarted') { 
        turnOnCamBtn.disabled = true;
        turnOffCamBtn.disabled = false;
      }
      else if (msg.command === 'previewStopped') { 
        turnOnCamBtn.disabled = false;
        turnOffCamBtn.disabled = true;
        isCameraReady = false;
        updateButtonStates();
      }
      else if (msg.command === 'recordingStarted') { 
        stopRecBtn.disabled = false; 
        startRecBtn.disabled = true; 
      }
      else if (msg.command === 'recordingStopped') { 
        stopRecBtn.disabled = true; 
        startRecBtn.disabled = false; 
      }
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

function deactivate() {
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

module.exports = { activate, deactivate };