import { useMemo, useState, type FormEvent } from "react";
import { PPGCanvas } from "./components/PPGCanvas";
import { useSensorData } from "./hooks/useSensorData";

const WS_URL = import.meta.env.VITE_WS_URL || "http://localhost:3001";

function App() {
  const [deviceInput, setDeviceInput] = useState("ESP_001");
  const {
    latest,
    ppgChunk,
    aiHistory,
    connectionState,
    error,
    connectToDevice,
    disconnect,
    isConnected,
    deviceId,
  } = useSensorData(WS_URL);

  const statusLabel = useMemo(() => {
    if (connectionState === "connected") return "Connected";
    if (connectionState === "connecting") return "Connecting";
    if (connectionState === "error") return "Error";
    return "Idle";
  }, [connectionState]);

  const onConnect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    connectToDevice(deviceInput);
  };

  const spo2Value = latest?.spo2 ?? "--";
  const bpmValue = latest?.bpm ?? "--";
  const latestAssessment = aiHistory[0];
  const bpClass =
    latest?.bp_class ??
    (latestAssessment
      ? latestAssessment.status === "stable"
        ? "normal_bp"
        : "high_bp"
      : null);
  const bpConfidence = latest?.bp_confidence ?? latestAssessment?.confidence ?? null;

  const bpClassLabel =
    bpClass === "normal_bp"
      ? "Normal BP"
      : bpClass === "high_bp"
        ? "High BP"
        : "N/A";
  const bpClassTone =
    bpClass === "normal_bp"
      ? "bg-lime-100 text-lime-800 border-lime-200"
      : bpClass === "high_bp"
        ? "bg-red-100 text-red-800 border-red-200"
        : "bg-slate-100 text-slate-700 border-slate-200";
  const dotClass =
    connectionState === "connected"
      ? "bg-lime-700"
      : connectionState === "connecting"
        ? "bg-amber-600"
        : connectionState === "error"
          ? "bg-red-600"
          : "bg-slate-400";

  const statusTone = (status: "stable" | "warning" | "critical") => {
    if (status === "critical") return "border-red-200 bg-red-50 text-red-900";
    if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
    return "border-lime-200 bg-lime-50 text-lime-900";
  };

  return (
    <main className="grid gap-4">
      <header className="space-y-1">
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-lime-700">
          Real-time Health Dashboard
        </p>
        <h1 className="m-0 font-sans text-3xl font-bold text-slate-900 md:text-4xl">
          Sensor - UDP - Gateway - Web
        </h1>
        <p className="m-0 max-w-prose text-sm md:text-base">
          Monitor real-time biosignals for each ESP32 node.
        </p>
      </header>

      <section className="grid gap-3 rounded-2xl border border-lime-200 bg-lime-50/70 p-4 shadow-sm">
        <form
          onSubmit={onConnect}
          className="grid grid-cols-1 items-center gap-2 md:grid-cols-[120px_1fr_auto_auto]"
        >
          <label
            htmlFor="device_id"
            className="text-sm font-medium text-slate-700"
          >
            Device ID
          </label>
          <input
            id="device_id"
            value={deviceInput}
            onChange={(event) => setDeviceInput(event.target.value)}
            placeholder="ESP_001"
            className="w-full rounded-xl border border-lime-200 bg-white px-3 py-2 font-mono text-sm outline-none ring-lime-300 focus:ring"
          />
          <button
            type="submit"
            className="rounded-xl border border-amber-700 bg-amber-400 px-3 py-2 text-sm font-semibold text-amber-950"
          >
            Connect
          </button>
          <button
            type="button"
            className="rounded-xl border border-lime-300 bg-lime-100 px-3 py-2 text-sm font-semibold text-lime-900"
            onClick={disconnect}
          >
            Disconnect
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass}`}
          />
          <strong>{statusLabel}</strong>
          <span>Gateway: {WS_URL}</span>
          <span>Device: {deviceId || "N/A"}</span>
        </div>

        {error ? <p className="m-0 text-sm text-red-700">{error}</p> : null}
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <article className="rounded-2xl border border-lime-200 bg-white/80 p-4 shadow-sm">
          <p className="m-0 text-sm text-slate-600">SpO2</p>
          <p className="m-0 font-mono text-5xl leading-none text-slate-900">
            {spo2Value}
          </p>
          <p className="m-0 text-sm text-slate-600">%</p>
        </article>
        <article className="rounded-2xl border border-lime-200 bg-white/80 p-4 shadow-sm">
          <p className="m-0 text-sm text-slate-600">Heart Rate</p>
          <p className="m-0 font-mono text-5xl leading-none text-slate-900">
            {bpmValue}
          </p>
          <p className="m-0 text-sm text-slate-600">BPM</p>
        </article>
        <article className="rounded-2xl border border-lime-200 bg-white/80 p-4 shadow-sm">
          <p className="m-0 text-sm text-slate-600">BP Classification</p>
          <p className="m-0 mt-1 text-2xl font-semibold text-slate-900">{bpClassLabel}</p>
          <p className="m-0 mt-2 text-sm text-slate-600">
            Confidence: {bpConfidence !== null ? `${Math.round(bpConfidence * 100)}%` : "--"}
          </p>
          <p
            className={`mt-3 inline-flex rounded-lg border px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.06em] ${bpClassTone}`}
          >
            {bpClass || "unknown"}
          </p>
        </article>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <article className="rounded-2xl border border-lime-200 bg-white/80 p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between">
            <h2 className="m-0 text-xl font-semibold text-slate-900">
              PPG Signal
            </h2>
            <p className="m-0 text-sm">
              {isConnected ? "Receiving live packets" : "Sensor not connected"}
            </p>
          </div>
          <PPGCanvas
            chunk={ppgChunk}
            width={1100}
            height={300}
            maxSamples={1600}
          />
        </article>

        <article className="rounded-2xl border border-lime-200 bg-white/80 p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between">
            <h2 className="m-0 text-xl font-semibold text-slate-900">
              AI Assessment History
            </h2>
          </div>

          <div className="grid max-h-90 gap-2 overflow-y-auto pr-1">
            {aiHistory.length === 0 ? (
              <p className="m-0 text-sm text-slate-600">No assessment records yet.</p>
            ) : (
              aiHistory.map((item, index) => (
                <article
                  key={`${item.ts}-${index}`}
                  className={`rounded-xl border px-3 py-2 ${statusTone(item.status)}`}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <strong>{item.status.toUpperCase()}</strong>
                    <span>confidence: {Math.round((item.confidence || 0) * 100)}%</span>
                    <span>{new Date(item.ts).toLocaleTimeString()}</span>
                  </div>
                  <p className="m-0 mt-1 text-sm">
                    <strong>Diagnosis:</strong> {item.diagnosis || item.summary}
                  </p>
                  {Array.isArray(item.warnings) && item.warnings.length > 0 ? (
                    <p className="m-0 mt-1 text-xs opacity-90">
                      <strong>Warnings:</strong> {item.warnings.slice(0, 3).join(" | ")}
                    </p>
                  ) : Array.isArray(item.findings) && item.findings.length > 0 ? (
                    <p className="m-0 mt-1 text-xs opacity-80">
                      <strong>Warnings:</strong> {item.findings.slice(0, 3).join(" | ")}
                    </p>
                  ) : null}
                  {Array.isArray(item.recommendations) && item.recommendations.length > 0 ? (
                    <p className="m-0 mt-1 text-xs opacity-90">
                      <strong>Recommendations:</strong> {item.recommendations.slice(0, 3).join(" | ")}
                    </p>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </article>
      </section>
    </main>
  );
}

export default App;
