import * as THREE from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'
import { makeDayScenery, loadScannedPlants, SCAN_KEEP_OUT } from './riverDayScenery'

// Night river under the drone: a planar-reflection water surface (real mirror
// of the scene, distorted by ripples flowing downstream + rotor downwash),
// dark banks with reeds and tree silhouettes, ghat lamps on the far shore,
// fireflies, lily pads, a distant ridge and a moonlit sky.
//
// Layer 1 holds things that lie flat on the water (pads, foam, markers): the
// main camera sees them, the mirror camera does not, so they never get a
// doubled reflection of themselves.

export const SURFACE_LAYER = 1

const WATER_VERT = /* glsl */ `
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vUv = textureMatrix * vec4(position, 1.0);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`

const WATER_FRAG = /* glsl */ `
  uniform vec3 color;
  uniform sampler2D tDiffuse;
  uniform sampler2D tNormal;
  uniform float uTime, uWash, uPoolI, uFlow;
  uniform vec3 uCam, uDrone, uPool0, uPool1, uMoonDir;
  uniform vec4 uBoat; // x, z, stir, hull scale
  uniform vec3 uGlint;
  varying vec4 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>

  vec2 nmap(vec2 uv) { return texture2D(tNormal, uv).xy * 2.0 - 1.0; }

  void main() {
    vec2 p = vWorld.xz;
    float t = uTime * uFlow;
    // Current runs away from the camera (-z); crests lie across the river.
    vec2 n = nmap(p * vec2(0.045, 0.10) + vec2(0.0, t * 0.060)) * 0.55
           + nmap(p * vec2(0.11, 0.21) + vec2(t * 0.010, t * 0.130)) * 0.30
           + nmap(p * vec2(0.36, 0.55) + vec2(-t * 0.020, t * 0.280)) * 0.15;

    // Rotor downwash: rings radiating out from under the drone, stronger the lower it flies.
    vec2 d = p - uDrone.xz;
    float r = length(d);
    float h = max(uDrone.y, 0.4);
    float wash = uWash * exp(-r * r / (1.5 + h * h * 0.5)) * clamp(6.0 / (h * h), 0.0, 1.6);
    float ring = sin(r * 5.5 - uTime * 9.0);
    n += (d / (r + 1e-3)) * ring * wash * 0.9;

    // Hull ripples spreading from the boat.
    vec2 db = p - uBoat.xy;
    float rb = length(db);
    float rs = rb / uBoat.w;
    float bw = uBoat.z * exp(-max(rs - 2.0, 0.0) * 0.55) * smoothstep(1.2, 2.2, rs);
    n += (db / (rb + 1e-3)) * sin(rb * 7.0 - uTime * 4.0) * bw * 0.35;

    float dist = length(vWorld - uCam);
    float amp = 1.0 / (1.0 + dist * 0.05);
    vec4 uv = vUv;
    // Distort more vertically than horizontally -> lights smear into long streaks.
    uv.xy += n * vec2(0.010, 0.040) * amp * uv.w;
    vec3 refl = texture2DProj(tDiffuse, uv).rgb;

    vec3 V = normalize(uCam - vWorld);
    vec3 N = normalize(vec3(n.x * 0.22, 1.0, n.y * 0.22));
    float cosi = max(dot(V, N), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
    fres = clamp(fres + 0.22, 0.0, 1.0);
    // Slight depth tint: near water reads greener, far water bluer.
    vec3 deep = mix(color * vec3(0.9, 1.25, 1.1), color, smoothstep(6.0, 40.0, dist));
    vec3 col = mix(deep, refl * 0.92, fres);

    // Moon glitter: tight specular sparkles on the ripples.
    vec3 Ns = normalize(vec3(n.x * 0.55, 1.0, n.y * 0.55));
    float sp = pow(max(dot(reflect(-uMoonDir, Ns), V), 0.0), 380.0);
    col += uGlint * sp * 1.6;

    // Headlight pools where the beams meet the water (ripples catch glints).
    vec2 q0 = (p - uPool0.xz) * vec2(0.45, 0.22);
    vec2 q1 = (p - uPool1.xz) * vec2(0.45, 0.22);
    float pool = exp(-dot(q0, q0)) + exp(-dot(q1, q1));
    float glint = pow(max(0.0, 0.5 + 0.5 * (n.x * 0.6 + n.y)), 6.0);
    col += vec3(0.75, 0.85, 1.0) * uPoolI * pool * (0.04 + glint * 0.8);

    // Faint spray sheen in the downwash rings.
    col += vec3(0.55, 0.75, 0.95) * wash * 0.035 * (0.5 + 0.5 * ring);

    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const SKY_FRAG = /* glsl */ `
  uniform vec3 uHorizon, uZenith, uMoonDir;
  uniform float uTime, uDay;
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    float y = vDir.y;
    vec3 col = mix(uHorizon, uZenith, uDay > 0.5 ? pow(smoothstep(-0.02, 0.5, y), 0.6) : smoothstep(0.0, 0.42, y));
    float m = max(dot(vDir, uMoonDir), 0.0);
    if (uDay > 0.5) {
      // Daylight: warm haze around the low sun, soft drifting cumulus.
      col += vec3(1.0, 0.86, 0.62) * (pow(m, 6.0) * 0.28 + pow(m, 90.0) * 0.6);
      vec2 cp = vDir.xz / (y + 0.18) * 1.6 + vec2(uTime * 0.012, uTime * 0.02);
      float c = vn(cp) * 0.55 + vn(cp * 2.1 + 3.7) * 0.3 + vn(cp * 4.6 + 9.1) * 0.15;
      c = smoothstep(0.48, 0.78, c) * smoothstep(0.03, 0.14, y);
      vec3 cloud = mix(vec3(0.86, 0.9, 0.95), vec3(1.0, 0.97, 0.92), pow(m, 3.0));
      col = mix(col, cloud, c * 0.85);
      gl_FragColor = vec4(col, 1.0);
      return;
    }
    // Warm city glow low on the horizon, downstream.
    col += vec3(0.10, 0.055, 0.03) * exp(-max(y, 0.0) * 22.0) * smoothstep(0.2, -0.9, vDir.z) * 0.6;
    // Moon halo
    col += vec3(0.32, 0.40, 0.55) * pow(m, 60.0) * 0.5 + vec3(0.10, 0.13, 0.2) * pow(m, 8.0) * 0.3;
    // Stars, twinkling, fading out toward the hazy horizon
    vec3 c = floor(vDir * 340.0);
    float h1 = hash(c);
    float s = step(0.9962, h1) * smoothstep(0.05, 0.3, y);
    float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h1 * 3.0) + h1 * 40.0);
    col += vec3(0.8, 0.85, 1.0) * s * (0.35 + 0.65 * hash(c + 3.1)) * tw;
    gl_FragColor = vec4(col, 1.0);
  }
`

const LAMP_VERT = /* glsl */ `
  attribute float aSize; attribute vec3 aColor; attribute float aPhase;
  uniform float uHalfH, uTime, uOn;
  varying vec3 vC; varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float flick = 0.85 + 0.15 * sin(uTime * (3.0 + aPhase * 5.0) + aPhase * 30.0);
    vC = aColor * flick;
    vA = uOn;
    gl_PointSize = aSize * projectionMatrix[1][1] * uHalfH / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`
const FIREFLY_VERT = /* glsl */ `
  attribute float aPhase;
  uniform float uHalfH, uTime;
  varying vec3 vC; varying float vA;
  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.6 + aPhase * 9.0) * 0.5;
    p.y += sin(uTime * 0.9 + aPhase * 5.0) * 0.25;
    p.z += cos(uTime * 0.5 + aPhase * 7.0) * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float blink = pow(max(0.0, sin(uTime * (0.8 + aPhase) + aPhase * 50.0)), 6.0);
    vC = vec3(0.75, 1.0, 0.35) * 3.0;
    vA = blink;
    gl_PointSize = 0.09 * projectionMatrix[1][1] * uHalfH / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`
const POINT_FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec3 vC; varying float vA;
  void main() {
    float m = texture2D(map, gl_PointCoord).a;
    gl_FragColor = vec4(vC * m * vA, 1.0);
  }
`

// Tileable ripple normal map, generated once (no texture download).
function makeNormalTex(size = 256) {
  const hgt = new Float32Array(size * size)
  const octave = (period, amp, seed) => {
    let st = seed
    const rnd = () => (st = (st * 16807) % 2147483647) / 2147483647
    const grid = new Float32Array(period * period).map(rnd)
    const sm = (x) => x * x * (3 - 2 * x)
    const g = (i, j) => grid[(j % period) * period + (i % period)]
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * period
      const iy = Math.floor(fy)
      const ty = sm(fy - iy)
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * period
        const ix = Math.floor(fx)
        const tx = sm(fx - ix)
        const a = g(ix, iy) + (g(ix + 1, iy) - g(ix, iy)) * tx
        const b = g(ix, iy + 1) + (g(ix + 1, iy + 1) - g(ix, iy + 1)) * tx
        hgt[y * size + x] += amp * (a + (b - a) * ty)
      }
    }
  }
  octave(4, 1, 7)
  octave(8, 0.5, 13)
  octave(16, 0.25, 29)
  octave(32, 0.12, 51)
  const data = new Uint8Array(size * size * 4)
  const k = 22
  const H = (x, y) => hgt[((y + size) % size) * size + ((x + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = -(H(x + 1, y) - H(x - 1, y)) * k
      const ny = -(H(x, y + 1) - H(x, y - 1)) * k
      const l = Math.hypot(nx, ny, 1)
      const o = (y * size + x) * 4
      data[o] = ((nx / l) * 0.5 + 0.5) * 255
      data[o + 1] = ((ny / l) * 0.5 + 0.5) * 255
      data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255
      data[o + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d'), w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

const softDot = () =>
  canvasTex(64, 64, (x, w) => {
    const g = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.25, 'rgba(255,255,255,0.75)')
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = g
    x.fillRect(0, 0, w, w)
  })

// Moon disc with soft limb and grey maria.
const moonDiscTex = () =>
  canvasTex(256, 256, (x, w) => {
    const c = w / 2
    const R = w * 0.42
    x.save()
    x.beginPath()
    x.arc(c, c, R, 0, Math.PI * 2)
    x.clip()
    const base = x.createRadialGradient(c - R * 0.25, c - R * 0.25, R * 0.1, c, c, R)
    base.addColorStop(0, '#fbfbf6')
    base.addColorStop(0.8, '#e6e6de')
    base.addColorStop(1, '#bdbdb4')
    x.fillStyle = base
    x.fillRect(0, 0, w, w)
    const maria = [
      [-0.3, -0.25, 0.32],
      [0.12, -0.32, 0.22],
      [0.28, 0.05, 0.26],
      [-0.12, 0.18, 0.2],
      [0.0, 0.42, 0.12],
      [-0.45, 0.2, 0.14],
    ]
    for (const [mx, my, mr] of maria) {
      const g = x.createRadialGradient(c + mx * R, c + my * R, 0, c + mx * R, c + my * R, mr * R)
      g.addColorStop(0, 'rgba(120,122,120,0.55)')
      g.addColorStop(1, 'rgba(120,122,120,0)')
      x.fillStyle = g
      x.fillRect(0, 0, w, w)
    }
    let s = 11
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 40; i++) {
      const a = rnd() * Math.PI * 2
      const rr = Math.sqrt(rnd()) * R * 0.9
      x.fillStyle = `rgba(150,150,145,${0.15 + rnd() * 0.2})`
      x.beginPath()
      x.arc(c + Math.cos(a) * rr, c + Math.sin(a) * rr, 1 + rnd() * 4, 0, Math.PI * 2)
      x.fill()
    }
    x.restore()
  })

const haloTex = () =>
  canvasTex(128, 128, (x, w) => {
    const g = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2)
    g.addColorStop(0, 'rgba(210,225,255,0.55)')
    g.addColorStop(0.3, 'rgba(170,190,240,0.16)')
    g.addColorStop(1, 'rgba(150,170,230,0)')
    x.fillStyle = g
    x.fillRect(0, 0, w, w)
  })

// Distance of the shoreline from the river centre, along z.
export const edgeAt = (z) => 15 + Math.sin(z * 0.045) * 2.6 + Math.sin(z * 0.13 + 1.3) * 1.1 + Math.max(0, -z - 60) * 0.05

export function makeRiver({ scene, camera, WATER_Y, W, H, getPr, mood = 'night', renderer = null }) {
  // 'night' is the intro; 'day' is a lighter, greener take for the Home page loop.
  const day = mood === 'day'
  // Recording the Home loop (dev only): real scanned plants and sun shadows.
  const scans = day && import.meta.env.DEV && !!renderer
  const PAL = day
    ? { horizon: 0xc4e0ee, zenith: 0x2f7fd8, water: 0x1f5058, bank: 0x5b8a3c, tree: 0xffffff, reed: 0x6f9a3a, pad: 0x3f8a3a, ridge: 0x8fadb0 }
    : { horizon: 0x0b1626, zenith: 0x010204, water: 0x040a10, bank: 0x0a0d0b, tree: 0x050806, reed: 0x15200f, pad: 0x1c3a1f, ridge: 0x050a12 }
  const horizon = new THREE.Color(PAL.horizon)
  const zenith = new THREE.Color(PAL.zenith)
  // The mirror is blurred by ripples anyway: half-res, no MSAA keeps it cheap.
  const RT_SCALE = 0.5
  const rtSize = (w, h) => [Math.max(64, Math.round(w * getPr() * RT_SCALE)), Math.max(64, Math.round(h * getPr() * RT_SCALE))]
  const normalTex = makeNormalTex()
  const dot = softDot()
  const disposables = [normalTex, dot]
  let seed = 4242
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647

  camera.layers.enable(SURFACE_LAYER)
  const moonDir = new THREE.Vector3(-0.36, 0.2, -1).normalize()

  // --- water ---
  const waterShader = {
    name: 'RiverWater',
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: null },
        tNormal: { value: null },
        uTime: { value: 0 },
        uFlow: { value: 1 },
        uWash: { value: 0 },
        uPoolI: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uDrone: { value: new THREE.Vector3(0, 99, 0) },
        uPool0: { value: new THREE.Vector3(0, 0, 999) },
        uPool1: { value: new THREE.Vector3(0, 0, 999) },
        uMoonDir: { value: moonDir },
        uBoat: { value: new THREE.Vector4(0, 999, 0, 1) },
        uGlint: { value: day ? new THREE.Color(1.6, 1.4, 1.1) : new THREE.Color(0.75, 0.82, 1.0) },
      },
    ]),
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
  }
  const water = new Reflector(new THREE.PlaneGeometry(420, 420), {
    textureWidth: rtSize(W(), H())[0],
    textureHeight: rtSize(W(), H())[1],
    clipBias: 0.003,
    color: PAL.water,
    shader: waterShader,
    multisample: 0,
  })
  water.material.fog = true
  water.material.uniforms.tNormal.value = normalTex
  water.rotation.x = -Math.PI / 2
  water.position.set(0, WATER_Y, -150)
  water.camera.layers.set(0) // mirror ignores the surface-decal layer
  scene.add(water)
  const U = water.material.uniforms

  // --- banks: mud lip, grassy slope, then rising land ---
  const ACROSS = [-0.6, 0, 1.2, 3.5, 9, 30, 220]
  const LIFT = [-0.35, 0.05, 0.42, 0.62, 0.8, 1.4, 4]
  const bump = (z, ai, side) => (ai > 1 ? Math.sin(z * 0.21 + ai * 2 + side) * 0.15 * ai : 0)
  /** bank height at `off` metres in from the shoreline (matches the mesh below) */
  const groundAt = (side, z, off) => {
    let i = 1
    while (i < ACROSS.length - 1 && ACROSS[i] < off) i++
    const k = Math.min(1, Math.max(0, (off - ACROSS[i - 1]) / (ACROSS[i] - ACROSS[i - 1])))
    return WATER_Y + LIFT[i - 1] + bump(z, i - 1, side) + k * (LIFT[i] + bump(z, i, side) - LIFT[i - 1] - bump(z, i - 1, side))
  }
  // Daylight gets real-looking trees, grass and hills (own seed: the shared one stays as it was).
  let dseed = 1907
  const drnd = () => (dseed = (dseed * 16807) % 2147483647) / 2147483647
  const dayScenery = day ? makeDayScenery({ scene, rnd: drnd, WATER_Y, edgeAt, groundAt, keepOut: scans ? SCAN_KEEP_OUT : null }) : null
  // wet mud at the waterline, drier bank, then grass
  const BANK_HUE = [0x2f271c, 0x3f3223, 0x6b5e3e, 0x5b7d33, 0x547733, 0x4b6b30, 0x5d7849]
  const bankMat = day
    ? new THREE.MeshLambertMaterial({ color: 0xffffff, map: dayScenery.groundTex, vertexColors: true })
    : new THREE.MeshLambertMaterial({ color: PAL.bank })
  const hc = new THREE.Color()
  const zs = []
  for (let z = 12; z >= -260; z -= 2) zs.push(z)
  const makeBank = (side) => {
    const pos = []
    const idx = []
    const uv = []
    const col = []
    zs.forEach((z, zi) => {
      const e = edgeAt(z)
      ACROSS.forEach((a, ai) => {
        const x = side * (e + a)
        pos.push(x, WATER_Y + LIFT[ai] + bump(z, ai, side), z)
        uv.push(x * 0.14, z * 0.14)
        const n = 0.82 + 0.36 * (0.5 + 0.5 * Math.sin(z * 0.37 + ai * 1.7 + side * 2.3) * Math.sin(z * 0.11 + ai))
        hc.setHex(BANK_HUE[ai]).multiplyScalar(n)
        col.push(hc.r, hc.g, hc.b)
        if (zi > 0 && ai > 0) {
          const n = ACROSS.length
          const i0 = (zi - 1) * n + ai - 1
          const i1 = (zi - 1) * n + ai
          const i2 = zi * n + ai - 1
          const i3 = zi * n + ai
          if (side > 0) idx.push(i0, i2, i1, i1, i2, i3)
          else idx.push(i0, i1, i2, i1, i3, i2)
        }
      })
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    const bank = new THREE.Mesh(geo, bankMat)
    bank.receiveShadow = true
    scene.add(bank)
  }
  makeBank(-1)
  makeBank(1)

  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const sc = new THREE.Vector3()
  const ps = new THREE.Vector3()
  const eul = new THREE.Euler()
  const Y = new THREE.Vector3(0, 1, 0)

  // --- tree silhouettes: layered canopy (cone + blob) ---
  const treeGeo = new THREE.ConeGeometry(1, 1, 7)
  treeGeo.translate(0, 0.5, 0)
  const treeMat = new THREE.MeshLambertMaterial({ color: PAL.tree })
  const TREES = 520
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, TREES)
  const blobGeo = new THREE.IcosahedronGeometry(1, day ? 3 : 1)
  const blobs = new THREE.InstancedMesh(blobGeo, treeMat, 260)
  for (let i = 0; i < TREES; i++) {
    const side = i % 2 ? 1 : -1
    const z = -16 - rnd() * 230
    const off = 3 + Math.pow(rnd(), 1.6) * 26
    const hgt = 3.5 + rnd() * 7
    const wid = hgt * (0.22 + rnd() * 0.12)
    ps.set(side * (edgeAt(z) + off), WATER_Y + 0.5, z)
    sc.set(wid, hgt, wid)
    q.setFromAxisAngle(Y, rnd() * 6.28)
    m4.compose(ps, q, sc)
    trees.setMatrixAt(i, m4)
    if (i < 260) {
      // broadleaf crowns (mango/peepal-like) between the conifers
      const z2 = -18 - rnd() * 200
      const off2 = 2 + Math.pow(rnd(), 1.4) * 18
      const r = 1.6 + rnd() * 2.4
      ps.set(side * (edgeAt(z2) + off2), WATER_Y + 1.2 + r * 0.9 + rnd() * 2, z2)
      sc.set(r * 1.25, r * (0.75 + rnd() * 0.3), r * 1.15)
      m4.compose(ps, q, sc)
      blobs.setMatrixAt(i, m4)
    }
  }
  if (day) {
    // mixed greens: dark conifers, brighter broadleaf crowns
    const cc = new THREE.Color()
    const greens = [0x2f5d2a, 0x3c6e2f, 0x2a5233, 0x4a7d34, 0x36622c]
    for (let i = 0; i < TREES; i++) trees.setColorAt(i, cc.setHex(greens[i % greens.length]).multiplyScalar(0.85 + rnd() * 0.3))
    for (let i = 0; i < 260; i++) blobs.setColorAt(i, cc.setHex(greens[(i * 3 + 1) % greens.length]).multiplyScalar(1.05 + rnd() * 0.35))
  }
  trees.instanceMatrix.needsUpdate = true
  blobs.instanceMatrix.needsUpdate = true
  if (!day) scene.add(trees, blobs) // daylight has its own trees (built above)

  // --- reeds along the shoreline, swaying ---
  const reedGeo = new THREE.ConeGeometry(0.025, 1, 3)
  reedGeo.translate(0, 0.5, 0)
  const reedMat = new THREE.MeshLambertMaterial({ color: PAL.reed })
  const reedU = { uTime: { value: 0 } }
  reedMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = reedU.uTime
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float ph = instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.3;
         transformed.x += sin(uTime * 1.3 + ph) * 0.12 * position.y * position.y;
         transformed.z += cos(uTime * 1.1 + ph) * 0.06 * position.y * position.y;`,
      )
  }
  const REEDS = 1400
  const reeds = new THREE.InstancedMesh(reedGeo, reedMat, REEDS)
  for (let i = 0; i < REEDS; i++) {
    const side = i % 2 ? 1 : -1
    const z = -14 - Math.pow(rnd(), 1.3) * 140
    const off = -0.9 + rnd() * 2.6
    ps.set(side * (edgeAt(z) + off), WATER_Y - 0.1, z)
    eul.set((rnd() - 0.5) * 0.35, rnd() * 6.28, (rnd() - 0.5) * 0.35)
    q.setFromEuler(eul)
    const h = 0.8 + rnd() * 1.6
    sc.set(1 + rnd(), h, 1 + rnd())
    m4.compose(ps, q, sc)
    reeds.setMatrixAt(i, m4)
  }
  reeds.instanceMatrix.needsUpdate = true
  reeds.layers.set(SURFACE_LAYER) // main view only: keeps the mirror pass light
  scene.add(reeds)

  // --- lily pads / water hyacinth near the banks, with a few lotus buds ---
  const padShape = new THREE.Shape()
  padShape.absarc(0, 0, 1, 0.25, Math.PI * 2 - 0.05, false)
  padShape.lineTo(0, 0)
  const padGeo = new THREE.ShapeGeometry(padShape, 18)
  padGeo.rotateX(-Math.PI / 2)
  const padMat = new THREE.MeshLambertMaterial({ color: PAL.pad })
  const PADS = 150
  const pads = new THREE.InstancedMesh(padGeo, padMat, PADS)
  pads.layers.set(SURFACE_LAYER)
  const padBase = []
  for (let c = 0, i = 0; i < PADS; c++) {
    const side = c % 2 ? 1 : -1
    const z = -12 - rnd() * 90
    const cx = side * (edgeAt(z) - 1.2 - rnd() * 3.5)
    const n = 6 + Math.floor(rnd() * 10)
    for (let k = 0; k < n && i < PADS; k++, i++) {
      padBase.push({ x: cx + (rnd() - 0.5) * 3, z: z + (rnd() - 0.5) * 3, s: 0.18 + rnd() * 0.32, r: rnd() * 6.28, ph: rnd() * 6 })
    }
  }
  const lotusMat = new THREE.MeshLambertMaterial({ color: 0xf2a6c4, emissive: 0x4a1830 })
  const lotusGeo = new THREE.ConeGeometry(0.09, 0.2, 6, 1, true)
  const lotus = new THREE.InstancedMesh(lotusGeo, lotusMat, 14)
  for (let i = 0; i < 14; i++) {
    const p = padBase[(i * 11) % PADS]
    ps.set(p.x, WATER_Y + 0.1, p.z)
    m4.compose(ps, q.identity(), sc.setScalar(0.9 + rnd() * 0.5))
    lotus.setMatrixAt(i, m4)
  }
  lotus.instanceMatrix.needsUpdate = true
  lotus.layers.set(SURFACE_LAYER)
  scene.add(pads, lotus)

  // --- ghat lamps along the far shores (warm points; the water streaks them) ---
  const LAMPS = 70
  const lampPos = new Float32Array(LAMPS * 3)
  const lampSize = new Float32Array(LAMPS)
  const lampCol = new Float32Array(LAMPS * 3)
  const lampPh = new Float32Array(LAMPS)
  for (let i = 0; i < LAMPS; i++) {
    const side = i % 3 === 0 ? -1 : 1
    const z = -45 - rnd() * 170
    lampPos.set([side * (edgeAt(z) + 0.6 + rnd() * 5), WATER_Y + 0.5 + rnd() * 1.8, z], i * 3)
    lampSize[i] = 0.35 + rnd() * 0.5
    const warm = rnd() < 0.82
    lampCol.set(warm ? [2.6, 1.35, 0.5] : [1.6, 1.9, 2.4], i * 3)
    lampPh[i] = rnd()
  }
  const lampGeo = new THREE.BufferGeometry()
  lampGeo.setAttribute('position', new THREE.BufferAttribute(lampPos, 3))
  lampGeo.setAttribute('aSize', new THREE.BufferAttribute(lampSize, 1))
  lampGeo.setAttribute('aColor', new THREE.BufferAttribute(lampCol, 3))
  lampGeo.setAttribute('aPhase', new THREE.BufferAttribute(lampPh, 1))
  const lampMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: dot }, uHalfH: { value: 1 }, uTime: { value: 0 }, uOn: { value: 1 } },
    vertexShader: LAMP_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const lamps = new THREE.Points(lampGeo, lampMat)
  lamps.frustumCulled = false
  lamps.visible = !day
  scene.add(lamps)

  // --- fireflies over the reeds ---
  const FF = 90
  const ffPos = new Float32Array(FF * 3)
  const ffPh = new Float32Array(FF)
  for (let i = 0; i < FF; i++) {
    const side = i % 2 ? 1 : -1
    const z = -16 - rnd() * 60
    ffPos.set([side * (edgeAt(z) - 1 + rnd() * 5), WATER_Y + 0.3 + rnd() * 2.2, z], i * 3)
    ffPh[i] = rnd()
  }
  const ffGeo = new THREE.BufferGeometry()
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3))
  ffGeo.setAttribute('aPhase', new THREE.BufferAttribute(ffPh, 1))
  const ffMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: dot }, uHalfH: { value: 1 }, uTime: { value: 0 } },
    vertexShader: FIREFLY_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const fireflies = new THREE.Points(ffGeo, ffMat)
  fireflies.frustumCulled = false
  fireflies.layers.set(SURFACE_LAYER)
  fireflies.visible = !day
  scene.add(fireflies)

  // --- distant ridge (unfogged silhouette just darker than the horizon) ---
  {
    const pos = []
    const idx = []
    const N = 120
    for (let i = 0; i <= N; i++) {
      const x = -320 + (640 * i) / N
      const top = 4 + Math.abs(Math.sin(i * 0.37)) * 5 + Math.sin(i * 0.11 + 2) * 4 + Math.sin(i * 1.7) * 0.8
      pos.push(x, WATER_Y - 1, -228, x, WATER_Y + Math.max(1.5, top), -228)
      if (i > 0) {
        const a = (i - 1) * 2
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setIndex(idx)
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: PAL.ridge, fog: false, side: THREE.DoubleSide })))
  }

  // --- sky, moon, moonlight ---
  const skyU = { uHorizon: { value: horizon }, uZenith: { value: zenith }, uMoonDir: { value: moonDir }, uTime: { value: 0 }, uDay: { value: day ? 1 : 0 } }
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(240, 32, 16),
    new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
  )
  sky.renderOrder = -10
  scene.add(sky)
  const moonTex = moonDiscTex()
  const halo = haloTex()
  disposables.push(moonTex, halo)
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, color: new THREE.Color(2.4, 2.45, 2.6), fog: false, depthWrite: false, transparent: true }))
  moon.position.copy(moonDir).multiplyScalar(225)
  moon.scale.setScalar(9)
  moon.renderOrder = -9
  const moonHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, color: 0xffffff, fog: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }))
  moonHalo.position.copy(moon.position)
  moonHalo.scale.setScalar(46)
  moonHalo.renderOrder = -9
  moon.visible = moonHalo.visible = !day
  scene.add(moon, moonHalo)

  const moonLight = new THREE.DirectionalLight(0x9db2dc, 0.55)
  moonLight.position.copy(moonDir).multiplyScalar(60)
  scene.add(moonLight)
  if (day) {
    // sun high behind the camera's left shoulder, plus sky/grass bounce
    moonLight.color.set(0xfff0d8)
    moonLight.intensity = 2.3
    moonLight.position.set(-30, 46, 34)
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x4d6b34, 1.15))
  }
  let scansReady = Promise.resolve(null)
  if (scans) {
    // The sun casts soft shadows over the near reach; trees never move far, so
    // the shadow map is drawn once (after the scans load), not every frame.
    moonLight.position.set(-42, 40, -18)
    moonLight.target.position.set(0, WATER_Y, -62)
    scene.add(moonLight.target)
    moonLight.castShadow = true
    const sc = moonLight.shadow.camera
    sc.left = -78
    sc.right = 78
    sc.top = 78
    sc.bottom = -78
    sc.near = 1
    sc.far = 220
    moonLight.shadow.mapSize.set(4096, 4096)
    moonLight.shadow.bias = -0.0004
    moonLight.shadow.normalBias = 0.03
    moonLight.shadow.radius = 3
    renderer.shadowMap.needsUpdate = true
    scansReady = loadScannedPlants({ scene, rnd: drnd, edgeAt, groundAt, wind: dayScenery.wind, surfaceLayer: SURFACE_LAYER })
      .then((r) => {
        renderer.shadowMap.needsUpdate = true
        return r
      })
      .catch((e) => {
        console.warn('scanned plants not loaded (run the rec-assets fetch first):', e)
        return null
      })
  }

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const hitWater = (from, to, out) => {
    const dy = to.y - from.y
    if (dy > -1e-3) return out.set(0, 0, 999)
    const k = (WATER_Y - from.y) / dy
    return out.copy(from).lerp(to, k)
  }
  let clock = 0

  return {
    horizon,
    moonDir,
    /** resolves once the scanned plants are in (dev day mood); null otherwise */
    scans: scansReady,
    normalTex,
    dot,
    /** wash: rotor downwash 0..1, poolI: headlight level 0..1, beams: [[from, to], ...] in world space */
    update(dt, { cam, dronePos, wash, poolI, beams, halfH, boat }) {
      clock += dt
      U.uTime.value = clock
      U.uCam.value.copy(cam.position)
      U.uDrone.value.set(dronePos.x, dronePos.y - WATER_Y, dronePos.z)
      U.uWash.value = wash
      U.uPoolI.value = poolI
      if (boat) U.uBoat.value.set(boat.x, boat.z, boat.stir, boat.scale ?? 1)
      if (beams[0]) hitWater(a.copy(beams[0][0]), b.copy(beams[0][1]), U.uPool0.value)
      if (beams[1]) hitWater(a.copy(beams[1][0]), b.copy(beams[1][1]), U.uPool1.value)
      skyU.uTime.value = clock
      reedU.uTime.value = clock
      dayScenery?.update(clock)
      lampMat.uniforms.uTime.value = clock
      lampMat.uniforms.uHalfH.value = halfH
      ffMat.uniforms.uTime.value = clock
      ffMat.uniforms.uHalfH.value = halfH
      // pads ride the swell
      for (let i = 0; i < PADS; i++) {
        const p = padBase[i]
        ps.set(p.x, WATER_Y + 0.012 + Math.sin(clock * 1.1 + p.ph) * 0.01, p.z)
        q.setFromAxisAngle(Y, p.r + Math.sin(clock * 0.3 + p.ph) * 0.08)
        m4.compose(ps, q, sc.setScalar(p.s))
        pads.setMatrixAt(i, m4)
      }
      pads.instanceMatrix.needsUpdate = true
    },
    resize(w, h) {
      water.getRenderTarget().setSize(...rtSize(w, h))
    },
    dispose() {
      water.dispose()
      disposables.forEach((t) => t.dispose())
      dayScenery?.dispose()
    },
  }
}
