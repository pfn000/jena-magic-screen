# Jena live motion telemetry (local)

What lands here: the page (local dev or `scripts/motion-log-server.mjs`) samples Jena's DRAWN pose at a fixed 120 Hz,
decoupled from the render rate (interpolated between rendered frames; frames longer than 25 ms are counted as drops and
their samples flagged), and POSTs a batch every 4 s (`motion-tuning.json` -> `telemetry.batchSec`, 2-5 s) to `/motion-log`.

- `<day>/<stamp>-<n>s120.jtel.gz`: gzip of [float16 per sample: every humanoid bone quaternion (x,y,z,w), hips xyz,
  gaze yaw/pitch] + [uint8 x255 expression/viseme weights] + [uint8 flags: bit0 interpolated, bit1 across a drop].
- `schema.json`: bone and expression order. `../../../data/motion-log/<day>.jsonl`: one summary line per batch
  (timestamps, samples, render fps, drops, interpolated, clips played, per-bone jerk spikes, joint-limit hits, loops).
- Decode / inspect: `python3 scripts/telemetry_tools.py decode <file>`.

Upload (NOT done yet; root decides): `python3 scripts/telemetry_tools.py hf-upload` is a dry run listing what would go
to a PRIVATE Hugging Face dataset (`<user>/jena-motion-telemetry`); `--go` with `HF_TOKEN` set (Saidie's HF account,
token from the vault, never committed) creates the private dataset and uploads the folder.

Volume: ~55 KB/s raw at 120 Hz, ~25-35 KB/s gzipped (~100-140 KB per 4 s batch) while the page is open.
