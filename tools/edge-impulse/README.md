# Edge Impulse BP-PPG Pipeline

This folder contains a practical pipeline for:
1. Preparing PPG/BP data from public datasets.
2. Converting windows into Edge Impulse CSV samples.
3. Uploading and training a binary classifier: `normal_bp` vs `high_bp`.

## 1) Recommended dataset sources (high trust)

- PhysioNet MIMIC-III Waveform Database Matched Subset (PPG + ABP) — **Recommended (use selective downloader)**
- PhysioNet MIMIC-IV Waveform Database — larger, similar approach
- UCI cuff-less BP datasets (as auxiliary) — use only after main model is stable

Recommendation for best reliability:
- Use PhysioNet as main source.
- Use patient-level split to avoid data leakage.
- **Download selectively** — the full MIMIC-III dataset is 2.4 TB; use the provided downloader to fetch only PPG+ABP records (~5–20 GB pilot).

## 2) Expected raw CSV schema

The script supports flexible columns, but each CSV must include:

- `ppg` (or `pleth`, `ir`, `signal`, `ppg_value`)
- and either:
  - `sbp` + `dbp` (or equivalent aliases), or
  - `label` column with values `normal_bp` / `high_bp`

Optional:
- `subject_id` (or `subject`, `patient_id`, `pid`) for robust subject-level splitting.

## 3) Download PPG+ABP from MIMIC-III (Optional but recommended for quick start)

If you don't already have PPG + BP data, use this downloader to fetch a pilot dataset from PhysioNet MIMIC-III. It will:
- Identify records with both PPG and ABP signals
- Download only those records (not the full 2.4 TB)
- Extract PPG and ABP into CSV format

```bash
pip install wfdb  # Required for reading MIMIC-III waveform files

python download_mimic3_selective.py \
  --output-dir ../../data/raw \
  --record-prefix p00 \
  --max-patients 5 \
  --max-gb 1
```

This demo mode uses the small `p00` folder only, so it starts much faster and is better for a first sanity check. Increase `--max-patients` later if that subset looks good.

## 4) Install

```bash
cd tools/edge-impulse
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 5) Prepare dataset windows

Example command:

```bash
python prepare_ppg_bp_dataset.py \
  --input-glob "../../data/raw/*.csv" \
  --output-dir "../../data/ei-bp-ppg" \
  --sample-rate 100 \
  --window-sec 5 \
  --overlap 0.5 \
  --lowcut 0.5 \
  --highcut 8 \
  --test-ratio 0.2
```

Output structure:

```text
data/ei-bp-ppg/
  training/
    normal_bp/
    high_bp/
  testing/
    normal_bp/
    high_bp/
  summary.json
```

Notes:
- Label rule from BP (ACC/AHA style used in script):
  - `normal_bp`: SBP < 120 and DBP < 80
  - `high_bp`: SBP >= 130 or DBP >= 80
  - Elevated (120-129 and <80) is dropped by default; add `--include-elevated-as-high` to keep it.
- Signal processing:
  - Bandpass filter 0.5-8 Hz
  - Windowing 5s with overlap
  - Remove flat segments by std threshold

## 6) Upload to Edge Impulse (CLI)

Install uploader:

```bash
npm i -g edge-impulse-cli
```

Login/configure once:

```bash
edge-impulse-uploader --clean
```

Upload training:

```bash
find ../../data/ei-bp-ppg/training -name "*.csv" -print0 | \
  xargs -0 edge-impulse-uploader --category training
```

Upload testing:

```bash
find ../../data/ei-bp-ppg/testing -name "*.csv" -print0 | \
  xargs -0 edge-impulse-uploader --category testing
```

Edge Impulse docs notes used:
- CLI uploader supports `--category training|testing|split`.
- Labels can be inferred from filenames/folders or overridden with `--label`.

## 7) Training setup in Edge Impulse Studio

Project: `BP-PPG-Nhom13`

Recommended impulse for this project:
- Input: Time series, window size = 5000 ms
- Processing block: Spectral Analysis (or Raw Data for baseline comparison)
- Learning block: Classification (2 classes)

Training checklist:
- Ensure class balance in Data Acquisition panel.
- Train and capture:
  - Training metrics
  - Confusion Matrix
  - Sensitivity (high_bp recall)
  - Specificity (normal_bp recall)

## 8) Practical tips to increase success rate

- Keep subject-level split (not random window-level split).
- Use balanced class counts.
- Exclude low-quality/noisy windows.
- Compare Spectral Analysis vs Raw Data and keep better model.
- Validate with real ESP32/MAX30102 capture before final report.

## 9) Medical disclaimer for report/demo

This is an educational prototype and not a medical diagnostic device.
Performance depends on dataset quality, motion artifacts, skin tone, and sensor conditions.
Clinical validation is required for medical use.
