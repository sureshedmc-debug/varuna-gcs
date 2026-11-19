// Tests src/lib/boatTarget.js — the app's judgement of what the boat camera
// sees: which boxes are plastic, how far away they are, and which one gets
// locked. No browser needed.
//
//   node scripts/test-boat-target.mjs

import { PlasticLock, boxGround, isPlastic, pixelToGround, plasticClassIds } from '../src/lib/boatTarget.js'

let pass = 0
let fail = 0
const check = (ok, what) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + what)
  ok ? pass++ : fail++
}
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol

// The boat's camera, as boat-pi/config.py has it.
const CFG = { camera_hfov_deg: 66, camera_tilt_deg: 15, camera_height_m: 0.6 }
const W = 640
const H = 360
const box = (o = {}) => ({ x1: 300, y1: 150, x2: 340, y2: 200, score: 0.8, cls: 0, label: 'plastic bottle', hits: 3, id: 1, ...o })

console.log('Which classes may move the boat')
{
  const meta = { names: ['plastic bag', 'OTHERS', 'plastic bottle', 'plastic container'], targetIds: [0, 1, 2, 3] }
  const ids = plasticClassIds(meta)
  check(ids.has(0) && ids.has(2) && ids.has(3), 'bag, bottle and container count as plastic')
  check(!ids.has(1), '"OTHERS" never does')
  check(isPlastic({ cls: 2, label: 'plastic bottle' }, ids, meta.names), 'a bottle box passes')
  check(!isPlastic({ cls: 1, label: 'OTHERS' }, ids, meta.names), 'an OTHERS box is refused')
  check(!isPlastic({ cls: 0, label: 'person' }, ids, meta.names), 'a box labelled person is refused even in a plastic class')
  const single = plasticClassIds({ names: ['plastic'], targetIds: [0] })
  check(single.has(0), 'a single-class "plastic" model still works')
  const odd = plasticClassIds({ names: ['thing-a', 'thing-b'], targetIds: [0, 1] })
  check(odd.has(0) && odd.has(1), 'a model with names we do not recognise falls back to its target classes')
  check(plasticClassIds({ names: ['a', 'b'], targetIds: [0, 1], motorClassIds: [1] }).has(1) === true,
        'the model file can name the classes itself (motor_class_ids)')
}

console.log('Distance on the water')
{
  const horizon = pixelToGround(W / 2, 0, W, H, CFG)
  check(horizon === null || horizon.forward > 30, 'the top of the picture is the horizon (no usable distance)')
  const far = boxGround(box({ y2: 130 }), W, H, CFG)
  const mid = boxGround(box({ y2: 200 }), W, H, CFG)
  const close = boxGround(box({ y2: 270 }), W, H, CFG)
  check(far.forward > mid.forward && mid.forward > close.forward, 'lower in the picture = nearer the boat')
  check(near(close.distance, Math.hypot(close.forward, close.right)), 'distance is forward + sideways together')
  const left = boxGround(box({ x1: 60, x2: 100, y2: 240 }), W, H, CFG)
  const right = boxGround(box({ x1: 540, x2: 580, y2: 240 }), W, H, CFG)
  check(left.right < 0 && right.right > 0, 'left of the picture is to port, right is to starboard')
  check(left.bearing < 0 && right.bearing > 0, 'bearing follows')
  // The boat does this same sum in Python (boat-pi/camera_model.py) to place
  // what the camera sees on the water. These are ITS answers for these pixels:
  // if the two ever disagree, the boat and the app mean different places.
  //   py -c "from camera_model import CameraModel; print(CameraModel(66,15,0.6,640,360).pixel_to_ground(320,240))"
  for (const [x, y, fwd, right] of [
    [320, 240, 1.4894, 0.0],
    [320, 200, 1.9235, 0.0],
    [320, 270, 1.2664, 0.0],
    [100, 240, 1.4894, -0.7116],
    [540, 240, 1.4894, 0.7116],
    [320, 130, 3.7020, 0.0],
  ]) {
    const g = pixelToGround(x, y, 640, 360, CFG)
    check(near(g.forward, fwd, 0.001) && near(g.right, right, 0.001),
          `pixel ${x},${y} -> ${g.forward.toFixed(4)} m ahead, ${g.right.toFixed(4)} m across (the boat says ${fwd}, ${right})`)
  }
}

console.log('One false frame never counts')
{
  const lock = new PlasticLock({ ids: new Set([0]), names: ['plastic'], conf: 0.45, minHits: 2, maxM: 15 })
  check(lock.update([box({ hits: 1, score: 0.5 })], W, H, CFG, 1000) === null, 'seen once, not sure: nothing')
  check(lock.update([box({ hits: 2, score: 0.5 })], W, H, CFG, 1200) !== null, 'seen twice: locked')
}
{
  const lock = new PlasticLock({ ids: new Set([0]), names: ['plastic'], conf: 0.45, minHits: 2, sureScore: 0.8 })
  check(lock.update([box({ hits: 1, score: 0.9 })], W, H, CFG, 1000) !== null, 'one very sure sighting is enough')
}
{
  const lock = new PlasticLock({ ids: new Set([0]), names: ['plastic'], conf: 0.6 })
  check(lock.update([box({ score: 0.45 })], W, H, CFG, 1000) === null, 'under the threshold: nothing')
}
{
  const lock = new PlasticLock({ ids: new Set([0, 1]), names: ['plastic', 'OTHERS'] })
  check(lock.update([box({ cls: 1, label: 'OTHERS' })], W, H, CFG, 1000) === null, 'OTHERS never locks')
  check(lock.update([box({ label: 'person', cls: 0 })], W, H, CFG, 1100) === null, 'a person never locks')
}

console.log('The lock stays on its item')
{
  const lock = new PlasticLock({ ids: new Set([0]), names: ['plastic'], lostMs: 1200 })
  const a = lock.update([box({ id: 1, y2: 200 })], W, H, CFG, 1000)
  check(a.id === '1', 'locked onto item 1')
  // A different box scores higher for one pass.
  const b = lock.update([box({ id: 1, y2: 210 }), box({ id: 2, x1: 100, x2: 140, y2: 210, score: 0.99 })], W, H, CFG, 1200)
  check(b.id === '1', 'a better-scoring neighbour does not steal the lock')
  // It blinks out for a few frames (spray, glare).
  const c = lock.update([], W, H, CFG, 1600)
  check(c && c.id === '1' && c.confirmed, 'out of sight briefly: the lock holds')
  check(c.visible === false, '…and the boat is told it is not visible right now')
  const d = lock.update([], W, H, CFG, 3000)
  check(d === null, 'gone too long: the lock is dropped')
  const e = lock.update([box({ id: 2, x1: 100, x2: 140, y2: 210 })], W, H, CFG, 3200)
  check(e.id === '2', 'then the next item may be locked')
}

console.log('Closing in')
{
  const lock = new PlasticLock({ ids: new Set([0]), names: ['plastic'], smooth: 1 })
  let v = lock.update([box({ y2: 150 })], W, H, CFG, 1000)
  const first = v.distance_m
  for (let i = 1; i <= 5; i++) v = lock.update([box({ y2: 150 + i * 20 })], W, H, CFG, 1000 + i * 160)
  check(v.distance_m < first, `distance falls as it comes closer (${first} m -> ${v.distance_m} m)`)
  check(v.closing === true, 'the boat is told it is closing')
  check(v.held_ms >= 800, 'how long it has been held is reported')
}

console.log('In front of the boat')
{
  const lock = new PlasticLock({ ids: new Set([0]), names: ['plastic'], centreFrac: 0.35 })
  const ahead = lock.update([box({ x1: 300, x2: 340, y2: 260 })], W, H, CFG, 1000)
  check(ahead.centred === true, 'dead ahead: in the boat\'s path')
  lock.clear()
  const aside = lock.update([box({ x1: 10, x2: 50, y2: 260 })], W, H, CFG, 2000)
  check(aside.centred === false, 'far off to the side: not in its path')
}

console.log('After a collection')
{
  const lock = new PlasticLock({ ids: new Set([0]), names: ['plastic'] })
  lock.update([box()], W, H, CFG, 1000)
  lock.clear(2000, 1000)
  check(lock.update([box()], W, H, CFG, 1500) === null, 'nothing is picked up during the cool-down')
  check(lock.update([box()], W, H, CFG, 3100) !== null, 'then the next item is')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
