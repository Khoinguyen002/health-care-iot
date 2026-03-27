import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { AIAssessment, SensorPacket, VitalPoint } from "../types/sensor";

type ConnectionState = "idle" | "connecting" | "connected" | "error";

const MAX_VITAL_POINTS = 240;
const MAX_AI_HISTORY = 50;

const pushPoint = (arr: VitalPoint[], point: VitalPoint): VitalPoint[] => {
  const next = [...arr, point];
  if (next.length <= MAX_VITAL_POINTS) {
    return next;
  }
  return next.slice(next.length - MAX_VITAL_POINTS);
};

export function useSensorData(serverUrl: string) {
  const socketRef = useRef<Socket | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [deviceId, setDeviceId] = useState("");
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<SensorPacket | null>(null);
  const [spo2Series, setSpo2Series] = useState<VitalPoint[]>([]);
  const [bpmSeries, setBpmSeries] = useState<VitalPoint[]>([]);
  const [ppgChunk, setPpgChunk] = useState<number[]>([]);
  const [aiHistory, setAiHistory] = useState<AIAssessment[]>([]);

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setConnectionState("idle");
  }, []);

  const connectToDevice = useCallback(
    (nextDeviceId: string) => {
      const trimmed = nextDeviceId.trim();
      if (!trimmed) {
        setError("device_id must not be empty");
        return;
      }

      setError("");
      setConnectionState("connecting");
      setDeviceId(trimmed);
      setLatest(null);
      setSpo2Series([]);
      setBpmSeries([]);
      setPpgChunk([]);
      setAiHistory([]);

      socketRef.current?.disconnect();

      const socket = io(serverUrl, {
        transports: ["websocket"],
      });

      socketRef.current = socket;

      socket.on("connect", () => {
        setConnectionState("connected");
        socket.emit("subscribe-device", { device_id: trimmed });
      });

      socket.on("connect_error", (err) => {
        setConnectionState("error");
        setError(err.message || "Cannot connect to gateway");
      });

      socket.on("gateway-error", (payload: { message?: string }) => {
        setConnectionState("error");
        setError(payload?.message || "Gateway error");
      });

      socket.on("sensor-data", (packet: SensorPacket) => {
        setLatest(packet);
        setPpgChunk(Array.isArray(packet.ppg) ? packet.ppg : []);

        const ts = Number(packet.ts || Date.now());
        const spo2 =
          typeof packet.spo2 === "number" && Number.isFinite(packet.spo2)
            ? packet.spo2
            : null;
        const bpm =
          typeof packet.bpm === "number" && Number.isFinite(packet.bpm)
            ? packet.bpm
            : null;

        if (spo2 !== null) {
          setSpo2Series((curr) => pushPoint(curr, { ts, value: spo2 }));
        }
        if (bpm !== null) {
          setBpmSeries((curr) => pushPoint(curr, { ts, value: bpm }));
        }
      });

      socket.on(
        "ai-history",
        (payload: { device_id?: string; items?: AIAssessment[] }) => {
          const items = Array.isArray(payload?.items) ? payload.items : [];
          setAiHistory(items.slice(0, MAX_AI_HISTORY));
        },
      );

      socket.on("ai-assessment", (item: AIAssessment) => {
        if (!item || typeof item !== "object") return;
        setAiHistory((curr) => [item, ...curr].slice(0, MAX_AI_HISTORY));
      });

      socket.on("disconnect", () => {
        setConnectionState("idle");
      });
    },
    [serverUrl],
  );

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const isConnected = useMemo(
    () => connectionState === "connected",
    [connectionState],
  );

  return {
    deviceId,
    latest,
    spo2Series,
    bpmSeries,
    ppgChunk,
    aiHistory,
    error,
    connectionState,
    isConnected,
    connectToDevice,
    disconnect,
  };
}
