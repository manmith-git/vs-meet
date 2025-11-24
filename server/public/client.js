// public/client.js
// Simple mesh WebRTC client that can (A) send browser camera+mic OR (B) be receive-only.
// Connects to the signaling server (same origin).
(function () {
  const socket = io(); // served from same origin (Render) at /socket.io

  // Config: add TURN servers here if needed
  const PC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
      // { urls: 'turn:YOUR_TURN_HOST:3478', username: 'user', credential: 'pass' }
    ]
  };

  const nameInput = document.getElementById('nameInput');
  const roomInput = document.getElementById('roomInput');
  const createBtn = document.getElementById('createBtn');
  const joinBtn = document.getElementById('joinBtn');
  const grid = document.getElementById('grid');
  const statusEl = document.getElementById('status');
  const sendMediaCheckbox = document.getElementById('sendMediaCheckbox');

  let localStream = null;
  const pcs = {};       // peerId -> RTCPeerConnection
  const tiles = {};     // peerId -> DOM tile

  function setStatus(t) { statusEl.textContent = t; }

  // Create or update a video tile for a stream
  function addOrUpdateTile(id, stream, label, isLocal) {
    let tile = tiles[id];
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = !!isLocal;
      video.width = 320;
      tile.appendChild(video);
      const lab = document.createElement('div');
      lab.className = 'label';
      lab.textContent = label || id;
      tile.appendChild(lab);
      grid.appendChild(tile);
      tiles[id] = tile;
    }
    const v = tile.querySelector('video');
    if (v.srcObject !== stream) v.srcObject = stream;
    // attempt to play (autoplay policies may block until user gesture)
    v.play().catch(e => { /* ignore autoplay block */ });
  }

  function removeTile(id) {
    const t = tiles[id];
    if (!t) return;
    t.remove();
    delete tiles[id];
  }

  // Acquire local camera+mic if user checked checkbox
  async function ensureLocalMedia() {
    if (!sendMediaCheckbox.checked) return null;
    if (localStream) return localStream;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStream = s;
      addOrUpdateTile('local', localStream, nameInput.value || 'Me (browser)', true);
      return localStream;
    } catch (e) {
      console.error('getUserMedia failed', e);
      alert('Could not access camera/microphone: ' + e.message);
      throw e;
    }
  }

  // Wiring socket handlers
  let wired = false;
  function wireSocket() {
    if (wired) return;
    wired = true;

    socket.on('connect', () => {
      setStatus('Connected to signaling: ' + socket.id);
      console.log('socket connected', socket.id);
    });

    socket.on('new-peer', async ({ socketId, name }) => {
      console.log('new-peer', socketId, name);
      addOrUpdateTile(socketId, new MediaStream(), name || 'Guest');
      await createOfferTo(socketId);
    });

    socket.on('signal', async ({ from, data }) => {
      if (!pcs[from]) await createPeerConnection(from, false);
      const pc = pcs[from];
      if (!pc) return console.warn('signal for unknown pc', from);
      console.log('signal received from', from, data.type || 'candidate');
      try {
        if (data.type === 'offer') {
          await pc.setRemoteDescription(data);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, from: socket.id, data: pc.localDescription });
        } else if (data.type === 'answer') {
          await pc.setRemoteDescription(data);
        } else if (data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (err) {
        console.error('Error processing signal', err);
      }
    });

    socket.on('peer-left', ({ socketId }) => {
      console.log('peer left', socketId);
      if (pcs[socketId]) { try { pcs[socketId].close(); } catch {} delete pcs[socketId]; }
      removeTile(socketId);
    });

    socket.on('room-meta', ({ meta }) => {
      // Optionally update labels (if you want)
      Object.entries(meta || {}).forEach(([id, name]) => {
        const tile = tiles[id];
        if (tile) tile.querySelector('.label').textContent = name;
      });
    });
  }

  async function createPeerConnection(peerId) {
    if (pcs[peerId]) return pcs[peerId];
    const pc = new RTCPeerConnection(PC_CONFIG);
    pcs[peerId] = pc;

    // add local tracks (if present) BEFORE creating offer
    if (localStream) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    // remote stream collector
    const remoteStream = new MediaStream();
    addOrUpdateTile(peerId, remoteStream, peerId, false);

    pc.ontrack = (ev) => {
      ev.streams[0].getTracks().forEach(tr => remoteStream.addTrack(tr));
      addOrUpdateTile(peerId, remoteStream, peerId, false);
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socket.emit('signal', { to: peerId, from: socket.id, data: { candidate: ev.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('pc state', peerId, pc.connectionState);
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        try { pc.close(); } catch (e) {}
        delete pcs[peerId];
        removeTile(peerId);
      }
    };

    return pc;
  }

  async function createOfferTo(peerId) {
    const pc = await createPeerConnection(peerId);
    // ensure local tracks exist (in case user enabled them after pc created)
    if (!localStream && sendMediaCheckbox.checked) {
      await ensureLocalMedia();
      if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    console.log('creating offer to', peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, from: socket.id, data: pc.localDescription });
  }

  // UI button handlers
  createBtn.onclick = async () => {
    const roomId = (Math.random().toString(36).slice(2,8)).toUpperCase();
    roomInput.value = roomId;
    try {
      await ensureLocalMedia(); // optional; if unchecked it'll still create room but not send tracks
    } catch (e) { /* user denied */ }
    wireSocket();
    socket.emit('create-room', { roomId, name: nameInput.value }, (res) => {
      if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not create room');
      setStatus('Created room ' + roomId);
    });
  };

  joinBtn.onclick = async () => {
    const roomId = (roomInput.value || '').trim().toUpperCase();
    if (!roomId) return alert('Enter room code');
    try {
      await ensureLocalMedia();
    } catch (e) { /* user denied; still allow join if unchecked */ }
    wireSocket();
    socket.emit('join-room', { roomId, name: nameInput.value }, async (res) => {
      if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not join room');
      setStatus('Joined ' + roomId);
      const others = res.others || [];
      // create offers to existing peers
      for (const id of others) {
        await createOfferTo(id);
      }
    });
  };

  // Clean up before unload
  window.addEventListener('beforeunload', () => {
    try {
      socket.disconnect();
    } catch (e) {}
  });

  // expose for debug
  window.__client = { socket, pcs, tiles };

  setStatus('Ready');
})();
