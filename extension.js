const vscode = require("vscode");
const { exec, spawn } = require("child_process");
const path = require("path");
const os = require("os");

let ffmpegProcess = null;
let previewProcess = null;
let isRecording = false;
let currentRecordingPath = null;

// load platform module (windows/macos/linux)
const platform = os.platform();
let platformModule;

if (platform === "win32") {
  platformModule = require("./platforms/windows");
}
// } else if (platform === 'darwin') {
// 	platformModule = require('./platforms/macos');
// } else {
// 	platformModule = require('./platforms/linux');
// }

const { listDevices, getVideoInputArgs, getAudioInputArgs } = platformModule;

function checkFfmpegInstalled() {
  return new Promise((resolve) => {
    exec("ffmpeg -version", (error) => {
      resolve(!error);
    });
  });
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

      let isDisposed = false;

      await checkFfmpegInstalled();

      panel.webview.html = getWebviewContent();

      panel.webview.onDidReceiveMessage(
        async (message) => {
          switch (message.command) {
            case "checkRequirements": {
              const ffmpeg = await checkFfmpegInstalled();
              panel.webview.postMessage({
                command: "requirementsStatus",
                ffmpeg,
              });
              break;
            }

            case "startRecording": {
              if (isRecording || previewProcess) return;

              // detect available devices
              let videoDeviceName = null;
              let audioDeviceName = null;

              const devices = await listDevices();
              if (devices.videoDevices.length === 0) {
                vscode.window.showErrorMessage(
                  "No video devices found. Please connect a camera."
                );
                return;
              }
              videoDeviceName = devices.videoDevices[0];
              audioDeviceName =
                devices.audioDevices.length > 0
                  ? devices.audioDevices[0]
                  : null;

              console.log("Using video device:", videoDeviceName);
              console.log("Using audio device:", audioDeviceName);

              const workspaceFolders = vscode.workspace.workspaceFolders;
              const outputDir = workspaceFolders
                ? workspaceFolders[0].uri.fsPath
                : require("os").homedir();
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const outputPath = path.join(
                outputDir,
                `recording-${timestamp}.mp4`
              );

              isRecording = true;
              currentRecordingPath = outputPath;

              // jpeg frame boundary markers
              let frameBuffer = Buffer.alloc(0);
              const JPEG_START = Buffer.from([0xff, 0xd8]);
              const JPEG_END = Buffer.from([0xff, 0xd9]);

              const videoArgs = getVideoInputArgs(videoDeviceName);
              const audioArgs = audioDeviceName
                ? getAudioInputArgs(audioDeviceName)
                : [];

              console.log("Starting recording with video args:", videoArgs);
              console.log("Starting recording with audio args:", audioArgs);
              console.log("Output path:", outputPath);

              const ffmpegArgs = [
                ...videoArgs,
                ...(audioArgs.length > 0 ? audioArgs : []),
              ];

              if (audioArgs.length > 0) {
                ffmpegArgs.push(
                  "-map",
                  "0:v",
                  "-f",
                  "image2pipe",
                  "-vcodec",
                  "mjpeg",
                  "-q:v",
                  "3",
                  "pipe:1",
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
                ffmpegArgs.push(
                  "-map",
                  "0:v",
                  "-f",
                  "image2pipe",
                  "-vcodec",
                  "mjpeg",
                  "-q:v",
                  "3",
                  "pipe:1",
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

              previewProcess = spawn("ffmpeg", ffmpegArgs);

              previewProcess.stdout.on("data", (data) => {
                if (isDisposed) return;

                // extract complete jpeg frames
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

                if (frameBuffer.length > 1024 * 1024) {
                  frameBuffer = Buffer.alloc(0);
                }
              });

              let recordingError = "";
              let audioBuffer = "";
              let lastAudioUpdate = Date.now();

              previewProcess.stderr.on("data", (data) => {
                const text = data.toString();
                recordingError += text;
                audioBuffer += text;

                if (text.includes("Error") || text.includes("error")) {
                  console.error("FFmpeg Error:", text);
                }
                if (
                  text.includes("Input #") ||
                  text.includes("Output #") ||
                  text.includes("Stream #")
                ) {
                  console.log("FFmpeg Stream Info:", text);
                }

                const rmsMatch = audioBuffer.match(/RMS level dB: (-?[0-9.]+)/);
                if (rmsMatch && Date.now() - lastAudioUpdate > 50) {
                  const rmsDB = parseFloat(rmsMatch[1]);
                  const level = Math.max(0, Math.min(100, (rmsDB + 60) * 2));
                  if (!isDisposed && isRecording) {
                    panel.webview.postMessage({
                      command: "audioLevel",
                      level: level,
                    });
                  }
                  audioBuffer = "";
                  lastAudioUpdate = Date.now();
                }

                if (audioBuffer.length > 10000) {
                  audioBuffer = audioBuffer.slice(-5000);
                }
              });
              previewProcess.on("error", (err) => {
                console.error("FFmpeg process error:", err);
                vscode.window.showErrorMessage(
                  `Recording error: ${err.message}`
                );
                isRecording = false;
                panel.webview.postMessage({ command: "recordingStopped" });
              });

              previewProcess.on("exit", (code) => {
                if (isRecording) {
                  if (code === 0 || code === 255) {
                    vscode.window.showInformationMessage(
                      `Recording saved: ${currentRecordingPath}`
                    );
                  } else {
                    vscode.window.showErrorMessage(
                      `Recording failed with code ${code}`
                    );
                    console.error("FFmpeg error:", recordingError);
                  }
                  isRecording = false;
                }
              });

              vscode.window.showInformationMessage(
                `Recording started: ${outputPath}`
              );
              panel.webview.postMessage({
                command: "recordingStarted",
                path: outputPath,
              });
              break;
            }

            case "stopRecording": {
              if (!isRecording || !previewProcess) return;

              console.log("Stopping recording...");
              isRecording = false;

              // send quit command to ffmpeg
              previewProcess.stdin.write("q");
              setTimeout(() => {
                if (previewProcess) {
                  console.log("Force killing ffmpeg process");
                  previewProcess.kill("SIGTERM");
                  previewProcess = null;
                }
              }, 1000);

              vscode.window.showInformationMessage("Recording stopped");
              panel.webview.postMessage({ command: "recordingStopped" });
              break;
            }
          }
        },
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(
        () => {
          isDisposed = true;
          if (ffmpegProcess) {
            ffmpegProcess.kill("SIGINT");
            ffmpegProcess = null;
          }
          if (previewProcess) {
            previewProcess.kill();
            previewProcess = null;
          }
        },
        undefined,
        context.subscriptions
      );
    }
  );

  context.subscriptions.push(disposable);
}

function getWebviewContent() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>VS Code Meet</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			padding: 0;
			height: 100vh;
			display: flex;
			flex-direction: column;
		}

		.header {
			background: var(--vscode-titleBar-activeBackground);
			padding: 16px 24px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display:flex;
			flex-direction:column;
			gap:4px;
		}

		.header h1 {
			font-size: 20px;
			font-weight: 600;
		}

		.header p {
			color: var(--vscode-descriptionForeground);
			font-size: 13px;
		}

		.main-content {
			flex: 1;
			display: flex;
			padding: 20px;
			gap: 20px;
			overflow: auto;
		}

		.left-panel {
			flex: 2;
			display: flex;
			flex-direction: column;
			gap: 16px;
			min-width: 0;
		}

		.right-panel {
			flex: 1;
			display: flex;
			flex-direction: column;
			gap: 16px;
			min-width: 260px;
		}

		.card {
			background: var(--vscode-sideBar-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 10px;
			padding: 16px;
		}

		.card h2 {
			font-size: 16px;
			font-weight: 600;
			margin-bottom: 10px;
			display: flex;
			align-items: center;
			gap: 8px;
		}

		/* Meeting UI */

		.meet-controls {
			display:flex;
			flex-wrap:wrap;
			gap:8px;
			margin-bottom:10px;
		}
		.meet-controls input {
			flex:1 1 150px;
			padding:6px 8px;
			font-size:13px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
			border-radius:6px;
		}
		.meet-controls button {
			padding:6px 10px;
			font-size:13px;
			border-radius:6px;
			border:none;
			cursor:pointer;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.meet-controls button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.meet-status {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin-bottom:8px;
		}
		.video-grid {
			display:grid;
			grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
			gap:8px;
		}
		.video-tile {
			background:#111;
			border-radius:8px;
			overflow:hidden;
			display:flex;
			flex-direction:column;
		}
		.video-tile video {
			width:100%;
			height:150px;
			object-fit:cover;
			background:#000;
		}
		.video-label {
			padding:6px 8px;
			font-size:12px;
			text-align:center;
			background:rgba(0,0,0,0.7);
			color:#fff;
		}

		/* Preview & audio */

		.preview-container {
			background: #000;
			border-radius: 10px;
			overflow: hidden;
			position: relative;
			min-height: 260px;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.preview-video {
			width: 100%;
			height: auto;
			display: block;
		}

		.preview-placeholder {
			color: #888;
			font-size: 14px;
			text-align: center;
		}

		.audio-visualizer {
			width: 100%;
			height: 80px;
			background: var(--vscode-editor-background);
			border-radius: 8px;
			padding: 10px;
			position: relative;
			overflow: hidden;
		}

		.audio-bars {
			display: flex;
			align-items: flex-end;
			height: 100%;
			gap: 3px;
			justify-content: space-around;
		}

		.audio-bar {
			flex: 1;
			background: linear-gradient(to top, #4CAF50, #8BC34A);
			border-radius: 3px 3px 0 0;
			transition: height 0.1s ease;
			min-height: 2px;
		}

		/* Requirements & controls */

		.requirements-grid {
			display: grid;
			gap: 10px;
		}

		.requirement-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px;
			background: var(--vscode-editor-background);
			border-radius: 8px;
			border: 1px solid var(--vscode-panel-border);
		}

		.requirement-label {
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: 500;
		}

		.status-dot {
			width: 10px;
			height: 10px;
			border-radius: 50%;
			display: inline-block;
		}

		.status-text {
			font-size: 12px;
			padding: 3px 10px;
			border-radius: 12px;
			font-weight: 500;
		}

		.status-ok {
			background: #4CAF50;
		}

		.status-error {
			background: #f44336;
		}

		.btn {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 10px 16px;
			border-radius: 8px;
			cursor: pointer;
			font-size: 13px;
			font-weight: 500;
			transition: all 0.15s;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
		}

		.btn:hover:not(:disabled) {
			background: var(--vscode-button-hoverBackground);
			transform: translateY(-1px);
		}

		.btn:active:not(:disabled) {
			transform: translateY(0);
		}

		.btn:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.btn-secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}

		.btn-secondary:hover:not(:disabled) {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.btn-danger {
			background: #f44336;
			color: white;
		}

		.recording-indicator {
			display: none;
			align-items: center;
			gap: 8px;
			padding: 10px;
			background: rgba(244, 67, 54, 0.1);
			border: 1px solid #f44336;
			border-radius: 8px;
			color: #f44336;
			font-weight: 500;
			font-size: 13px;
		}

		.recording-indicator.active {
			display: flex;
		}

		.recording-dot {
			width: 10px;
			height: 10px;
			background: #f44336;
			border-radius: 50%;
			animation: pulse 1.5s infinite;
		}

		@keyframes pulse {
			0%, 100% { opacity: 1; transform: scale(1); }
			50% { opacity: 0.5; transform: scale(0.9); }
		}

		.status-message {
			padding: 10px;
			border-radius: 8px;
			font-size: 13px;
			display: none;
		}

		.status-message.active {
			display: block;
		}

		.status-message.success {
			background: rgba(76, 175, 80, 0.1);
			color: #4CAF50;
			border: 1px solid #4CAF50;
		}

		.status-message.info {
			background: rgba(33, 150, 243, 0.1);
			color: #2196F3;
			border: 1px solid #2196F3;
		}

		@media (max-width: 900px) {
			.main-content {
				flex-direction: column;
			}
			.right-panel {
				min-width: 0;
			}
		}
	</style>
</head>
<body>
	<div class="header">
		<h1>VS Code Meet</h1>
		<p>Share audio & video with your team, plus record using FFmpeg.</p>
	</div>

	<div class="main-content">
		<div class="left-panel">
			<div class="card">
				<h2>🧑‍🤝‍🧑 Meet Room</h2>
				<div class="meet-controls">
					<input id="nameInput" placeholder="Your name" />
					<input id="roomInput" placeholder="Room code (6 chars) or leave blank to create" />
					<button id="createRoomBtn">Create</button>
					<button id="joinRoomBtn">Join</button>
				</div>
				<div class="meet-status" id="meetStatus">Not connected.</div>
				<div class="video-grid" id="videoGrid"></div>
			</div>

			<div class="card">
				<h2>📹 FFmpeg Preview</h2>
				<div class="preview-container">
					<img class="preview-video" id="previewVideo" style="display: none;" />
					<div class="preview-placeholder" id="previewPlaceholder">
						Click "Start Recording" to start FFmpeg preview
					</div>
				</div>
			</div>

			<div class="card">
				<h2>🎵 Audio Levels</h2>
				<div class="audio-visualizer">
					<div class="audio-bars" id="audioBars">
						${Array(20)
              .fill(0)
              .map(() => '<div class="audio-bar" style="height: 2px;"></div>')
              .join("")}
					</div>
				</div>
			</div>
		</div>

		<div class="right-panel">
			<div class="card">
				<h2>⚙ Requirements</h2>
				<div class="requirements-grid">
					<div class="requirement-item">
						<div class="requirement-label">
							<span class="status-dot" id="ffmpegDot"></span>
							<span>FFmpeg</span>
						</div>
						<span class="status-text" id="ffmpegStatus">Checking...</span>
					</div>
				</div>
				<button class="btn btn-secondary" id="refreshBtn" style="margin-top: 10px;">
					🔄 Refresh
				</button>
			</div>

			<div class="card">
				<h2>🎬 Recording Controls</h2>
				<div class="recording-indicator" id="recordingIndicator">
					<span class="recording-dot"></span>
					<span>Recording in progress</span>
				</div>
				<div style="display:flex; flex-direction:column; gap:8px; margin-top:10px;">
					<button class="btn" id="startBtn" disabled>
						⏺ Start Recording
					</button>
					<button class="btn btn-danger" id="stopBtn" disabled>
						⏹ Stop Recording
					</button>
				</div>
				<div class="status-message" id="statusMessage"></div>
			</div>
		</div>
	</div>

	<!-- Socket.IO from your Render server -->
	<script src="https://voice-collab-room.onrender.com/socket.io/socket.io.js"></script>

	<script>
		const vscode = acquireVsCodeApi();

		/* ==== FFmpeg recording UI (unchanged behaviour) ==== */

		const bars = document.querySelectorAll('.audio-bar');
		const previewVideo = document.getElementById('previewVideo');
		const previewPlaceholder = document.getElementById('previewPlaceholder');

		// Check requirements on load
		vscode.postMessage({ command: 'checkRequirements' });

		document.getElementById('refreshBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'checkRequirements' });
		});

		document.getElementById('startBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'startRecording' });
		});

		document.getElementById('stopBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'stopRecording' });
		});

		function updateAudioBars(level) {
			bars.forEach((bar) => {
				const height = Math.max(2, Math.random() * level);
				bar.style.height = height + '%';
			});
		}

		function showStatus(message, type) {
			const statusEl = document.getElementById('statusMessage');
			statusEl.textContent = message;
			statusEl.className = 'status-message active ' + type;
		}

		window.addEventListener('message', event => {
			const message = event.data;
			
			switch (message.command) {
				case 'requirementsStatus': {
					const ffmpegDot = document.getElementById('ffmpegDot');
					const ffmpegStatus = document.getElementById('ffmpegStatus');
					const startBtn = document.getElementById('startBtn');
					
					if (message.ffmpeg) {
						ffmpegDot.className = 'status-dot status-ok';
						ffmpegStatus.textContent = 'Installed ✓';
						ffmpegStatus.style.color = '#4CAF50';
						startBtn.disabled = false;
					} else {
						ffmpegDot.className = 'status-dot status-error';
						ffmpegStatus.textContent = 'Missing ✗';
						ffmpegStatus.style.color = '#f44336';
					}
					break;
				}
				
				case 'frameUpdate':
					previewPlaceholder.style.display = 'none';
					previewVideo.style.display = 'block';
					previewVideo.src = message.frame;
					break;
				
				case 'recordingStarted':
					document.getElementById('recordingIndicator').classList.add('active');
					document.getElementById('startBtn').disabled = true;
					document.getElementById('stopBtn').disabled = false;
					showStatus('Recording: ' + message.path, 'success');
					break;
				
				case 'recordingStopped':
					document.getElementById('recordingIndicator').classList.remove('active');
					document.getElementById('startBtn').disabled = false;
					document.getElementById('stopBtn').disabled = true;
					showStatus('Recording stopped successfully', 'success');
					break;
				
				case 'audioLevel':
					updateAudioBars(message.level);
					break;
			}
		});

		/* ==== WebRTC Meet logic ==== */
		const SIGNALING_SERVER = "https://voice-collab-room.onrender.com";
		const socket = io(SIGNALING_SERVER);

		const nameInput = document.getElementById('nameInput');
		const roomInput = document.getElementById('roomInput');
		const createRoomBtn = document.getElementById('createRoomBtn');
		const joinRoomBtn = document.getElementById('joinRoomBtn');
		const meetStatus = document.getElementById('meetStatus');
		const videoGrid = document.getElementById('videoGrid');

		const pcConfig = {
			iceServers: [
				{ urls: 'stun:stun.l.google.com:19302' }
			]
		};

		let localStream = null;
		const peerConnections = {}; // socketId -> RTCPeerConnection
		const tiles = {}; // socketId or 'local' -> tile element
		let handlersWired = false;

		function setMeetStatus(text) {
			meetStatus.textContent = text;
		}

		function createTile(id, stream, label, isLocal) {
			let tile = tiles[id];
			let videoEl;
			if (tile) {
				videoEl = tile.querySelector('video');
			} else {
				tile = document.createElement('div');
				tile.className = 'video-tile';
				videoEl = document.createElement('video');
				videoEl.autoplay = true;
				videoEl.playsInline = true;
				videoEl.muted = !!isLocal;
				tile.appendChild(videoEl);
				const lab = document.createElement('div');
				lab.className = 'video-label';
				lab.textContent = label || 'Guest';
				tile.appendChild(lab);
				videoGrid.appendChild(tile);
				tiles[id] = tile;
			}
			videoEl.srcObject = stream;
		}

		function removeTile(id) {
			const tile = tiles[id];
			if (!tile) return;
			tile.remove();
			delete tiles[id];
		}

		async function ensureLocalStream() {
			if (localStream) return localStream;
			try {
				localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
				createTile('local', localStream, nameInput.value || 'Me (VS Code)', true);
				return localStream;
			} catch (e) {
				setMeetStatus('Could not get camera/mic: ' + e.message);
				throw e;
			}
		}

		function wireSocketHandlers() {
			if (handlersWired) return;
			handlersWired = true;

			socket.on('new-peer', async ({ socketId, name }) => {
				setMeetStatus('New peer joined: ' + (name || socketId));
				createTile(socketId, new MediaStream(), name || 'Guest');
				await createOfferTo(socketId);
			});

			socket.on('signal', async ({ from, data }) => {
				if (!peerConnections[from]) {
					await createPeerConnection(from, false);
				}
				const pc = peerConnections[from];
				if (data.type === 'offer') {
					await pc.setRemoteDescription(new RTCSessionDescription(data));
					const answer = await pc.createAnswer();
					await pc.setLocalDescription(answer);
					socket.emit('signal', { to: from, from: socket.id, data: pc.localDescription });
				} else if (data.type === 'answer') {
					await pc.setRemoteDescription(new RTCSessionDescription(data));
				} else if (data.candidate) {
					try {
						await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
					} catch (e) {
						console.warn('Error adding candidate', e);
					}
				}
			});

			socket.on('peer-left', ({ socketId }) => {
				setMeetStatus('Peer left: ' + socketId);
				if (peerConnections[socketId]) {
					peerConnections[socketId].close();
					delete peerConnections[socketId];
				}
				removeTile(socketId);
			});
		}

		async function createPeerConnection(remoteId, isInitiator) {
			if (peerConnections[remoteId]) return peerConnections[remoteId];
			const pc = new RTCPeerConnection(pcConfig);
			peerConnections[remoteId] = pc;

			const stream = await ensureLocalStream();
			for (const track of stream.getTracks()) {
				pc.addTrack(track, stream);
			}

			const remoteStream = new MediaStream();
			createTile(remoteId, remoteStream, remoteId, false);

			pc.ontrack = (ev) => {
				ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
				createTile(remoteId, remoteStream, remoteId, false);
			};

			pc.onicecandidate = (ev) => {
				if (ev.candidate) {
					socket.emit('signal', {
						to: remoteId,
						from: socket.id,
						data: { candidate: ev.candidate }
					});
				}
			};

			pc.onconnectionstatechange = () => {
				if (['failed','disconnected','closed'].includes(pc.connectionState)) {
					try { pc.close(); } catch {}
					delete peerConnections[remoteId];
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

		createRoomBtn.addEventListener('click', async () => {
			const roomId = (Math.random().toString(36).slice(2, 8)).toUpperCase();
			roomInput.value = roomId;
			await ensureLocalStream();
			wireSocketHandlers();
			socket.emit('create-room', { roomId, name: nameInput.value }, (res) => {
				if (!res || !res.ok) {
					setMeetStatus('Could not create room: ' + (res && res.message ? res.message : 'unknown error'));
					return;
				}
				setMeetStatus('Created room ' + roomId + '. Share this code with others.');
			});
		});

		joinRoomBtn.addEventListener('click', async () => {
			const roomId = (roomInput.value || '').trim().toUpperCase();
			if (!roomId) {
				setMeetStatus('Enter a room code to join.');
				return;
			}
			await ensureLocalStream();
			wireSocketHandlers();
			socket.emit('join-room', { roomId, name: nameInput.value }, async (res) => {
				if (!res || !res.ok) {
					setMeetStatus('Could not join room: ' + (res && res.message ? res.message : 'unknown error'));
					return;
				}
				setMeetStatus('Joined room ' + roomId);
				const others = res.others || [];
				for (const otherId of others) {
					await createOfferTo(otherId);
				}
			});
		});
	</script>
</body>
</html>`;
}

function deactivate() {
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGINT");
    ffmpegProcess = null;
  }
  if (previewProcess) {
    previewProcess.kill();
    previewProcess = null;
  }
}

module.exports = {
  activate,
  deactivate,
};
