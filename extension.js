// extension.js - CLEAN FIXED VERSION (screenshot removed)
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

      // set webview content (no screenshot to avoid interpolation issues)
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
                  const s = d.toString();
                  panel.webview.postMessage({ command: "ffmpegLog", text: s });
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

                // frames for preview
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

// getWebviewContent (NO screenshot)
function getWebviewContent() {
  // signaling server URL (your render instance)
  const SIGNALING_SERVER = "https://voice-collab-room.onrender.com";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VS Code Meet — WebView</title>
<style>
  :root { --bg: var(--vscode-editor-background); --fg: var(--vscode-foreground); }
  body{ font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial; background:var(--bg); color:var(--fg); margin:0; padding:0; }
  .topbar{ display:flex; align-items:center; gap:8px; padding:10px; border-bottom:1px solid rgba(255,255,255,0.04); }
  .topbar input{ padding:6px 8px; border-radius:6px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:var(--fg); }
  .topbar button{ padding:6px 10px; border-radius:6px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; cursor:pointer;}
  .container{ display:flex; gap:12px; padding:12px; height: calc(100vh - 56px); box-sizing:border-box; }
  .left{ flex:2; display:flex; flex-direction:column; gap:12px; overflow:auto; }
  .right{ width:320px; display:flex; flex-direction:column; gap:12px; }
  .card{ background:var(--vscode-sideBar-background); border:1px solid var(--vscode-panel-border); border-radius:10px; padding:12px; }
  #previewCanvas{ width:100%; background:#000; border-radius:8px; display:block; }
  .video-grid{ display:grid; grid-template-columns: repeat(auto-fill, minmax(200px,1fr)); gap:8px; margin-top:8px; }
  .video-tile{ background:#111; border-radius:8px; overflow:hidden; display:flex; flex-direction:column; }
  .video-tile video{ width:100%; height:140px; object-fit:cover; background:#000; }
  .video-label{ padding:6px 8px; font-size:12px; color:#fff; text-align:center; background:rgba(0,0,0,0.6); }
  .status{ font-size:13px; color:var(--vscode-descriptionForeground); margin-top:6px;}
  .small { font-size:12px; color: #bbb; word-break:break-all; }
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
    <button id="turnOffCamBtn">Turn Camera Off</button>
    <button id="startRecBtn">Start Recording</button>
    <button id="stopRecBtn" disabled>Stop Recording</button>
  </div>

  <div class="container">
    <div class="left">
      <div class="card">
        <h3>Preview</h3>
        <canvas id="previewCanvas" width="640" height="360"></canvas>
        <div id="previewPlaceholder" class="status">Waiting for FFmpeg preview...</div>
        <pre id="ffmpegLog" class="status small" style="max-height:120px; overflow:auto;"></pre>
      </div>

      <div class="card">
        <h3>Participants</h3>
        <div id="videoGrid" class="video-grid"></div>
      </div>
    </div>

    <div class="right">
      <div class="card">
        <h3>Requirements</h3>
        <div>FFmpeg status: <span id="ffmpegStatus">Checking...</span></div>
      </div>

      <div class="card">
        <h3>Info</h3>
        <div class="small">Screenshot card removed (Option A)</div>
      </div>
    </div>
  </div>

  <!-- socket.io from your signaling server -->
  <script src="${SIGNALING_SERVER}/socket.io/socket.io.js"></script>

  <script>
  (function () {
    // Ensure vscode messaging is available inside webview
    const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;

    // Config
    const SIGNALING_SERVER = "${SIGNALING_SERVER}";
    const nameInput = document.getElementById('nameInput');
    const roomInput = document.getElementById('roomInput');
    const createRoomBtn = document.getElementById('createRoomBtn');
    const joinRoomBtn = document.getElementById('joinRoomBtn');
    const turnOnCamBtn = document.getElementById('turnOnCamBtn');
    const turnOffCamBtn = document.getElementById('turnOffCamBtn');
    const startRecBtn = document.getElementById('startRecBtn');
    const stopRecBtn = document.getElementById('stopRecBtn');
    const previewCanvas = document.getElementById('previewCanvas');
    const previewPlaceholder = document.getElementById('previewPlaceholder');
    const ffmpegLog = document.getElementById('ffmpegLog');
    const videoGrid = document.getElementById('videoGrid');
    const ffmpegStatus = document.getElementById('ffmpegStatus');

    const ctx = previewCanvas.getContext('2d');
    const devicePixel = window.devicePixelRatio || 1;

    // safe socket creation
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

    // local capture vars
    let localCanvasStream = null;
    let localAudioStreamTrack = null;
    let combinedLocalStream = null;
    let audioWs = null;
    let audioWsPort = null;
    let gotFrame = false;

    // audio pipeline (AudioWorklet preferred)
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

    function handleFrameDataURL(dataUrl) {
      const img = new Image();
      img.onload = () => {
        const targetW = previewCanvas.clientWidth;
        previewCanvas.width = targetW * devicePixel;
        previewCanvas.height = (previewCanvas.width * img.height / img.width) | 0;
        ctx.drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height);
        if (!gotFrame) {
          gotFrame = true;
          previewPlaceholder.style.display = 'none';
          startLocalCaptureIfReady();
        }
      };
      img.src = dataUrl;
    }

    async function startLocalCaptureIfReady() {
      if (localCanvasStream) return;
      localCanvasStream = previewCanvas.captureStream(30);
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

    const tiles = {};
    function addOrUpdateTile(id, stream, label, isLocal) {
      let tile = tiles[id];
      if (!tile) {
        tile = document.createElement('div'); tile.className = 'video-tile';
        const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = !!isLocal;
        tile.appendChild(v);
        const lab = document.createElement('div'); lab.className = 'video-label'; lab.textContent = label || id;
        tile.appendChild(lab);
        videoGrid.appendChild(tile);
        tiles[id] = tile;
      }
      const videoEl = tile.querySelector('video');
      if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
      videoEl.play().catch(()=>{});
    }
    function removeTile(id) { const t = tiles[id]; if (t) { t.remove(); delete tiles[id]; } }

    // WebRTC mesh
    const pcs = {};
    let wired = false;

    function wireSignalingHandlers() {
      if (wired) return;
      if (!socket) { console.warn('[signal] socket missing'); return; }
      wired = true;

      socket.on('connect', () => console.log('[signal] connected', socket.id));

      // Important: do NOT create offer on new-peer (prevents glare). Joiner will create offers.
      socket.on('new-peer', ({ socketId, name }) => {
        console.log('[signal] new-peer', socketId, name);
        addOrUpdateTile(socketId, new MediaStream(), name || 'Guest');
      });

      socket.on('signal', async ({ from, data }) => {
        if (!pcs[from]) await createPeerConnection(from, false);
        const pc = pcs[from];
        if (!pc) return;
        try {
          if (data.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('signal', { to: from, from: socket.id, data: pc.localDescription });
          } else if (data.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data));
          } else if (data.candidate) {
            try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { console.warn(e); }
          }
        } catch (err) {
          console.error('[signal] process error', err);
        }
      });

      socket.on('peer-left', ({ socketId }) => {
        console.log('[signal] peer-left', socketId);
        if (pcs[socketId]) { try { pcs[socketId].close(); } catch {} delete pcs[socketId]; }
        removeTile(socketId);
      });
    }

    async function createPeerConnection(remoteId) {
      if (pcs[remoteId]) return pcs[remoteId];
      const pc = new RTCPeerConnection(pcConfig);
      pcs[remoteId] = pc;

      if (combinedLocalStream) {
        for (const t of combinedLocalStream.getTracks()) pc.addTrack(t, combinedLocalStream);
      }

      const remoteStream = new MediaStream();
      addOrUpdateTile(remoteId, remoteStream, remoteId, false);

      pc.ontrack = (ev) => {
        ev.streams[0].getTracks().forEach(tr => remoteStream.addTrack(tr));
        addOrUpdateTile(remoteId, remoteStream, remoteId, false);
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) socket.emit('signal', { to: remoteId, from: socket.id, data: { candidate: ev.candidate } });
      };

      pc.onconnectionstatechange = () => {
        if (['failed','disconnected','closed'].includes(pc.connectionState)) {
          try { pc.close(); } catch {}
          delete pcs[remoteId];
          removeTile(remoteId);
        }
      };

      return pc;
    }

    async function createOfferTo(remoteId) {
      const pc = await createPeerConnection(remoteId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: remoteId, from: socket.id, data: pc.localDescription });
    }

    // UI actions
    createRoomBtn.addEventListener('click', async () => {
      if (!socket) return alert('Signaling unavailable');
      const roomId = (Math.random().toString(36).slice(2,8)).toUpperCase();
      roomInput.value = roomId;
      wireSignalingHandlers();
      socket.emit('create-room', { roomId, name: nameInput.value }, (res) => {
        if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not create room');
        alert('Room created: ' + roomId);
      });
    });

    joinRoomBtn.addEventListener('click', async () => {
      if (!socket) return alert('Signaling unavailable');
      const roomId = (roomInput.value || '').trim().toUpperCase();
      if (!roomId) return alert('Enter room code');
      wireSignalingHandlers();
      if (!gotFrame) return alert('Start FFmpeg preview first (Turn Camera On) then join the room.');
      await ensureAudioPipeline();
      socket.emit('join-room', { roomId, name: nameInput.value }, async (res) => {
        if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not join room');
        const others = res.others || [];
        for (const id of others) await createOfferTo(id); // JOINER creates offers
      });
    });

    // extension messaging
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
      else if (msg.command === 'ffmpegLog' && msg.text) { ffmpegLog.textContent += msg.text + "\\n"; ffmpegLog.scrollTop = ffmpegLog.scrollHeight; }
      else if (msg.command === 'requirementsStatus') ffmpegStatus.textContent = msg.ffmpeg ? 'Installed ✓' : 'Missing ✗';
      else if (msg.command === 'audioWsPort') { audioWsPort = msg.port; connectLocalAudioWs(audioWsPort); }
      else if (msg.command === 'previewStarted') previewPlaceholder.style.display = 'none';
      else if (msg.command === 'previewStopped') previewPlaceholder.style.display = 'block';
      else if (msg.command === 'recordingStarted') { stopRecBtn.disabled = false; startRecBtn.disabled = true; }
      else if (msg.command === 'recordingStopped') { stopRecBtn.disabled = true; startRecBtn.disabled = false; }
    });

    // initial check
    try { if (vscode) vscode.postMessage({ command: 'checkRequirements' }); } catch (e) {}

    window.__internal = { connectLocalAudioWs, ensureAudioPipeline, createOfferTo, createPeerConnection, pcs, combinedLocalStream };
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
