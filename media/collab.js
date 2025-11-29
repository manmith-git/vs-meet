// media/collab.js
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

/* ---------- fallback/default-room logic moved here ---------- */
function collabRandRoom(len = 9) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s.toUpperCase();
}
try {
  // If panel injected a placeholder or empty value, ensure we have a usable room id.
  if (roomInput) {
    const v = (roomInput.value || "").trim();
    if (!v || v === "DEFAULT_ROOM_PLACEHOLDER") {
      roomInput.value = collabRandRoom();
    }
  }
} catch (e) {
  console.warn("collab: default room generation failed", e);
}
/* ----------------------------------------------------------- */

const Y = window.Y;
if (!Y) {
  // if Yjs didn't load, show error in log area (or console)
  if (logEl) { logEl.textContent = "ERROR: Yjs did NOT load from local UMD.\n"; }
  console.error("Yjs not found (window.Y)");
  return;
}

let pc=null, dc=null, socket=null, role=null, room=null, pending=[];
let offerSent=false;
const DEFAULT_WSS = "wss://vscode-webrtc-signaling.onrender.com";

// Yjs state
const ydoc = new Y.Doc();
const ytext = ydoc.getText("codetext");
let isApplyingRemoteY = false;
let lastTextSentFromY = "";

// small helpers
function log(m){
  if (!logEl) return;
  logEl.textContent += m + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function setState(s){
  if(!hostBtn || !joinBtn || !discBtn) return;
  if(s==="idle"){ hostBtn.disabled=false; joinBtn.disabled=false; discBtn.disabled=true; }
  if(s==="connecting"){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
  if(s==="connected"){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
}
function updateUserList(users){
  if(!usersEl) return;
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
  if(!usersEl) return;
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
    dc.send(JSON.stringify({ type: "y-update", data: Array.from(update) }));
  } catch {}
});

// When Yjs text changes, tell extension (but avoid echo spam)
ytext.observe(() => {
  try {
    const t = ytext.toString();
    if (t === lastTextSentFromY) return;
    lastTextSentFromY = t;
    vscode.postMessage({ type: "editor-change", text: t, forward: false });
  } catch {}
});

// WebRTC
function ensurePC(){
  pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  pc.onicecandidate=e=>{
    if(e.candidate && socket && room){
      socket.send(JSON.stringify({ type:"candidate", room, candidate:e.candidate }));
    }
  };
  pc.onconnectionstatechange=()=>{
    log("RTC: " + pc.connectionState);
    if(pc.connectionState==="connected") setState("connected");
    if(["failed","disconnected","closed"].includes(pc.connectionState)){ log("RTC ended"); reset(); }
  };
}

function wire(ch){
  dc=ch;
  dc.onopen=()=>{
    log("DataChannel open");
    vscode.postMessage({ type:"dc-open", role });
    try {
      const full = Y.encodeStateAsUpdate(ydoc);
      dc.send(JSON.stringify({ type:"y-update", data:Array.from(full) }));
    } catch {}
  };

  dc.onmessage=e=>{
    let msg;
    try{ msg = JSON.parse(e.data); }catch{ return; }

    if (msg.type === "y-update" && msg.data) {
      try{ isApplyingRemoteY = true; Y.applyUpdate(ydoc, new Uint8Array(msg.data)); }
      finally { isApplyingRemoteY = false; }
      return;
    }

    if (msg.type === "cursor" && msg.id) { pulseUser(msg.id); }

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
  if(!room){ log("Room cannot be empty"); return; }

  setState("connecting");
  ensurePC();

  if(role==="host"){ wire(pc.createDataChannel("code")); } else { pc.ondatachannel = e => wire(e.channel); }

  socket = new WebSocket(DEFAULT_WSS);
  socket.onopen = () => {
    log("WS connected");
    socket.send(JSON.stringify({ type: (role === "host") ? "create" : "join", room }));
  };

  socket.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "room-state") {
      log("Room state count=" + msg.count);
      if (role === "host" && !offerSent && msg.count > 1) {
        offerSent = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({ type:"offer", room, sdp:offer }));
      }
      return;
    }

    if (msg.type === "peer-joined") {
      log("Peer joined");
      if (role === "host" && !offerSent) {
        offerSent = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({ type:"offer", room, sdp:offer }));
      }
      return;
    }

    if (msg.type === "offer" && role === "join") {
      await pc.setRemoteDescription(msg.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.send(JSON.stringify({ type:"answer", room, sdp:ans }));
      for (const c of pending) { try { await pc.addIceCandidate(c); } catch {} }
      pending = [];
      return;
    }

    if (msg.type === "answer" && role === "host") {
      await pc.setRemoteDescription(msg.sdp);
      for (const c of pending) { try { await pc.addIceCandidate(c); } catch {} }
      pending = [];
      return;
    }

    if (msg.type === "candidate") {
      if (!pc.remoteDescription) { pending.push(msg.candidate); }
      else { try { await pc.addIceCandidate(msg.candidate); } catch {} }
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

  if (m.type === "user-list") { updateUserList(m.users); return; }

  if (m.forward && dc && dc.readyState === "open") {
    try { dc.send(JSON.stringify(m)); } catch {}
  }

  if (m.type === "editor-change" && typeof m.text === "string") {
    const current = ytext.toString();
    if (current === m.text) return;
    isApplyingRemoteY = true;
    ydoc.transact(() => { try { ytext.delete(0, ytext.length); } catch {} try { ytext.insert(0, m.text); } catch {} });
    isApplyingRemoteY = false;
    lastTextSentFromY = m.text;
    return;
  }

  if (m.type === "editor-delta") {
    const offset = typeof m.offset === "number" ? m.offset : 0;
    const removed = typeof m.removed === "number" ? m.removed : 0;
    const inserted = typeof m.inserted === "string" ? m.inserted : "";
    ydoc.transact(() => {
      if (removed > 0) { try { ytext.delete(offset, removed); } catch {} }
      if (inserted && inserted.length) { try { ytext.insert(offset, inserted); } catch {} }
    });
    return;
  }
});

// UI controls
regenBtn.onclick = () => { roomInput.value = (Math.random().toString(36).substr(2,9)).toUpperCase(); };
copyBtn.onclick = () => { vscode.postMessage({ type:"copy", text: roomInput.value }); };
applyProfile.onclick = () => { vscode.postMessage({ type:"profile-update", profile:{ color: colorInp.value } }); };

hostBtn.onclick = () => start("host");
joinBtn.onclick = () => start("join");
discBtn.onclick = reset;

setState("idle");
log("Ready. Yjs loaded & WebRTC idle");
})();
