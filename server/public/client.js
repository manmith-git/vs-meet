// public/client.js
// Enhanced mesh WebRTC client with better UI, leave button, and responsive design
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
  const leaveBtn = document.getElementById('leaveBtn');
  const grid = document.getElementById('grid');
  const statusEl = document.getElementById('status');
  const sendMediaCheckbox = document.getElementById('sendMediaCheckbox');
  const roomInfoEl = document.getElementById('roomInfo');

  let localStream = null;
  const pcs = {};       // peerId -> RTCPeerConnection
  const tiles = {};     // peerId -> DOM tile
  let currentRoomId = null;
  let peerNames = {};   // Track peer display names

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'status error' : 'status';
  }

  function updateRoomInfo() {
    if (currentRoomId) {
      const participantCount = Object.keys(tiles).filter(id => id !== 'local' && id !== socket.id).length + 1;
      roomInfoEl.textContent = `Room: ${currentRoomId} | Participants: ${participantCount}`;
      roomInfoEl.style.display = 'block';
    } else {
      roomInfoEl.style.display = 'none';
    }
  }

  // Create or update a video tile for a stream
  function addOrUpdateTile(id, stream, label, isLocal) {
    let tile = tiles[id];
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.setAttribute('data-peer-id', id);
      
      const videoContainer = document.createElement('div');
      videoContainer.className = 'video-container';
      
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = !!isLocal;
      
      videoContainer.appendChild(video);
      tile.appendChild(videoContainer);
      
      const labelEl = document.createElement('div');
      labelEl.className = 'participant-label';
      labelEl.textContent = label || (isLocal ? 'You' : 'Guest');
      tile.appendChild(labelEl);

      // Add leave/remove icon for local tile
      if (isLocal) {
        const controls = document.createElement('div');
        controls.className = 'tile-controls';
        const muteBtn = document.createElement('button');
        muteBtn.className = 'control-btn mute-btn';
        muteBtn.innerHTML = '🔇';
        muteBtn.title = 'Mute audio';
        muteBtn.onclick = toggleAudio;
        controls.appendChild(muteBtn);
        
        const videoBtn = document.createElement('button');
        videoBtn.className = 'control-btn video-btn';
        videoBtn.innerHTML = '📹';
        videoBtn.title = 'Toggle video';
        videoBtn.onclick = toggleVideo;
        controls.appendChild(videoBtn);
        
        tile.appendChild(controls);
      }
      
      grid.appendChild(tile);
      tiles[id] = tile;
    }
    
    const v = tile.querySelector('video');
    if (v.srcObject !== stream) v.srcObject = stream;
    
    // Update label if name changed
    const labelEl = tile.querySelector('.participant-label');
    const displayName = peerNames[id] || label || (isLocal ? 'You' : 'Guest');
    if (labelEl.textContent !== displayName) {
      labelEl.textContent = displayName;
    }
    
    // attempt to play (autoplay policies may block until user gesture)
    v.play().catch(e => { 
      console.log('Autoplay blocked, waiting for user interaction');
    });
    
    updateRoomInfo();
  }

  function removeTile(id) {
    const t = tiles[id];
    if (!t) return;
    t.remove();
    delete tiles[id];
    delete peerNames[id];
    updateRoomInfo();
  }

  function toggleAudio() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const muteBtn = document.querySelector('.mute-btn');
      if (muteBtn) {
        muteBtn.innerHTML = audioTrack.enabled ? '🔊' : '🔇';
        muteBtn.title = audioTrack.enabled ? 'Mute audio' : 'Unmute audio';
      }
    }
  }

  function toggleVideo() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      const videoBtn = document.querySelector('.video-btn');
      if (videoBtn) {
        videoBtn.innerHTML = videoTrack.enabled ? '📹' : '📵';
        videoBtn.title = videoTrack.enabled ? 'Turn off camera' : 'Turn on camera';
      }
    }
  }

  // Acquire local camera+mic if user checked checkbox
  async function ensureLocalMedia() {
    if (!sendMediaCheckbox.checked) {
      // If disabling media, stop existing stream
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        removeTile('local');
      }
      return null;
    }
    
    if (localStream) return localStream;
    
    try {
      const s = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 1280, height: 720 },
        audio: true 
      });
      localStream = s;
      addOrUpdateTile('local', localStream, nameInput.value || 'You', true);
      return localStream;
    } catch (e) {
      console.error('getUserMedia failed', e);
      sendMediaCheckbox.checked = false;
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
      setStatus('Connected to signaling server');
      console.log('socket connected', socket.id);
      updateUI();
    });

    socket.on('disconnect', () => {
      setStatus('Disconnected from server', true);
      updateUI();
    });

    socket.on('new-peer', async ({ socketId, name }) => {
      console.log('new-peer', socketId, name);
      if (name) {
        peerNames[socketId] = name;
      }
      // Create empty tile for this future remote stream
      addOrUpdateTile(socketId, new MediaStream(), name || 'Guest', false);
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
      if (pcs[socketId]) { 
        try { pcs[socketId].close(); } catch {} 
        delete pcs[socketId]; 
      }
      removeTile(socketId);
    });

    socket.on('room-meta', ({ meta }) => {
      // Update peer names from room metadata
      Object.entries(meta || {}).forEach(([id, name]) => {
        peerNames[id] = name;
        const tile = tiles[id];
        if (tile) {
          const labelEl = tile.querySelector('.participant-label');
          if (labelEl) labelEl.textContent = name;
        }
      });
    });
  }

  async function createPeerConnection(peerId) {
    if (pcs[peerId]) return pcs[peerId];
    const pc = new RTCPeerConnection(PC_CONFIG);
    pcs[peerId] = pc;

    // add local tracks (if present) BEFORE creating offer
    if (localStream) {
      localStream.getTracks().forEach(t => {
        try {
          pc.addTrack(t, localStream);
        } catch (e) {
          console.warn('Error adding track:', e);
        }
      });
    }

    // remote stream collector
    const remoteStream = new MediaStream();
    addOrUpdateTile(peerId, remoteStream, peerNames[peerId] || peerId, false);

    pc.ontrack = (ev) => {
      console.log('Received track from', peerId);
      if (ev.streams && ev.streams[0]) {
        ev.streams[0].getTracks().forEach(tr => {
          if (!remoteStream.getTracks().includes(tr)) {
            remoteStream.addTrack(tr);
          }
        });
        addOrUpdateTile(peerId, remoteStream, peerNames[peerId] || peerId, false);
      }
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

    pc.oniceconnectionstatechange = () => {
      console.log('ice state', peerId, pc.iceConnectionState);
    };

    return pc;
  }

  async function createOfferTo(peerId) {
    const pc = await createPeerConnection(peerId);
    // ensure local tracks exist (in case user enabled them after pc created)
    if (!localStream && sendMediaCheckbox.checked) {
      await ensureLocalMedia();
      if (localStream) {
        localStream.getTracks().forEach(t => {
          try {
            pc.addTrack(t, localStream);
          } catch (e) {
            console.warn('Error adding track to existing PC:', e);
          }
        });
      }
    }

    console.log('creating offer to', peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: peerId, from: socket.id, data: pc.localDescription });
    } catch (err) {
      console.error('Error creating offer:', err);
    }
  }

  function leaveRoom() {
    if (currentRoomId) {
      socket.emit('leave-room', { roomId: currentRoomId });
      currentRoomId = null;
    }
    
    // Close all peer connections
    Object.keys(pcs).forEach(peerId => {
      try {
        pcs[peerId].close();
      } catch (e) {}
      delete pcs[peerId];
    });
    
    // Remove all remote tiles
    Object.keys(tiles).forEach(id => {
      if (id !== 'local' && id !== socket.id) {
        removeTile(id);
      }
    });
    
    // Reset UI
    setStatus('Left the room');
    updateUI();
  }

  function updateUI() {
    const isInRoom = currentRoomId !== null;
    const isConnected = socket.connected;
    
    createBtn.disabled = isInRoom || !isConnected;
    joinBtn.disabled = isInRoom || !isConnected;
    leaveBtn.disabled = !isInRoom;
    roomInput.disabled = isInRoom;
    
    if (isInRoom) {
      leaveBtn.style.display = 'inline-block';
    } else {
      leaveBtn.style.display = 'none';
    }
  }

  // UI button handlers
  createBtn.onclick = async () => {
    const roomId = (Math.random().toString(36).slice(2,8)).toUpperCase();
    roomInput.value = roomId;
    const userName = nameInput.value || 'User';
    
    try {
      await ensureLocalMedia();
    } catch (e) { 
      // User denied media, continue without it
    }
    
    wireSocket();
    socket.emit('create-room', { roomId, name: userName }, (res) => {
      if (!res || !res.ok) {
        alert(res && res.message ? res.message : 'Could not create room');
        return;
      }
      currentRoomId = roomId;
      peerNames[socket.id] = userName;
      setStatus(`Created room ${roomId}`);
      updateUI();
    });
  };

  joinBtn.onclick = async () => {
    const roomId = (roomInput.value || '').trim().toUpperCase();
    if (!roomId) return alert('Enter room code');
    const userName = nameInput.value || 'User';
    
    try {
      await ensureLocalMedia();
    } catch (e) { 
      // User denied media; still allow join if unchecked
    }
    
    wireSocket();
    socket.emit('join-room', { roomId, name: userName }, async (res) => {
      if (!res || !res.ok) {
        alert(res && res.message ? res.message : 'Could not join room');
        return;
      }
      currentRoomId = roomId;
      peerNames[socket.id] = userName;
      setStatus(`Joined room ${roomId}`);
      
      const others = res.others || [];
      // create offers to existing peers
      for (const id of others) {
        if (id !== socket.id) {
          await createOfferTo(id);
        }
      }
      updateUI();
    });
  };

  leaveBtn.onclick = leaveRoom;

  // Media checkbox change handler
  sendMediaCheckbox.onchange = async () => {
    try {
      await ensureLocalMedia();
      
      // If we're in a room and we just enabled media, renegotiate with all peers
      if (currentRoomId && localStream) {
        Object.keys(pcs).forEach(peerId => {
          createOfferTo(peerId); // This will re-offer with new tracks
        });
      }
    } catch (e) {
      console.error('Error toggling media:', e);
    }
  };

  // Clean up before unload
  window.addEventListener('beforeunload', () => {
    leaveRoom();
    try {
      socket.disconnect();
    } catch (e) {}
  });

  // Handle page visibility change - pause video when tab not visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Tab is hidden - could pause videos here if needed
    } else {
      // Tab is visible - play videos again
      Object.values(tiles).forEach(tile => {
        const video = tile.querySelector('video');
        if (video && video.paused) {
          video.play().catch(console.warn);
        }
      });
    }
  });

  // expose for debug
  window.__client = { socket, pcs, tiles, peerNames };

  setStatus('Ready to connect');
  updateUI();
})();