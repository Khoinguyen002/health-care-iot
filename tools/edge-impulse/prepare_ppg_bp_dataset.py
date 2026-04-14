#!/usr/bin/env python3
"""Prepare PPG-BP windows for Edge Impulse classification.

Input expectations:
- One or more CSV files containing a PPG signal and either:
  1) SBP + DBP columns, or
  2) a pre-labeled class column (normal_bp/high_bp).

Output:
- Edge Impulse-ready CSV files in:
  output/training/{normal_bp,high_bp}/*.csv
  output/testing/{normal_bp,high_bp}/*.csv

Each exported sample is a fixed-length window with columns:
  timestamp,ppg
where timestamp is in milliseconds from window start.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
from scipy.signal import butter, filtfilt

NORMAL_BP = "normal_bp"
HIGH_BP = "high_bp"
VALID_LABELS = {NORMAL_BP, HIGH_BP}

DEFAULT_PPG_CANDIDATES = [
    "ppg",
    "pleth",
    "ir",
    "signal",
    "ppg_value",
]
DEFAULT_SBP_CANDIDATES = ["sbp", "sys", "systolic", "systolic_bp"]
DEFAULT_DBP_CANDIDATES = ["dbp", "dia", "diastolic", "diastolic_bp"]
DEFAULT_LABEL_CANDIDATES = ["label", "class", "bp_class"]
DEFAULT_SUBJECT_CANDIDATES = ["subject", "subject_id", "patient_id", "pid"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare PPG-BP dataset for Edge Impulse.")
    parser.add_argument(
        "--input-glob",
        required=True,
        help="Glob for input CSV files, e.g. 'data/raw/*.csv'",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Output directory for training/testing folders",
    )
    parser.add_argument("--sample-rate", type=float, default=100.0, help="Signal sample rate in Hz")
    parser.add_argument("--window-sec", type=float, default=5.0, help="Window length in seconds")
    parser.add_argument(
        "--overlap",
        type=float,
        default=0.5,
        help="Window overlap ratio in [0,1). Default 0.5",
    )
    parser.add_argument("--lowcut", type=float, default=0.5, help="Bandpass low cut (Hz)")
    parser.add_argument("--highcut", type=float, default=8.0, help="Bandpass high cut (Hz)")
    parser.add_argument(
        "--test-ratio",
        type=float,
        default=0.2,
        help="Deterministic subject-level test ratio. Default 0.2",
    )
    parser.add_argument(
        "--include-elevated-as-high",
        action="store_true",
        help="Map Elevated BP (120-129/<80) to high_bp instead of dropping",
    )
    parser.add_argument(
        "--min-std",
        type=float,
        default=1e-6,
        help="Reject windows with std below this threshold",
    )
    parser.add_argument(
        "--max-samples",
        type=int,
        default=0,
        help="Optional cap for total exported windows (0 means no limit)",
    )
    return parser.parse_args()


def find_column(columns: Iterable[str], candidates: list[str]) -> str | None:
    lowered = {c.lower(): c for c in columns}
    for key in candidates:
        if key in lowered:
            return lowered[key]
    return None


def bandpass_filter(signal: np.ndarray, fs: float, lowcut: float, highcut: float) -> np.ndarray:
    nyq = 0.5 * fs
    low = max(lowcut / nyq, 1e-6)
    high = min(highcut / nyq, 0.999999)
    if low >= high:
        raise ValueError(f"Invalid bandpass settings: lowcut={lowcut}, highcut={highcut}, fs={fs}")
    b, a = butter(N=4, Wn=[low, high], btype="band")
    return filtfilt(b, a, signal)


def label_from_bp(sbp: float, dbp: float, include_elevated_as_high: bool) -> str | None:
    if sbp < 120 and dbp < 80:
        return NORMAL_BP

    if sbp >= 130 or dbp >= 80:
        return HIGH_BP

    # Elevated: 120-129 and <80
    if include_elevated_as_high:
        return HIGH_BP

    return None


def deterministic_split(subject_id: str, test_ratio: float) -> str:
    digest = hashlib.sha1(subject_id.encode("utf-8")).hexdigest()
    score = int(digest[:8], 16) / 0xFFFFFFFF
    return "testing" if score < test_ratio else "training"


def export_edge_impulse_csv(path: Path, window: np.ndarray, fs: float) -> None:
    step_ms = 1000.0 / fs
    timestamps = np.arange(window.shape[0], dtype=np.float64) * step_ms
    df = pd.DataFrame({"timestamp": timestamps.astype(np.int64), "ppg": window})
    df.to_csv(path, index=False)


def main() -> None:
    args = parse_args()

    if not (0 <= args.overlap < 1):
        raise SystemExit("--overlap must be in [0,1)")
    if not (0 < args.test_ratio < 1):
        raise SystemExit("--test-ratio must be in (0,1)")

    input_paths = sorted(Path().glob(args.input_glob))
    if not input_paths:
        raise SystemExit(f"No files matched: {args.input_glob}")

    output_dir = Path(args.output_dir)
    for subset in ("training", "testing"):
        for label in VALID_LABELS:
            (output_dir / subset / label).mkdir(parents=True, exist_ok=True)

    win_size = int(round(args.sample_rate * args.window_sec))
    step = int(round(win_size * (1.0 - args.overlap)))
    if win_size < 10 or step <= 0:
        raise SystemExit("Window config invalid. Check sample-rate/window-sec/overlap.")

    exported = 0
    skipped = 0
    by_subset_label: dict[str, dict[str, int]] = {
        "training": {NORMAL_BP: 0, HIGH_BP: 0},
        "testing": {NORMAL_BP: 0, HIGH_BP: 0},
    }

    for in_path in input_paths:
        try:
            df = pd.read_csv(in_path)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] Cannot read {in_path}: {exc}")
            continue

        ppg_col = find_column(df.columns, DEFAULT_PPG_CANDIDATES)
        label_col = find_column(df.columns, DEFAULT_LABEL_CANDIDATES)
        sbp_col = find_column(df.columns, DEFAULT_SBP_CANDIDATES)
        dbp_col = find_column(df.columns, DEFAULT_DBP_CANDIDATES)
        subject_col = find_column(df.columns, DEFAULT_SUBJECT_CANDIDATES)

        if ppg_col is None:
            print(f"[WARN] Missing PPG column in {in_path}")
            continue

        if label_col is None and (sbp_col is None or dbp_col is None):
            print(f"[WARN] Missing label OR SBP/DBP in {in_path}")
            continue

        clean = df.copy()
        clean[ppg_col] = pd.to_numeric(clean[ppg_col], errors="coerce")
        clean = clean.dropna(subset=[ppg_col])

        if label_col is not None:
            clean[label_col] = clean[label_col].astype(str).str.strip().str.lower()

        if sbp_col is not None:
            clean[sbp_col] = pd.to_numeric(clean[sbp_col], errors="coerce")
        if dbp_col is not None:
            clean[dbp_col] = pd.to_numeric(clean[dbp_col], errors="coerce")

        if clean.shape[0] < win_size:
            print(f"[WARN] Too short for one window in {in_path}")
            continue

        ppg_raw = clean[ppg_col].to_numpy(dtype=np.float64)
        try:
            ppg_filt = bandpass_filter(ppg_raw, args.sample_rate, args.lowcut, args.highcut)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] Filter failed for {in_path}: {exc}")
            continue

        if subject_col is not None:
            subj_val = str(clean.iloc[0][subject_col]).strip()
            subject_id = subj_val if subj_val else in_path.stem
        else:
            # Default: use the stem prefix before first underscore to reduce leakage risk.
            subject_id = in_path.stem.split("_")[0]

        subset = deterministic_split(subject_id, args.test_ratio)

        for start in range(0, ppg_filt.shape[0] - win_size + 1, step):
            end = start + win_size
            segment = ppg_filt[start:end]

            if float(np.std(segment)) < args.min_std:
                skipped += 1
                continue

            label: str | None
            if label_col is not None:
                raw_label = str(clean.iloc[start:end][label_col].mode().iloc[0]).strip().lower()
                label = raw_label if raw_label in VALID_LABELS else None
            else:
                sbp = float(np.nanmedian(clean.iloc[start:end][sbp_col]))
                dbp = float(np.nanmedian(clean.iloc[start:end][dbp_col]))
                if math.isnan(sbp) or math.isnan(dbp):
                    skipped += 1
                    continue
                label = label_from_bp(sbp, dbp, args.include_elevated_as_high)

            if label not in VALID_LABELS:
                skipped += 1
                continue

            out_name = f"{in_path.stem}_{start:06d}.csv"
            out_path = output_dir / subset / label / out_name
            export_edge_impulse_csv(out_path, segment, args.sample_rate)

            exported += 1
            by_subset_label[subset][label] += 1

            if args.max_samples > 0 and exported >= args.max_samples:
                break

        if args.max_samples > 0 and exported >= args.max_samples:
            break

    summary = {
        "input_files": len(input_paths),
        "sample_rate_hz": args.sample_rate,
        "window_sec": args.window_sec,
        "overlap": args.overlap,
        "exported_windows": exported,
        "skipped_windows": skipped,
        "distribution": by_subset_label,
    }

    summary_path = output_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("[DONE] Dataset prepared")
    print(json.dumps(summary, indent=2))
    print(f"[DONE] Summary: {summary_path}")


if __name__ == "__main__":
    main()
