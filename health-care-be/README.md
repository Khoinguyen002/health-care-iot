# health-care-be — UDP → WebSocket Gateway

Node.js gateway that receives UDP packets from ESP32 sensor nodes and streams the data to browser clients over WebSocket.

## Overview

```
ESP32  ──UDP──►  server.js  ──WebSocket──►  Browser
               (port 41234)   (port 3001)
```

- **UDP server** listens for JSON health packets from ESP32 devices.
- **WebSocket server** (Socket.IO) lets browser clients subscribe to a specific device and receive its data in real time.
- **HTTP server** (Express) exposes a `/health` endpoint for uptime checks.

## Tech Stack

| Package | Version | Role |
|---------|---------|------|
| express | 4.21.2 | HTTP server + health endpoint |
| socket.io | 4.8.1 | WebSocket server |
| cors | 2.8.5 | CORS middleware |
| nodemon | dev | Auto-reload in development |

## Getting Started

```bash
npm install
npm run dev     # development — auto-reloads on file change
npm start       # production
```

## Configuration

Set environment variables before starting the server.

| Variable | Default | Description |
|----------|---------|-------------|
| `UDP_PORT` | `41234` | UDP port to receive ESP32 packets |
| `WS_PORT` | `3001` | WebSocket (and HTTP) server port |

Example:

```bash
UDP_PORT=41234 WS_PORT=3001 npm start
```

## UDP Packet Format

The server expects JSON payloads from the ESP32. Required field: `device_id`.

```json
{
  "device_id": "ESP_001",
  "spo2": 97.5,
  "bpm": 72,
  "ppg": [4500, 4510, 4498],
  "ts": 1234567890
}
```

The `ppg` array is capped at 256 samples. Total packet size must be under 65535 bytes.

## WebSocket API

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `subscribe-device` | `{ deviceId: string }` | Subscribe to a device's data stream |
| `unsubscribe-device` | `{ deviceId: string }` | Stop receiving data from a device |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `subscribed` | `{ deviceId: string }` | Subscription confirmed |
| `unsubscribed` | `{ deviceId: string }` | Unsubscription confirmed |
| `sensor-data` | See below | New reading from subscribed device |
| `gateway-error` | `{ message: string }` | Error from the gateway |

#### `sensor-data` payload

```json
{
  "device_id": "ESP_001",
  "spo2": 97.5,
  "bpm": 72,
  "ppg": [4500, 4510, 4498],
  "ts": 1234567890,
  "source": "192.168.1.50"
}
```

`source` is the sender's IP address, added by the gateway.

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{ status: "ok" }` — for uptime/load balancer checks |

## Project Structure

```
health-care-be/
├── src/
│   └── server.js       # All server logic (UDP + WebSocket + HTTP)
├── package.json
└── package-lock.json
```
