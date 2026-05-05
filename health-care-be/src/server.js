require('dotenv').config();

const dgram = require('node:dgram');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const Redis = require('ioredis');

const UDP_PORT = Number(process.env.UDP_PORT || 41234);
const WS_PORT = Number(process.env.WS_PORT || 3001);
const MAX_PACKET_SIZE = Number(process.env.MAX_PACKET_SIZE || 65535);
const AI_EVAL_INTERVAL_MS = Number(process.env.AI_EVAL_INTERVAL_MS || 30000);
const AI_WINDOW_MS = Number(process.env.AI_WINDOW_MS || 120000);
const AI_MIN_POINTS = Number(process.env.AI_MIN_POINTS || 10);
const AI_MAX_HISTORY = Number(process.env.AI_MAX_HISTORY || 50);
const REDIS_URL = process.env.REDIS_URL || '';

const redisClient = REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    })
  : null;

if (redisClient) {
  redisClient.on('error', (err) => {
    console.error('[redis] error:', err.message);
  });

  redisClient.on('connect', () => {
    console.log('[redis] tcp connected');
  });

  redisClient.on('ready', () => {
    console.log('[redis] ready');
  });

  redisClient.on('reconnecting', () => {
    console.warn('[redis] reconnecting');
  });

  redisClient.on('end', () => {
    console.warn('[redis] connection ended');
  });

  redisClient.connect().catch((err) => {
    console.error('[redis] connect failed:', err.message);
  });
}

console.log('[ei] scheduler config', {
  evalIntervalMs: AI_EVAL_INTERVAL_MS,
  windowMs: AI_WINDOW_MS,
  minPoints: AI_MIN_POINTS,
});

console.log('[redis] config', {
  enabled: Boolean(redisClient),
  url: REDIS_URL ? `${REDIS_URL.slice(0, 20)}...` : '(empty)',
});

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
const recentReadingsByDevice = new Map();
const lastEvalTsByDevice = new Map();
const memoryHistoryByDevice = new Map();
let aiEvalInProgress = false;

// socketId -> subscribed deviceId
const subscriptions = new Map();

function hasActiveSubscriber(deviceId) {
  const room = io.sockets.adapter.rooms.get(`device:${deviceId}`);
  return Boolean(room && room.size > 0);
}

const average = (arr) => arr.reduce((sum, value) => sum + value, 0) / arr.length;

const stdDev = (arr) => {
  if (!arr.length) return 0;
  const mean = average(arr);
  const variance = arr.reduce((sum, value) => sum + (value - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const percentile = (arr, p) => {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[idx];
};

function toNullableFiniteNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function historyKey(deviceId) {
  return `health:ai:history:${deviceId}`;
}

function pushLimitedHistory(deviceId, item) {
  const current = memoryHistoryByDevice.get(deviceId) || [];
  current.unshift(item);
  memoryHistoryByDevice.set(deviceId, current.slice(0, AI_MAX_HISTORY));
}

async function persistAssessment(deviceId, assessment) {
  pushLimitedHistory(deviceId, assessment);

  if (!redisClient) return;

  try {
    const key = historyKey(deviceId);
    const raw = JSON.stringify(assessment);
    await redisClient.lpush(key, raw);
    await redisClient.ltrim(key, 0, AI_MAX_HISTORY - 1);
    console.log('[redis] assessment saved', {
      deviceId,
      key,
      ts: assessment.ts,
      status: assessment.status,
    });
  } catch (error) {
    console.error('[redis] persist failed:', error?.message || error);
  }
}

async function loadAssessmentHistory(deviceId) {
  if (!redisClient) {
    console.log('[redis] load history from memory', { deviceId });
    return memoryHistoryByDevice.get(deviceId) || [];
  }

  try {
    const raws = await redisClient.lrange(historyKey(deviceId), 0, AI_MAX_HISTORY - 1);
    const items = [];

    for (const raw of raws) {
      try {
        items.push(JSON.parse(raw));
      } catch {
        // Ignore corrupted history item.
      }
    }

    console.log('[redis] load history', { deviceId, count: items.length });
    return items;
  } catch (error) {
    console.error('[redis] load history failed:', error?.message || error);
    return memoryHistoryByDevice.get(deviceId) || [];
  }
}

function addReadingForAnalysis(reading) {
  const deviceId = reading.device_id;
  const now = Number(reading.gateway_ts || Date.now());
  const list = recentReadingsByDevice.get(deviceId) || [];

  list.push(reading);
  const cutoff = now - AI_WINDOW_MS;
  while (list.length && Number(list[0].gateway_ts || 0) < cutoff) {
    list.shift();
  }

  recentReadingsByDevice.set(deviceId, list);
}

function clearEvaluatedReadings(deviceId, evaluatedTs) {
  const list = recentReadingsByDevice.get(deviceId);
  if (!list || !list.length) return;

  const beforeLen = list.length;
  const filtered = list.filter((r) => Number(r.gateway_ts || 0) > evaluatedTs);

  console.log('[ai] clear evaluated readings', {
    deviceId,
    evaluatedTs,
    removed: beforeLen - filtered.length,
    remaining: filtered.length,
  });

  if (filtered.length === 0) {
    recentReadingsByDevice.delete(deviceId);
  } else {
    recentReadingsByDevice.set(deviceId, filtered);
  }
}

function summarizeWindow(readings) {
  const spo2 = readings.map((r) => r.spo2).filter(Number.isFinite);
  const bpm = readings.map((r) => r.bpm).filter(Number.isFinite);
  const ppg = readings
    .flatMap((r) => (Array.isArray(r.ppg) ? r.ppg : []))
    .filter(Number.isFinite)
    .slice(-800);

  return {
    sample_count: readings.length,
    spo2_count: spo2.length,
    bpm_count: bpm.length,
    ppg_count: ppg.length,
    spo2_mean: spo2.length ? Number(average(spo2).toFixed(2)) : null,
    spo2_min: spo2.length ? Math.min(...spo2) : null,
    spo2_max: spo2.length ? Math.max(...spo2) : null,
    bpm_mean: bpm.length ? Number(average(bpm).toFixed(2)) : null,
    bpm_min: bpm.length ? Math.min(...bpm) : null,
    bpm_max: bpm.length ? Math.max(...bpm) : null,
    ppg_std: ppg.length ? Number(stdDev(ppg).toFixed(2)) : null,
    ppg_p10: ppg.length ? percentile(ppg, 0.1) : null,
    ppg_p90: ppg.length ? percentile(ppg, 0.9) : null,
  };
}

function extractJsonBlock(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function createPrompt(deviceId, summary) {
  return [
    `Device: ${deviceId}`,
    `Summary ${AI_EVAL_INTERVAL_MS / 1000}s: ${JSON.stringify(summary)}`,
    'Assess health status from bpm/spo2/ppg quality and provide diagnosis, warnings, and recommendations.',
    'Return strict JSON with fields:',
    '{"status":"stable|warning|critical","confidence":0-1,"summary":"...","diagnosis":"...","warnings":["..."],"recommendations":["..."],"findings":["..."]}',
    'Use warning if spo2 < 94 or bpm outside 50-120 trend. Use critical if spo2 < 90 or severe instability.',
  ].join('\n');
}

function fallbackAssessment(deviceId, summary) {
  let status = 'stable';
  if ((summary.spo2_min ?? 100) < 94 || (summary.bpm_max ?? 70) > 120 || (summary.bpm_min ?? 70) < 50) {
    status = 'warning';
  }
  if ((summary.spo2_min ?? 100) < 90) {
    status = 'critical';
  }

  return {
    device_id: deviceId,
    ts: Date.now(),
    status,
    confidence: 0.55,
    summary: 'Heuristic assessment used because AI response unavailable.',
    diagnosis: 'Provisional automated assessment from fallback heuristic.',
    warnings: [
      `spo2 range: ${summary.spo2_min ?? 'n/a'}-${summary.spo2_max ?? 'n/a'}`,
      `bpm range: ${summary.bpm_min ?? 'n/a'}-${summary.bpm_max ?? 'n/a'}`,
      `ppg variability(std): ${summary.ppg_std ?? 'n/a'}`,
    ],
    findings: [
      `spo2 range: ${summary.spo2_min ?? 'n/a'}-${summary.spo2_max ?? 'n/a'}`,
      `bpm range: ${summary.bpm_min ?? 'n/a'}-${summary.bpm_max ?? 'n/a'}`,
      `ppg variability(std): ${summary.ppg_std ?? 'n/a'}`,
    ],
    recommendations: [
      'Keep finger stable on sensor and avoid movement.',
      'Re-check if warning persists for >2 minutes.',
    ],
    metrics: summary,
  };
}

function evaluateDevice(deviceId, readings) {
  const summary = summarizeWindow(readings);

  const eiReadings = readings.filter(
    (r) => r.bp_class === 'normal_bp' || r.bp_class === 'high_bp'
  );

  console.log('[ei] evaluate start', {
    deviceId,
    total: readings.length,
    eiWindows: eiReadings.length,
    spo2_mean: summary.spo2_mean,
    bpm_mean: summary.bpm_mean,
  });

  if (!eiReadings.length) {
    console.warn('[ei] no classified windows yet, using fallback', { deviceId });
    return fallbackAssessment(deviceId, summary);
  }

  const highCount = eiReadings.filter((r) => r.bp_class === 'high_bp').length;
  const normalCount = eiReadings.length - highCount;
  const highRatio = highCount / eiReadings.length;
  const avgConf =
    eiReadings.reduce((s, r) => s + (r.bp_confidence || 0), 0) / eiReadings.length;

  const status = highRatio >= 0.85 ? 'critical' : highRatio >= 0.5 ? 'warning' : 'stable';
  const dominant = highRatio >= 0.5 ? 'high_bp' : 'normal_bp';

  const diagnosis =
    dominant === 'high_bp'
      ? `High BP detected in ${highCount}/${eiReadings.length} windows (${Math.round(highRatio * 100)}%). Average confidence: ${Math.round(avgConf * 100)}%.`
      : `Normal BP in ${normalCount}/${eiReadings.length} windows (${Math.round((1 - highRatio) * 100)}%). Average confidence: ${Math.round(avgConf * 100)}%.`;

  const result = {
    device_id: deviceId,
    ts: Date.now(),
    source: 'edge_impulse',
    status,
    confidence: Math.round(avgConf * 100) / 100,
    summary: `Edge Impulse: ${Math.round(highRatio * 100)}% high_bp — ${eiReadings.length} windows, SpO2 ${summary.spo2_mean ?? 'n/a'}%, BPM ${summary.bpm_mean ?? 'n/a'}`,
    diagnosis,
    warnings:
      dominant === 'high_bp'
        ? [
            `${highCount}/${eiReadings.length} windows: high_bp`,
            `SpO2 range: ${summary.spo2_min ?? 'n/a'}–${summary.spo2_max ?? 'n/a'}%`,
            `BPM range: ${summary.bpm_min ?? 'n/a'}–${summary.bpm_max ?? 'n/a'}`,
          ]
        : [],
    findings: [
      `high_bp: ${highCount} windows (${Math.round(highRatio * 100)}%)`,
      `normal_bp: ${normalCount} windows`,
      `avg confidence: ${Math.round(avgConf * 100)}%`,
      `SpO2 mean: ${summary.spo2_mean ?? 'n/a'}%  |  BPM mean: ${summary.bpm_mean ?? 'n/a'}`,
    ],
    recommendations:
      dominant === 'high_bp'
        ? [
            'Rest and re-measure after 5 minutes.',
            'Avoid stress and caffeine before measuring.',
            'Consult a doctor if high_bp persists across multiple sessions.',
          ]
        : ['Blood pressure is stable. Continue regular monitoring.'],
    metrics: {
      ...summary,
      ei_total_windows: eiReadings.length,
      ei_high_bp_windows: highCount,
      ei_normal_bp_windows: normalCount,
      ei_high_bp_ratio: Math.round(highRatio * 100) / 100,
    },
  };

  console.log('[ei] evaluate done', { deviceId, status, highRatio, avgConf });
  return result;
}

async function runAiEvaluationTick() {
  if (aiEvalInProgress) return;
  aiEvalInProgress = true;
  console.log('[ei] tick start', { devices: recentReadingsByDevice.size });

  try {
    for (const [deviceId, readings] of recentReadingsByDevice.entries()) {
      if (!hasActiveSubscriber(deviceId)) {
        console.log('[ei] skip device (no active websocket subscriber)', {
          deviceId,
        });
        continue;
      }

      if (readings.length < AI_MIN_POINTS) {
        console.log('[ei] skip device (not enough points)', {
          deviceId,
          points: readings.length,
          min: AI_MIN_POINTS,
        });
        continue;
      }

      const lastTs = Number(readings[readings.length - 1]?.gateway_ts || 0);
      const lastEvalTs = lastEvalTsByDevice.get(deviceId) || 0;
      if (lastTs <= lastEvalTs) {
        console.log('[ei] skip device (no new data)', { deviceId });
        continue;
      }

      const assessment = evaluateDevice(deviceId, readings);
      lastEvalTsByDevice.set(deviceId, lastTs);

      await persistAssessment(deviceId, assessment);
      io.to(`device:${deviceId}`).emit('ai-assessment', assessment);
      
      // Clear all readings that were part of this evaluation, keep only NEW readings
      clearEvaluatedReadings(deviceId, lastTs);
      
      console.log('[ei] emitted assessment', {
        deviceId,
        status: assessment.status,
        ts: assessment.ts,
      });
    }
  } finally {
    console.log('[ei] tick end');
    aiEvalInProgress = false;
  }
}

io.on('connection', (socket) => {
  console.log(`[ws] connected: ${socket.id}`);

  socket.on('subscribe-device', async (payload) => {
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

    try {
      const history = await loadAssessmentHistory(deviceId);
      socket.emit('ai-history', { device_id: deviceId, items: history });
    } catch (error) {
      console.error('[ai] load history error:', error?.message || error);
      socket.emit('ai-history', { device_id: deviceId, items: [] });
    }

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

  const receivedAt = Date.now();
  const spo2 = toNullableFiniteNumber(payload.spo2);
  const bpm = toNullableFiniteNumber(payload.bpm);
  const bpClassRaw = String(payload?.bp_class || '')
    .trim()
    .toLowerCase();
  const bpClass = bpClassRaw === 'normal_bp' || bpClassRaw === 'high_bp' ? bpClassRaw : null;
  const bpConfidenceRaw = toNullableFiniteNumber(payload.bp_confidence);
  const bpConfidence =
    bpConfidenceRaw === null ? null : clamp(bpConfidenceRaw, 0, 1);

  const reading = {
    device_id: deviceId,
    spo2,
    bpm,
    bp_class: bpClass,
    bp_confidence: bpConfidence,
    ppg: Array.isArray(payload.ppg) ? payload.ppg.slice(-256).map(Number) : [],
    ts: Number(payload.ts || receivedAt),
    gateway_ts: receivedAt,
    source: `${rinfo.address}:${rinfo.port}`,
  };

  io.to(`device:${deviceId}`).emit('sensor-data', reading);
  addReadingForAnalysis(reading);
});

udpServer.bind(UDP_PORT, () => {
  const address = udpServer.address();
  setInterval(runAiEvaluationTick, AI_EVAL_INTERVAL_MS);
  console.log('[ei] scheduler started', { everyMs: AI_EVAL_INTERVAL_MS });
  console.log(`[udp] listening on ${address.address}:${address.port}`);
});

httpServer.listen(WS_PORT, () => {
  console.log(`[ws/http] listening on port ${WS_PORT}`);
});
