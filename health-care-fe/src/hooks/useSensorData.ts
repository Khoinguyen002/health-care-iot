import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { SensorPacket, VitalPoint } from "../types/sensor";

type ConnectionState = "idle" | "connecting" | "connected" | "error";

const MAX_VITAL_POINTS = 240;

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

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setConnectionState("idle");
  }, []);

  const connectToDevice = useCallback(
    (nextDeviceId: string) => {
      const trimmed = nextDeviceId.trim();
      if (!trimmed) {
        setError("device_id khong duoc de trong");
        return;
      }

      setError("");
      setConnectionState("connecting");
      setDeviceId(trimmed);
      setLatest(null);
      setSpo2Series([]);
      setBpmSeries([]);
      setPpgChunk([]);

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
        setError(err.message || "Khong the ket noi den gateway");
      });

      socket.on("gateway-error", (payload: { message?: string }) => {
        setConnectionState("error");
        setError(payload?.message || "Loi tu gateway");
      });

      socket.on("sensor-data", (packet: SensorPacket) => {
        setLatest(packet);
        setPpgChunk(Array.isArray(packet.ppg) ? packet.ppg : []);

        const ts = Number(packet.ts || Date.now());
        const spo2 = Number(packet.spo2);
        const bpm = Number(packet.bpm);

        if (Number.isFinite(spo2)) {
          setSpo2Series((curr) => pushPoint(curr, { ts, value: spo2 }));
        }
        if (Number.isFinite(bpm)) {
          setBpmSeries((curr) => pushPoint(curr, { ts, value: bpm }));
        }
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
    error,
    connectionState,
    isConnected,
    connectToDevice,
    disconnect,
  };
}
