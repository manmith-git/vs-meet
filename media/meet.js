// media/meet.js (webview script)
// This script runs inside the webview context.

(function () {
  const vscode = (typeof acquireVsCodeApi === "function") ? acquireVsCodeApi() : null;
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
    document.body.appendChild(msg);
  }

  const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  let localCanvasStream = null;
  let localAudioStreamTrack = null;
  let combinedLocalStream = null;
  let audioWs = null;
  let audioWsPort = null;
  let gotFrame = false;

  async function createAudioPipelineSampleRate(sampleRate = 48000) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    const workletCode = `
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
    `;
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

  const tiles = {};
  function adjustGridLayout() {
    const ids = Object.keys(tiles);
    const n = ids.length || 1;
    const cols = Math.ceil(Math.sqrt(n));
    videoGrid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
  }

  function extractNameFromPayload(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') return null;
    return (obj.name || obj.displayName || obj.username || obj.label || (obj.meta && (obj.meta.name || obj.meta.displayName)) || null);
  }

  function computeLabel(passedLabel, id) {
    if (peerNames[id]) return peerNames[id];
    if (passedLabel && passedLabel !== id) return String(passedLabel).trim();
    if (id && id.length > 4) return 'Guest-' + id.slice(0,4);
    return passedLabel || id || 'Guest';
  }

  function updateTileLabelIfExists(id) {
    const tile = tiles[id];
    if (!tile) return;
    const lab = tile.querySelector('.video-label');
    const newLabel = computeLabel(null, id);
    if (lab && lab.textContent !== newLabel) lab.textContent = newLabel;
  }

  function addOrUpdateTile(id, stream, label, isLocal) {
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
    if (t) { t.remove(); delete tiles[id]; adjustGridLayout(); }
  }

  const pcs = {};
  let wired = false;

  function wireSignalingHandlers() {
    if (wired) return;
    if (!socket) { console.warn('[signal] socket missing'); return; }
    wired = true;

    socket.on('connect', () => console.log('[signal] connected', socket.id));
    socket.on('new-peer', (payload) => {
      const socketId = payload && (payload.socketId || payload.id || payload);
      const name = extractNameFromPayload(payload) || null;
      if (socketId && name) { peerNames[socketId] = name; updateTileLabelIfExists(socketId); }
    });

    socket.on('room-info', (payload) => {
      const others = payload && (payload.others || payload.peers || payload.participants || payload.members);
      if (Array.isArray(others)) {
        for (const o of others) {
          if (!o) continue;
          if (typeof o === 'object') {
            const id = o.id || o.socketId || o.s || null;
            const nm = extractNameFromPayload(o);
            if (id && nm) { peerNames[id] = nm; updateTileLabelIfExists(id); }
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
      } else if (data.type === "answer") {
        if (!pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
        }
      } else if (data.candidate) {
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
    if (!remoteId || (socket && remoteId === socket.id)) return null;
    const pc = new RTCPeerConnection(pcConfig);
    pcs[remoteId] = pc;

    if (combinedLocalStream) combinedLocalStream.getTracks().forEach(t => pc.addTrack(t, combinedLocalStream));

    pc.ontrack = (ev) => {
      const incoming = ev.streams && ev.streams[0] ? ev.streams[0] : null;
      const hasTracks = incoming && ((incoming.getVideoTracks && incoming.getVideoTracks().length) || (incoming.getAudioTracks && incoming.getAudioTracks().length));
      if (hasTracks) { addOrUpdateTile(remoteId, incoming, peerNames[remoteId] || remoteId, false); }
      else {
        let tries = 0;
        const iv = setInterval(() => {
          tries++;
          const s = ev.streams && ev.streams[0] ? ev.streams[0] : null;
          if (s && ((s.getVideoTracks && s.getVideoTracks().length) || (s.getAudioTracks && s.getAudioTracks().length))) {
            clearInterval(iv);
            addOrUpdateTile(remoteId, s, peerNames[remoteId] || remoteId, false);
          } else if (tries > 10) { clearInterval(iv); }
        }, 100);
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit("signal", { to: remoteId, from: socket.id, data: { candidate: ev.candidate } });
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
        if (gotFrame) { clearInterval(iv); clearTimeout(to); resolve(true); }
        else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('Preview frame timeout')); }
      }, 200);
      const to = setTimeout(() => { clearInterval(iv); reject(new Error('Preview frame timeout')); }, timeoutMs);
    });
  }

  createRoomBtn.addEventListener('click', async () => {
    if (!socket) return alert('Signaling unavailable');
    const roomId = (Math.random().toString(36).slice(2,8)).toUpperCase();
    roomInput.value = roomId;
    wireSignalingHandlers();
    socket.emit('create-room', { roomId, name: nameInput.value }, async (res) => {
      if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not create room');

      if (res.meta && typeof res.meta === 'object') {
        for (const k of Object.keys(res.meta)) { peerNames[k] = res.meta[k]; updateTileLabelIfExists(k); }
      }

      const others = res.others || res.peers || res.participants || res.members || null;
      if (Array.isArray(others)) {
        for (const item of others) {
          if (!item) continue;
          if (typeof item === 'object') {
            const id = item.id || item.socketId || item.s || null;
            const nm = extractNameFromPayload(item);
            if (id && nm) { peerNames[id] = nm; updateTileLabelIfExists(id); }
          }
        }
      }

      try { if (vscode) { vscode.postMessage({ command: 'startRecording' }); } } catch (e) { console.warn('[create] could not post startRecording', e); }

      try { await waitForPreviewFrame(10000); } catch (err) { alert('Preview/recording did not start in time. Please ensure FFmpeg is available and your camera is connected. Auto-join aborted.'); return; }

      try { await ensureAudioPipeline(); } catch (e) { console.warn('[auto-join] ensureAudioPipeline failed', e); }

      socket.emit('join-room', { roomId, name: nameInput.value }, async (joinRes) => {
        if (!joinRes || !joinRes.ok) { return alert(joinRes && joinRes.message ? joinRes.message : 'Could not join room automatically'); }
        const list = joinRes.others || joinRes.peers || joinRes.participants || joinRes.members || [];
        if (joinRes.meta && typeof joinRes.meta === 'object') {
          for (const k of Object.keys(joinRes.meta)) { peerNames[k] = joinRes.meta[k]; updateTileLabelIfExists(k); }
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
        for (const k of Object.keys(res.meta)) { peerNames[k] = res.meta[k]; updateTileLabelIfExists(k); }
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
  });

  try { if (vscode) vscode.postMessage({ command: 'checkRequirements' }); } catch (e) {}
  window.__internal = { connectLocalAudioWs, ensureAudioPipeline, createOfferTo, createPeerConnection, pcs, combinedLocalStream, peerNames };
})();
