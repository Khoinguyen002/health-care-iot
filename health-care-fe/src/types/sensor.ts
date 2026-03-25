export type SensorPacket = {
  device_id: string;
  spo2: number;
  bpm: number;
  ppg: number[];
  ts: number;
  source?: string;
};

export type VitalPoint = {
  ts: number;
  value: number;
};
