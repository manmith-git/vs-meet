// extension.js - final version
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
let audioWsServer = null; // WebSocket server instance
let audioHttpServer = null; // underlying http server
let audioWsPort = null;

const platform = os.platform();
let platformModule;

if (platform === "win32") {
  platformModule = require("./platforms/windows");
} else {
  // Fallback: try windows module if others not implemented
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
    if (audioWsServer && audioHttpServer && audioWsPort) {
      return resolve(audioWsPort);
    }
    // create a tiny HTTP server and attach ws to it
    audioHttpServer = http.createServer((req, res) => {
      res.writeHead(200);
      res.end("OK");
    });
    audioHttpServer.listen(0, "127.0.0.1", () => {
      const addr = audioHttpServer.address();
      audioWsPort = addr.port;
      audioWsServer = new WebSocket.Server({ server: audioHttpServer });
      audioWsServer.on("connection", (ws) => {
        console.log("Audio WS client connected");
        ws.on("close", () => {
          console.log("Audio WS client disconnected");
        });
      });
      console.log("Audio WS server listening on port", audioWsPort);
      resolve(audioWsPort);
    });
    audioHttpServer.on("error", (err) => {
      console.error("Audio HTTP server error:", err);
      reject(err);
    });
  });
}

function broadcastAudioChunk(chunk) {
  if (!audioWsServer) return;
  audioWsServer.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      // send raw PCM as binary
      c.send(chunk);
    }
  });
}

function stopLocalAudioWsServer() {
  if (audioWsServer) {
    try {
      audioWsServer.close();
    } catch (e) {}
    audioWsServer = null;
  }
  if (audioHttpServer) {
    try {
      audioHttpServer.close();
    } catch (e) {}
    audioHttpServer = null;
    audioWsPort = null;
  }
}

function activate(context) {
  console.log("Camera Recorder + Meet extension activated!");

  const disposable = vscode.commands.registerCommand(
    "meetup.openRecorder",
    async function () {
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

      // developer instruction: uploaded screenshot path (provided earlier)
      // include it as the "uploaded file url" in the webview context
      const uploadedScreenshotUrl = "sandbox:/mnt/data/Screenshot 2025-11-24 084215.png";

      let isDisposed = false;
      await checkFfmpegInstalled();
      panel.webview.html = getWebviewContent(uploadedScreenshotUrl);

      // handle messages from webview (UI actions)
      panel.webview.onDidReceiveMessage(
        async (message) => {
          if (!message || !message.command) return;
          try {
            switch (message.command) {
              case "checkRequirements": {
                const ffmpeg = await checkFfmpegInstalled();
                panel.webview.postMessage({ command: "requirementsStatus", ffmpeg });
                break;
              }

              case "turnCameraOn": {
                // Start preview-only ffmpeg (no file output) if not already running
                if (previewProcess) {
                  panel.webview.postMessage({ command: "previewAlreadyRunning" });
                  break;
                }
                // Start WS server for audio so webview can connect
                const port = await startLocalAudioWsServer();
                panel.webview.postMessage({ command: "audioWsPort", port });

                // start ffmpeg preview with audio pipe:3 (RAW PCM s16le 48k mono)
                const devices = await listDevices();
                if (devices.videoDevices.length === 0) {
                  vscode.window.showErrorMessage("No video devices found. Please connect a camera.");
                  break;
                }
                const videoDeviceName = devices.videoDevices[0];
                const audioDeviceName = devices.audioDevices.length > 0 ? devices.audioDevices[0] : null;
                const videoArgs = getVideoInputArgs(videoDeviceName);
                const audioArgs = audioDeviceName ? getAudioInputArgs(audioDeviceName) : [];

                // Build ffmpeg args:
                // video -> stdout (pipe:1) as mjpeg
                // audio -> fd 3 (pipe:3) as raw PCM s16le 48000 1 channel
                // no MP4 recording in preview mode
                const args = [
                  ...videoArgs,
                  ...(audioArgs.length > 0 ? audioArgs : []),
                  // video mapping
                  "-map", "0:v",
                  "-f", "image2pipe",
                  "-vcodec", "mjpeg",
                  "-q:v", "3",
                  "pipe:1",
                ];
                // audio mapping -> raw PCM pipe:3
                if (audioArgs.length > 0) {
                  args.push(
                    "-map", "0:a",
                    "-f", "s16le",
                    "-ar", "48000",
                    "-ac", "1",
                    "pipe:3"
                  );
                }

                console.log("Starting preview ffmpeg with args:", args.join(" "));
                // spawn with three pipes: stdout (pipe), stderr (pipe), and fd 3 (pipe)
                previewProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });

                // handle mjpeg frames from stdout
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
                    panel.webview.postMessage({ command: "frameUpdate", frame: `data:image/jpeg;base64,${base64}` });
                  }
                  if (frameBuffer.length > 1024 * 1024) frameBuffer = Buffer.alloc(0);
                });

                // handle raw pcm audio from fd 3 (if audio mapped)
                if (previewProcess.stdio && previewProcess.stdio[3]) {
                  previewProcess.stdio[3].on("data", (chunk) => {
                    // broadcast raw PCM binary to connected WS clients
                    broadcastAudioChunk(chunk);
                  });
                  previewProcess.stdio[3].on("end", () => {
                    console.log("Preview FFmpeg audio pipe ended");
                  });
                }

                previewProcess.stderr.on("data", (d) => {
                  // optional logging for ffmpeg messages
                  const s = d.toString();
                  // occasionally ffmpeg prints informative lines - forward audio level if parsed
                  panel.webview.postMessage({ command: "ffmpegLog", text: s });
                });

                previewProcess.on("exit", (code) => {
                  console.log("Preview ffmpeg exited with code", code);
                  previewProcess = null;
                });

                panel.webview.postMessage({ command: "previewStarted" });
                break;
              }

              case "turnCameraOff": {
                // stop preview process (but not recording)
                if (previewProcess) {
                  try {
                    previewProcess.stdin && previewProcess.stdin.write("q");
                  } catch (e) {}
                  try {
                    previewProcess.kill("SIGTERM");
                  } catch (e) {}
                  previewProcess = null;
                }
                // stop local audio ws server
                stopLocalAudioWsServer();
                panel.webview.postMessage({ command: "previewStopped" });
                break;
              }

              case "startRecording": {
                // start recording + preview (if already preview running, we'll also record)
                if (isRecording) return;
                const devices = await listDevices();
                if (devices.videoDevices.length === 0) {
                  vscode.window.showErrorMessage("No video devices found. Please connect a camera.");
                  break;
                }
                const videoDeviceName = devices.videoDevices[0];
                const audioDeviceName = devices.audioDevices.length > 0 ? devices.audioDevices[0] : null;

                const workspaceFolders = vscode.workspace.workspaceFolders;
                const outputDir = workspaceFolders ? workspaceFolders[0].uri.fsPath : require("os").homedir();
                const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                const outputPath = path.join(outputDir, `recording-${timestamp}.mp4`);

                // Build ffmpeg args: same as before but with mp4 output (file) + image2pipe stdout for preview + pipe:3 audio
                const videoArgs = getVideoInputArgs(videoDeviceName);
                const audioArgs = audioDeviceName ? getAudioInputArgs(audioDeviceName) : [];

                // ensure audio ws server is running
                const port = await startLocalAudioWsServer();
                panel.webview.postMessage({ command: "audioWsPort", port });

                const args = [
                  ...videoArgs,
                  ...(audioArgs.length > 0 ? audioArgs : []),
                  // stdout preview
                  "-map", "0:v",
                  "-f", "image2pipe",
                  "-vcodec", "mjpeg",
                  "-q:v", "3",
                  "pipe:1",
                ];

                if (audioArgs.length > 0) {
                  // also map audio to pipe:3 and include in mp4
                  args.push(
                    "-map", "0:a",
                    "-f", "s16le",
                    "-ar", "48000",
                    "-ac", "1",
                    "pipe:3"
                  );
                }

                // mp4 output mapping: create mp4 from the devices (video + audio)
                // We'll append another mapping to generate mp4 file using libx264 + aac if audio exists
                if (audioArgs.length > 0) {
                  args.push(
                    "-map", "0:v",
                    "-map", "0:a",
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

                console.log("Starting recording ffmpeg with args:", args.join(" "));
                isRecording = true;
                currentRecordingPath = outputPath;
                // spawn with pipe: stdout and pipe:3 for audio
                previewProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });

                // handle frames (same logic)
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
                    panel.webview.postMessage({ command: "frameUpdate", frame: `data:image/jpeg;base64,${base64}` });
                  }
                  if (frameBuf.length > 1024 * 1024) frameBuf = Buffer.alloc(0);
                });

                // audio pipe
                if (previewProcess.stdio && previewProcess.stdio[3]) {
                  previewProcess.stdio[3].on("data", (chunk) => {
                    broadcastAudioChunk(chunk);
                  });
                }

                previewProcess.stderr.on("data", (d) => {
                  const s = d.toString();
                  panel.webview.postMessage({ command: "ffmpegLog", text: s });
                });

                previewProcess.on("exit", (code) => {
                  console.log("Recording ffmpeg exited with code", code);
                  if (isRecording) {
                    if (code === 0 || code === 255) {
                      vscode.window.showInformationMessage(`Recording saved: ${currentRecordingPath}`);
                    } else {
                      vscode.window.showErrorMessage(`Recording failed with code ${code}`);
                    }
                  }
                  isRecording = false;
                  panel.webview.postMessage({ command: "recordingStopped" });
                });

                panel.webview.postMessage({ command: "recordingStarted", path: outputPath });
                break;
              }

              case "stopRecording": {
                if (!isRecording || !previewProcess) return;
                isRecording = false;
                try { previewProcess.stdin && previewProcess.stdin.write("q"); } catch (e) {}
                setTimeout(() => {
                  if (previewProcess) {
                    try { previewProcess.kill("SIGTERM"); } catch (e) {}
                    previewProcess = null;
                  }
                }, 1000);
                panel.webview.postMessage({ command: "recordingStopped" });
                break;
              }

              default:
                console.log("Unknown command from webview:", message.command);
            }
          } catch (err) {
            console.error("Error handling webview message", err);
          }
        },
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(
        () => {
          isDisposed = true;
          // stop ffmpeg processes
          if (previewProcess) {
            try { previewProcess.kill("SIGTERM"); } catch (e) {}
            previewProcess = null;
          }
          if (ffmpegProcess) {
            try { ffmpegProcess.kill("SIGINT"); } catch (e) {}
            ffmpegProcess = null;
          }
          // stop ws server
          stopLocalAudioWsServer();
        },
        undefined,
        context.subscriptions
      );
    }
  );

  context.subscriptions.push(disposable);
}

function getWebviewContent(uploadedScreenshotUrl) {
  // SIGNALING_SERVER used by the webview JS for socket.io connections (your Render server)
  const SIGNALING_SERVER = "https://voice-collab-room.onrender.com";

  // We'll include the local audio WS port dynamically by sending a message 'audioWsPort' from extension to webview when server starts
  // webview will call window.connectLocalAudioWS(port)
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
  .controls-row{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .status{ font-size:13px; color:var(--vscode-descriptionForeground); margin-top:6px;}
  .small { font-size:12px; color: #bbb; word-break:break-all; }
  img#uploadedScreenshot { width:100%; border-radius:6px; margin-top:6px; }
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
        <h3>Uploaded Screenshot</h3>
        <!-- The extension passed this path as uploadedScreenshotUrl. Build step can transform it to a resource URL. -->
        <div id="screenshotWrap"><img id="uploadedScreenshot" src="${uploadedScreenshotUrl}" alt="uploaded screenshot" /></div>
        <div class="small">Path: <span id="uploadedPath">${uploadedScreenshotUrl}</span></div>
      </div>
    </div>
  </div>

  <!-- socket.io (signaling) -->
  <script src="https://voice-collab-room.onrender.com/socket.io/socket.io.js"></script>

  <script>
  (function () {
    // ---- Config ----
    const SIGNALING_SERVER = "https://voice-collab-room.onrender.com";
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

    // WebRTC and local audio wiring
    const socket = io(SIGNALING_SERVER);
    const pcConfig = { iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] };

    let localCanvasStream = null;      // canvas.captureStream()
    let localAudioStreamTrack = null;  // produced by WebAudio -> MediaStream (destination)
    let combinedLocalStream = null;    // stream we add to RTCPeerConnection (canvas + audio)
    let audioWs = null;                // local WebSocket to extension (sends raw PCM)
    let audioWsPort = null;
    let gotFrame = false;

    // audioWorklet helper: will create worklet that receives Float32 chunks via port.postMessage
    async function createAudioPipelineSampleRate(sampleRate = 48000) {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });

      // create a blob for the worklet processor code
      const workletCode = `
      class PCMPlayerProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this._buffer = [];
          this._readIndex = 0;
          this._channelCount = 1;
          this.port.onmessage = (ev) => {
            // Expect Float32Array transferable
            const data = ev.data;
            if (data && data.buffer) {
              this._buffer.push(data);
            }
          };
        }
        process(inputs, outputs, parameters) {
          const output = outputs[0];
          if (this._buffer.length === 0) {
            // output silence
            for (let ch = 0; ch < output.length; ch++) {
              const out = output[ch];
              out.fill(0);
            }
            return true;
          }
          // fill output with samples from queued buffers
          const framesNeeded = output[0].length;
          for (let ch = 0; ch < output.length; ch++) {
            const out = output[ch];
            let written = 0;
            while (written < framesNeeded && this._buffer.length > 0) {
              const front = this._buffer[0];
              const available = front.length - this._readIndex;
              const toCopy = Math.min(available, framesNeeded - written);
              for (let i = 0; i < toCopy; i++) out[written + i] = front[this._readIndex + i];
              this._readIndex += toCopy;
              written += toCopy;
              if (this._readIndex >= front.length) {
                this._buffer.shift();
                this._readIndex = 0;
              }
            }
            // if not fully written, fill rest with zeros
            for (let i = written; i < framesNeeded; i++) out[i] = 0;
          }
          return true;
        }
      }
      registerProcessor('pcm-player-processor', PCMPlayerProcessor);
      `;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const moduleUrl = URL.createObjectURL(blob);
      try {
        await audioContext.audioWorklet.addModule(moduleUrl);
      } catch (e) {
        console.warn('AudioWorklet addModule failed', e);
        // fallback will be handled below
      }

      const node = new AudioWorkletNode(audioContext, 'pcm-player-processor');
      node.port.start();

      // connect to destination (MediaStream)
      const destination = audioContext.createMediaStreamDestination();
      node.connect(destination);

      // return helpers to push Float32 arrays into the worklet
      return {
        audioContext,
        destination,
        node,
        pushFloat32Array: (f32) => {
          try {
            node.port.postMessage(f32, [f32.buffer]);
          } catch (e) {
            // if transferable fails, send a copy
            node.port.postMessage(f32);
          }
        }
      };
    }

    // fallback pipeline if audioWorklet not supported properly
    async function createFallbackAudioPipeline(sampleRate = 48000) {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
      const destination = audioContext.createMediaStreamDestination();
      // We'll use a ScriptProcessorNode (deprecated) as fallback
      const bufferSize = 4096;
      const channels = 1;
      const sp = audioContext.createScriptProcessor(bufferSize, 0, channels);
      // ring buffer
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
          if (queueReadIndex >= front.length) {
            queue.shift();
            queueReadIndex = 0;
          }
        }
        if (written < out.length) {
          for (let i = written; i < out.length; i++) out[i] = 0;
        }
      };

      // pushFloat32Array
      function pushFloat32Array(f32) {
        queue.push(f32);
      }

      sp.connect(destination);
      return { audioContext, destination, sp, pushFloat32Array };
    }

    // Choose pipeline factory depending on availability
    let audioPipeline = null;
    async function ensureAudioPipeline() {
      if (audioPipeline) return audioPipeline;
      try {
        audioPipeline = await createAudioPipelineSampleRate(48000);
        console.log('Using AudioWorklet pipeline');
      } catch (e) {
        console.warn('AudioWorklet pipeline failed, using fallback', e);
        audioPipeline = await createFallbackAudioPipeline(48000);
      }
      return audioPipeline;
    }

    // connect to local audio WS (port received from extension)
    function connectLocalAudioWs(port) {
      if (!port) { console.warn('No port provided for local audio WS'); return; }
      if (audioWs && audioWs.readyState === WebSocket.OPEN) return;
      const url = 'ws://127.0.0.1:' + port;
      console.log('Connecting to local audio WS at', url);
      audioWs = new WebSocket(url);
      audioWs.binaryType = 'arraybuffer';
      audioWs.onopen = () => {
        console.log('local audio WS open');
      };
      audioWs.onmessage = async (ev) => {
        // ev.data is ArrayBuffer raw PCM s16le 48k mono
        const ab = ev.data;
        // Convert s16le to Float32 array in range [-1,1]
        const s16 = new Int16Array(ab);
        const f32 = new Float32Array(s16.length);
        for (let i = 0; i < s16.length; i++) f32[i] = s16[i] / 32768;
        const pipeline = await ensureAudioPipeline();
        pipeline.pushFloat32Array(f32);
      };
      audioWs.onclose = () => {
        console.log('local audio WS closed');
        audioWs = null;
      };
      audioWs.onerror = (e) => {
        console.warn('local audio WS error', e);
      };
    }

    // draw JPEG frames onto canvas
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

    // capture canvas and create combined stream with audio
    async function startLocalCaptureIfReady() {
      if (localCanvasStream) return;
      // capture canvas
      localCanvasStream = previewCanvas.captureStream(30);
      // ensure audio pipeline exists and connect its destination to a track
      const pipeline = await ensureAudioPipeline();
      // destination is a MediaStream
      const audioDestStream = pipeline.destination.stream || pipeline.destination;
      // in case destination is a MediaStreamDestination node -> .stream
      const audioTrack = audioDestStream.getAudioTracks()[0];
      if (audioTrack) {
        localAudioStreamTrack = audioTrack;
        // add audio track to canvas stream
        try {
          localCanvasStream.addTrack(localAudioStreamTrack);
        } catch (e) {
          console.warn('Failed to add audio track to canvas stream', e);
        }
      } else {
        console.warn('No audio track available from pipeline.destination');
      }
      combinedLocalStream = localCanvasStream;
      // show local tile
      addOrUpdateTile('local', combinedLocalStream, nameInput.value || 'Me (VS Code)', true);
    }

    // UI tile helpers
    const tiles = {};
    function addOrUpdateTile(id, stream, label, isLocal) {
      let tile = tiles[id];
      if (!tile) {
        tile = document.createElement('div');
        tile.className = 'video-tile';
        const v = document.createElement('video');
        v.autoplay = true; v.playsInline = true; v.muted = !!isLocal;
        tile.appendChild(v);
        const lab = document.createElement('div'); lab.className='video-label'; lab.textContent=label||id;
        tile.appendChild(lab);
        videoGrid.appendChild(tile);
        tiles[id] = tile;
      }
      const videoEl = tile.querySelector('video');
      videoEl.srcObject = stream;
    }
    function removeTile(id) {
      const tile = tiles[id];
      if (tile) { tile.remove(); delete tiles[id]; }
    }

    // --- WebRTC mesh logic using socket.io (SIGNALING_SERVER) ---
    const pcs = {}; // peerId -> RTCPeerConnection
    let wired = false;

    function wireSignalingHandlers() {
      if (wired) return;
      wired = true;

      socket.on('connect', () => {
        console.log('connected to signaling server', socket.id);
      });

      socket.on('new-peer', async ({ socketId, name }) => {
        console.log('new-peer', socketId);
        addOrUpdateTile(socketId, new MediaStream(), name || 'Guest');
        await createOfferTo(socketId);
      });

      socket.on('signal', async ({ from, data }) => {
        if (!pcs[from]) await createPeerConnection(from, false);
        const pc = pcs[from];
        if (!pc) return;
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
      });

      socket.on('peer-left', ({ socketId }) => {
        console.log('peer-left', socketId);
        if (pcs[socketId]) { try { pcs[socketId].close(); } catch {} delete pcs[socketId]; }
        removeTile(socketId);
      });
    }

    async function createPeerConnection(remoteId, isInitiator) {
      if (pcs[remoteId]) return pcs[remoteId];
      const pc = new RTCPeerConnection(pcConfig);
      pcs[remoteId] = pc;

      // add local tracks (canvas + audio) if available
      if (combinedLocalStream) {
        for (const t of combinedLocalStream.getTracks()) pc.addTrack(t, combinedLocalStream);
      }

      // remote stream collector
      const remoteStream = new MediaStream();
      addOrUpdateTile(remoteId, remoteStream, remoteId, false);

      pc.ontrack = (ev) => {
        ev.streams[0].getTracks().forEach(tr => remoteStream.addTrack(tr));
        addOrUpdateTile(remoteId, remoteStream, remoteId, false);
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          socket.emit('signal', { to: remoteId, from: socket.id, data: { candidate: ev.candidate }});
        }
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
      const pc = await createPeerConnection(remoteId, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: remoteId, from: socket.id, data: pc.localDescription });
    }

    // UI actions: create/join rooms via signaling server
    createRoomBtn.addEventListener('click', async () => {
      const roomId = (Math.random().toString(36).slice(2,8)).toUpperCase();
      roomInput.value = roomId;
      wireSignalingHandlers();
      socket.emit('create-room', { roomId, name: nameInput.value }, (res) => {
        if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not create room');
        alert('Room created: ' + roomId);
      });
    });

    joinRoomBtn.addEventListener('click', async () => {
      const roomId = (roomInput.value || '').trim().toUpperCase();
      if (!roomId) return alert('Enter room code to join');
      wireSignalingHandlers();

      // ensure we have capture started (video+audio)
      if (!gotFrame) {
        return alert('Start the FFmpeg preview first (Turn Camera On) so the canvas stream is available, then join the room.');
      }
      // ensure audio pipeline is ready
      await ensureAudioPipeline();

      socket.emit('join-room', { roomId, name: nameInput.value }, async (res) => {
        if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not join room');
        const others = res.others || [];
        // create offers to existing members
        for (const otherId of others) await createOfferTo(otherId);
      });
    });

    // Turn camera on/off controls send messages to extension host to start/stop ffmpeg
    turnOnCamBtn.addEventListener('click', () => {
      // ask extension host to spin up ffmpeg preview + audio WS
      vscode.postMessage({ command: 'turnCameraOn' });
    });
    turnOffCamBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'turnCameraOff' });
      // close local audio ws if open
      try { if (audioWs) audioWs.close(); } catch (e) {}
    });

    startRecBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'startRecording' });
      stopRecBtn.disabled = false;
      startRecBtn.disabled = true;
    });
    stopRecBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'stopRecording' });
      stopRecBtn.disabled = true;
      startRecBtn.disabled = false;
    });

    // Handle messages from extension (frameUpdate, audioWsPort, etc.)
    window.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.command === 'frameUpdate' && msg.frame) {
        handleFrameDataURL(msg.frame);
      } else if (msg.command === 'ffmpegLog' && msg.text) {
        ffmpegLog.textContent += msg.text + "\\n";
        ffmpegLog.scrollTop = ffmpegLog.scrollHeight;
      } else if (msg.command === 'requirementsStatus') {
        ffmpegStatus.textContent = msg.ffmpeg ? 'Installed ✓' : 'Missing ✗';
      } else if (msg.command === 'audioWsPort') {
        audioWsPort = msg.port;
        // connect immediately
        connectLocalAudioWs(audioWsPort);
      } else if (msg.command === 'previewStarted') {
        previewPlaceholder.style.display = 'none';
      } else if (msg.command === 'previewStopped') {
        previewPlaceholder.style.display = 'block';
      } else if (msg.command === 'recordingStarted') {
        stopRecBtn.disabled = false;
        startRecBtn.disabled = true;
      } else if (msg.command === 'recordingStopped') {
        stopRecBtn.disabled = true;
        startRecBtn.disabled = false;
      }
    });

    // initial check: ask extension for ffmpeg status
    try { vscode.postMessage({ command: 'checkRequirements' }); } catch (e) { console.warn('vscode postMessage not available (outside extension)', e); }

    // Expose debug helpers
    window.__internal = {
      connectLocalAudioWs,
      ensureAudioPipeline,
      createOfferTo,
      createPeerConnection,
      pcs,
      combinedLocalStream,
    };
  })();
  </script>
</body>
</html>
`;
}

function deactivate() {
  if (ffmpegProcess) {
    try { ffmpegProcess.kill("SIGINT"); } catch (e) {}
    ffmpegProcess = null;
  }
  if (previewProcess) {
    try { previewProcess.kill("SIGINT"); } catch (e) {}
    previewProcess = null;
  }
  stopLocalAudioWsServer();
}

module.exports = { activate, deactivate };
