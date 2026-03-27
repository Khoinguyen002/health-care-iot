export type SensorPacket = {
  device_id: string;
  spo2: number | null;
  bpm: number | null;
  ppg: number[];
  ts: number;
  source?: string;
};

export type VitalPoint = {
  ts: number;
  value: number;
};

export type AIAssessment = {
  device_id: string;
  ts: number;
  status: "stable" | "warning" | "critical";
  confidence: number;
  summary: string;
  diagnosis?: string;
  warnings?: string[];
  findings: string[];
  recommendations: string[];
  metrics?: {
    sample_count?: number;
    spo2_count?: number;
    bpm_count?: number;
    ppg_count?: number;
    spo2_mean?: number | null;
    spo2_min?: number | null;
    spo2_max?: number | null;
    bpm_mean?: number | null;
    bpm_min?: number | null;
    bpm_max?: number | null;
    ppg_std?: number | null;
    ppg_p10?: number | null;
    ppg_p90?: number | null;
  };
};
