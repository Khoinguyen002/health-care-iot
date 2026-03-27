# health_node — ESP32 Sensor Firmware

Arduino sketch for the ESP32 health monitoring node. Reads SpO2 and heart rate data from a MAX30105 sensor and streams it to the backend gateway over UDP.

## Hardware

| Component | Description |
|-----------|-------------|
| ESP32 | Main microcontroller (WiFi-enabled) |
| MAX30105 | Pulse oximeter and heart-rate sensor (PPG) |

### Wiring (I2C)

| MAX30105 Pin | ESP32 Pin |
|--------------|-----------|
| VIN | 3.3V |
| GND | GND |
| SDA | GPIO 21 (default I2C SDA) |
| SCL | GPIO 22 (default I2C SCL) |

## Dependencies

Install these libraries via the Arduino Library Manager:

- **SparkFun MAX3010x Pulse and Proximity Sensor Library** — sensor driver + SpO2/HR algorithm
- **Arduino core for ESP32** — board support

## Configuration

Create `local_config.h` in the sketch directory (this file is git-ignored):

```cpp
#pragma once

#define WIFI_SSID       "your_wifi_ssid"
#define WIFI_PASSWORD   "your_wifi_password"
#define BACKEND_IP      "192.168.x.x"   // IP of the machine running health-care-be
#define BACKEND_UDP_PORT 41234
#define DEVICE_ID       "ESP_001"
```

> The sketch will not compile without `local_config.h`.

## Key Parameters

| Constant | Value | Description |
|----------|-------|-------------|
| `SENSOR_SAMPLE_RATE_HZ` | 100 | Sensor polling rate (Hz) |
| `PPG_CHUNK_CAP` | 64 | PPG samples sent per UDP packet |
| `ALGO_WINDOW_SIZE` | 100 | Sample window for SpO2/HR algorithm |
| `UDP_INTERVAL_MS` | 80 | UDP transmit interval (~12.5 packets/sec) |

## Data Processing Pipeline

```
MAX30105 sensor (Red + IR LEDs)
  ↓ 100 Hz
EMA low-pass filter
  ↓
Finger presence check (IR threshold)
  ↓
Motion artifact rejection
  ↓
Algorithm window (100 samples)
  ├─ MAXIM SpO2/HR algorithm  →  spo2, bpm
  └─ Circular PPG buffer (64 samples)
        ↓
UDP JSON packet → Backend (every 80ms)
```

### Finger Detection

If the IR reading falls below the threshold, the node reports `spo2 = 0` and `bpm = 0` and continues collecting data without running the algorithm.

## UDP Packet Format

Sent as a JSON string to `BACKEND_IP:BACKEND_UDP_PORT` every `UDP_INTERVAL_MS` ms.

```json
{
  "device_id": "ESP_001",
  "spo2": 97.5,
  "bpm": 72,
  "ppg": [4500, 4505, 4510, "...up to 64 samples"],
  "ts": 1234567890
}
```

`ts` is the ESP32 uptime in milliseconds (`millis()`).

## Flashing

1. Open `health_node.ino` in the Arduino IDE.
2. Create `local_config.h` with your credentials (see above).
3. Select your ESP32 board under **Tools → Board**.
4. Select the correct COM/USB port.
5. Click **Upload**.

## Serial Monitor

Set baud rate to `115200`. The sketch prints connection status, sensor readings, and UDP transmission logs.

## File Structure

```
health_node/
├── health_node.ino     # Main sketch
└── local_config.h      # WiFi + network secrets (git-ignored, create manually)
```
