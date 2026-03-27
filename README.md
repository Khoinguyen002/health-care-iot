# Health Care IoT — Real-time Health Monitoring System

A full-stack IoT system for real-time health monitoring using an ESP32 microcontroller, a Node.js gateway server, and a React dashboard.

## System Architecture

```
ESP32 Sensor Node
  └─ MAX30105 PPG sensor (SpO2 + Heart Rate)
  └─ WiFi → UDP packets every 80ms
        ↓
Backend Gateway (Node.js)
  └─ UDP server (port 41234) — receives ESP32 packets
  └─ WebSocket server (port 3001) — streams data to browser
        ↓
Frontend Dashboard (React + TypeScript)
  └─ Connects via WebSocket to a device by ID
  └─ Displays SpO2, BPM, and live PPG waveform
```

## Repository Structure

```
health-care-iot/
├── esp32/
│   └── health_node/
│       ├── health_node.ino       # ESP32 firmware (Arduino)
│       └── local_config.h        # WiFi/network secrets (git-ignored)
├── health-care-be/               # Node.js gateway server
│   └── src/
│       └── server.js
└── health-care-fe/               # React + TypeScript dashboard
    └── src/
```

## Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| `esp32/health_node` | Arduino / C++ | Reads sensor, sends UDP |
| `health-care-be` | Node.js, Express, Socket.IO | UDP→WebSocket gateway |
| `health-care-fe` | React, TypeScript, Vite, Tailwind | Real-time dashboard |

## Data Flow

1. The ESP32 reads PPG data from the MAX30105 sensor at 100 Hz.
2. Every 80ms it sends a UDP JSON packet to the backend.
3. The backend parses the packet and broadcasts it via WebSocket to all clients subscribed to that device.
4. The frontend subscribes to a device ID and renders live SpO2, BPM, and PPG waveform.

### UDP Packet Format

```json
{
  "device_id": "ESP_001",
  "spo2": 97.5,
  "bpm": 72,
  "ppg": [4500, 4510, 4498, "...64 samples"],
  "ts": 1234567890
}
```

## Quick Start

### 1. Flash the ESP32

See [esp32/health_node/README.md](esp32/health_node/README.md).

### 2. Start the Backend

```bash
cd health-care-be
npm install
npm run dev        # development (nodemon)
# or
npm start          # production
```

### 3. Start the Frontend

```bash
cd health-care-fe
npm install
npm run dev
```

Open `http://localhost:5173`, enter the device ID (e.g. `ESP_001`), and click Connect.

## Environment Variables

### Backend (`health-care-be`)

| Variable | Default | Description |
|----------|---------|-------------|
| `UDP_PORT` | `41234` | Port to receive ESP32 UDP packets |
| `WS_PORT` | `3001` | WebSocket server port |

### Frontend (`health-care-fe`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_WS_URL` | `http://localhost:3001` | Backend WebSocket URL |

## Hardware Requirements

- ESP32 development board
- MAX30105 pulse oximeter and heart-rate sensor
- I2C connection between ESP32 and MAX30105
- 2.4 GHz WiFi network shared by ESP32 and the backend host
