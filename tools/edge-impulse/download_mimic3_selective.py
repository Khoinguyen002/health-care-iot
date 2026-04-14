#!/usr/bin/env python3
"""
Selective downloader for MIMIC-III PPG+ABP records.

Only downloads records that have PPG signal, then extracts PPG and ABP
into CSV format suitable for preprocessor.

Usage (fast demo — ~10 min, ~50 MB, ~800 windows):
    python download_mimic3_selective.py \
        --output-dir data/raw \
        --max-patients 20 \
        --max-seconds-per-record 120 \
        --record-prefix p00 \
        --skip-index-check

Full quality run (~30 min, <500 MB, 2000+ windows):
    python download_mimic3_selective.py \
        --output-dir data/raw \
        --max-patients 50 \
        --max-seconds-per-record 300 \
        --record-prefix p00
"""

from __future__ import annotations

import argparse
import csv
import concurrent.futures
from pathlib import Path
from typing import Optional
from urllib.request import urlopen

import numpy as np

# Try to import wfdb; if not available, provide install instructions
try:
    import wfdb
except ImportError:
    print("ERROR: wfdb not found. Install with:")
    print("  pip install wfdb")
    exit(1)

try:
    from scipy.signal import find_peaks
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False


PHYSIONET_BASE = "https://physionet.org/files/mimic3wdb-matched/1.0"
RECORDS_WAVEFORMS_URL = f"{PHYSIONET_BASE}/RECORDS-waveforms"

# Common PPG signal names in MIMIC-III
PPG_ALIASES = ["PLETH", "Pleth", "pleth", "PPG", "ppg", "IR", "ir"]
# Common ABP signal names -> SBP/DBP
ABP_ALIASES = ["ABP", "Abp", "abp", "ART", "art"]

# Typical MIMIC-III waveform sample rate (Hz). Used to convert --max-seconds.
# wfdb exposes the actual fs per record; this is only for the sampto estimate.
TYPICAL_FS = 125

# Physiological plausibility bounds for ABP (mmHg)
ABP_MIN, ABP_MAX = 20.0, 250.0
# Plausibility bounds for PPG (raw ADC units vary widely; exclude obvious artifacts)
PPG_VALID_RANGE = (-32768 + 1, 32767)  # wfdb stores as int16-range; NaN excluded separately


def fetch_records_index(url: str) -> list[str]:
    """Fetch the RECORDS-waveforms index from PhysioNet."""
    print(f"Fetching index from {url}...")
    try:
        with urlopen(url, timeout=30) as resp:
            content = resp.read().decode("utf-8")
        records = [line.strip() for line in content.split("\n") if line.strip()]
        print(f"Found {len(records)} records total.")
        return records
    except Exception as exc:
        print(f"ERROR fetching records: {exc}")
        return []


def _check_one_record(args: tuple[str, str]) -> tuple[str, bool]:
    """Worker for parallel header scanning. Returns (record_name, has_ppg_and_abp)."""
    record_name, physionet_base = args
    hea_url = f"{physionet_base}/{record_name}.hea"
    try:
        with urlopen(hea_url, timeout=10) as resp:
            hea_content = resp.read().decode("utf-8")
        has_ppg = any(alias in hea_content for alias in PPG_ALIASES)
        has_abp = any(alias in hea_content for alias in ABP_ALIASES)
        return record_name, has_ppg and has_abp
    except Exception:
        return record_name, False


def select_candidate_records(
    records: list[str],
    desired_count: int,
    skip_index_check: bool,
    parallel_workers: int = 8,
) -> list[str]:
    """Return records to try, stopping once enough likely candidates are found."""
    if skip_index_check:
        print(f"Skipping header scan — taking first {desired_count} records as candidates.")
        return records[:desired_count]

    candidates: list[str] = []
    scanned = 0
    batch_size = parallel_workers * 4

    print(f"Scanning headers in parallel (workers={parallel_workers})...")

    with concurrent.futures.ThreadPoolExecutor(max_workers=parallel_workers) as pool:
        # Process in batches so we can stop early once we have enough
        for batch_start in range(0, len(records), batch_size):
            batch = records[batch_start : batch_start + batch_size]
            args_list = [(r, PHYSIONET_BASE) for r in batch]

            for record_name, matched in pool.map(_check_one_record, args_list):
                scanned += 1
                if matched:
                    candidates.append(record_name)
                    print(f"  [MATCH] {record_name} ({len(candidates)}/{desired_count})")

            if len(candidates) >= desired_count:
                break

            if scanned % 200 == 0:
                print(f"  [SCAN] checked {scanned}, found {len(candidates)} matches...")

    print(f"Found {len(candidates)} candidate records after scanning {scanned} records.")
    return candidates


def _estimate_per_beat_bp(abp: np.ndarray, fs: float) -> tuple[float, float]:
    """
    Estimate SBP and DBP from an ABP waveform.

    Uses peak/valley detection when scipy is available; falls back to
    robust percentiles otherwise.  Returns (sbp, dbp) in mmHg.
    """
    # Filter out physiologically implausible values before estimation
    valid = abp[(abp >= ABP_MIN) & (abp <= ABP_MAX)]
    if valid.size < 10:
        return float("nan"), float("nan")

    if HAS_SCIPY:
        # Min inter-beat distance ~300 ms
        min_dist = max(int(fs * 0.30), 1)
        peaks, _ = find_peaks(valid, distance=min_dist, prominence=5)
        valleys, _ = find_peaks(-valid, distance=min_dist, prominence=5)
        if peaks.size >= 3 and valleys.size >= 3:
            sbp = float(np.median(valid[peaks]))
            dbp = float(np.median(valid[valleys]))
            # Sanity check: pulse pressure should be positive
            if sbp > dbp:
                return sbp, dbp

    # Fallback: robust percentiles
    sbp = float(np.percentile(valid, 90))
    dbp = float(np.percentile(valid, 10))
    return sbp, dbp


def extract_ppg_abp_to_csv(
    record_name: str,
    output_csv: Path,
    subject_id: Optional[str] = None,
    max_seconds: float = 0.0,
) -> bool:
    """
    Download record and extract PPG + ABP signals to CSV.

    Parameters
    ----------
    max_seconds : float
        If > 0, only download the first max_seconds of the record.
        This dramatically reduces download size (a 2-hour record → 2 minutes).

    Returns True if successful.
    """
    try:
        record_path = Path(record_name)
        record_base = record_path.name
        pn_dir = f"mimic3wdb-matched/1.0/{record_path.parent.as_posix()}"

        # MIMIC-III ICU records often start with minutes of zeros/NaN while
        # nurses connect sensors. To find real signal we search 10× the desired
        # clean window (capped at 10 min). We trim to max_seconds of CLEAN data
        # after filtering, so the output CSV size stays bounded.
        search_seconds = min(max(max_seconds * 10, 600), 600) if max_seconds > 0 else 0
        sampto = int(search_seconds * TYPICAL_FS) if search_seconds > 0 else None

        # --- Step 1: header-only check (no signal data downloaded) ---
        # MIMIC-III records are almost always multi-segment: the top-level .hea
        # lists sub-segment filenames, not signals. We must read the first real
        # sub-segment header to discover signal names.
        print(f"  Checking {record_name}...", end=" ", flush=True)
        header = wfdb.rdheader(record_base, pn_dir=pn_dir)
        sig_names: list[str] = getattr(header, "sig_name", None) or []

        if not sig_names:
            # Multi-segment layout: iterate sub-segments to find signals
            seg_names = getattr(header, "seg_name", None) or []
            for seg in seg_names:
                if not seg or seg == "~":
                    continue
                try:
                    seg_hdr = wfdb.rdheader(seg, pn_dir=pn_dir)
                    candidate = getattr(seg_hdr, "sig_name", None) or []
                    if candidate:
                        sig_names = candidate
                        break
                except Exception:
                    continue

        if not sig_names:
            print("[SKIP] No signal names found in header")
            return False

        ppg_idx: Optional[int] = None
        abp_idx: Optional[int] = None
        for i, sig_name in enumerate(sig_names):
            if ppg_idx is None and any(alias in sig_name for alias in PPG_ALIASES):
                ppg_idx = i
            if abp_idx is None and any(alias in sig_name for alias in ABP_ALIASES):
                abp_idx = i

        if ppg_idx is None or abp_idx is None:
            print(f"[SKIP] Missing {'PPG' if ppg_idx is None else 'ABP'}")
            return False

        # --- Step 2: download signal data only for matching records ---
        print(f"has PPG+ABP — downloading (search {search_seconds:.0f}s)...", end=" ", flush=True)
        record = wfdb.rdrecord(record_base, pn_dir=pn_dir, sampto=sampto)
        print("OK", flush=True)

        # Re-resolve indices from actual record (may differ if multi-segment)
        ppg_idx = None
        abp_idx = None
        for i, sig_name in enumerate(record.sig_name):
            if ppg_idx is None and any(alias in sig_name for alias in PPG_ALIASES):
                ppg_idx = i
            if abp_idx is None and any(alias in sig_name for alias in ABP_ALIASES):
                abp_idx = i

        if ppg_idx is None or abp_idx is None:
            print(f"  [SKIP] Signal disappeared after full load")
            return False

        ppg_signal = record.p_signal[:, ppg_idx]
        abp_signal = record.p_signal[:, abp_idx]
        fs = float(record.fs)

        # Mask out NaN / physiologically invalid rows
        ppg_nan = np.isnan(ppg_signal)
        abp_nan = np.isnan(abp_signal)
        abp_invalid = (abp_signal < ABP_MIN) | (abp_signal > ABP_MAX)
        bad_rows = ppg_nan | abp_nan | abp_invalid

        ppg_clean = ppg_signal[~bad_rows]
        abp_clean = abp_signal[~bad_rows]

        # Trim to max_seconds of CLEAN data (we searched a wider window above)
        if max_seconds > 0:
            keep = int(max_seconds * fs)
            ppg_clean = ppg_clean[:keep]
            abp_clean = abp_clean[:keep]

        if ppg_clean.size < int(fs * 5):  # need at least 5 seconds of clean data
            print(f"  [SKIP] Too little clean data ({ppg_clean.size} samples)")
            return False

        # Per-beat SBP/DBP estimation from full clean ABP segment
        sbp_est, dbp_est = _estimate_per_beat_bp(abp_clean, fs)

        if np.isnan(sbp_est) or np.isnan(dbp_est):
            print(f"  [SKIP] Could not estimate BP from ABP signal")
            return False

        if sbp_est <= dbp_est:
            print(f"  [SKIP] Implausible BP: SBP={sbp_est:.1f} DBP={dbp_est:.1f}")
            return False

        print(
            f"  BP≈{sbp_est:.0f}/{dbp_est:.0f} mmHg | "
            f"{ppg_clean.size} clean samples ({ppg_clean.size/fs:.0f}s)"
        )

        # Write CSV — per-row SBP/DBP are the record-level estimates
        # (prepare_ppg_bp_dataset.py uses nanmedian over each window, so
        # a consistent per-record value is correct and gives a stable label)
        with open(output_csv, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["ppg", "sbp", "dbp", "subject_id"])
            writer.writeheader()
            sid = subject_id or record_name
            for ppg_val in ppg_clean:
                writer.writerow(
                    {
                        "ppg": round(float(ppg_val), 6),
                        "sbp": round(sbp_est, 2),
                        "dbp": round(dbp_est, 2),
                        "subject_id": sid,
                    }
                )

        print(f"  → {output_csv.name}")
        return True

    except Exception as exc:
        print(f"  [ERROR] {exc}")
        return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Selectively download MIMIC-III PPG+ABP records.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples
--------
Fast demo (~10 min, ~50 MB, ~800 windows):
  python download_mimic3_selective.py \\
      --output-dir data/raw \\
      --max-patients 20 \\
      --max-seconds-per-record 120 \\
      --record-prefix p00 \\
      --skip-index-check

Quality run (~30 min, <500 MB, 2000+ windows):
  python download_mimic3_selective.py \\
      --output-dir data/raw \\
      --max-patients 50 \\
      --max-seconds-per-record 300 \\
      --record-prefix p00
""",
    )
    parser.add_argument("--output-dir", required=True, help="Output directory for CSV files")
    parser.add_argument(
        "--max-patients",
        type=int,
        default=20,
        help="Maximum number of patients to download (default 20)",
    )
    parser.add_argument(
        "--max-seconds-per-record",
        type=float,
        default=120.0,
        help=(
            "Only download the FIRST N seconds of each record (default 120). "
            "This is the most important flag for keeping downloads small. "
            "120s → ~40 windows/patient at 5s windows with 50%% overlap. "
            "Set to 0 to disable (download full record — can be hours of data)."
        ),
    )
    parser.add_argument(
        "--max-gb",
        type=float,
        default=2.0,
        help="Approximate max GB to download (default 2)",
    )
    parser.add_argument(
        "--skip-index-check",
        action="store_true",
        help=(
            "Skip checking each record header for PPG/ABP signals. "
            "Faster start but some records will be skipped during download. "
            "Recommended for --record-prefix p00 (high PPG density)."
        ),
    )
    parser.add_argument(
        "--record-prefix",
        default="p00",
        help=(
            "Restrict to one patient folder prefix (default p00). "
            "p00 has good PPG+ABP coverage. Use 'all' to scan all prefixes."
        ),
    )
    parser.add_argument(
        "--scan-workers",
        type=int,
        default=8,
        help="Parallel workers for header scanning (default 8)",
    )

    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Fetch records index
    records = fetch_records_index(RECORDS_WAVEFORMS_URL)
    if not records:
        print("ERROR: Could not fetch records index.")
        return

    if args.record_prefix and args.record_prefix.lower() != "all":
        prefix = f"{args.record_prefix}/"
        records = [r for r in records if r.startswith(prefix)]
        print(f"Restricted to prefix '{args.record_prefix}': {len(records)} records.")
        if not records:
            print(f"ERROR: No records found for prefix '{args.record_prefix}'.")
            return

    # Scan 10× the target: p00 has ~30% PPG+ABP density so we need a wide pool
    candidate_goal = args.max_patients * 10
    candidates = select_candidate_records(
        records,
        desired_count=candidate_goal,
        skip_index_check=args.skip_index_check,
        parallel_workers=args.scan_workers,
    )

    if not candidates:
        print("ERROR: No suitable records found.")
        return

    max_bytes = int(args.max_gb * 1e9)

    print(f"\nDownloading up to {args.max_patients} patients")
    print(f"  max_seconds_per_record : {args.max_seconds_per_record or 'unlimited'}")
    print(f"  size limit             : {args.max_gb:.1f} GB")
    print()

    downloaded = 0
    total_bytes = 0

    for record_name in candidates:
        if downloaded >= args.max_patients or total_bytes >= max_bytes:
            break

        subject_id = "/".join(record_name.split("/")[:2])  # e.g. "p00/p000001"
        output_csv = output_dir / f"{record_name.replace('/', '_')}.csv"

        if output_csv.exists():
            print(f"  [SKIP] {output_csv.name} already exists")
            downloaded += 1
            continue

        if extract_ppg_abp_to_csv(
            record_name,
            output_csv,
            subject_id=subject_id,
            max_seconds=args.max_seconds_per_record,
        ):
            downloaded += 1
            # Rough size estimate: ~120s × 125 Hz × 2 signals × 4 bytes ≈ 120 KB
            total_bytes += output_csv.stat().st_size if output_csv.exists() else 120_000

    print(f"\n[DONE] Downloaded {downloaded} records to {output_dir}")
    print()
    print("Next step — prepare Edge Impulse dataset:")
    print(
        f"  python prepare_ppg_bp_dataset.py"
        f" --input-glob '{output_dir}/*.csv'"
        f" --output-dir data/ei_dataset"
        f" --sample-rate 125"
        f" --window-sec 5"
        f" --overlap 0.5"
    )


if __name__ == "__main__":
    main()
