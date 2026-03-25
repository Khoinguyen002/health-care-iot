const dgram = require('node:dgram');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const UDP_PORT = Number(process.env.UDP_PORT || 41234);
const WS_PORT = Number(process.env.WS_PORT || 3001);
const MAX_PACKET_SIZE = Number(process.env.MAX_PACKET_SIZE || 65535);

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

const udpServer = dgram.createSocket('udp4');

// socketId -> subscribed deviceId
const subscriptions = new Map();

io.on('connection', (socket) => {
  console.log(`[ws] connected: ${socket.id}`);

  socket.on('subscribe-device', (payload) => {
    const deviceId = String(payload?.device_id || '').trim();

    if (!deviceId) {
      socket.emit('gateway-error', { message: 'device_id is required' });
      return;
    }

    const previous = subscriptions.get(socket.id);
    if (previous) {
      socket.leave(`device:${previous}`);
    }

    subscriptions.set(socket.id, deviceId);
    socket.join(`device:${deviceId}`);
    socket.emit('subscribed', { device_id: deviceId });

    console.log(`[ws] ${socket.id} subscribed device=${deviceId}`);
  });

  socket.on('unsubscribe-device', () => {
    const current = subscriptions.get(socket.id);
    if (!current) {
      return;
    }

    socket.leave(`device:${current}`);
    subscriptions.delete(socket.id);
    socket.emit('unsubscribed', { device_id: current });
  });

  socket.on('disconnect', () => {
    subscriptions.delete(socket.id);
    console.log(`[ws] disconnected: ${socket.id}`);
  });
});

udpServer.on('error', (error) => {
  console.error('[udp] server error:', error);
});

udpServer.on('message', (msg, rinfo) => {
  if (msg.length > MAX_PACKET_SIZE) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(msg.toString('utf8'));
  } catch {
    return;
  }

  const deviceId = String(payload?.device_id || '').trim();
  if (!deviceId) {
    return;
  }

  const reading = {
    device_id: deviceId,
    spo2: Number(payload.spo2),
    bpm: Number(payload.bpm),
    ppg: Array.isArray(payload.ppg) ? payload.ppg.slice(-256).map(Number) : [],
    ts: Number(payload.ts || Date.now()),
    source: `${rinfo.address}:${rinfo.port}`,
  };

  io.to(`device:${deviceId}`).emit('sensor-data', reading);
});

udpServer.bind(UDP_PORT, () => {
  const address = udpServer.address();
  console.log(`[udp] listening on ${address.address}:${address.port}`);
});

httpServer.listen(WS_PORT, () => {
  console.log(`[ws/http] listening on port ${WS_PORT}`);
});
