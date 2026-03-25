import { useEffect, useRef } from "react";

type PPGCanvasProps = {
  chunk: number[];
  width?: number;
  height?: number;
  maxSamples?: number;
};

export function PPGCanvas({
  chunk,
  width = 960,
  height = 260,
  maxSamples = 1400,
}: PPGCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const writePtrRef = useRef(0);
  const sizeRef = useRef(maxSamples);
  const bufferRef = useRef<Float32Array>(new Float32Array(maxSamples));

  useEffect(() => {
    if (bufferRef.current.length !== maxSamples) {
      bufferRef.current = new Float32Array(maxSamples);
      sizeRef.current = maxSamples;
      writePtrRef.current = 0;
    }
  }, [maxSamples]);

  useEffect(() => {
    if (!chunk.length) {
      return;
    }

    const buffer = bufferRef.current;
    const size = sizeRef.current;
    let ptr = writePtrRef.current;

    for (let i = 0; i < chunk.length; i += 1) {
      buffer[ptr] = Number(chunk[i]) || 0;
      ptr = (ptr + 1) % size;
    }

    writePtrRef.current = ptr;
  }, [chunk]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || width;
      const h = canvas.clientHeight || height;

      canvas.width = Math.floor(w * ratio);
      canvas.height = Math.floor(h * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    let rafId = 0;
    const draw = () => {
      const w = canvas.clientWidth || width;
      const h = canvas.clientHeight || height;
      const buffer = bufferRef.current;
      const size = sizeRef.current;
      const ptr = writePtrRef.current;

      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < size; i += 1) {
        const value = buffer[(ptr + i) % size];
        if (value < min) min = value;
        if (value > max) max = value;
      }

      const range = Math.max(max - min, 1);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#f9fbf2";
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = "#dbe6ca";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 5; i += 1) {
        const y = (h / 5) * i;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      ctx.strokeStyle = "#cf4e2f";
      ctx.lineWidth = 2;
      ctx.beginPath();

      for (let i = 0; i < size; i += 1) {
        const sample = buffer[(ptr + i) % size];
        const x = (i / (size - 1)) * w;
        const normalized = (sample - min) / range;
        const y = h - normalized * (h - 8) - 4;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.stroke();
      rafId = window.requestAnimationFrame(draw);
    };

    rafId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    };
  }, [height, width]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full max-w-full rounded-xl border border-lime-200 bg-lime-50"
      style={{ width: `${width}px`, height: `${height}px`, maxWidth: "100%" }}
    />
  );
}
