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
// Harder, like the real cameras: the drone's picture is darker and warmer
// (a different camera / light), and the AI only says "plastic" for every item,
// so the look alone has to pick the right one.
const SAME_COLOUR = { 'plastic bottle': 'plastic bag', 'plastic bag': 'plastic bottle' }
const shift = ({ w, h, rgb }, gain, tint) => ({
  w, h, rgb: rgb.map((v, i) => Math.max(0, Math.min(255, Math.round(v * gain * tint[i % 3])))),
})
for (const [name, gain, tint] of [['darker + warmer', 0.65, [1.15, 1, 0.8]], ['brighter + cooler', 1.3, [0.85, 1, 1.2]]]) {
  let worst = Infinity
  for (const [label, ref] of Object.entries(fx.refs)) {
    const rs = signature(toImg(shift(ref, gain, tint)))
    const scored = cands.map((c) => ({ label: c.label, ...matchScore(rs, 'plastic', c.sig, 'plastic', c.score) }))
    const own = scored.find((s) => s.label === label)
    // The simulator's bottle and bag are the same white: with no class name
    // and different viewpoints, colour can't separate them (the class can).
    const twin = SAME_COLOUR[label]
    const best = Math.max(...scored.filter((s) => s.label !== label && s.label !== twin).map((s) => s.score))
    const ok = own.score >= best + 0.15 && best < THRESHOLD
    worst = Math.min(worst, own.score - best)
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}, class unknown: ${label.padEnd(18)} own=${own.score.toFixed(2)} best different-colour item=${best.toFixed(2)}`)
  }
  console.log(`      worst margin (${name}): ${worst.toFixed(2)}`)
}
// Plastic bottles, as the real cameras see them.
// The drone model's catch-all class is "OTHERS": it must not count as a
// different kind from the boat's "plastic bottle" (it used to cost 25 %).
{
  const ref = fx.refs['plastic bottle']
  const rs = signature(toImg(ref))
  const scored = cands.map((c) => ({ label: c.label, ...matchScore(rs, 'OTHERS', c.sig, c.label, c.score) }))
  const own = scored.find((s) => s.label === 'plastic bottle')
  const best = Math.max(...scored.filter((s) => s.label !== 'plastic bottle').map((s) => s.score))
  const ok = own.score >= THRESHOLD && own.score >= best + 0.15
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  bottle, drone says OTHERS: own=${own.score.toFixed(2)} best other item=${best.toFixed(2)}`)
}
// The same bottle lying the other way in the boat's view (turned 90 deg): still a match.
const turn = ({ w, h, rgb }) => {
  const out = new Array(rgb.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 3, d = (x * h + (h - 1 - y)) * 3
    out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2]
  }
  return { w: h, h: w, rgb: out }
}
{
  const rs = signature(toImg(fx.refs['plastic bottle']))
  const b = fx.cands.find((c) => c.label === 'plastic bottle')
  const turned = matchScore(rs, 'plastic bottle', signature(toImg(turn(b))), b.label, b.score)
  const ok = turned.score >= THRESHOLD
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  bottle turned 90 deg in the boat's view: ${turned.score.toFixed(2)}`)
  const rsElong = rs.elong, cElong = signature(toImg(b)).elong
  check0(rsElong >= 1.7 && cElong >= 1.6, `a bottle reads long and thin from both cameras (drone ${rsElong.toFixed(1)}:1, boat ${cElong.toFixed(1)}:1)`)
}
function check0(cond, what) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) failed++ }
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
