// meet/audio-ws.js
const http = require("http");
const WebSocket = require("ws");
const state = require("../state");

function startLocalAudioWsServer() {
  return new Promise((resolve, reject) => {
    if (state.audioWsServer && state.audioHttpServer && state.audioWsPort)
      return resolve(state.audioWsPort);

    state.audioHttpServer = http.createServer((req, res) => {
      res.writeHead(200);
      res.end("OK");
    });

    state.audioHttpServer.listen(0, "127.0.0.1", () => {
      const addr = state.audioHttpServer.address();
      state.audioWsPort = addr.port;
      state.audioWsServer = new WebSocket.Server({ server: state.audioHttpServer });
      state.audioWsServer.on("connection", (ws) => {
        console.log("[audio-ws] client connected");
        ws.on("close", () => console.log("[audio-ws] client disconnected"));
      });
      console.log("[audio-ws] listening on port", state.audioWsPort);
      resolve(state.audioWsPort);
    });

    state.audioHttpServer.on("error", (err) => {
      console.error("[audio-ws] http server error", err);
      reject(err);
    });
  });
}

function broadcastAudioChunk(chunk) {
  if (!state.audioWsServer) return;
  for (const client of state.audioWsServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(chunk);
    }
  }
}

function stopLocalAudioWsServer() {
  if (state.audioWsServer) {
    try { state.audioWsServer.close(); } catch (e) { console.warn(e); }
    state.audioWsServer = null;
  }
  if (state.audioHttpServer) {
    try { state.audioHttpServer.close(); } catch (e) { console.warn(e); }
    state.audioHttpServer = null;
    state.audioWsPort = null;
  }
}

module.exports = { startLocalAudioWsServer, broadcastAudioChunk, stopLocalAudioWsServer };
