const socket = io();

const pcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

const nameInput = document.getElementById('nameInput');
const roomInput = document.getElementById('roomInput');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const statusEl = document.getElementById('status');
const grid = document.getElementById('grid');

let localStream = null;
const pcs = {};
const tiles = {};

function setStatus(t) { statusEl.textContent = t; }

async function getLocalMedia() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    addOrUpdateTile('local', localStream, nameInput.value || 'Me (browser)', true);
    return localStream;
  } catch (e) {
    alert('Could not access camera/mic: ' + e.message);
    throw e;
  }
}

function addOrUpdateTile(id, stream, label, isLocal) {
  let tile = tiles[id];
  let video;
  if (tile) {
    video = tile.querySelector('video');
  } else {
    tile = document.createElement('div');
    tile.className = 'tile';
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = !!isLocal;
    tile.appendChild(video);
    const lab = document.createElement('div');
    lab.className = 'label';
    lab.textContent = label || 'Guest';
    tile.appendChild(lab);
    grid.appendChild(tile);
    tiles[id] = tile;
  }
  video.srcObject = stream;
}

function removeTile(id) {
  const tile = tiles[id];
  if (!tile) return;
  tile.remove();
  delete tiles[id];
}

let wired = false;
function wireSocketHandlers() {
  if (wired) return;
  wired = true;

  socket.on('new-peer', async ({ socketId, name }) => {
    setStatus('New peer: ' + (name || socketId));
    addOrUpdateTile(socketId, new MediaStream(), name || 'Guest', false);
    await createOfferTo(socketId);
  });

  socket.on('signal', async ({ from, data }) => {
    if (!pcs[from]) await createPeerConnection(from, false);
    const pc = pcs[from];
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
        console.warn('candidate error', e);
      }
    }
  });

  socket.on('peer-left', ({ socketId }) => {
    setStatus('Peer left: ' + socketId);
    if (pcs[socketId]) {
      pcs[socketId].close();
      delete pcs[socketId];
    }
    removeTile(socketId);
  });
}

async function createPeerConnection(remoteId) {
  if (pcs[remoteId]) return pcs[remoteId];
  const pc = new RTCPeerConnection(pcConfig);
  pcs[remoteId] = pc;

  const stream = await getLocalMedia();
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  const remoteStream = new MediaStream();
  addOrUpdateTile(remoteId, remoteStream, remoteId, false);

  pc.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach(tr => remoteStream.addTrack(tr));
    addOrUpdateTile(remoteId, remoteStream, remoteId, false);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      socket.emit('signal', { to: remoteId, from: socket.id, data: { candidate: ev.candidate } });
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
  const pc = await createPeerConnection(remoteId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: remoteId, from: socket.id, data: pc.localDescription });
}

createBtn.onclick = async () => {
  const roomId = (Math.random().toString(36).slice(2,8)).toUpperCase();
  roomInput.value = roomId;
  await getLocalMedia();
  wireSocketHandlers();
  socket.emit('create-room', { roomId, name: nameInput.value }, (res) => {
    if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not create room');
    setStatus('Created room ' + roomId);
  });
};

joinBtn.onclick = async () => {
  const roomId = (roomInput.value || '').trim().toUpperCase();
  if (!roomId) return alert('Enter room code to join');
  await getLocalMedia();
  wireSocketHandlers();
  socket.emit('join-room', { roomId, name: nameInput.value }, async (res) => {
    if (!res || !res.ok) return alert(res && res.message ? res.message : 'Could not join room');
    setStatus('Joined room ' + roomId);
    const others = res.others || [];
    for (const id of others) await createOfferTo(id);
  });
};
