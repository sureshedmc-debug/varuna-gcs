// Test of the app's drone-to-boat matcher (src/lib/targetMatch.js) on the
// boat simulator's pictures: the drone's top-down crop of each kind of
// plastic against the boat camera's view of all five, side by side.
// Each reference must score highest on its own item, above the boat's
// match threshold (0.55), and every other item below it.
//
//   node scripts/test-target-match.mjs      (needs Python with Pillow: boat-pi/sim_world.py draws the pictures)

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { signature, matchScore } from '../src/lib/targetMatch.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const boatPi = path.join(here, '..', 'boat-pi')
const THRESHOLD = 0.55

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
out = {"refs": {l: img(tm.open_image(w.reference_image(l))) for l in labels}, "cands": []}
for b in w.detections(pose, W, H)["targets"]:
    out["cands"].append({"label": b["label"], "score": b["score"], **img(tm.crop_box(frame, b, W, H))})
print(json.dumps(out))
`

function run() {
  for (const exe of process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']) {
    try {
      return execFileSync(exe, ['-c', PY], { cwd: boatPi, maxBuffer: 64 << 20 }).toString()
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

const fx = JSON.parse(run())
let failed = 0
const cands = fx.cands.map((c) => ({ ...c, sig: signature(toImg(c)) }))
console.log(`${cands.length} items in the boat's view: ${cands.map((c) => c.label).join(', ')}`)
for (const [label, ref] of Object.entries(fx.refs)) {
  const rs = signature(toImg(ref))
  const scored = cands.map((c) => ({ label: c.label, ...matchScore(rs, label, c.sig, c.label, c.score) }))
  const own = scored.find((s) => s.label === label)
  const others = scored.filter((s) => s.label !== label)
  const ok = own && own.score >= THRESHOLD && others.every((s) => s.score < THRESHOLD && s.score < own.score)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${scored.map((s) => `${s.label.split(' ').pop().slice(0, 9)}=${s.score.toFixed(2)}`).join('  ')}`)
}
// Edge cases: no reference image (class + detector only), unknown class, no images at all.
const c0 = cands[0]
const noRef = matchScore(null, c0.label, c0.sig, c0.label, 0.8)
const wrongClass = matchScore(null, 'plastic bag', c0.sig, 'plastic bottle', 0.8)
const check = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) failed++ }
check(noRef.score >= THRESHOLD && !('look' in noRef.parts), `no drone image: same class accepted on class + score (${noRef.score})`)
check(wrongClass.score < THRESHOLD, `no drone image: a different class is refused (${wrongClass.score})`)
check(signature(null) === null && matchScore(null, '', null, '', null).score >= 0, 'no images at all: no crash')
console.log(failed ? `\n${failed} FAILED` : '\nTARGET MATCH TESTS PASSED')
process.exit(failed ? 1 : 0)
