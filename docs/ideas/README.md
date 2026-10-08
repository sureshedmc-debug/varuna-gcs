# Daily ideas log

One brief per day from the scheduled research run. Each brief is grounded in the
code as it stood that day, so an older brief may describe something since fixed.

**Future runs: read this ledger first and propose genuinely new ideas.** Mark an
idea `done` when it lands so it isn't re-suggested, and `dropped` (with the
reason) when it's been considered and rejected.

| Date | Brief | Headline |
| --- | --- | --- |
| 2026-10-08 | [2026-10-08.md](2026-10-08.md) | TACO-trained model is the wrong domain (mAP@50 = 0.29); count tracks not frames; per-class thresholds; report flux (items/h, kg/day) |

## Ledger

Status of every idea raised so far.

### 2026-10-08

| # | Idea | Status |
| --- | --- | --- |
| 1 | Retrain on river-surface data (RiSID + FloW) alongside TACO | open |
| 2 | Count/log/alert only on tracks confirmed over ≥3 frames | open |
| 3 | Per-class confidence thresholds in the JSON sidecar | open |
| 4 | Use the already-loaded COCO pass as a verifier (bottle boost, non-trash suppression) | open |
| 5 | Drift-coherence features from track velocity | open |
| 6 | Seed the learner with a sun-glint prior | open |
| 7 | Flip-TTA on the tile pass, inside the existing budget branch | open |
| 8 | Reject off-water detections using the OSM water polygon | open |
| 9 | Flux mode: items/hour and kg/day, width-normalized | open |
| 10 | Count items crossing a transect line, once each | open |
