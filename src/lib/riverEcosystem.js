import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildJalDhara } from './jalDharaBoat'
import { SURFACE_LAYER } from './riverScene'

// The Varuna loop on the river: plastic drifts downstream, the drone's camera
// footprint sweeps the water and tags each piece, the tag is relayed to
// NIRMAL DHARA JALYAN over the link, and the boat slides across the current to meet it
// with its conveyor — the belt carries it up and drops it in the bay.

const CURRENT = 0.62 // river speed, units/s toward -z
const SPAWN_Z = -2.5
const LANE_EVERY = 3.4
const LANE_N = 9
const BAY_KEEP = 16
// the boat is modelled at ~1/1.7 of its presented size; everything here is in world units
const BOAT_SCALE = 1.7
const ANCHOR = { x: 3.4, z: -20, yaw: -0.72 }
const BOAT_RANGE = 2.6

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a, b, t) => a + (b - a) * t
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

// ---------- waste models ----------
function makeWasteKit(envMap) {
  const env = (m, k = 1) => {
    m.envMap = envMap
    m.envMapIntensity = k
    return m
  }

  // PET bottle profile (radius, height) lying along x
  const prof = [
    [0, 0],
    [0.1, 0.0],
    [0.115, 0.03],
    [0.118, 0.36],
    [0.1, 0.44],
    [0.05, 0.53],
    [0.04, 0.58],
    [0.04, 0.62],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  const bottleGeo = new THREE.LatheGeometry(prof, 18)
  bottleGeo.translate(0, -0.31, 0)
  bottleGeo.rotateZ(Math.PI / 2)
  const capGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.05, 12)
  capGeo.rotateZ(Math.PI / 2)
  capGeo.translate(-0.335, 0, 0)
  const labelGeo = new THREE.CylinderGeometry(0.121, 0.121, 0.16, 18, 1, true)
  labelGeo.rotateZ(Math.PI / 2)
  labelGeo.translate(0.03, 0, 0)
  const canGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.26, 16)
  canGeo.rotateZ(Math.PI / 2)
  const cupGeo = new THREE.CylinderGeometry(0.1, 0.07, 0.2, 14, 1, true)
  cupGeo.rotateZ(Math.PI / 2 + 0.1)
  const wrapGeo = new THREE.BoxGeometry(0.34, 0.025, 0.22, 4, 1, 3)
  {
    const p = wrapGeo.attributes.position
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + Math.sin(p.getX(i) * 18) * 0.012 + Math.cos(p.getZ(i) * 22) * 0.01)
    wrapGeo.computeVertexNormals()
  }
  const bagGeos = [0, 1, 2].map((s) => {
    const g = new THREE.IcosahedronGeometry(0.24, 2)
    const p = g.attributes.position
    let st = 31 + s * 7
    const rnd = () => (st = (st * 16807) % 2147483647) / 2147483647
    const lumps = Array.from({ length: 6 }, () => new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize())
    const v = new THREE.Vector3()
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i)
      let k = 1
      for (const l of lumps) k += Math.max(0, v.clone().normalize().dot(l)) * 0.35 * (rnd() * 0.5 + 0.5)
      v.multiplyScalar(k)
      v.y *= 0.32
      p.setXYZ(i, v.x, v.y, v.z)
    }
    g.computeVertexNormals()
    return g
  })

  // One draw call per piece: parts are baked into a single geometry with vertex
  // colours, all sharing one material (PET reads as pale tinted plastic).
  const litter = env(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide }), 0.45)
  const col = new THREE.Color()
  const bake = (parts) => {
    const geos = parts.map(([geo, hex]) => {
      const g = (geo.index ? geo.toNonIndexed() : geo.clone())
      for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n)
      col.set(hex)
      const c = new Float32Array(g.attributes.position.count * 3)
      for (let i = 0; i < c.length; i += 3) c.set([col.r, col.g, col.b], i)
      g.setAttribute('color', new THREE.BufferAttribute(c, 3))
      return g
    })
    const out = mergeGeometries(geos, false)
    geos.forEach((g) => g.dispose())
    return out
  }
  const CAPS = [0x1d4ed8, 0xdc2626, 0xf8fafc, 0x16a34a]
  const LABELS = [0xd61f26, 0x0e7c3a, 0x1e40af, 0xf59e0b]
  const variants = [
    ...[0, 1, 2, 3].map((i) => ({ geo: bake([[bottleGeo, i % 2 ? 0x9fd9b0 : 0xc9e6f7], [capGeo, CAPS[i]], [labelGeo, LABELS[i]]]), r: 0.36, sink: 0.05 })),
    ...[0xc8102e, 0x9ca3af, 0x0ea5e9].map((c) => ({ geo: bake([[canGeo, c]]), r: 0.2, sink: 0.035 })),
    ...[0xf2f2ee, 0x2563eb, 0x18181b].map((c, i) => ({ geo: bake([[bagGeos[i], c]]), r: 0.34, sink: 0.0 })),
    ...[0xfacc15, 0xf97316, 0xdb2777, 0x22c55e].map((c) => ({ geo: bake([[wrapGeo, c]]), r: 0.26, sink: -0.005 })),
    { geo: bake([[cupGeo, 0xf5f5f0]]), r: 0.2, sink: 0.03 },
  ]
  ;[bottleGeo, capGeo, labelGeo, canGeo, cupGeo, wrapGeo, ...bagGeos].forEach((g) => g.dispose())
  // interleave kinds so neighbours differ
  const order = [0, 4, 7, 10, 1, 14, 5, 8, 11, 2, 6, 9, 12, 3, 13]
  let k = 0
  function make() {
    const v = variants[order[k++ % order.length]]
    return { mesh: new THREE.Mesh(v.geo, litter), r: v.r, sink: v.sink }
  }
  return { make }
}

// ---------- shaders ----------
const MARK_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`
const MARK_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uA, uPing, uTime;
  varying vec2 vUv;
  void main(){
    vec2 p = vUv * 2.0 - 1.0;
    vec2 a = abs(p);
    // corner brackets
    float edge = step(0.86, max(a.x, a.y)) * step(max(a.x, a.y), 0.94);
    float corner = step(0.55, min(a.x, a.y));
    float br = edge * corner;
    // thin ring that breathes
    float r = length(p);
    float rr = 0.62 + 0.04 * sin(uTime * 3.0);
    float ring = smoothstep(0.035, 0.0, abs(r - rr)) * 0.55;
    // detection ping: one expanding ring
    float pr = mix(0.2, 1.4, uPing);
    float ping = smoothstep(0.08, 0.0, abs(r - pr)) * (1.0 - uPing) * step(0.001, uPing) * step(uPing, 0.999);
    float c = (br + ring + ping * 1.4) * uA;
    gl_FragColor = vec4(uColor * c, 1.0);
  }`

const SCAN_FRAG = /* glsl */ `
  uniform float uA, uTime; uniform vec2 uSize;
  varying vec2 vUv;
  void main(){
    vec2 p = (vUv - 0.5) * uSize;
    vec2 h = uSize * 0.5;
    vec2 q = abs(p) - h + 0.35;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.35;
    float border = smoothstep(0.05, 0.0, abs(d)) ;
    float inside = step(d, 0.0);
    vec2 g = abs(fract(p / 0.6) - 0.5);
    float grid = smoothstep(0.03, 0.0, min(g.x, g.y)) * 0.12 * inside;
    // sweep line bouncing along z with a fading trail
    float s = sin(uTime * 1.3);
    float sz = s * h.y;
    float dir = sign(cos(uTime * 1.3));
    float dz = (p.y - sz) * -dir;
    float line = exp(-dz * dz * 260.0);
    float trail = dz > 0.0 ? exp(-dz * 2.2) * 0.25 : 0.0;
    float corners = step(h.x - 0.9, abs(p.x)) * step(h.y - 0.9, abs(p.y)) * border;
    vec3 col = vec3(0.13, 0.83, 0.93);
    float a = (border * 0.35 + corners * 0.9 + grid + (line * 0.9 + trail) * inside) * uA;
    gl_FragColor = vec4(col * a, 1.0);
  }`

const FOAM_FRAG = /* glsl */ `
  uniform float uTime, uYaw, uOn, uStir;
  uniform vec2 uFoot;
  varying vec2 vUv; varying vec3 vW;
  uniform vec2 uBoat;
  uniform float uScale;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ return noise(p)*0.55 + noise(p*2.1+3.1)*0.3 + noise(p*4.3+7.7)*0.15; }
  float sdRR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q,0.0)) + min(max(q.x,q.y),0.0) - r; }
  void main(){
    vec2 p = (vW.xz - uBoat) / uScale;          // offset from boat centre, in hull units
    float c = cos(uYaw), s = sin(uYaw);
    vec2 l = vec2(p.x * c - p.y * s, p.x * s + p.y * c); // boat-local (x, z)
    vec2 drift = vec2(0.0, uTime * 0.62);
    float n = fbm(vW.xz * 3.2 + drift * 3.2);
    float n2 = fbm(vW.xz * 7.0 + drift * 7.0 + 11.0);

    float d = sdRR(l, vec2(1.3, 2.2), 0.72);
    float contact = smoothstep(0.38, 0.0, d) * step(-0.02, d);
    float f = contact * (0.35 + 0.65 * n) * 0.9;

    // churn where the belt dips into the water
    vec2 fo = l - uFoot;
    f += exp(-fo.y * fo.y / 0.05) * smoothstep(0.62, 0.4, abs(fo.x)) * (0.4 + 0.8 * n2) * 0.9;

    // thruster wash streaming off the stern
    for (int i = 0; i < 2; i++) {
      float sx = i == 0 ? -0.72 : 0.72;
      float back = -l.y - 2.4;
      float w = 0.12 + max(back, 0.0) * 0.13;
      float e = (l.x - sx) / w;
      float stream = exp(-e * e) * step(0.0, back) * exp(-back * 0.32);
      f += stream * uOn * (0.3 + 0.9 * n2) * 0.8;
    }

    // Kelvin-ish wake lines spreading downstream (world -z)
    float down = -p.y - 1.2;
    float hw = 1.9 + max(down, 0.0) * 0.36;
    float lw = 0.12 + max(down, 0.0) * 0.035;
    float e2 = (abs(p.x + 0.6) - hw) / lw;
    float wake = exp(-e2 * e2) * step(0.0, down) * exp(-down * 0.1);
    f += wake * uStir * (0.25 + 0.75 * n) * 0.55;

    f = clamp(f, 0.0, 1.0) * smoothstep(0.25, 0.55, n * 0.6 + f * 0.6);
    vec3 col = vec3(0.6, 0.68, 0.76);
    gl_FragColor = vec4(col, f * 0.85);
  }`
const FOAM_VERT = `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`

const ARC_VERT = /* glsl */ `
  attribute float aU;
  uniform float uHalfH, uTime, uA;
  varying float vA; varying vec3 vC;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pulse = pow(fract(aU * 2.0 - uTime * 0.9), 10.0);
    vA = (0.12 + pulse * 1.4) * uA;
    vC = mix(vec3(0.13, 0.83, 0.93), vec3(0.55, 0.36, 0.96), aU);
    gl_PointSize = (0.07 + pulse * 0.06) * projectionMatrix[1][1] * uHalfH / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`
const DOT_FRAG = /* glsl */ `
  uniform sampler2D map; varying float vA; varying vec3 vC;
  void main(){ float m = texture2D(map, gl_PointCoord).a; gl_FragColor = vec4(vC * m * vA * 2.2, 1.0); }`
// Daylight link: additive glow vanishes against a bright sky, so the beads are
// drawn as solid, saturated colour (normal blending) and packed into a beam.
const ARC_VERT_DAY = /* glsl */ `
  attribute float aU;
  uniform float uHalfH, uTime, uA;
  varying float vA; varying vec3 vC;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pulse = pow(fract(aU * 2.0 - uTime * 0.9), 8.0);
    vA = (0.85 + pulse * 0.15) * uA;
    vC = mix(mix(vec3(0.0, 0.5, 0.82), vec3(0.42, 0.12, 0.88), aU), vec3(0.2, 0.95, 1.0), pulse * 0.7);
    gl_PointSize = (0.17 + pulse * 0.12) * projectionMatrix[1][1] * uHalfH / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`
const DOT_FRAG_DAY = /* glsl */ `
  uniform sampler2D map; varying float vA; varying vec3 vC;
  void main(){ float m = texture2D(map, gl_PointCoord).a; float a = clamp(m * 1.6, 0.0, 1.0) * clamp(vA, 0.0, 1.0); if (a < 0.02) discard; gl_FragColor = vec4(vC, a); }`
const PATH_VERT = /* glsl */ `
  attribute float aU;
  uniform float uHalfH, uTime, uA;
  varying float vA; varying vec3 vC;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pulse = 0.35 + 0.65 * pow(fract(aU - uTime * 0.7), 3.0);
    vA = pulse * uA;
    vC = vec3(0.62, 0.42, 1.0);
    gl_PointSize = 0.075 * projectionMatrix[1][1] * uHalfH / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`

export function makeEcosystem({ scene, envMap, WATER_Y, dotTex, seed0 = 9001, mood = 'night' }) {
  const day = mood === 'day'
  let seed = seed0
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647

  // ---------- boat ----------
  const B = buildJalDhara(envMap)
  scene.add(B.group)
  const boat = { x: ANCHOR.x, vx: 0, z: ANCHOR.z, yaw: ANCHOR.yaw }
  B.group.scale.setScalar(BOAT_SCALE)
  const footOffsetX = Math.sin(ANCHOR.yaw) * B.rampFoot.z * BOAT_SCALE
  B.group.position.set(boat.x, WATER_Y, boat.z)
  B.group.rotation.y = boat.yaw

  // presentation light so the white foam reads at night (from the camera side)
  const boatKey = new THREE.SpotLight(0xcfdcff, 0, 0, 0.2, 0.8, 0)
  boatKey.position.set(ANCHOR.x - 6, WATER_Y + 7, ANCHOR.z + 14)
  scene.add(boatKey, boatKey.target)

  // ---------- foam + wake decal on the water ----------
  const foamU = {
    uTime: { value: 0 },
    uYaw: { value: boat.yaw },
    uOn: { value: 0 },
    uStir: { value: 0.6 },
    uFoot: { value: new THREE.Vector2(B.rampFoot.x, B.rampFoot.z) },
    uBoat: { value: new THREE.Vector2() },
    uScale: { value: BOAT_SCALE },
  }
  const foam = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 26).rotateX(-Math.PI / 2).translate(0, 0, -6),
    new THREE.ShaderMaterial({ uniforms: foamU, vertexShader: FOAM_VERT, fragmentShader: FOAM_FRAG, transparent: true, depthWrite: false }),
  )
  foam.scale.setScalar(BOAT_SCALE)
  foam.layers.set(SURFACE_LAYER)
  foam.renderOrder = 1
  scene.add(foam)

  // ---------- waste ----------
  const kit = makeWasteKit(envMap)
  const markGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const items = []
  const POOL = LANE_N + BAY_KEEP + 12 + 4
  for (let i = 0; i < POOL; i++) {
    const w = kit.make()
    w.mesh.traverse((o) => o.layers.set(SURFACE_LAYER)) // floating litter: main view only
    const mark = new THREE.Mesh(
      markGeo,
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0x22d3ee) }, uA: { value: 0 }, uPing: { value: 0 }, uTime: { value: 0 } },
        vertexShader: MARK_VERT,
        fragmentShader: MARK_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    mark.layers.set(SURFACE_LAYER)
    mark.renderOrder = 2
    mark.scale.setScalar(w.r * 2.6)
    mark.visible = false
    scene.add(mark)
    items.push({
      ...w,
      mark,
      state: 'free',
      lane: false,
      x: 0,
      z: 0,
      ph: rnd() * 6.28,
      spin: (rnd() - 0.5) * 0.3,
      yaw: rnd() * 6.28,
      detAt: -1,
      markA: 0,
      tgtA: 0,
      s: 0,
      t0: 0,
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      rot: new THREE.Euler(),
      bornAt: 0,
      scale: 1,
    })
  }
  const take = () => items.find((it) => it.state === 'free')
  const toRiver = (it, x, z, lane) => {
    if (it.mesh.parent !== scene) scene.attach(it.mesh)
    it.state = 'float'
    it.lane = lane
    it.x = x
    it.z = z
    it.detAt = -1
    it.markA = 0
    it.tgtA = 0
    it.scale = 1
    it.mesh.scale.setScalar(1)
    it.mesh.visible = true
    it.yaw = rnd() * 6.28
  }

  const laneMin = ANCHOR.x - BOAT_RANGE + footOffsetX + 0.2
  const laneMax = ANCHOR.x + BOAT_RANGE + footOffsetX - 0.2
  let lastLaneX = (laneMin + laneMax) / 2
  const nextLaneX = () => {
    const x = clamp(lastLaneX + (rnd() - 0.5) * 3.6, laneMin, laneMax)
    lastLaneX = x
    return x
  }
  const footWorld = new THREE.Vector3()
  B.group.updateMatrixWorld(true)
  B.group.localToWorld(footWorld.copy(B.rampFoot))
  // pre-populate: lane items already on their way, decor scattered, a few in the bay
  for (let z = SPAWN_Z; z > footWorld.z + 1.2; z -= CURRENT * LANE_EVERY) toRiver(take(), nextLaneX(), z, true)
  const decorX = () => (rnd() < 0.55 ? -3.2 - rnd() * 8 : 8.4 + rnd() * 5)
  for (let i = 0; i < 12; i++) toRiver(take(), decorX(), SPAWN_Z - rnd() * 42, false)
  // snagged against the left bank
  for (let i = 0; i < 4; i++) {
    const it = take()
    toRiver(it, -12.2 - rnd() * 1.5, -24 - i * 5 - rnd() * 3, false)
    it.state = 'stuck'
  }
  let collected = 0
  const bayItems = []
  const placeInBay = (it, animate) => {
    const bay = B.bay
    it.to.set(lerp(bay.x0, bay.x1, rnd()), bay.floor + 0.06 + Math.min(bayItems.length, 14) * 0.006, lerp(bay.z0, bay.z1, rnd()))
    it.rot.set((rnd() - 0.5) * 0.4, rnd() * 6.28, (rnd() - 0.5) * 0.4)
    bayItems.push(it)
    collected++
    if (!animate) {
      if (it.mesh.parent !== B.body) B.body.add(it.mesh)
      it.mesh.position.copy(it.to)
      it.mesh.scale.setScalar(1 / BOAT_SCALE) // keep litter at world size inside the scaled hull
      it.mesh.rotation.copy(it.rot)
      it.state = 'bay'
    }
  }
  for (let i = 0; i < 7; i++) {
    const it = take()
    it.mesh.visible = true
    placeInBay(it, false)
  }
  const nextLane = { at: LANE_EVERY }

  // ---------- drone scan footprint + frustum ----------
  const SCAN = new THREE.Vector2(5.2, 3.8)
  const scanU = { uA: { value: 0 }, uTime: { value: 0 }, uSize: { value: SCAN } }
  const scan = new THREE.Mesh(
    new THREE.PlaneGeometry(SCAN.x, SCAN.y).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({ uniforms: scanU, vertexShader: MARK_VERT, fragmentShader: SCAN_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  )
  scan.layers.set(SURFACE_LAYER)
  scan.renderOrder = 2
  scene.add(scan)
  const frustPos = new Float32Array(8 * 3)
  const frustCol = new Float32Array(8 * 3)
  const frustGeo = new THREE.BufferGeometry()
  frustGeo.setAttribute('position', new THREE.BufferAttribute(frustPos, 3))
  frustGeo.setAttribute('color', new THREE.BufferAttribute(frustCol, 3))
  const frust = new THREE.LineSegments(frustGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
  frust.frustumCulled = false
  frust.layers.set(SURFACE_LAYER)
  scene.add(frust)

  // ---------- drone <-> boat link + boat path ----------
  const ARC_N = day ? 150 : 46
  const arcPos = new Float32Array(ARC_N * 3)
  const arcU = new Float32Array(ARC_N).map((_, i) => i / (ARC_N - 1))
  const arcGeo = new THREE.BufferGeometry()
  arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPos, 3))
  arcGeo.setAttribute('aU', new THREE.BufferAttribute(arcU, 1))
  const arcMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: dotTex }, uHalfH: { value: 1 }, uTime: { value: 0 }, uA: { value: 0 } },
    vertexShader: day ? ARC_VERT_DAY : ARC_VERT,
    fragmentShader: day ? DOT_FRAG_DAY : DOT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: day ? THREE.NormalBlending : THREE.AdditiveBlending,
  })
  const arc = new THREE.Points(arcGeo, arcMat)
  arc.frustumCulled = false
  arc.layers.set(SURFACE_LAYER)
  scene.add(arc)
  const PATH_N = 14
  const pathPos = new Float32Array(PATH_N * 3)
  const pathU = new Float32Array(PATH_N).map((_, i) => i / (PATH_N - 1))
  const pathGeo = new THREE.BufferGeometry()
  pathGeo.setAttribute('position', new THREE.BufferAttribute(pathPos, 3))
  pathGeo.setAttribute('aU', new THREE.BufferAttribute(pathU, 1))
  const pathMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: dotTex }, uHalfH: { value: 1 }, uTime: { value: 0 }, uA: { value: 0 } },
    vertexShader: PATH_VERT,
    fragmentShader: DOT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const path = new THREE.Points(pathGeo, pathMat)
  path.frustumCulled = false
  path.layers.set(SURFACE_LAYER)
  scene.add(path)

  // ---------- per-frame ----------
  const tmp = new THREE.Vector3()
  const loc = new THREE.Vector3()
  const p0 = new THREE.Vector3()
  const p1 = new THREE.Vector3()
  const p2 = new THREE.Vector3()
  const mastW = new THREE.Vector3()
  const scanC = new THREE.Vector3(0, WATER_Y, -9)
  let clock = 0
  let target = null
  let aiWasOn = false

  function update(dt, { t, power, ai, drone, halfH }) {
    clock += dt
    const on = power

    // --- spawn ---
    nextLane.at -= dt
    if (nextLane.at <= 0) {
      nextLane.at += LANE_EVERY * (0.8 + rnd() * 0.4)
      const laneCount = items.filter((it) => it.lane && it.state === 'float').length
      if (laneCount < LANE_N) {
        let it = take()
        if (!it && bayItems.length) {
          it = bayItems.shift()
          it.state = 'free'
        }
        if (it) toRiver(it, nextLaneX(), SPAWN_Z, true)
      }
    }
    while (bayItems.length > BAY_KEEP) {
      const old = bayItems.shift()
      old.state = 'leaving'
      old.t0 = clock
    }

    // --- boat steering: meet the next tagged item at the belt ---
    B.group.updateMatrixWorld(true)
    B.group.localToWorld(footWorld.copy(B.rampFoot))
    target = null
    let best = Infinity
    for (const it of items) {
      if (it.state !== 'float' || !it.lane) continue
      const dz = it.z - footWorld.z
      if (dz > -0.3 && dz < best) {
        best = dz
        target = it
      }
    }
    const want = target ? clamp(target.x - footOffsetX, ANCHOR.x - BOAT_RANGE, ANCHOR.x + BOAT_RANGE) : ANCHOR.x
    if (boatHook) {
      // recording: a scripted, exactly repeating course
      const h = boatHook(t, ANCHOR)
      boat.vx = dt > 0 ? (h.x - boat.x) / dt : boat.vx
      boat.x = h.x
      boat.z = h.z
    } else {
      const ax = (want - boat.x) * 1.3 - boat.vx * 2.1
      boat.vx = clamp(boat.vx + ax * dt, -1.1, 1.1)
      boat.x += boat.vx * dt
      boat.z = ANCHOR.z + Math.sin(t * 0.23) * 0.25
    }
    boat.yaw = ANCHOR.yaw + clamp(boat.vx * 0.16, -0.18, 0.18)
    B.group.position.set(boat.x, WATER_Y, boat.z)
    B.group.rotation.y = boat.yaw
    B.body.position.y = Math.sin(t * 1.4) * 0.022
    B.body.rotation.x = Math.sin(t * 1.1) * 0.012
    B.body.rotation.z = Math.sin(t * 0.9 + 1) * 0.02 - boat.vx * 0.02
    B.group.updateMatrixWorld(true)
    B.group.localToWorld(footWorld.copy(B.rampFoot))
    B.update(t, dt, Math.max(0.15, on))

    foamU.uTime.value = clock
    foamU.uYaw.value = boat.yaw
    foamU.uOn.value = on
    foamU.uStir.value = 0.45 + Math.abs(boat.vx) * 0.6
    foamU.uBoat.value.set(boat.x, boat.z)
    foam.position.set(boat.x, WATER_Y + 0.006, boat.z)

    tmp.set(boat.x, WATER_Y + 0.4 * BOAT_SCALE, boat.z)
    boatKey.target.position.copy(tmp)
    boatKey.angle = Math.atan((4.2 * BOAT_SCALE * 0.85) / boatKey.position.distanceTo(tmp))
    boatKey.intensity = 0.35 + 0.6 * on

    // --- drone scan footprint ---
    scanC.x = lerp(scanC.x, drone.x, 1 - Math.exp(-dt * 2))
    scanC.z = lerp(scanC.z, drone.z - 0.6, 1 - Math.exp(-dt * 2))
    scan.position.set(scanC.x, WATER_Y + 0.012, scanC.z)
    scanU.uTime.value = clock
    const scanA = ai * 0.42
    scanU.uA.value = scanA
    {
      // four lines from the gimbal to the footprint corners
      const hx = SCAN.x / 2
      const hz = SCAN.y / 2
      const cs = [
        [-hx, -hz],
        [hx, -hz],
        [hx, hz],
        [-hx, hz],
      ]
      cs.forEach(([cx, cz], i) => {
        frustPos.set([drone.x, drone.y - 0.45, drone.z + 0.4, scanC.x + cx, WATER_Y + 0.02, scanC.z + cz], i * 6)
        const a = scanA * 0.22
        frustCol.set([0.13 * a, 0.83 * a, 0.93 * a, 0.13 * a * 0.15, 0.83 * a * 0.15, 0.93 * a * 0.15], i * 6)
      })
      frustGeo.attributes.position.needsUpdate = true
      frustGeo.attributes.color.needsUpdate = true
    }

    if (ai > 0.5 && !aiWasOn) {
      // at switch-on, tag what the drone has already passed, one after another
      let k = 0
      items
        .filter((it) => it.state === 'float' && it.lane && it.z < scanC.z + SCAN.y / 2)
        .sort((a, b) => b.z - a.z)
        .forEach((it) => (it.detAt = clock + 0.15 + k++ * 0.14))
    }
    aiWasOn = ai > 0.5

    // --- items ---
    for (const it of items) {
      const m = it.mesh
      if (it.state === 'float' || it.state === 'stuck') {
        if (it.state === 'float') it.z -= CURRENT * dt
        it.yaw += it.spin * dt
        // keep clear of the hull: slide along its side
        loc.set(it.x, WATER_Y, it.z)
        B.group.worldToLocal(loc)
        const inBelt = Math.abs(loc.x) < 0.62 && loc.z > B.rampTop.z && loc.z < B.rampFoot.z + 0.25
        if (it.state === 'float' && it.lane && inBelt && loc.z > B.rampFoot.z - 0.35) {
          // caught by the belt
          it.state = 'ramp'
          it.s = 0
          B.body.attach(m)
          it.rot.set(0, (rnd() - 0.5) * 0.6, 0)
          it.from.copy(m.position)
          it.t0 = clock
        } else if (it.state === 'float' && Math.abs(loc.x) < 1.42 + it.r * 0.5 && loc.z > -2.6 && loc.z < 2.4) {
          loc.x = Math.sign(loc.x || 1) * (1.42 + it.r * 0.5)
          B.group.localToWorld(loc)
          it.x = lerp(it.x, loc.x, 1 - Math.exp(-dt * 8))
          it.z = lerp(it.z, loc.z, 1 - Math.exp(-dt * 8))
        }
        if (it.state === 'float' || it.state === 'stuck') {
          const bob = Math.sin(clock * 1.7 + it.ph) * 0.016
          m.position.set(it.x, WATER_Y - it.sink + bob, it.z)
          m.rotation.set(Math.sin(clock * 1.3 + it.ph) * 0.08, it.yaw, Math.sin(clock * 1.1 + it.ph * 2) * 0.1)
          if (it.state === 'float' && it.lane && it.z < ANCHOR.z - 9) {
            it.state = 'free'
            m.visible = false
          } else if (it.state === 'float' && !it.lane && it.z < -46) toRiver(it, decorX(), SPAWN_Z - rnd() * 4, false)
        }
        // drone tagging
        if (ai > 0.5 && it.detAt < 0 && it.state === 'float' && Math.abs(it.x - scanC.x) < SCAN.x / 2 && Math.abs(it.z - scanC.z) < SCAN.y / 2) it.detAt = clock
      }
      if (it.state === 'ramp') {
        // ride the belt up from the waterline
        it.s = clamp(it.s + (B.beltSpeed * dt) / B.rampLen)
        const settle = smooth(0, 0.12, it.s)
        B.rampPoint(it.s, it.r * 0.35, tmp)
        m.position.lerpVectors(it.from, tmp, settle)
        m.quaternion.copy(B.rampQuat)
        m.rotateY(it.rot.y)
        if (it.s >= 1) {
          it.state = 'drop'
          it.t0 = clock
          it.from.copy(m.position)
          placeInBay(it, true)
        }
      } else if (it.state === 'drop') {
        const k = clamp((clock - it.t0) / 0.55)
        m.position.lerpVectors(it.from, it.to, k)
        m.position.y += Math.sin(k * Math.PI) * 0.25 - k * k * 0.05
        m.rotation.set(it.rot.x * k + k * 2.2, it.rot.y, it.rot.z * k)
        if (k >= 1) {
          it.state = 'bay'
          m.rotation.copy(it.rot)
        }
      } else if (it.state === 'leaving') {
        const k = clamp((clock - it.t0) / 0.5)
        m.scale.setScalar((1 - k) / BOAT_SCALE)
        if (k >= 1) {
          it.state = 'free'
          m.visible = false
          m.scale.setScalar(1)
        }
      }

      // markers
      const tagged = it.detAt >= 0 && clock >= it.detAt && it.state === 'float'
      it.markA = lerp(it.markA, tagged ? 1 : 0, 1 - Math.exp(-dt * (tagged ? 6 : 10)))
      it.tgtA = lerp(it.tgtA, it === target && tagged ? 1 : 0, 1 - Math.exp(-dt * 5))
      const mk = it.mark
      mk.visible = it.markA > 0.01 && it.mesh.visible
      if (mk.visible) {
        mk.position.set(it.x, WATER_Y + 0.014, it.z)
        mk.rotation.y = it.yaw * 0.2
        const U = mk.material.uniforms
        U.uA.value = it.markA * (0.55 + it.tgtA * 0.35) * ai
        U.uTime.value = clock + it.ph
        U.uPing.value = it.detAt >= 0 ? clamp((clock - it.detAt) / 0.7) : 0
        U.uColor.value.setRGB(lerp(0.13, 0.62, it.tgtA), lerp(0.83, 0.42, it.tgtA), lerp(0.93, 1.0, it.tgtA))
        mk.scale.setScalar(it.r * 2.6 * (1 + it.tgtA * 0.25))
      }
    }

    // --- link arc: drone gimbal -> boat GPS mast ---
    B.mastTop.getWorldPosition(mastW)
    p0.set(drone.x, drone.y - 0.4, drone.z)
    p2.copy(mastW)
    p1.copy(p0).add(p2).multiplyScalar(0.5)
    p1.y += 1.6
    for (let i = 0; i < ARC_N; i++) {
      const u = i / (ARC_N - 1)
      const a = (1 - u) * (1 - u)
      const b = 2 * (1 - u) * u
      const c = u * u
      arcPos.set([p0.x * a + p1.x * b + p2.x * c, p0.y * a + p1.y * b + p2.y * c, p0.z * a + p1.z * b + p2.z * c], i * 3)
    }
    arcGeo.attributes.position.needsUpdate = true
    arcMat.uniforms.uTime.value = clock
    arcMat.uniforms.uHalfH.value = halfH
    arcMat.uniforms.uA.value = ai * (day ? 1 : 0.8)

    // --- planned path: belt foot -> current target ---
    const pa = target ? target.tgtA * ai : 0
    if (target) {
      for (let i = 0; i < PATH_N; i++) {
        const u = i / (PATH_N - 1)
        pathPos.set([lerp(footWorld.x, target.x, u), WATER_Y + 0.03, lerp(footWorld.z + 0.2, target.z, u)], i * 3)
      }
      pathGeo.attributes.position.needsUpdate = true
    }
    pathMat.uniforms.uTime.value = clock
    pathMat.uniforms.uHalfH.value = halfH
    pathMat.uniforms.uA.value = lerp(pathMat.uniforms.uA.value, pa * 0.9, 1 - Math.exp(-dt * 4))
  }

  const proj = new THREE.Vector3()
  let boatHook = null
  return {
    update,
    /** dev: fn(t, anchor) -> {x, z} drives the boat instead of its steering */
    setBoatHook: (fn) => (boatHook = fn),
    /** the boat model (for per-scene finishes) */
    boatGroup: B.group,
    boatPos: () => ({ x: boat.x, z: boat.z, stir: 0.4 + Math.abs(boat.vx) * 0.5, scale: BOAT_SCALE }),
    /** screen-space anchor for the boat's HUD label (CSS px) */
    hud(camera, w, h) {
      B.mastTop.getWorldPosition(proj)
      proj.project(camera)
      return { x: (proj.x * 0.5 + 0.5) * w, y: (-proj.y * 0.5 + 0.5) * h, visible: proj.z < 1, collected }
    },
    dispose() {
      B.dispose()
    },
  }
}
