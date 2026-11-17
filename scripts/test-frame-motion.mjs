// Test of src/lib/frameMotion.js: the picture's own movement between two
// detection passes (the drone shaking), and the tracker following it.
//
//   node scripts/test-frame-motion.mjs

import { greyOf, estimateShift, MOTION_W } from '../src/lib/frameMotion.js'
import { BoxTracker } from '../src/lib/track.js'

let failed = 0
const check = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) failed++ }

const W = MOTION_W, H = 48
// A textured scene (smooth blobs, like a river bank seen from above), larger than the view.
function scene(seed) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const SW = W + 60, SH = H + 60
  const v = new Float32Array(SW * SH)
  for (let k = 0; k < 40; k++) {
    const cx = rnd() * SW, cy = rnd() * SH, r = 3 + rnd() * 9, a = (rnd() - 0.5) * 160
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d < r * 2) v[y * SW + x] += a * Math.exp(-(d * d) / (r * r))
    }
  }
  return { v, SW }
}
// The view at (ox, oy) of the scene, as RGBA, with a brightness change and noise.
function view({ v, SW }, ox, oy, bright = 0, noise = 3, seed = 7) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const out = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // bilinear sample (sub-pixel shifts)
    const sx = x + 30 + ox, sy = y + 30 + oy
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0
    const g = (xx, yy) => v[yy * SW + xx]
    const val = g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy
    const p = 120 + val + bright + (rnd() - 0.5) * 2 * noise
    const i = (y * W + x) * 4
    out[i] = out[i + 1] = out[i + 2] = p; out[i + 3] = 255
  }
  return greyOf(out, W, H)
}

const sc = scene(42)
const base = view(sc, 0, 0)
for (const [dx, dy] of [[0, 0], [3, -5], [-8, 2], [6.5, 4.25], [-10, -10]]) {
  // The camera moved by (-dx, -dy) over the scene: the picture moved by (dx, dy).
  const cur = view(sc, -dx, -dy, 25, 3, 99)
  const s = estimateShift(base, cur, W, H, 10)
  check(s && Math.abs(s.dx - dx) < 0.6 && Math.abs(s.dy - dy) < 0.6,
    `picture moved (${dx}, ${dy}) -> found ${s ? `(${s.dx.toFixed(2)}, ${s.dy.toFixed(2)}) q=${s.quality.toFixed(2)}` : 'null'}`)
}

// Flat water: nothing to lock on to.
const flat = (n) => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < a.length; i += 4) { a[i] = a[i + 1] = a[i + 2] = 100 + ((i * 7919 + n) % 5); a[i + 3] = 255 } return greyOf(a, W, H) }
check(estimateShift(flat(1), flat(2), W, H, 10) === null, 'flat picture: no shift guessed')

// Pure noise (sparkling waves): different every frame, so no clear winner.
const noisy = (seed) => { let s = seed; const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < a.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = a[i + 1] = a[i + 2] = 60 + (s % 120); a[i + 3] = 255 } return greyOf(a, W, H) }
check(estimateShift(noisy(1), noisy(2), W, H, 10) === null, 'unrelated pictures (sparkling water): no shift guessed')

// The tracker keeps its box through a shake bigger than the box when shifted first.
{
  const box = (x, y) => ({ x1: x, y1: y, x2: x + 30, y2: y + 30, score: 0.5, label: 'plastic bottle' })
  const plain = new BoxTracker({ matchIou: 0.25, smoothing: 0.45, maxAgeMs: 600, confirmHits: 2 })
  const comp = new BoxTracker({ matchIou: 0.25, smoothing: 0.45, maxAgeMs: 600, confirmHits: 2 })
  const ids = { plain: new Set(), comp: new Set() }
  // The picture jumps ±60 px (twice the box) every pass, as on a shaking drone.
  const jumps = [0, 60, -60, 50, -40, 60, -60, 0]
  let at = 200
  jumps.forEach((j, i) => {
    at += j
    const t = i * 150
    plain.update([box(at, 200)], t).forEach((b) => ids.plain.add(b.id))
    comp.shift(j, 0)
    comp.update([box(at, 200)], t).forEach((b) => ids.comp.add(b.id))
  })
  check(ids.comp.size === 1, `with the picture's movement: one track through the shaking (ids ${[...ids.comp]})`)
  console.log(`      (without it: ${ids.plain.size} different tracks)`)
}

console.log(failed ? `\n${failed} FAILED` : '\nFRAME MOTION TESTS PASSED')
process.exit(failed ? 1 : 0)
