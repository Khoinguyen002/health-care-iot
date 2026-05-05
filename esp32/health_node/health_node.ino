// ============================================================
// health_node.ino  —  ESP32 + MAX30102 + Edge Impulse Edge AI
// ------------------------------------------------------------
// Upgrade: Runs BP classification locally (Edge AI) using the
// Edge Impulse exported library, then pushes results via UDP
// to the Web Dashboard.
//
// Required Arduino libraries (install via Library Manager /
// .zip import):
//   1. SparkFun MAX3010x Pulse and Proximity Sensor Library
//   2. ArduinoJson  (>= 6.x)
//   3. <ProjectName>_inferencing  ← exported from Edge Impulse
//      (Deployment → Arduino library → Download .zip)
//
// Edge Impulse project: BP-PPG-Nhom13
// Library header:       <BP_PPG_Nhom13_inferencing.h>
// ============================================================

// --- Core Arduino / ESP32 ---
#include <WiFi.h>
#include <WiFiUdp.h>
#include <Wire.h>
#include <math.h>

// --- Sensor ---
#include <MAX30105.h>
#include <spo2_algorithm.h>
#include <heartRate.h>

// --- Serialization ---
#include <ArduinoJson.h>

#include <BP-PPG-Nhom13_inferencing.h>

// ============================================================
//  Configuration
// ============================================================

#define DEBUG_LOG_ENABLED       1
#define DEBUG_STATUS_INTERVAL_MS 1000

// WiFi + Gateway
const char* WIFI_SSID       = "K Home F1";
const char* WIFI_PASSWORD   = "K08081998";
const char* BACKEND_IP      = "192.168.101.18";
const uint16_t BACKEND_UDP_PORT = 41234;
const char* DEVICE_ID       = "ESP_001";

// Timing
const uint16_t SENSOR_INTERVAL_MS  = 5;    // 200 Hz read tick
const uint16_t UDP_INTERVAL_MS     = 80;   // 12.5 packets/s
const uint8_t  MAX_SAMPLES_PER_TICK = 24;

// Finger detection
const uint32_t FINGER_IR_THRESHOLD_MIN = 500;
const uint32_t FINGER_IR_THRESHOLD_MAX = 12000;

// EMA / artifact filter
const float FILTER_ALPHA      = 0.18f;
const float MOTION_JUMP_RATIO = 0.28f;
const float MOTION_AC_RATIO   = 0.24f;
const uint8_t MAX_ARTIFACT_STREAK = 12;

// Heart-rate estimator
const uint8_t  HR_RATE_SIZE           = 8;
const uint16_t HR_MIN_BPM             = 40;
const uint16_t HR_MAX_BPM             = 180;
const float    BPM_SMOOTH_ALPHA       = 0.30f;
const uint16_t SENSOR_SAMPLE_RATE_HZ  = 100;
const uint32_t HR_BEAT_TIMEOUT_US     = 2500000UL;
const uint32_t HR_MIN_BEAT_INTERVAL_US = 300000UL;

// ============================================================
//  Hardware objects
// ============================================================
WiFiUDP    udp;
MAX30105   particleSensor;

// ============================================================
//  PPG ring buffer for UDP streaming
// ============================================================
static const uint16_t PPG_CHUNK_CAP = 64;
int32_t  ppgChunkRing[PPG_CHUNK_CAP];
uint16_t ppgChunkRead  = 0;
uint16_t ppgChunkWrite = 0;
uint16_t ppgChunkCount = 0;

// ============================================================
//  MAXIM SpO2/HR algorithm window
// ============================================================
static const uint16_t ALGO_WINDOW_SIZE  = 100;
static const uint16_t ALGO_RECALC_EVERY = 25;
uint32_t redBuffer[ALGO_WINDOW_SIZE];
uint32_t irBuffer[ALGO_WINDOW_SIZE];
uint32_t redOrdered[ALGO_WINDOW_SIZE];
uint32_t irOrdered[ALGO_WINDOW_SIZE];
uint16_t algoWrite            = 0;
uint16_t algoCount            = 0;
uint16_t newSamplesSinceCalc  = 0;

float gSpO2 = 97.0f;
float gBpm  = 72.0f;

// ============================================================
//  Edge Impulse inference buffer
// ============================================================
// EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE is defined in the library
// and equals: (window_ms / 1000) * sample_rate
// For a 5000 ms window at 100 Hz → 500 samples.
// The library header will assert a mismatch at compile time if
// the sensor rate does not match the trained project.

static float   eiBuffer[EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE];
static uint16_t eiIdx = 0;

// Latest inference result (written by runEdgeImpulse, read by sendUdpTick)
static char  gBpClass[16]    = "unknown";
static float gBpConfidence   = 0.0f;
static uint32_t gBpInfCount  = 0;   // total inferences run

// ============================================================
//  EMA / filter state
// ============================================================
float    irEma        = 0.0f;
float    redEma       = 0.0f;
uint32_t prevIrRaw    = 0;
uint32_t prevRedRaw   = 0;
bool     filterReady  = false;
uint8_t  artifactStreak = 0;

// ============================================================
//  Heart-rate estimator state
// ============================================================
uint8_t  rates[HR_RATE_SIZE];
uint8_t  rateSpot     = 0;
uint32_t lastBeatUs   = 0;
float    bpmSmooth    = 72.0f;
uint32_t statBeatDetected = 0;
uint32_t lastIrRawForDebug = 0;

// ============================================================
//  Finger detection state
// ============================================================
float    noFingerBaselineIr = 800.0f;
bool     baselineReady      = false;
uint32_t fingerIrThreshold  = FINGER_IR_THRESHOLD_MIN;

// ============================================================
//  Timing
// ============================================================
unsigned long lastSensorReadMs  = 0;
unsigned long lastUdpSendMs     = 0;
unsigned long lastDebugStatusMs = 0;

// ============================================================
//  Statistics (cleared every debug interval)
// ============================================================
uint32_t statSamplesTotal    = 0;
uint32_t statSamplesClean    = 0;
uint32_t statSamplesArtifact = 0;
uint32_t statNoFinger        = 0;
uint32_t statUdpPackets      = 0;
uint32_t statUdpPpgSamples   = 0;

// ============================================================
//  Debug helpers
// ============================================================
#if DEBUG_LOG_ENABLED
void debugLog(const char* msg) { Serial.println(msg); }

void debugStatus(unsigned long nowMs) {
  if (nowMs - lastDebugStatusMs < DEBUG_STATUS_INTERVAL_MS) return;
  lastDebugStatusMs = nowMs;

  Serial.print("[dbg] bpm=");      Serial.print(gBpm, 1);
  Serial.print(" spo2=");          Serial.print(gSpO2, 1);
  Serial.print(" bp=");            Serial.print(gBpClass);
  Serial.print(" conf=");          Serial.print(gBpConfidence, 2);
  Serial.print(" inf#=");          Serial.print(gBpInfCount);
  Serial.print(" eiBuf=");         Serial.print(eiIdx);
  Serial.print("/");               Serial.print(EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE);
  Serial.print(" clean=");         Serial.print(statSamplesClean);
  Serial.print(" artifact=");      Serial.print(statSamplesArtifact);
  Serial.print(" noFinger=");      Serial.print(statNoFinger);
  Serial.print(" udpPkts=");       Serial.print(statUdpPackets);
  Serial.print(" irRaw=");         Serial.println(lastIrRawForDebug);

  statSamplesTotal    = 0;
  statSamplesClean    = 0;
  statSamplesArtifact = 0;
  statNoFinger        = 0;
  statUdpPackets      = 0;
  statUdpPpgSamples   = 0;
  statBeatDetected    = 0;
}
#else
void debugLog(const char* msg)        { (void)msg; }
void debugStatus(unsigned long nowMs) { (void)nowMs; }
#endif

// ============================================================
//  WiFi
// ============================================================
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

// ============================================================
//  MAX30102 init
// ============================================================
void initMax30102() {
  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    debugLog("[max30102] init failed — halted");
    while (true) delay(1000);
  }

  particleSensor.setup(
    /*ledBrightness*/ 50,
    /*sampleAverage*/ 1,
    /*ledMode*/       2,   // RED + IR
    /*sampleRate*/    SENSOR_SAMPLE_RATE_HZ,
    /*pulseWidth*/    411,
    /*adcRange*/      16384
  );

  debugLog("[max30102] initialized");
}

// ============================================================
//  PPG ring buffer helpers
// ============================================================
void enqueuePpgChunk(int32_t value) {
  ppgChunkRing[ppgChunkWrite] = value;
  ppgChunkWrite = (ppgChunkWrite + 1) % PPG_CHUNK_CAP;
  if (ppgChunkCount < PPG_CHUNK_CAP) {
    ppgChunkCount++;
    return;
  }
  // Drop oldest when full (keep real-time stream for chart).
  ppgChunkRead = (ppgChunkRead + 1) % PPG_CHUNK_CAP;
}

// ============================================================
//  MAXIM algorithm window helpers
// ============================================================
void pushAlgoSample(uint32_t redValue, uint32_t irValue) {
  redBuffer[algoWrite] = redValue;
  irBuffer[algoWrite]  = irValue;
  algoWrite = (algoWrite + 1) % ALGO_WINDOW_SIZE;
  if (algoCount < ALGO_WINDOW_SIZE) algoCount++;
  newSamplesSinceCalc++;
}

void resetAlgoWindow() {
  algoWrite           = 0;
  algoCount           = 0;
  newSamplesSinceCalc = 0;
}

// ============================================================
//  Finger detection
// ============================================================
bool sensorHasFinger(uint32_t irValue) {
  return irValue > fingerIrThreshold;
}

void updateFingerThreshold(uint32_t irRaw, bool fingerPresent) {
  if (!baselineReady) {
    noFingerBaselineIr = (float)irRaw;
    baselineReady = true;
  }
  if (!fingerPresent) {
    noFingerBaselineIr = noFingerBaselineIr * 0.92f + (float)irRaw * 0.08f;
    float target = noFingerBaselineIr * 2.2f + 120.0f;
    if (target < (float)FINGER_IR_THRESHOLD_MIN) target = (float)FINGER_IR_THRESHOLD_MIN;
    if (target > (float)FINGER_IR_THRESHOLD_MAX) target = (float)FINGER_IR_THRESHOLD_MAX;
    fingerIrThreshold = (uint32_t)target;
  }
}

// ============================================================
//  EMA / artifact filter
// ============================================================
void resetFilterState() {
  filterReady    = false;
  artifactStreak = 0;
}

bool preprocessSample(uint32_t rawRed, uint32_t rawIr,
                       uint32_t* outRed, uint32_t* outIr) {
  if (!sensorHasFinger(rawIr)) {
    resetFilterState();
    *outRed = 0;
    *outIr  = 0;
    return false;
  }

  if (!filterReady) {
    redEma      = (float)rawRed;
    irEma       = (float)rawIr;
    prevRedRaw  = rawRed;
    prevIrRaw   = rawIr;
    filterReady = true;
    *outRed = rawRed;
    *outIr  = rawIr;
    return true;
  }

  redEma += FILTER_ALPHA * ((float)rawRed - redEma);
  irEma  += FILTER_ALPHA * ((float)rawIr  - irEma);

  const float prevIr  = fmaxf((float)prevIrRaw,  1.0f);
  const float prevRed = fmaxf((float)prevRedRaw, 1.0f);
  const float jumpIr  = fabsf((float)rawIr  - (float)prevIrRaw)  / prevIr;
  const float jumpRed = fabsf((float)rawRed - (float)prevRedRaw) / prevRed;
  const float acIr    = fabsf((float)rawIr  - irEma) / fmaxf(irEma, 1.0f);

  prevIrRaw  = rawIr;
  prevRedRaw = rawRed;

  const bool motionArtifact =
    jumpIr  > MOTION_JUMP_RATIO ||
    jumpRed > MOTION_JUMP_RATIO ||
    acIr    > MOTION_AC_RATIO;

  *outRed = (uint32_t)fmaxf(redEma, 0.0f);
  *outIr  = (uint32_t)fmaxf(irEma,  0.0f);

  return !motionArtifact;
}

// ============================================================
//  Heart-rate estimator
// ============================================================
void resetHeartRateEstimator() {
  for (uint8_t i = 0; i < HR_RATE_SIZE; i++) rates[i] = 0;
  rateSpot  = 0;
  lastBeatUs = 0;
}

void updateHeartRateFromBeat(uint32_t irSample, uint32_t sampleTimeUs) {
  if (!checkForBeat(irSample)) {
    if (lastBeatUs != 0 && (sampleTimeUs - lastBeatUs) > HR_BEAT_TIMEOUT_US)
      resetHeartRateEstimator();
    return;
  }

  statBeatDetected++;
  if (lastBeatUs == 0) { lastBeatUs = sampleTimeUs; return; }

  const uint32_t deltaUs = sampleTimeUs - lastBeatUs;
  if (deltaUs < HR_MIN_BEAT_INTERVAL_US) return;
  lastBeatUs = sampleTimeUs;
  if (deltaUs == 0) return;

  const float bpm = 60000000.0f / (float)deltaUs;
  if (bpm < HR_MIN_BPM || bpm > HR_MAX_BPM) return;

  rates[rateSpot++] = (uint8_t)(bpm + 0.5f);
  rateSpot %= HR_RATE_SIZE;

  uint16_t sum = 0; uint8_t cnt = 0;
  for (uint8_t i = 0; i < HR_RATE_SIZE; i++) {
    if (rates[i] > 0) { sum += rates[i]; cnt++; }
  }
  if (!cnt) return;

  const float avg = (float)sum / (float)cnt;
  bpmSmooth += BPM_SMOOTH_ALPHA * (avg - bpmSmooth);
  gBpm = bpmSmooth;
}

// ============================================================
//  SpO2 computation (MAXIM algorithm)
// ============================================================
void computeVitalsFromMaxAlgorithm() {
  if (algoCount < ALGO_WINDOW_SIZE) return;

  for (uint16_t i = 0; i < ALGO_WINDOW_SIZE; i++) {
    uint16_t idx    = (algoWrite + i) % ALGO_WINDOW_SIZE;
    redOrdered[i]   = redBuffer[idx];
    irOrdered[i]    = irBuffer[idx];
  }

  int32_t spo2 = 0, heartRate = 0;
  int8_t  spo2Valid = 0, hrValid = 0;

  maxim_heart_rate_and_oxygen_saturation(
    irOrdered, ALGO_WINDOW_SIZE, redOrdered,
    &spo2, &spo2Valid, &heartRate, &hrValid
  );

  (void)heartRate; (void)hrValid;

  if (spo2Valid && spo2 >= 70 && spo2 <= 100)
    gSpO2 = (float)spo2;

  newSamplesSinceCalc = 0;
}

// ============================================================
//  Edge Impulse — BP classification
// ============================================================
// Callback required by the EI SDK: copy features from our
// global eiBuffer into the signal struct.
static int ei_get_data_callback(size_t offset, size_t length, float* out_ptr) {
  memcpy(out_ptr, eiBuffer + offset, length * sizeof(float));
  return 0;
}

void runEdgeImpulse() {
  signal_t signal;
  signal.total_length = EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE;
  signal.get_data     = &ei_get_data_callback;

  ei_impulse_result_t result = { 0 };
  EI_IMPULSE_ERROR err = run_classifier(&signal, &result, false /* debug */);

  if (err != EI_IMPULSE_OK) {
#if DEBUG_LOG_ENABLED
    Serial.print("[ei] run_classifier error: ");
    Serial.println(err);
#endif
    return;
  }

  // Find highest-confidence class.
  size_t bestIdx = 0;
  float  bestVal = result.classification[0].value;
  for (size_t i = 1; i < EI_CLASSIFIER_LABEL_COUNT; i++) {
    if (result.classification[i].value > bestVal) {
      bestVal = result.classification[i].value;
      bestIdx = i;
    }
  }

  strncpy(gBpClass, result.classification[bestIdx].label, sizeof(gBpClass) - 1);
  gBpClass[sizeof(gBpClass) - 1] = '\0';
  gBpConfidence = bestVal;
  gBpInfCount++;

  // ── Serial Monitor output required for report ──────────────
  Serial.print("[ei] label=");
  Serial.print(gBpClass);
  Serial.print(" confidence=");
  Serial.print(gBpConfidence * 100.0f, 1);
  Serial.print("% inferences=");
  Serial.println(gBpInfCount);
#if DEBUG_LOG_ENABLED
  // Print all class scores for debugging.
  for (size_t i = 0; i < EI_CLASSIFIER_LABEL_COUNT; i++) {
    Serial.print("    ");
    Serial.print(result.classification[i].label);
    Serial.print(": ");
    Serial.print(result.classification[i].value * 100.0f, 1);
    Serial.println("%");
  }
#endif
}

// Push one filtered IR sample (AC component) into the EI window.
// When the window is full, inference runs and the buffer resets.
void pushEiSample(float irRawValue) {
  // Normalize to AC/DC ratio: (raw - DC) / DC
  // DC ≈ irEma. This gives ~±0.01–0.05 range, matching MIMIC-III PPG scale (~0.03).
  const float dc = fmaxf(irEma, 1.0f);
  eiBuffer[eiIdx++] = (irRawValue - dc) / dc;

  if (eiIdx >= EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE) {
    runEdgeImpulse();
    eiIdx = 0;
  }
}

// Reset the EI buffer when finger is removed (avoid contaminating
// the next inference window with stale no-finger data).
void resetEiBuffer() {
  eiIdx = 0;
}

// ============================================================
//  Main sensor read tick
// ============================================================
void readSensorFast(unsigned long nowMs) {
  if (nowMs - lastSensorReadMs < SENSOR_INTERVAL_MS) return;
  lastSensorReadMs = nowMs;

  particleSensor.check();

  uint8_t processed = 0;
  while (particleSensor.available() && processed < MAX_SAMPLES_PER_TICK) {
    statSamplesTotal++;
    const uint32_t sampleTimeUs = micros();
    const uint32_t redRaw = particleSensor.getRed();
    const uint32_t irRaw  = particleSensor.getIR();
    lastIrRawForDebug = irRaw;

    const bool fingerPresent = sensorHasFinger(irRaw);
    updateFingerThreshold(irRaw, fingerPresent);

    uint32_t redFiltered = redRaw;
    uint32_t irFiltered  = irRaw;
    const bool cleanSample = preprocessSample(redRaw, irRaw, &redFiltered, &irFiltered);

    enqueuePpgChunk((int32_t)irFiltered);

    if (!fingerPresent) {
      statNoFinger++;
      resetAlgoWindow();
      resetHeartRateEstimator();
      resetEiBuffer();  // clear EI window so stale data doesn't contaminate
    } else {
      updateHeartRateFromBeat(irRaw, sampleTimeUs);
    }

    // Feed EI buffer at full sensor rate whenever finger is present.
    // Pass raw IR so the AC pulsatile component can be extracted correctly.
    // Using irFiltered (≈ irEma) would yield near-zero AC values.
    if (fingerPresent && filterReady) {
      pushEiSample((float)irRaw);
    }

    if (cleanSample) {
      statSamplesClean++;
      artifactStreak = 0;

      pushAlgoSample(redFiltered, irFiltered);
      if (newSamplesSinceCalc >= ALGO_RECALC_EVERY)
        computeVitalsFromMaxAlgorithm();

    } else if (fingerPresent) {
      statSamplesArtifact++;
      artifactStreak++;
      if (artifactStreak >= MAX_ARTIFACT_STREAK)
        resetAlgoWindow();
    }

    particleSensor.nextSample();
    processed++;
  }
}

// ============================================================
//  UDP send tick
// ============================================================
void sendUdpTick(unsigned long nowMs) {
  if (nowMs - lastUdpSendMs < UDP_INTERVAL_MS) return;
  lastUdpSendMs = nowMs;

  StaticJsonDocument<4096> doc;
  doc["device_id"]     = DEVICE_ID;
  doc["spo2"]          = gSpO2;
  doc["bpm"]           = gBpm;
  doc["bp_class"]      = gBpClass;      // Edge AI result: "normal_bp" | "high_bp" | "unknown"
  doc["bp_confidence"] = gBpConfidence; // 0.0 – 1.0
  doc["ts"]            = millis();

  JsonArray ppg = doc.createNestedArray("ppg");
  uint16_t samplesToSend = ppgChunkCount;
  for (uint16_t i = 0; i < samplesToSend; i++) {
    ppg.add(ppgChunkRing[(ppgChunkRead + i) % PPG_CHUNK_CAP]);
  }
  ppgChunkRead  = ppgChunkWrite;
  ppgChunkCount = 0;

  char payload[4096];
  const size_t len = serializeJson(doc, payload, sizeof(payload));

  udp.beginPacket(BACKEND_IP, BACKEND_UDP_PORT);
  udp.write((const uint8_t*)payload, len);
  udp.endPacket();

  statUdpPackets++;
  statUdpPpgSamples += samplesToSend;
}

// ============================================================
//  Arduino entry points
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(300);
  debugLog("[boot] health_node + Edge Impulse starting");

#if DEBUG_LOG_ENABLED
  Serial.print("[ei] DSP input frame size = ");
  Serial.println(EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE);
  Serial.print("[ei] Label count          = ");
  Serial.println(EI_CLASSIFIER_LABEL_COUNT);
  Serial.print("[ei] Sample rate          = ");
  Serial.print(EI_CLASSIFIER_FREQUENCY);
  Serial.println(" Hz");
#endif

  Wire.begin();
  connectWiFi();
  initMax30102();
  udp.begin(0);
  resetHeartRateEstimator();
  debugLog("[udp] sender ready");
  debugLog("[boot] ready — place finger on sensor");
}

void loop() {
  const unsigned long nowMs = millis();
  readSensorFast(nowMs);
  sendUdpTick(nowMs);
  debugStatus(nowMs);
  yield();
}
