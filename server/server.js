// server.js – Complete WebRTC Signaling Server (Ready for Render)
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ===============================
// SERVE WEBCLIENT
// ===============================
app.use(express.static(path.join(__dirname, "public")));

// ===============================
// ROOM STORAGE
// ===============================
// rooms = {
//   ABC123: {
//     sockets: Set([socketId1, socketId2]),
//     meta: { socketId1: "Alice", socketId2: "Bob" }
//   }
// }
const rooms = {};

io.on("connection", (socket) => {
  console.log("[io] connected:", socket.id);

  // ===============================
  // CREATE ROOM
  // ===============================
  socket.on("create-room", ({ roomId, name }, cb) => {
    if (!roomId) {
      return cb && cb({ ok: false, message: "Invalid roomId" });
    }

    if (rooms[roomId]) {
      return cb && cb({ ok: false, message: "Room already exists" });
    }

    rooms[roomId] = {
      sockets: new Set([socket.id]),
      meta: { [socket.id]: name || "Anonymous" },
    };

    socket.join(roomId);
    console.log(`[room] CREATED ${roomId} by ${socket.id}`);

    cb && cb({
      ok: true,
      roomId,
      meta: rooms[roomId].meta,
    });

    io.to(roomId).emit("room-meta", { meta: rooms[roomId].meta });
  });

  // ===============================
  // JOIN ROOM
  // ===============================
  socket.on("join-room", ({ roomId, name }, cb) => {
    const room = rooms[roomId];

    if (!room) {
      return cb && cb({ ok: false, message: "Room does not exist" });
    }

    const existingIds = Array.from(room.sockets);

    room.sockets.add(socket.id);
    room.meta[socket.id] = name || "Anonymous";

    socket.join(roomId);
    console.log(`[room] ${socket.id} JOINED ${roomId}`);

    // Reply to joiner
    cb &&
      cb({
        ok: true,
        others: existingIds,
        meta: room.meta,
      });

    // Notify others
    existingIds.forEach((id) => {
      io.to(id).emit("new-peer", {
        socketId: socket.id,
        name: name || "Anonymous",
      });
    });

    io.to(roomId).emit("room-meta", { meta: room.meta });
  });

  // ===============================
  // SIGNALING
  // ===============================
  socket.on("signal", ({ to, from, data }) => {
    if (!to || !data) return;
    console.log(
      `[signal] from=${from} to=${to} type=${data.type || "candidate"}`
    );

    io.to(to).emit("signal", { from, data });
  });

  // ===============================
  // LEAVE ROOM
  // ===============================
  socket.on("leave-room", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.sockets.delete(socket.id);
    delete room.meta[socket.id];

    socket.leave(roomId);

    io.to(roomId).emit("peer-left", { socketId: socket.id });
    io.to(roomId).emit("room-meta", { meta: room.meta });

    console.log(`[room] ${socket.id} LEFT ${roomId}`);

    if (room.sockets.size === 0) {
      delete rooms[roomId];
      console.log(`[room] DELETED EMPTY ROOM ${roomId}`);
    }
  });

  // ===============================
  // DISCONNECT
  // ===============================
  socket.on("disconnect", () => {
    console.log("[io] disconnected:", socket.id);

    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.sockets.has(socket.id)) {
        room.sockets.delete(socket.id);
        delete room.meta[socket.id];

        io.to(roomId).emit("peer-left", { socketId: socket.id });
        io.to(roomId).emit("room-meta", { meta: room.meta });

        if (room.sockets.size === 0) {
          delete rooms[roomId];
          console.log(`[room] DELETED EMPTY ROOM AFTER DISCONNECT ${roomId}`);
        }
      }
    }
  });
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
