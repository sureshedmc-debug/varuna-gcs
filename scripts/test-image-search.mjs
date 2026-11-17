// Test of the boat camera's model-free search (src/lib/imageSearch.js) on the
// boat simulator's picture: five kinds of plastic on the water, no AI model.
// For each drone photo, the search must find its item in the boat's picture,
// score it highest and above the boat's match threshold (0.55), and score
// every other item below it.
//
//   node scripts/test-image-search.mjs      (needs Python with Pillow: boat-pi/sim_world.py draws the pictures)

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { signature, SIG } from '../src/lib/targetMatch.js'
import { findCandidates, imageMatch } from '../src/lib/imageSearch.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const boatPi = path.join(here, '..', 'boat-pi')
const THRESHOLD = 0.55
const GRID_W = 160

const PY = `
import json, sys, types
sys.path.insert(0, '.')
from config import load_config
from sim_world import SimWorld
from camera_model import to_world
import target_match as tm
cfg = load_config()
boat = types.SimpleNamespace(lat=17.4239, lng=78.4738, heading=0.0, rate=1)
w = SimWorld(boat, cfg)
labels = ["plastic bottle", "plastic bag", "plastic cup", "plastic container", "other plastic"]
for i, l in enumerate(labels):
    lat, lng = to_world(boat.lat, boat.lng, 0, 6.0, -2.4 + 1.2 * i)
    w.place(lat, lng, l)
W, H = cfg["camera_width"], cfg["camera_height"]
pose = (boat.lat, boat.lng, 0.0)
frame = tm.open_image(w.render(pose, W, H))
img = lambda im: {"w": im.width, "h": im.height, "rgb": list(im.tobytes())}
truth = [{"label": b["label"], "x1": b["x1"], "y1": b["y1"], "x2": b["x2"], "y2": b["y2"]}
         for b in w.detections(pose, W, H)["targets"]]
print(json.dumps({"refs": {l: img(tm.open_image(w.reference_image(l))) for l in labels},
                  "frame": img(frame), "truth": truth, "ramp_top": cfg["ramp_top"]}))
`

function run() {
  for (const exe of process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']) {
    try {
      return execFileSync(exe, ['-c', PY], { cwd: boatPi, maxBuffer: 256 << 20 }).toString()
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
  throw new Error('Python not found')
}

const toImg = ({ w, h, rgb }) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    data[j] = rgb[i]; data[j + 1] = rgb[i + 1]; data[j + 2] = rgb[i + 2]; data[j + 3] = 255
  }
  return { data, width: w, height: h }
}

/** Box-average resize (as a canvas drawImage does). */
function resize(img, w, h) {
  const out = new Uint8ClampedArray(w * h * 4)
  const sx = img.width / w, sy = img.height / h
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.floor((x + 1) * sx))
      const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.floor((y + 1) * sy))
      const acc = [0, 0, 0]
      let n = 0
      for (let yy = ya; yy < yb && yy < img.height; yy++) {
        for (let xx = xa; xx < xb && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4
          acc[0] += img.data[i]; acc[1] += img.data[i + 1]; acc[2] += img.data[i + 2]; n++
        }
      }
      const o = (y * w + x) * 4
      out[o] = acc[0] / n; out[o + 1] = acc[1] / n; out[o + 2] = acc[2] / n; out[o + 3] = 255
    }
  }
  return { data: out, width: w, height: h }
}

function cropOf(img, b) {
  const bw = b.x2 - b.x1, bh = b.y2 - b.y1
  const x1 = Math.max(0, Math.floor(b.x1 - 0.35 * bw)), y1 = Math.max(0, Math.floor(b.y1 - 0.35 * bh))
  const x2 = Math.min(img.width, Math.ceil(b.x2 + 0.35 * bw)), y2 = Math.min(img.height, Math.ceil(b.y2 + 0.35 * bh))
  const w = x2 - x1, h = y2 - y1
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y1 + y) * img.width + x1) * 4, ((y1 + y) * img.width + x2) * 4), y * w * 4)
  return resize({ data, width: w, height: h }, SIG, SIG)
}

const fx = JSON.parse(run())
const frame = toImg(fx.frame)
const W = frame.width, H = frame.height
const gh = Math.round((H * GRID_W) / W)
const grid = resize(frame, GRID_W, gh)
const k = W / GRID_W
const rampRow = Math.floor(fx.ramp_top * gh)
const overlap = (a, b) => {
  const iw = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), ih = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  return (iw * ih) / Math.min((a.x2 - a.x1) * (a.y2 - a.y1), (b.x2 - b.x1) * (b.y2 - b.y1))
}
let failed = 0
const check = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) failed++ }

const t0 = performance.now()
const found = findCandidates(grid, null, { y1: rampRow }).map((b) => ({ x1: b.x1 * k, y1: b.y1 * k, x2: b.x2 * k, y2: b.y2 * k }))
const ms = performance.now() - t0
const named = found.map((b) => ({ ...b, label: (fx.truth.find((t) => overlap(t, b) > 0.3) || {}).label || 'nothing' }))
console.log(`${found.length} things stand out from the water (${ms.toFixed(1)} ms): ${named.map((b) => b.label).join(', ')}`)
check(fx.truth.every((t) => named.some((b) => b.label === t.label)), 'every item is found without a model')

for (const [label, ref] of Object.entries(fx.refs)) {
  const rs = signature(toImg(ref), { raw: true })
  const cands = findCandidates(grid, rs, { y1: rampRow })
    .map((b) => ({ x1: b.x1 * k, y1: b.y1 * k, x2: b.x2 * k, y2: b.y2 * k }))
    .map((b) => ({ ...b, label: (fx.truth.find((t) => overlap(t, b) > 0.3) || {}).label || 'nothing', score: imageMatch(rs, signature(cropOf(frame, b), { raw: true })) }))
  const own = cands.filter((c) => c.label === label).sort((a, b) => b.score - a.score)[0]
  const others = cands.filter((c) => c.label !== label)
  const ok = own && own.score >= THRESHOLD && others.every((c) => c.score < THRESHOLD && c.score < own.score)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${cands.map((c) => `${c.label.split(' ').pop().slice(0, 9)}=${c.score.toFixed(2)}`).join('  ')}`)
}
check(imageMatch(null, null) === null, 'no drone photo: nothing is scored')
console.log(failed ? `\n${failed} FAILED` : '\nIMAGE SEARCH TESTS PASSED')
process.exit(failed ? 1 : 0)
