const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  }
});

// serve static web client
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {}; // { roomId: { sockets: Set(), meta: {socketId:name} } }

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('create-room', ({ roomId, name }, cb) => {
    if (rooms[roomId]) {
      return cb && cb({ ok: false, message: 'Room already exists' });
    }
    rooms[roomId] = { sockets: new Set([socket.id]), meta: { [socket.id]: name || 'Anonymous' } };
    socket.join(roomId);
    console.log(`room ${roomId} created by ${socket.id}`);
    cb && cb({ ok: true });
  });

  socket.on('join-room', ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ ok: false, message: 'Room does not exist' });

    const existingIds = Array.from(room.sockets);
    room.sockets.add(socket.id);
    room.meta[socket.id] = name || 'Anonymous';
    socket.join(roomId);

    // notify requester
    cb && cb({ ok: true, others: existingIds, meta: room.meta });

    // notify existing peers
    existingIds.forEach(id => {
      io.to(id).emit('new-peer', { socketId: socket.id, name: name || 'Anonymous' });
    });

    console.log(`${socket.id} joined room ${roomId}`);
  });

  socket.on('signal', ({ to, from, data }) => {
    io.to(to).emit('signal', { from, data });
  });

  socket.on('leave-room', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.sockets.delete(socket.id);
    delete room.meta[socket.id];
    socket.leave(roomId);
    io.to(roomId).emit('peer-left', { socketId: socket.id });
    if (room.sockets.size === 0) delete rooms[roomId];
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.sockets.has(socket.id)) {
        room.sockets.delete(socket.id);
        delete room.meta[socket.id];
        io.to(roomId).emit('peer-left', { socketId: socket.id });
        if (room.sockets.size === 0) delete rooms[roomId];
      }
    }
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
