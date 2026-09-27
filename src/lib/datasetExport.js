// Turn what the app auto-labelled into a real YOLO dataset.
//
// selfLearn.js decides what is trash and what isn't; this file packages that
// decision as something ultralytics can train on:
//
//   images/{train,val}/<id>.jpg   the CLEAN frame — no boxes drawn on it
//   labels/{train,val}/<id>.txt   "0 cx cy w h", normalised, one line per box
//                                 (an EMPTY file for a negative, which is how
//                                 YOLO is taught that a frame is background)
//   data.yaml, train.py, README.txt, manifest.json
//
// Negatives matter as much as positives here. A background image containing
// the thing the model keeps mistaking for trash is the single most effective
// way to stop it doing that — far more so than raising a threshold, which
// only trades false alarms for missed detections.

import { createZip, dataUrlToBytes } from './zip'
import { getSamples, markTrained } from './selfLearn'
import { getCleanFrame } from './photoStore'

const VAL_FRACTION = 0.2
// The archive is assembled in memory, so an unbounded export would try to hold
// every stored frame at once — thousands of JPEGs is enough to take the tab
// down. Newest frames win; the rest stay on disk for the next export.
const MAX_FRAMES_PER_EXPORT = 2000

// Deterministic split, so re-exporting doesn't shuffle images between train
// and val and quietly leak validation data into training.
function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

function stamp() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * Collect every sample that has a usable training image.
 * @param {object} opts
 * @param {boolean} opts.onlyNew  skip rows already marked trained
 */
export async function collectTrainingSet({ onlyNew = false, limit = MAX_FRAMES_PER_EXPORT } = {}) {
  const samples = await getSamples()
  // Newest first while selecting, so a capped export takes the most recent
  // footage rather than an arbitrary slice.
  samples.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  const out = []
  for (const s of samples) {
    if (out.length >= limit) break
    if (onlyNew && s.trained) continue
    // The clean frame lives under the sample's own id, or — for an operator
    // verdict on an existing sighting — under that sighting's id.
    const img = (await getCleanFrame(s.id)) || (s.sightingId ? await getCleanFrame(s.sightingId) : null)
    if (!img) continue
    out.push({ ...s, image: img })
  }
  out.reverse() // back to chronological order
  return out
}

/** Counts for the UI, without building the archive. */
export async function trainingSetStats() {
  const samples = await getSamples()
  let withFrame = 0
  let positive = 0
  let negative = 0
  let untrained = 0
  for (const s of samples) {
    if (s.hasFrame || s.sightingId) withFrame++
    if (s.verdict === 'positive') positive++
    else negative++
    if (!s.trained) untrained++
  }
  return { total: samples.length, withFrame, positive, negative, untrained }
}

/**
 * Build the dataset ZIP.
 * @returns {Promise<{blob: Blob, filename: string, counts: object, ids: string[]}>}
 */
export async function buildDatasetZip({ onlyNew = false, baseWeights = 'yolo11n.pt', epochs = 80 } = {}) {
  const rows = await collectTrainingSet({ onlyNew })
  if (!rows.length) throw new Error('No auto-labelled frames yet — fly a detection run first.')

  const files = []
  const counts = { train: 0, val: 0, positive: 0, negative: 0, boxes: 0 }
  const ids = []
  const manifest = []

  for (const s of rows) {
    const split = hash(s.id) < VAL_FRACTION ? 'val' : 'train'
    const name = s.id.replace(/[^\w-]/g, '_')
    let bytes
    try {
      bytes = dataUrlToBytes(s.image)
    } catch {
      continue
    }
    if (!bytes.length) continue

    const boxes = s.verdict === 'positive' ? s.boxes || [] : []
    const label = boxes
      .map((b) => {
        const cx = (b.x1 + b.x2) / 2
        const cy = (b.y1 + b.y2) / 2
        const w = Math.abs(b.x2 - b.x1)
        const h = Math.abs(b.y2 - b.y1)
        return `0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`
      })
      .join('\n')

    // A positive with no boxes carries no information either way — skip it
    // rather than export it as a background frame that contains trash.
    if (s.verdict === 'positive' && !boxes.length) continue

    files.push({ name: `images/${split}/${name}.jpg`, data: bytes })
    files.push({ name: `labels/${split}/${name}.txt`, data: label ? `${label}\n` : '' })
    counts[split]++
    counts[s.verdict]++
    counts.boxes += boxes.length
    ids.push(s.id)
    manifest.push({ id: s.id, split, verdict: s.verdict, reason: s.reason, boxes: boxes.length, ts: s.ts, lat: s.lat, lng: s.lng })
  }

  if (!counts.train) throw new Error('Not enough labelled frames to build a training split yet.')

  files.push({ name: 'data.yaml', data: DATA_YAML })
  files.push({ name: 'train.py', data: trainScript({ baseWeights, epochs }) })
  files.push({ name: 'README.txt', data: readme(counts) })
  files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 1) })

  return { blob: createZip(files), filename: `varuna-trash-dataset-${stamp()}.zip`, counts, ids }
}

/** Build, download, and mark the included rows as trained. */
export async function exportDataset(opts = {}) {
  const { blob, filename, counts, ids } = await buildDatasetZip(opts)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  if (opts.markUsed !== false) await markTrained(ids)
  return { filename, counts, bytes: blob.size }
}

const DATA_YAML = `# VARUNA auto-labelled trash dataset
# Generated by the app from its own flight footage. Labels come from temporal
# consistency and cross-model disagreement, not from a human annotator — see
# manifest.json for the reason recorded against each frame.
path: .
train: images/train
val: images/val

names:
  0: Trash
`

function trainScript({ baseWeights, epochs }) {
  return `"""Fine-tune the VARUNA trash detector on auto-labelled flight footage.

    pip install ultralytics onnx onnxruntime
    python train.py

Starts from the current weights rather than from scratch: this dataset is
small and domain-specific, so it should nudge an existing model toward your
river, camera and altitude — not try to teach detection from nothing.

The result is runs/varuna/weights/best.onnx. Copy it over
public/models/trash.onnx (keep a backup of the old one) and restart the app,
or load it from System -> Self-learning -> Load model file.
"""

from pathlib import Path
from ultralytics import YOLO

HERE = Path(__file__).parent
BASE = "${baseWeights}"          # existing weights to fine-tune from
EPOCHS = ${epochs}
IMGSZ = 640                      # must match the app's detector input size

def main():
    model = YOLO(BASE)
    model.train(
        data=str(HERE / "data.yaml"),
        epochs=EPOCHS,
        imgsz=IMGSZ,
        project=str(HERE / "runs"),
        name="varuna",
        exist_ok=True,
        # A small, self-labelled set overfits easily. Low LR, heavy
        # augmentation, and early stopping keep the pretrained features.
        lr0=0.001,
        patience=20,
        degrees=10.0,
        translate=0.1,
        scale=0.5,
        fliplr=0.5,
        mosaic=1.0,
    )

    metrics = model.val()
    print("mAP50:", metrics.box.map50, " mAP50-95:", metrics.box.map)

    out = model.export(format="onnx", imgsz=IMGSZ, opset=12, simplify=True)
    print("Exported:", out)
    print("Copy it to public/models/trash.onnx (back up the old one first).")

if __name__ == "__main__":
    main()
`
}

function readme(c) {
  return `VARUNA — auto-labelled trash dataset
====================================

${c.train} training frames, ${c.val} validation frames.
${c.positive} positive (${c.boxes} boxes), ${c.negative} negative (background).

Nobody labelled these by hand. Each frame was classified by the app itself:

  persisted       a tracked box survived long enough, at high enough
                  confidence, to be trusted as a real object  -> POSITIVE
  flicker         a box appeared and died within a few frames -> NEGATIVE
  person-overlap  the trash model fired on something the person/face model
                  called a human                              -> NEGATIVE
  operator        someone marked the detection in the app     -> either

Negative frames have an EMPTY label file on purpose. That is how YOLO learns
a scene is background, and it is the most effective fix for the false
positives these frames were captured from.

To train:

    pip install ultralytics onnx onnxruntime
    python train.py

Then copy runs/varuna/weights/best.onnx over public/models/trash.onnx, or
load it from System -> Self-learning in the app. Keep the previous model —
if mAP50 on the validation split is not better than the old one, don't ship it.
`
}
