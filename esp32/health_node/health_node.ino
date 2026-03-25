#include <WiFi.h>
#include <WiFiUdp.h>
#include <Wire.h>
#include <math.h>
#include <MAX30105.h>
#include <spo2_algorithm.h>
#include <heartRate.h>
#include <ArduinoJson.h>

#define DEBUG_LOG_ENABLED 1
#define DEBUG_STATUS_INTERVAL_MS 1000

// -------- WiFi + Gateway --------
const char* WIFI_SSID = "K Home";
const char* WIFI_PASSWORD = "K08081998";
const char* BACKEND_IP = "192.168.1.100";
const uint16_t BACKEND_UDP_PORT = 41234;

const char* DEVICE_ID = "ESP_001";

WiFiUDP udp;
MAX30105 particleSensor;

// -------- Sampling config --------
static const uint16_t PPG_CHUNK_CAP = 64;
int32_t ppgChunkRing[PPG_CHUNK_CAP];
uint16_t ppgChunkRead = 0;
uint16_t ppgChunkWrite = 0;
uint16_t ppgChunkCount = 0;

static const uint16_t ALGO_WINDOW_SIZE = 100;
static const uint16_t ALGO_RECALC_EVERY = 25;
uint32_t redBuffer[ALGO_WINDOW_SIZE];
uint32_t irBuffer[ALGO_WINDOW_SIZE];
uint32_t redOrdered[ALGO_WINDOW_SIZE];
uint32_t irOrdered[ALGO_WINDOW_SIZE];
uint16_t algoWrite = 0;
uint16_t algoCount = 0;
uint16_t newSamplesSinceCalc = 0;

float gSpO2 = 97.0f;
float gBpm = 72.0f;

unsigned long lastSensorReadMs = 0;
unsigned long lastUdpSendMs = 0;

const uint16_t SENSOR_INTERVAL_MS = 5;   // 200Hz read tick
const uint16_t UDP_INTERVAL_MS = 80;     // 12.5 packets/s
const uint8_t MAX_SAMPLES_PER_TICK = 24;
const uint32_t FINGER_IR_THRESHOLD_MIN = 500;
const uint32_t FINGER_IR_THRESHOLD_MAX = 12000;
const float FILTER_ALPHA = 0.18f;
const float MOTION_JUMP_RATIO = 0.28f;
const float MOTION_AC_RATIO = 0.24f;
const uint8_t MAX_ARTIFACT_STREAK = 12;

const uint8_t HR_RATE_SIZE = 8;
const uint16_t HR_MIN_BPM = 40;
const uint16_t HR_MAX_BPM = 180;
const float BPM_SMOOTH_ALPHA = 0.30f;
const uint16_t SENSOR_SAMPLE_RATE_HZ = 100;
const uint32_t HR_BEAT_TIMEOUT_US = 2500000UL;
const uint32_t HR_MIN_BEAT_INTERVAL_US = 300000UL; // Reject double peaks under 300ms.

float irEma = 0.0f;
float redEma = 0.0f;
uint32_t prevIrRaw = 0;
uint32_t prevRedRaw = 0;
bool filterReady = false;
uint8_t artifactStreak = 0;

uint8_t rates[HR_RATE_SIZE];
uint8_t rateSpot = 0;
uint32_t lastBeatUs = 0;
float bpmSmooth = 72.0f;
uint32_t statBeatDetected = 0;
uint32_t lastIrRawForDebug = 0;

float noFingerBaselineIr = 800.0f;
bool baselineReady = false;
uint32_t fingerIrThreshold = FINGER_IR_THRESHOLD_MIN;

unsigned long lastDebugStatusMs = 0;
uint32_t statSamplesTotal = 0;
uint32_t statSamplesClean = 0;
uint32_t statSamplesArtifact = 0;
uint32_t statNoFinger = 0;
uint32_t statUdpPackets = 0;
uint32_t statUdpPpgSamples = 0;

#if DEBUG_LOG_ENABLED
void debugLog(const char* msg) {
  Serial.println(msg);
}

void debugLogKV(const char* key, float value) {
  Serial.print(key);
  Serial.print(": ");
  Serial.println(value, 2);
}

void debugStatus(unsigned long nowMs) {
  if (nowMs - lastDebugStatusMs < DEBUG_STATUS_INTERVAL_MS) {
    return;
  }

  lastDebugStatusMs = nowMs;

  Serial.print("[dbg] bpm=");
  Serial.print(gBpm, 1);
  Serial.print(" spo2=");
  Serial.print(gSpO2, 1);
  Serial.print(" algoCount=");
  Serial.print(algoCount);
  Serial.print(" chunkPending=");
  Serial.print(ppgChunkCount);
  Serial.print(" clean=");
  Serial.print(statSamplesClean);
  Serial.print(" artifact=");
  Serial.print(statSamplesArtifact);
  Serial.print(" noFinger=");
  Serial.print(statNoFinger);
  Serial.print(" udpPkts=");
  Serial.print(statUdpPackets);
  Serial.print(" udpPpg=");
  Serial.print(statUdpPpgSamples);
  Serial.print(" beats=");
  Serial.print(statBeatDetected);
  Serial.print(" fingerTh=");
  Serial.print(fingerIrThreshold);
  Serial.print(" sampleRate=");
  Serial.print(SENSOR_SAMPLE_RATE_HZ);
  Serial.print(" irRaw=");
  Serial.println(lastIrRawForDebug);

  statSamplesTotal = 0;
  statSamplesClean = 0;
  statSamplesArtifact = 0;
  statNoFinger = 0;
  statUdpPackets = 0;
  statUdpPpgSamples = 0;
  statBeatDetected = 0;
}
#else
void debugLog(const char* msg) { (void)msg; }
void debugLogKV(const char* key, float value) { (void)key; (void)value; }
void debugStatus(unsigned long nowMs) { (void)nowMs; }
#endif

void connectWiFi() {
  debugLog("[wifi] connecting...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
#if DEBUG_LOG_ENABLED
    Serial.print(".");
#endif
  }

#if DEBUG_LOG_ENABLED
  Serial.println();
  Serial.print("[wifi] connected ip=");
  Serial.println(WiFi.localIP());
#endif
}

void initMax30102() {
  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    debugLog("[max30102] init failed");
    while (true) {
      delay(1000);
    }
  }

  byte ledBrightness = 50;
  byte sampleAverage = 1;
  byte ledMode = 2; // red + IR
  int sampleRate = SENSOR_SAMPLE_RATE_HZ;
  int pulseWidth = 411;
  int adcRange = 16384;

  particleSensor.setup(
    ledBrightness,
    sampleAverage,
    ledMode,
    sampleRate,
    pulseWidth,
    adcRange
  );

  debugLog("[max30102] initialized");
}

void enqueuePpgChunk(int32_t value) {
  ppgChunkRing[ppgChunkWrite] = value;
  ppgChunkWrite = (ppgChunkWrite + 1) % PPG_CHUNK_CAP;

  if (ppgChunkCount < PPG_CHUNK_CAP) {
    ppgChunkCount++;
    return;
  }

  // Queue full: drop oldest sample and keep latest stream for realtime chart.
  ppgChunkRead = (ppgChunkRead + 1) % PPG_CHUNK_CAP;
}

void pushAlgoSample(uint32_t redValue, uint32_t irValue) {
  redBuffer[algoWrite] = redValue;
  irBuffer[algoWrite] = irValue;
  algoWrite = (algoWrite + 1) % ALGO_WINDOW_SIZE;

  if (algoCount < ALGO_WINDOW_SIZE) {
    algoCount++;
  }

  newSamplesSinceCalc++;
}

bool sensorHasFinger(uint32_t irValue) {
  return irValue > fingerIrThreshold;
}

void updateFingerThreshold(uint32_t irRaw, bool fingerPresent) {
  if (!baselineReady) {
    noFingerBaselineIr = (float)irRaw;
    baselineReady = true;
  }

  if (!fingerPresent) {
    // Learn ambient/no-finger level slowly to avoid adapting to in-finger waveform.
    noFingerBaselineIr = noFingerBaselineIr * 0.92f + (float)irRaw * 0.08f;
    float target = noFingerBaselineIr * 2.2f + 120.0f;
    if (target < (float)FINGER_IR_THRESHOLD_MIN) {
      target = (float)FINGER_IR_THRESHOLD_MIN;
    }
    if (target > (float)FINGER_IR_THRESHOLD_MAX) {
      target = (float)FINGER_IR_THRESHOLD_MAX;
    }
    fingerIrThreshold = (uint32_t)target;
  }
}

void resetFilterState() {
  filterReady = false;
  artifactStreak = 0;
}

void resetHeartRateEstimator() {
  for (uint8_t i = 0; i < HR_RATE_SIZE; i++) {
    rates[i] = 0;
  }
  rateSpot = 0;
  lastBeatUs = 0;
}

void updateHeartRateFromBeat(uint32_t irSample, uint32_t sampleTimeUs) {
  if (!checkForBeat(irSample)) {
    if (lastBeatUs != 0 && (sampleTimeUs - lastBeatUs) > HR_BEAT_TIMEOUT_US) {
      resetHeartRateEstimator();
    }
    return;
  }

  statBeatDetected++;

  if (lastBeatUs == 0) {
    lastBeatUs = sampleTimeUs;
    return;
  }

  const uint32_t deltaUs = sampleTimeUs - lastBeatUs;
  if (deltaUs < HR_MIN_BEAT_INTERVAL_US) {
    return;
  }

  lastBeatUs = sampleTimeUs;
  if (deltaUs == 0) {
    return;
  }

  const float bpm = 60000000.0f / (float)deltaUs;
  if (bpm < HR_MIN_BPM || bpm > HR_MAX_BPM) {
    return;
  }

  rates[rateSpot++] = (uint8_t)(bpm + 0.5f);
  rateSpot %= HR_RATE_SIZE;

  uint16_t sum = 0;
  uint8_t validCount = 0;
  for (uint8_t i = 0; i < HR_RATE_SIZE; i++) {
    if (rates[i] > 0) {
      sum += rates[i];
      validCount++;
    }
  }

  if (validCount == 0) {
    return;
  }

  const float avgBpm = (float)sum / (float)validCount;
  bpmSmooth += BPM_SMOOTH_ALPHA * (avgBpm - bpmSmooth);
  gBpm = bpmSmooth;
}

bool preprocessSample(uint32_t rawRed, uint32_t rawIr, uint32_t* outRed, uint32_t* outIr) {
  if (!sensorHasFinger(rawIr)) {
    resetFilterState();
    *outRed = 0;
    *outIr = 0;
    return false;
  }

  if (!filterReady) {
    redEma = (float)rawRed;
    irEma = (float)rawIr;
    prevRedRaw = rawRed;
    prevIrRaw = rawIr;
    filterReady = true;

    *outRed = rawRed;
    *outIr = rawIr;
    return true;
  }

  redEma += FILTER_ALPHA * ((float)rawRed - redEma);
  irEma += FILTER_ALPHA * ((float)rawIr - irEma);

  const float prevIr = fmaxf((float)prevIrRaw, 1.0f);
  const float prevRed = fmaxf((float)prevRedRaw, 1.0f);
  const float jumpIr = fabsf((float)rawIr - (float)prevIrRaw) / prevIr;
  const float jumpRed = fabsf((float)rawRed - (float)prevRedRaw) / prevRed;
  const float acIr = fabsf((float)rawIr - irEma) / fmaxf(irEma, 1.0f);

  prevIrRaw = rawIr;
  prevRedRaw = rawRed;

  const bool hasMotionArtifact =
    jumpIr > MOTION_JUMP_RATIO ||
    jumpRed > MOTION_JUMP_RATIO ||
    acIr > MOTION_AC_RATIO;

  const uint32_t filteredRed = (uint32_t)fmaxf(redEma, 0.0f);
  const uint32_t filteredIr = (uint32_t)fmaxf(irEma, 0.0f);

  *outRed = filteredRed;
  *outIr = filteredIr;

  return !hasMotionArtifact;
}

void resetAlgoWindow() {
  algoWrite = 0;
  algoCount = 0;
  newSamplesSinceCalc = 0;
}

void computeVitalsFromMaxAlgorithm() {
  if (algoCount < ALGO_WINDOW_SIZE) {
    return;
  }

  // Reorder ring buffer into oldest->newest window required by maxim algorithm.
  for (uint16_t i = 0; i < ALGO_WINDOW_SIZE; i++) {
    uint16_t idx = (algoWrite + i) % ALGO_WINDOW_SIZE;
    redOrdered[i] = redBuffer[idx];
    irOrdered[i] = irBuffer[idx];
  }

  int32_t spo2 = 0;
  int32_t heartRate = 0;
  int8_t spo2Valid = 0;
  int8_t hrValid = 0;

  maxim_heart_rate_and_oxygen_saturation(
    irOrdered,
    ALGO_WINDOW_SIZE,
    redOrdered,
    &spo2,
    &spo2Valid,
    &heartRate,
    &hrValid
  );

  (void)heartRate;
  (void)hrValid;

  if (spo2Valid && spo2 >= 70 && spo2 <= 100) {
    gSpO2 = float(spo2);
  }

  newSamplesSinceCalc = 0;
}

void readSensorFast(unsigned long nowMs) {
  if (nowMs - lastSensorReadMs < SENSOR_INTERVAL_MS) {
    return;
  }

  lastSensorReadMs = nowMs;

  particleSensor.check();

  uint8_t processed = 0;
  while (particleSensor.available() && processed < MAX_SAMPLES_PER_TICK) {
    statSamplesTotal++;
    const uint32_t sampleTimeUs = micros();

    const uint32_t redRaw = particleSensor.getRed();
    const uint32_t irRaw = particleSensor.getIR();
    lastIrRawForDebug = irRaw;
    const bool fingerPresent = sensorHasFinger(irRaw);
    updateFingerThreshold(irRaw, fingerPresent);
    uint32_t redFiltered = redRaw;
    uint32_t irFiltered = irRaw;

    const bool cleanSample = preprocessSample(redRaw, irRaw, &redFiltered, &irFiltered);

    enqueuePpgChunk((int32_t)irFiltered);

    if (!fingerPresent) {
      statNoFinger++;
      resetAlgoWindow();
      resetHeartRateEstimator();
    } else {
      // checkForBeat performs better with raw IR waveform than aggressively filtered data.
      updateHeartRateFromBeat(irRaw, sampleTimeUs);
    }

    if (cleanSample) {
      statSamplesClean++;
      artifactStreak = 0;
      pushAlgoSample(redFiltered, irFiltered);
      if (newSamplesSinceCalc >= ALGO_RECALC_EVERY) {
        computeVitalsFromMaxAlgorithm();
      }
    } else if (fingerPresent) {
      statSamplesArtifact++;
      artifactStreak++;
      if (artifactStreak >= MAX_ARTIFACT_STREAK) {
        resetAlgoWindow();
      }
    }

    particleSensor.nextSample();
    processed++;
  }
}

void sendUdpTick(unsigned long nowMs) {
  if (nowMs - lastUdpSendMs < UDP_INTERVAL_MS) {
    return;
  }

  lastUdpSendMs = nowMs;

  StaticJsonDocument<4096> doc;
  doc["device_id"] = DEVICE_ID;
  doc["spo2"] = gSpO2;
  doc["bpm"] = gBpm;
  doc["ts"] = millis();

  JsonArray ppg = doc.createNestedArray("ppg");
  uint16_t samplesToSend = ppgChunkCount;

  // Send only fresh samples accumulated since previous UDP packet.
  for (uint16_t i = 0; i < samplesToSend; i++) {
    uint16_t idx = (ppgChunkRead + i) % PPG_CHUNK_CAP;
    ppg.add(ppgChunkRing[idx]);
  }

  ppgChunkRead = ppgChunkWrite;
  ppgChunkCount = 0;

  char payload[4096];
  const size_t len = serializeJson(doc, payload, sizeof(payload));

  udp.beginPacket(BACKEND_IP, BACKEND_UDP_PORT);
  udp.write((const uint8_t*)payload, len);
  udp.endPacket();

  statUdpPackets++;
  statUdpPpgSamples += samplesToSend;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  debugLog("[boot] health node starting");

  Wire.begin();
  connectWiFi();
  initMax30102();
  udp.begin(0);
  resetHeartRateEstimator();
  debugLog("[udp] sender ready");
}

void loop() {
  const unsigned long nowMs = millis();

  // Two independent ticks avoid blocking sensor sampling by network transmission.
  readSensorFast(nowMs);
  sendUdpTick(nowMs);
  debugStatus(nowMs);

  // Yield CPU without fixed delay to keep loop responsive.
  yield();
}
