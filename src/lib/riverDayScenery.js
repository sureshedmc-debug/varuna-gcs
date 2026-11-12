import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Daylight scenery for the Home loop ('day' mood only; the night intro keeps its
// silhouettes). Trees are built the way games do it: a bark trunk with limbs,
// and crowns of many alpha-cut leaf cards, lit with crown-shaped normals and
// darkened inside and underneath so they read as volume, swaying in the wind.
// Plus grass-and-mud bank colouring, grass tufts along the water, and a
// forested hill line fading into the haze.

const V3 = THREE.Vector3
const S = 2 // texture detail scale (2 = sharp at 4K)
const clamp01 = (v) => Math.min(1, Math.max(0, v))

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d'), w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 16
  return t
}

function leafShape(x, len, wid) {
  x.beginPath()
  x.moveTo(-len, 0)
  x.quadraticCurveTo(0, -wid, len, 0)
  x.quadraticCurveTo(0, wid, -len, 0)
  x.fill()
}

// A clump of broad leaves (mango / neem / peepal-like) with a few twigs.
const leafClumpTex = (rnd) =>
  canvasTex(512 * S, 512 * S, (x, w) => {
    const c = w / 2
    x.strokeStyle = 'rgba(70,52,34,0.9)'
    x.lineCap = 'round'
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2
      x.lineWidth = (2 + rnd() * 2) * S
      x.beginPath()
      x.moveTo(c, c)
      x.quadraticCurveTo(c + Math.cos(a + 0.4) * w * 0.2, c + Math.sin(a + 0.4) * w * 0.2, c + Math.cos(a) * w * 0.38, c + Math.sin(a) * w * 0.38)
      x.stroke()
    }
    const leaves = []
    for (let i = 0; i < 1100; i++) {
      const a = rnd() * Math.PI * 2
      const r = Math.pow(rnd(), 0.6) * w * 0.47
      leaves.push({ px: c + Math.cos(a) * r, py: c + Math.sin(a) * r * 0.9, r: r / (w * 0.47) })
    }
    // inner (shadowed) leaves first, outer sunlit ones on top
    leaves.sort((p, q) => p.r - q.r)
    for (const L of leaves) {
      const top = 1 - L.py / w // upper leaves catch more sky
      const light = (0.45 + rnd() * 0.4) * (0.6 + 0.4 * top) * (0.75 + 0.25 * L.r)
      const hue = 78 + rnd() * 40
      const sat = 32 + rnd() * 30
      x.fillStyle = `hsl(${hue.toFixed(0)},${sat.toFixed(0)}%,${(9 + light * 34).toFixed(1)}%)`
      const len = (9 + rnd() * 12) * S
      x.save()
      x.translate(L.px, L.py)
      x.rotate(rnd() * Math.PI * 2)
      leafShape(x, len, len * (0.75 + rnd() * 0.3))
      if (rnd() < 0.35) {
        x.strokeStyle = 'rgba(225,240,190,0.22)'
        x.lineWidth = S
        x.beginPath()
        x.moveTo(-len * 0.8, 0)
        x.lineTo(len * 0.8, 0)
        x.stroke()
      }
      x.restore()
    }
  })

// A conifer branch, trunk end on the left, drooping needles to the tip on the right.
const needleTex = (rnd) =>
  canvasTex(512 * S, 256 * S, (x, w, h) => {
    const cy = h * 0.42
    const at = (t) => [t * w, cy + t * t * h * 0.16]
    x.lineCap = 'round'
    for (let k = 0; k < 2; k++)
      for (let i = 0; i < 520; i++) {
        const t = rnd()
        const [bx, by] = at(t)
        const span = (1 - t * 0.75) * h * 0.36
        const side = rnd() < 0.5 ? -1 : 1
        const ang = side * (0.6 + rnd() * 0.7) + 0.35
        const len = span * (0.35 + rnd() * 0.65)
        const l = 10 + rnd() * 16 + k * 8
        x.strokeStyle = `hsl(${(135 + rnd() * 25).toFixed(0)},${(28 + rnd() * 18).toFixed(0)}%,${l.toFixed(0)}%)`
        x.lineWidth = (1.4 + rnd() * 1.4) * S
        x.beginPath()
        x.moveTo(bx, by)
        x.lineTo(bx + Math.cos(ang) * len * 0.5, by + Math.sin(ang) * len)
        x.stroke()
      }
    x.strokeStyle = 'rgba(60,44,30,1)'
    x.lineWidth = 5 * S
    x.beginPath()
    for (let t = 0; t <= 1.001; t += 0.05) {
      const [bx, by] = at(t)
      t === 0 ? x.moveTo(bx, by) : x.lineTo(bx, by)
    }
    x.stroke()
  })

// Grass blades rising from the bottom edge.
const grassTex = (rnd) =>
  canvasTex(256 * S, 256 * S, (x, w, h) => {
    for (let i = 0; i < 90; i++) {
      const bx = w * (0.08 + rnd() * 0.84)
      const bh = h * (0.35 + rnd() * 0.62)
      const lean = (rnd() - 0.5) * w * 0.35
      const bw = (2 + rnd() * 4) * S
      x.fillStyle = `hsl(${(70 + rnd() * 35).toFixed(0)},${(35 + rnd() * 25).toFixed(0)}%,${(16 + rnd() * 26).toFixed(0)}%)`
      x.beginPath()
      x.moveTo(bx - bw, h)
      x.quadraticCurveTo(bx + lean * 0.3, h - bh * 0.6, bx + lean, h - bh)
      x.quadraticCurveTo(bx + lean * 0.3 + bw * 0.4, h - bh * 0.6, bx + bw, h)
      x.fill()
    }
  })

// Near-white ground detail (the vertex colours give it its mud / grass hue).
const groundTex = (rnd) => {
  const t = canvasTex(512 * S, 512 * S, (x, w) => {
    x.fillStyle = 'rgb(236,236,236)'
    x.fillRect(0, 0, w, w)
    for (let i = 0; i < 9000 * S * S; i++) {
      const v = 150 + rnd() * 105
      x.fillStyle = `rgba(${v | 0},${v | 0},${(v * 0.95) | 0},${(0.25 + rnd() * 0.5).toFixed(2)})`
      const px = rnd() * w
      const py = rnd() * w
      if (rnd() < 0.6) x.fillRect(px, py, 1 + rnd() * 3, 1 + rnd() * 3)
      else {
        x.strokeStyle = x.fillStyle
        x.lineWidth = 1
        x.beginPath()
        x.moveTo(px, py)
        x.lineTo(px + (rnd() - 0.5) * 4, py - 3 - rnd() * 6)
        x.stroke()
      }
    }
  })
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

// --- geometry helpers --------------------------------------------------------

class Cards {
  constructor() {
    this.pos = []
    this.nrm = []
    this.uv = []
    this.col = []
    this.idx = []
  }
  /** a quad around c spanned by half-extents u, v; aoA at the -u edge, aoB at the +u edge */
  quad(c, u, v, n, aoA, aoB = aoA) {
    const b = this.pos.length / 3
    const corners = [
      [-1, -1, 0, 0, aoA],
      [1, -1, 1, 0, aoB],
      [1, 1, 1, 1, aoB],
      [-1, 1, 0, 1, aoA],
    ]
    for (const [su, sv, tu, tv, ao] of corners) {
      this.pos.push(c.x + u.x * su + v.x * sv, c.y + u.y * su + v.y * sv, c.z + u.z * su + v.z * sv)
      this.nrm.push(n.x, n.y, n.z)
      this.uv.push(tu, tv)
      this.col.push(ao, ao, ao)
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  geometry() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setIndex(this.idx)
    return g
  }
}

const randDir = (rnd, out = new V3()) => {
  const z = rnd() * 2 - 1
  const a = rnd() * Math.PI * 2
  const r = Math.sqrt(1 - z * z)
  return out.set(r * Math.cos(a), z, r * Math.sin(a))
}

/** bark: colour attribute darkens toward the ground */
function shadeBark(g, h) {
  const p = g.attributes.position
  const col = []
  for (let i = 0; i < p.count; i++) {
    const s = 0.45 + 0.55 * clamp01(p.getY(i) / h)
    col.push(s, s, s)
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.deleteAttribute('uv')
  return g
}

function limb(from, to, r0, r1) {
  const d = to.clone().sub(from)
  const len = d.length()
  const g = new THREE.CylinderGeometry(r1, r0, len, 5, 1, true)
  g.translate(0, len / 2, 0)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d.normalize()))
  g.translate(from.x, from.y, from.z)
  return g
}

/** Unit-height broadleaf tree: trunk, limbs, and lobed crown of leaf cards. Groups: 0 bark, 1 leaves. */
function broadleaf(rnd, o) {
  const bark = []
  const lean = new V3((rnd() - 0.5) * 0.06, o.trunkH, (rnd() - 0.5) * 0.06)
  bark.push(limb(new V3(0, -0.05, 0), lean, o.trunkR, o.trunkR * 0.65))
  const crownC = new V3(lean.x, o.crownY, lean.z)
  const R = new V3(...o.crownR)
  const lobes = []
  for (let i = 0; i < o.lobes; i++) {
    const a = rnd() * Math.PI * 2
    const el = -0.45 + rnd() * 1.5
    const k = 0.4 + rnd() * 0.5
    const c = new V3(Math.cos(a) * Math.cos(el) * R.x * k, Math.sin(el) * R.y * k, Math.sin(a) * Math.cos(el) * R.z * k).add(crownC)
    lobes.push({ c, r: o.lobeR * (0.7 + rnd() * 0.6) })
    const from = new V3(lean.x * 0.8, o.trunkH * (0.7 + rnd() * 0.3), lean.z * 0.8)
    bark.push(limb(from, from.clone().lerp(c, 0.8), o.trunkR * 0.45, o.trunkR * 0.15))
  }
  const cards = new Cards()
  const p = new V3()
  const d = new V3()
  const n = new V3()
  const u = new V3()
  const v = new V3()
  for (const L of lobes)
    for (let j = 0; j < o.cards; j++) {
      randDir(rnd, d)
      p.copy(L.c).addScaledVector(d, L.r * Math.pow(rnd(), 0.45))
      d.copy(p).sub(crownC).divide(R)
      const outer = clamp01(d.length())
      const under = clamp01((p.y - (o.crownY - R.y)) / (2 * R.y))
      n.copy(d)
      n.y += 0.35
      n.normalize()
      const ao = 0.3 + 0.7 * (0.45 * outer + 0.55 * under)
      randDir(rnd, u)
      v.copy(randDir(rnd, v)).cross(u).normalize()
      const s = o.card * (0.75 + rnd() * 0.5)
      cards.quad(p, u.multiplyScalar(s), v.multiplyScalar(s), n, ao)
    }
  const barkGeo = shadeBark(mergeGeometries(bark.map((g) => g.toNonIndexed())), o.crownY)
  return mergeGeometries([withUv(barkGeo), cards.geometry()], true)
}

/** Unit-height conifer: tiers of drooping branch cards around the trunk. */
function conifer(rnd) {
  const bark = shadeBark(limb(new V3(0, -0.05, 0), new V3(0, 1, 0), 0.022, 0.006).toNonIndexed(), 1)
  const cards = new Cards()
  const TIERS = 15
  const c = new V3()
  const u = new V3()
  const v = new V3()
  const n = new V3()
  for (let i = 0; i < TIERS; i++) {
    const f = i / (TIERS - 1)
    const y = 0.16 + f * 0.82
    const rad = 0.3 * Math.pow(1 - f, 0.95) + 0.035
    const N = 10
    const off = rnd() * 6.28
    for (let k = 0; k < N; k++) {
      const a = off + (k / N) * Math.PI * 2 + (rnd() - 0.5) * 0.4
      const dir = new V3(Math.cos(a), -0.22 - rnd() * 0.15, Math.sin(a)).normalize()
      const len = rad * (0.85 + rnd() * 0.3)
      c.set(0, y, 0).addScaledVector(dir, len * 0.5)
      u.copy(dir).multiplyScalar(len * 0.5)
      v.set(-Math.sin(a), 0.15, Math.cos(a)).normalize().multiplyScalar(len * 0.5)
      n.set(Math.cos(a), 0.7, Math.sin(a)).normalize()
      const ao = 0.3 + 0.5 * f
      cards.quad(c, u, v, n, ao * 0.6, Math.min(1, ao + 0.35))
    }
  }
  return mergeGeometries([withUv(bark), cards.geometry()], true)
}

function withUv(g) {
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
  // match the cards (indexed) so the two can merge
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()])
  return g
}

/** Lambert that keeps the crown-shaped normals on both faces of a card, and sways with the wind. */
function foliageMat(params, wind) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, ...params })
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = wind.uTime
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float ph = instanceMatrix[3][0] * 0.31 + instanceMatrix[3][2] * 0.17;
       float sw = max(position.y, 0.0) * max(position.y, 0.0);
       transformed.x += (sin(uTime * 0.9 + ph) * 0.014 + sin(uTime * 3.1 + ph * 3.0 + position.x * 23.0) * 0.004) * sw;
       transformed.z += (cos(uTime * 0.7 + ph) * 0.009 + cos(uTime * 2.7 + ph * 2.0 + position.z * 19.0) * 0.004) * sw;`,
    )
    if (params.side === THREE.DoubleSide)
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''),
      )
  }
  return m
}

/**
 * @param {{scene, rnd, WATER_Y, edgeAt, groundAt, keepOut?}} o groundAt(side, z, off) -> bank height there;
 *   keepOut(z, off) -> true where the scanned plants stand (no card trees there)
 */
export function makeDayScenery({ scene, rnd, WATER_Y, edgeAt, groundAt, keepOut = null }) {
  const wind = { uTime: { value: 0 } }
  const leafT = leafClumpTex(rnd)
  const needleT = needleTex(rnd)
  const grassT = grassTex(rnd)
  const groundT = groundTex(rnd)
  const disposables = [leafT, needleT, grassT, groundT]

  const barkMat = foliageMat({ color: 0x6a5642 }, wind)
  const paleBark = foliageMat({ color: 0x968b78 }, wind) // eucalyptus
  const leafMat = foliageMat({ map: leafT, alphaTest: 0.5, side: THREE.DoubleSide }, wind)
  const needleMat = foliageMat({ map: needleT, alphaTest: 0.5, side: THREE.DoubleSide }, wind)

  const KINDS = [
    // mango-like: dense dome on a short trunk
    { n: 230, mats: [barkMat, leafMat], geo: broadleaf(rnd, { trunkH: 0.42, trunkR: 0.035, crownY: 0.6, crownR: [0.42, 0.3, 0.4], lobes: 10, lobeR: 0.17, cards: 24, card: 0.12 }), h: [4.5, 9.5], tint: [0.95, 1.0, 0.85] },
    // neem / peepal: airier, taller crown
    { n: 190, mats: [barkMat, leafMat], geo: broadleaf(rnd, { trunkH: 0.5, trunkR: 0.03, crownY: 0.68, crownR: [0.34, 0.3, 0.33], lobes: 13, lobeR: 0.12, cards: 15, card: 0.1 }), h: [5, 11], tint: [1.05, 1.08, 0.8] },
    // eucalyptus: pale trunk, narrow high crown
    { n: 100, mats: [paleBark, leafMat], geo: broadleaf(rnd, { trunkH: 0.66, trunkR: 0.022, crownY: 0.76, crownR: [0.17, 0.24, 0.17], lobes: 8, lobeR: 0.09, cards: 16, card: 0.08 }), h: [8, 13], tint: [0.85, 0.95, 0.85] },
    { n: 28, mats: [barkMat, needleMat], geo: conifer(rnd), h: [6, 11], tint: [0.9, 1.0, 1.0] },
    // understory shrubs, so the forest floor isn't bare between trunks
    { n: 520, mats: [barkMat, leafMat], geo: broadleaf(rnd, { trunkH: 0.08, trunkR: 0.03, crownY: 0.42, crownR: [0.55, 0.38, 0.5], lobes: 7, lobeR: 0.24, cards: 16, card: 0.17 }), h: [1.1, 2.6], tint: [1.0, 1.05, 0.85], off: [0.8, 26] },
  ]

  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const sc = new V3()
  const ps = new V3()
  const cc = new THREE.Color()
  const Y = new V3(0, 1, 0)
  const meshes = []
  for (const K of KINDS) {
    const mesh = new THREE.InstancedMesh(K.geo, K.mats, K.n)
    for (let i = 0; i < K.n; i++) {
      const side = i % 2 ? 1 : -1
      let z, off
      for (let k = 0; k < 40; k++) {
        z = -16 - Math.pow(rnd(), 0.9) * 230
        off = K.off ? K.off[0] + Math.pow(rnd(), 1.3) * (K.off[1] - K.off[0]) : 1.2 + Math.pow(rnd(), 1.5) * 30
        if (!keepOut || !keepOut(z, off)) break
      }
      const h = K.h[0] + rnd() * (K.h[1] - K.h[0])
      const w = h * (0.85 + rnd() * 0.4)
      ps.set(side * (edgeAt(z) + off), groundAt(side, z, off) - 0.2, z)
      q.setFromAxisAngle(Y, rnd() * 6.28)
      m4.compose(ps, q, sc.set(w, h, w))
      mesh.setMatrixAt(i, m4)
      const l = 0.82 + rnd() * 0.3
      mesh.setColorAt(i, cc.setRGB(K.tint[0] * l * (0.92 + rnd() * 0.16), K.tint[1] * l, K.tint[2] * l * (0.9 + rnd() * 0.2)))
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.needsUpdate = true
    mesh.castShadow = mesh.receiveShadow = true
    meshes.push(mesh)
    scene.add(mesh)
  }

  // --- grass tufts along the water and up the banks ---
  const tuft = new THREE.PlaneGeometry(1, 1)
  tuft.translate(0, 0.5, 0)
  const tuft2 = tuft.clone().rotateY(Math.PI / 2)
  const tuftGeo = mergeGeometries([tuft, tuft2])
  tuftGeo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(tuftGeo.attributes.position.count).fill([0, 1, 0]).flat(), 3))
  const col = []
  for (let i = 0; i < tuftGeo.attributes.position.count; i++) {
    const s = 0.55 + 0.45 * tuftGeo.attributes.position.getY(i)
    col.push(s, s, s)
  }
  tuftGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  const grassMat = foliageMat({ map: grassT, alphaTest: 0.5, side: THREE.DoubleSide }, wind)
  const TUFTS = 3600
  const tufts = new THREE.InstancedMesh(tuftGeo, grassMat, TUFTS)
  for (let i = 0; i < TUFTS; i++) {
    const side = i % 2 ? 1 : -1
    const z = -9 - Math.pow(rnd(), 1.4) * 170
    const off = -0.2 + Math.pow(rnd(), 1.3) * 10
    const h = 0.3 + rnd() * 0.55
    ps.set(side * (edgeAt(z) + off), groundAt(side, z, off) - 0.04, z)
    q.setFromAxisAngle(Y, rnd() * 6.28)
    m4.compose(ps, q, sc.set(h * (1.2 + rnd()), h, h * (1.2 + rnd())))
    tufts.setMatrixAt(i, m4)
    const l = 0.8 + rnd() * 0.35
    tufts.setColorAt(i, cc.setRGB(l * (1 + rnd() * 0.15), l, l * 0.85))
  }
  tufts.instanceMatrix.needsUpdate = true
  tufts.instanceColor.needsUpdate = true
  tufts.receiveShadow = true
  scene.add(tufts)

  // --- a forested hill line beyond the reach, fading into the haze ---
  {
    const pos = []
    const colr = []
    const idx = []
    const N = 420
    const lo = new THREE.Color(0x2f4a2c)
    const hi = new THREE.Color(0x4e6f45)
    for (let i = 0; i <= N; i++) {
      const x = -300 + (600 * i) / N
      const top =
        5 + Math.sin(i * 0.031 + 1) * 2.4 + Math.sin(i * 0.09 + 4) * 1.1 + Math.abs(Math.sin(i * 1.9)) * 0.7 + Math.abs(Math.sin(i * 0.77 + 2)) * 0.6
      pos.push(x, WATER_Y - 1, -200, x, WATER_Y + top, -200)
      colr.push(lo.r, lo.g, lo.b, hi.r, hi.g, hi.b)
      if (i > 0) {
        const a = (i - 1) * 2
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3))
    geo.setIndex(idx)
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })))
  }

  return {
    wind,
    groundTex: groundT,
    update(clock) {
      wind.uTime.value = clock
    },
    dispose() {
      disposables.forEach((t) => t.dispose())
    },
  }
}

// --- scanned plants (dev recording only) -------------------------------------
// CC0 photogrammetry trees, shrubs, ferns and grass from Poly Haven, fetched
// into rec-assets/ (git-ignored, never shipped). The Home page only plays the
// video rendered from them.

const SCANS = [
  // big trees: one mesh each (culled on their own); small plants: instanced in batches by distance
  { name: 'island_tree_01', n: 9, h: [8.5, 12.5], zone: 'tree', shadow: true },
  { name: 'island_tree_02', n: 10, h: [7, 10], zone: 'tree', shadow: true },
  { name: 'tree_small_02', n: 8, h: [7.5, 11], zone: 'tree', shadow: true },
  { name: 'shrub_02', n: 150, h: [1.3, 2.6], zone: 'shrub', shadow: true },
  { name: 'shrub_01', n: 24, h: [0.9, 1.8], zone: 'shrub', shadow: true },
  { name: 'shrub_04', n: 90, h: [0.5, 1.1], zone: 'edge' },
  { name: 'fern_02', n: 280, h: [0.5, 1.0], zone: 'edge' },
  { name: 'grass_medium_02', n: 900, h: [0.35, 0.75], zone: 'edge' },
]
// z range and distance in from the shoreline for each zone
const ZONES = { tree: [-17, -118, 1.0, 22], shrub: [-12, -118, 0.4, 21], edge: [-9, -105, -0.3, 6] }
export const SCAN_KEEP_OUT = (z, off) => z > -120 && off < 24

/** sway like the card trees: uH = model height, so the base stays put */
function windPatch(mat, wind, H) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = wind.uTime
    sh.uniforms.uH = { value: H }
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime, uH;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
       float ph = instanceMatrix[3][0] * 0.31 + instanceMatrix[3][2] * 0.17;
       #else
       float ph = modelMatrix[3][0] * 0.31 + modelMatrix[3][2] * 0.17;
       #endif
       float k = clamp(position.y / uH, 0.0, 1.0); k *= k;
       transformed.x += (sin(uTime * 0.9 + ph) * 0.012 + sin(uTime * 3.1 + ph * 3.0 + position.x * 4.0) * 0.003) * k * uH;
       transformed.z += (cos(uTime * 0.7 + ph) * 0.008 + cos(uTime * 2.7 + ph * 2.0 + position.z * 4.0) * 0.003) * k * uH;`,
    )
  }
}

export async function loadScannedPlants({ scene, rnd, edgeAt, groundAt, wind, surfaceLayer, base = '/rec-assets/' }) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const loader = new GLTFLoader()
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const sc = new V3()
  const ps = new V3()
  const Y = new V3(0, 1, 0)
  const trees = [] // [side, z, off] of the big ones, kept apart
  let tris = 0
  const gltfs = await Promise.all(SCANS.map((S) => loader.loadAsync(`${base}${S.name}/${S.name}_2k.gltf`)))
  SCANS.forEach((S, si) => {
    const root = gltfs[si].scene
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    const H = box.max.y - box.min.y
    const centre = new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
    // where each copy stands
    const mats = []
    const [z0, z1, o0, o1] = ZONES[S.zone]
    for (let i = 0; i < S.n; i++) {
      const side = i % 2 ? 1 : -1
      let z, off
      for (let k = 0; k < 60; k++) {
        z = z0 + Math.pow(rnd(), 0.85) * (z1 - z0)
        off = o0 + Math.pow(rnd(), S.zone === 'tree' ? 1.2 : 1.4) * (o1 - o0)
        if (S.zone !== 'tree' || trees.every(([s2, z2, f2]) => s2 !== side || Math.hypot(z2 - z, f2 - off) > 6.5)) break
      }
      if (S.zone === 'tree') trees.push([side, z, off])
      const s = (S.h[0] + rnd() * (S.h[1] - S.h[0])) / H
      ps.set(side * (edgeAt(z) + off), groundAt(side, z, off) - 0.08 * s * H, z)
      q.setFromAxisAngle(Y, rnd() * 6.28)
      mats.push(new THREE.Matrix4().compose(ps, q, sc.set(s * (0.9 + rnd() * 0.2), s, s * (0.9 + rnd() * 0.2))))
    }
    root.traverse((o) => {
      if (!o.isMesh) return
      const g = o.geometry.clone().applyMatrix4(m4.multiplyMatrices(centre, o.matrixWorld))
      const mat = o.material.clone()
      if (mat.transparent || mat.alphaTest > 0 || mat.alphaMode === 'BLEND') {
        // cut-out leaves: sorted by depth like the rest, and they cast proper shadows
        mat.transparent = false
        mat.depthWrite = true
        mat.alphaTest = 0.5
      }
      mat.side = THREE.DoubleSide
      windPatch(mat, wind, H)
      g.computeBoundingSphere()
      const add = (mesh) => {
        mesh.castShadow = !!S.shadow
        mesh.receiveShadow = true
        if (S.zone === 'edge') mesh.layers.set(surfaceLayer) // keeps the mirror pass light
        scene.add(mesh)
      }
      if (S.zone === 'tree') {
        for (const mm of mats) {
          const mesh = new THREE.Mesh(g, mat)
          mesh.matrixAutoUpdate = false
          mesh.matrix.copy(mm)
          mesh.matrixWorldNeedsUpdate = true
          add(mesh)
        }
      } else {
        const BATCH = 30
        const sorted = mats.slice().sort((a, b) => a.elements[14] - b.elements[14])
        for (let b = 0; b < sorted.length; b += BATCH) {
          const part = sorted.slice(b, b + BATCH)
          const mesh = new THREE.InstancedMesh(g, mat, part.length)
          part.forEach((mm, i) => mesh.setMatrixAt(i, mm))
          mesh.instanceMatrix.needsUpdate = true
          mesh.computeBoundingSphere()
          add(mesh)
        }
      }
      tris += ((g.index ? g.index.count : g.attributes.position.count) / 3) * S.n
      o.geometry.dispose()
    })
  })
  return { tris }
}
