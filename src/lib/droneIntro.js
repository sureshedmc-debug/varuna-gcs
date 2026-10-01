import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

// Intro clock (seconds from mount)
const TL = {
  powerOn: 0.5,
  beams: 1.05,
  settle: 2.4, // drone has flown in and is hovering
}
// Rush clock (seconds from the operator's click)
const R = {
  launch: 0.2,
  arrive: 1.4,
  whiteStart: 1.3,
  whitePeak: 1.52,
  reveal: 1.62,
}
const IDLE_Z = -10
const ARRIVE_D = 1.35

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a, b, t) => a + (b - a) * t
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

// Headlights: hard on, one quick flicker, then full. `x` = seconds since switch-on.
function beamLevel(x) {
  if (x < 0) return 0
  if (x < 0.045) return 0.55
  if (x < 0.09) return 0.04
  return Math.min(1, 0.85 + (x - 0.09) * 3)
}

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d'), w, h)
  const t = new THREE.CanvasTexture(c)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  return t
}

function makeTextures() {
  const glow = canvasTex(256, 256, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    r.addColorStop(0, 'rgba(255,255,255,1)')
    r.addColorStop(0.08, 'rgba(255,255,255,0.9)')
    r.addColorStop(0.25, 'rgba(235,245,255,0.28)')
    r.addColorStop(0.55, 'rgba(210,225,255,0.07)')
    r.addColorStop(1, 'rgba(200,220,255,0)')
    g.fillStyle = r
    g.fillRect(0, 0, w, h)
  })
  const reflect = canvasTex(64, 256, (g, w, h) => {
    const img = g.createImageData(w, h)
    for (let y = 0; y < h; y++) {
      const vy = y / h
      const fy = Math.pow(1 - Math.abs(vy - 0.15) / 0.85, 2) * (vy < 0.15 ? vy / 0.15 : 1)
      for (let x = 0; x < w; x++) {
        const vx = (x - w / 2) / (w / 2)
        const a = Math.exp(-vx * vx * 6) * clamp(fy)
        const i = (y * w + x) * 4
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
        img.data[i + 3] = 255 * a
      }
    }
    g.putImageData(img, 0, 0)
  })
  const weave = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#1b1d22'
    g.fillRect(0, 0, w, h)
    const s = 16
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        const odd = ((x + y) / s) % 2 === 0
        const lg = g.createLinearGradient(x, y, odd ? x + s : x, odd ? y : y + s)
        lg.addColorStop(0, '#15171b')
        lg.addColorStop(0.5, '#2a2d34')
        lg.addColorStop(1, '#15171b')
        g.fillStyle = lg
        g.fillRect(x + 1, y + 1, s - 2, s - 2)
      }
    }
  })
  weave.wrapS = weave.wrapT = THREE.RepeatWrapping
  weave.repeat.set(1, 6)
  const disc = canvasTex(256, 256, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    r.addColorStop(0, 'rgba(20,22,26,0)')
    r.addColorStop(0.12, 'rgba(20,22,26,0.5)')
    r.addColorStop(0.5, 'rgba(26,28,33,0.32)')
    r.addColorStop(0.9, 'rgba(36,38,44,0.42)')
    r.addColorStop(0.97, 'rgba(70,74,82,0.55)')
    r.addColorStop(1, 'rgba(30,32,36,0)')
    g.fillStyle = r
    g.fillRect(0, 0, w, h)
  })
  return { glow, reflect, weave, disc }
}

function tubeBetween(a, b, r, mat, seg = 20) {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = dir.length()
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat)
  m.position.copy(a).addScaledVector(dir, 0.5)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
  return m
}

function bladeGeometry(R) {
  const s = new THREE.Shape()
  s.moveTo(0.05, -0.022)
  s.bezierCurveTo(R * 0.3, -0.075, R * 0.72, -0.056, R, -0.014)
  s.quadraticCurveTo(R + 0.014, 0, R, 0.012)
  s.bezierCurveTo(R * 0.7, 0.034, R * 0.32, 0.05, 0.05, 0.022)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.008,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelSegments: 1,
    curveSegments: 18,
  })
  g.rotateX(-Math.PI / 2)
  return g
}

/** Professional X-frame quadcopter. Nose faces +Z. */
function buildDrone(tex, envMap) {
  const envMats = []
  const env = (m, k) => {
    m.envMap = envMap
    m.userData.envK = k
    envMats.push(m)
    return m
  }
  const shell = env(new THREE.MeshPhysicalMaterial({ color: 0x16181d, metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.07 }), 1)
  const shellDark = env(new THREE.MeshStandardMaterial({ color: 0x0b0c0f, metalness: 0.35, roughness: 0.55 }), 0.6)
  const carbon = env(new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex.weave, metalness: 0.45, roughness: 0.38 }), 0.8)
  const alu = env(new THREE.MeshStandardMaterial({ color: 0x2b2e35, metalness: 0.95, roughness: 0.26 }), 1)
  const rubber = env(new THREE.MeshStandardMaterial({ color: 0x0a0a0b, metalness: 0, roughness: 0.85 }), 0.3)
  const glass = env(new THREE.MeshPhysicalMaterial({ color: 0x040507, metalness: 0.1, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 }), 1.3)
  const prop = env(new THREE.MeshStandardMaterial({ color: 0x0e0f12, metalness: 0.2, roughness: 0.35, transparent: true }), 0.8)
  const discMat = env(new THREE.MeshStandardMaterial({ map: tex.disc, color: 0xffffff, metalness: 0.3, roughness: 0.4, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }), 0.6)

  const led = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
  const ledBrow = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
  const accentCyan = new THREE.MeshBasicMaterial({ color: 0x22d3ee, toneMapped: false })
  const accentPurple = new THREE.MeshBasicMaterial({ color: 0x8b5cf6, toneMapped: false })
  const navFront = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
  const navRear = new THREE.MeshBasicMaterial({ color: 0xff2a2a, toneMapped: false })
  const lensCoat = new THREE.MeshBasicMaterial({ color: 0x6d4cff, toneMapped: false, transparent: true, opacity: 0.85 })

  const drone = new THREE.Group()
  const body = new THREE.Group()
  drone.add(body)

  // Fuselage
  const fus = new THREE.Mesh(new RoundedBoxGeometry(1.0, 0.3, 1.5, 5, 0.12), shell)
  body.add(fus)
  const canopy = new THREE.Mesh(new RoundedBoxGeometry(0.78, 0.13, 1.1, 4, 0.06), shell)
  canopy.position.set(0, 0.19, -0.06)
  body.add(canopy)
  const belly = new THREE.Mesh(new RoundedBoxGeometry(0.72, 0.16, 1.05, 4, 0.06), shellDark)
  belly.position.set(0, -0.19, -0.08)
  body.add(belly)
  // Battery latch + rear vents
  const latch = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.03, 0.5, 2, 0.012), alu)
  latch.position.set(0, 0.265, -0.15)
  body.add(latch)
  for (let i = 0; i < 5; i++) {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.012, 0.012), shellDark)
    v.position.set(0, 0.04 - i * 0.03, -0.755)
    body.add(v)
  }
  // Side accent seams (cyan front half, purple rear) — subtle edge glow
  for (const sx of [-1, 1]) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.01, 0.62), accentCyan)
    c.position.set(sx * 0.502, 0.04, 0.26)
    body.add(c)
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.01, 0.5), accentPurple)
    p.position.set(sx * 0.502, 0.04, -0.36)
    body.add(p)
  }

  // Front light cluster: dark glass fascia + angled LED brows + round high-beam projectors
  const fascia = new THREE.Mesh(new RoundedBoxGeometry(0.86, 0.17, 0.05, 3, 0.02), glass)
  fascia.position.set(0, 0.0, 0.75)
  body.add(fascia)
  const headlights = []
  for (const sx of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.022, 0.02), ledBrow)
    brow.position.set(sx * 0.235, 0.052, 0.778)
    brow.rotation.z = sx * -0.2
    body.add(brow)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.064, 0.012, 10, 40), alu)
    ring.position.set(sx * 0.19, -0.025, 0.778)
    body.add(ring)
    const proj = new THREE.Mesh(new THREE.CylinderGeometry(0.054, 0.054, 0.03, 32), led)
    proj.rotation.x = Math.PI / 2
    proj.position.set(sx * 0.19, -0.025, 0.775)
    body.add(proj)
    headlights.push(new THREE.Vector3(sx * 0.19, -0.025, 0.8))
  }

  // Gimbal camera under the nose
  const gimbal = new THREE.Group()
  gimbal.position.set(0, -0.31, 0.5)
  body.add(gimbal)
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.08, 24), alu)
  mount.position.y = 0.04
  gimbal.add(mount)
  const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 10, 32, Math.PI), shellDark)
  yoke.rotation.z = Math.PI
  yoke.position.y = 0.0
  gimbal.add(yoke)
  const camHead = new THREE.Group()
  camHead.position.y = -0.13
  gimbal.add(camHead)
  camHead.add(new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.19, 0.22, 3, 0.04), shell))
  const lensBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.075, 0.07, 32), alu)
  lensBarrel.rotation.x = Math.PI / 2
  lensBarrel.position.z = 0.135
  camHead.add(lensBarrel)
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.056, 32), glass)
  lens.position.z = 0.171
  camHead.add(lens)
  const coat = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.03, 32), lensCoat)
  coat.position.set(0.012, 0.012, 0.172)
  camHead.add(coat)

  // Arms, motors, props, nav LEDs
  const R = 0.56
  const bladeGeo = bladeGeometry(R)
  const props = []
  const navs = []
  const corners = [
    { x: -1, z: 1, cw: true },
    { x: 1, z: 1, cw: false },
    { x: -1, z: -1, cw: false },
    { x: 1, z: -1, cw: true },
  ]
  for (const c of corners) {
    const root = new THREE.Vector3(c.x * 0.4, 0.02, c.z * 0.55)
    const tip = new THREE.Vector3(c.x * 1.14, 0.1, c.z * 1.1)
    body.add(tubeBetween(root, tip, 0.048, carbon))
    const joint = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.12, 0.16, 2, 0.03), alu)
    joint.position.copy(root).lerp(tip, 0.06)
    joint.lookAt(tip)
    body.add(joint)

    const motor = new THREE.Group()
    motor.position.copy(tip)
    body.add(motor)
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.075, 0.12, 28), shellDark)
    pod.position.y = -0.03
    motor.add(pod)
    const stator = new THREE.Mesh(new THREE.CylinderGeometry(0.118, 0.118, 0.1, 36), alu)
    stator.position.y = 0.08
    motor.add(stator)
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.118, 0.04, 36), carbon)
    bell.position.y = 0.15
    motor.add(bell)
    for (let i = 0; i < 12; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.07, 0.02), shellDark)
      const a = (i / 12) * Math.PI * 2
      fin.position.set(Math.cos(a) * 0.119, 0.08, Math.sin(a) * 0.119)
      fin.rotation.y = -a
      motor.add(fin)
    }
    const navLed = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 10), c.z > 0 ? navFront : navRear)
    navLed.position.set(c.x * 0.05, -0.1, c.z * 0.05)
    motor.add(navLed)
    navs.push(navLed)
    // landing foot under rear motors
    if (c.z < 0) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.028, 0.16, 12), rubber)
      foot.position.y = -0.16
      motor.add(foot)
    }

    const rotor = new THREE.Group()
    rotor.position.set(tip.x, tip.y + 0.2, tip.z)
    body.add(rotor)
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.045, 24), alu)
    rotor.add(hub)
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), shell)
    cap.position.y = 0.022
    rotor.add(cap)
    const blades = new THREE.Group()
    rotor.add(blades)
    const twist = c.cw ? -0.14 : 0.14
    for (let k = 0; k < 2; k++) {
      const wrap = new THREE.Group()
      wrap.rotation.y = k * Math.PI
      const b = new THREE.Mesh(bladeGeo, prop)
      b.rotation.x = twist
      wrap.add(b)
      blades.add(wrap)
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R + 0.03, 64).rotateX(-Math.PI / 2), discMat)
    disc.position.y = 0.005
    rotor.add(disc)
    props.push({ blades, dir: c.cw ? -1 : 1, angle: Math.random() * 6 })
  }

  // Landing gear (folding skids)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      body.add(tubeBetween(new THREE.Vector3(sx * 0.3, -0.2, sz * 0.32), new THREE.Vector3(sx * 0.52, -0.62, sz * 0.32), 0.026, carbon))
    }
    const skid = tubeBetween(new THREE.Vector3(sx * 0.53, -0.63, -0.6), new THREE.Vector3(sx * 0.53, -0.63, 0.6), 0.03, carbon)
    body.add(skid)
    for (const sz of [-1, 1]) {
      const end = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 8), rubber)
      end.position.set(sx * 0.53, -0.63, sz * 0.6)
      body.add(end)
    }
  }

  // GPS mast + dual antennas
  const mast = tubeBetween(new THREE.Vector3(0, 0.25, -0.5), new THREE.Vector3(0, 0.46, -0.5), 0.016, alu)
  body.add(mast)
  const gps = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.035, 32), shell)
  gps.position.set(0, 0.48, -0.5)
  body.add(gps)
  for (const sx of [-1, 1]) {
    const ant = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.18, 0.07), shellDark)
    ant.position.set(sx * 0.3, 0.3, -0.66)
    ant.rotation.z = sx * 0.25
    body.add(ant)
  }

  return {
    drone,
    body,
    gimbal: camHead,
    props,
    navs,
    headlights,
    mats: { led, ledBrow, accentCyan, accentPurple, navFront, navRear, prop, discMat, envMats },
  }
}

const BEAM_VERT = /* glsl */ `
  uniform float uLen;
  varying vec3 vN; varying vec3 vView; varying float vAlong;
  void main(){
    vAlong = clamp(position.z / uLen, 0.0, 1.0);
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`
const BEAM_FRAG = /* glsl */ `
  uniform float uI; uniform vec3 uColor;
  varying vec3 vN; varying vec3 vView; varying float vAlong;
  void main(){
    float facing = abs(dot(normalize(vN), normalize(vView)));
    float edge = pow(facing, 2.6);
    float a = edge * pow(1.0 - vAlong, 2.6) * smoothstep(0.0, 0.04, vAlong + 0.01) * uI;
    gl_FragColor = vec4(uColor * a, 1.0);
  }`

const RadialBlurShader = {
  uniforms: { tDiffuse: { value: null }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uStrength: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uCenter; uniform float uStrength; varying vec2 vUv;
    void main(){
      if (uStrength < 0.0005) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
      vec2 d = vUv - uCenter;
      vec4 acc = vec4(0.0); float tot = 0.0;
      for (int i = 0; i < 24; i++) {
        float f = float(i) / 23.0;
        float w = 1.0 - f * 0.65;
        acc += texture2D(tDiffuse, vUv - d * uStrength * f) * w;
        tot += w;
      }
      gl_FragColor = acc / tot;
    }`,
}

const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uCA: { value: 0 }, uVig: { value: 1 }, uGrain: { value: 0.035 }, uWhite: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uCA, uVig, uGrain, uWhite; uniform vec2 uRes; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      vec2 off = c * uCA;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      float v = smoothstep(0.92, 0.22, length(c * vec2(1.0, 0.82)));
      col *= mix(1.0, v, uVig);
      col += (hash(floor(vUv * uRes) + fract(uTime) * 91.7) - 0.5) * uGrain * (1.0 - uWhite);
      vec3 white = mix(vec3(1.0), vec3(0.80, 0.85, 1.0), smoothstep(0.25, 0.8, length(c)));
      gl_FragColor = vec4(mix(col, white, uWhite), 1.0);
    }`,
}

/**
 * Mounts the cinematic intro into `container`. The drone powers on, flies in
 * and hovers until go() is called; then it rushes the camera and the frame
 * floods white. onReveal() fires at the white peak — swap in the app then.
 */
export function createDroneIntro(container, { onReveal, reducedMotion = false } = {}) {
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false })
  } catch {
    renderer = null
  }
  if (!renderer || !renderer.getContext()) {
    renderer?.dispose()
    return { supported: false, go: () => onReveal && onReveal(), dispose() {}, step() {}, state: () => ({ t: 0, g: -1 }) }
  }

  const W = () => container.clientWidth || window.innerWidth
  const H = () => container.clientHeight || window.innerHeight
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
  renderer.setPixelRatio(dpr)
  renderer.setSize(W(), H())
  renderer.setClearColor(0x000000, 1)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  container.appendChild(renderer.domElement)
  Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' })

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  scene.fog = new THREE.FogExp2(0x020205, 0.011)

  const pmrem = new THREE.PMREMGenerator(renderer)
  const roomEnv = new RoomEnvironment()
  const envTex = pmrem.fromScene(roomEnv, 0.04).texture

  const baseFov = () => (W() / H() < 1 ? 54 : 34)
  const camera = new THREE.PerspectiveCamera(baseFov(), W() / H(), 0.05, 260)
  camera.position.set(0, 0.62, 0)
  camera.lookAt(0, 0.95, IDLE_Z)

  const tex = makeTextures()
  const D = buildDrone(tex, envTex)
  scene.add(D.drone)

  // Lighting: near-black ambient, purple/cyan rim from behind, fill that blooms on with the beams
  const hemi = new THREE.HemisphereLight(0x2a3550, 0x000000, 0.08)
  scene.add(hemi)
  const rimP = new THREE.SpotLight(0x8b5cf6, 0, 12, 0.24, 0.9, 0)
  rimP.position.set(-4, 2.2, -6)
  rimP.target = D.drone
  D.drone.add(rimP)
  const rimC = new THREE.SpotLight(0x22d3ee, 0, 12, 0.24, 0.9, 0)
  rimC.position.set(4, 2.0, -6)
  rimC.target = D.drone
  D.drone.add(rimC)
  // Key light rides with the camera and is cone-fitted to the drone every frame,
  // so the aircraft itself is clearly lit while the void around it stays black.
  const key = new THREE.SpotLight(0xe9f0ff, 0, 0, 0.1, 0.75, 0)
  scene.add(key)
  scene.add(key.target)
  const keyFill = new THREE.SpotLight(0xb9c8ff, 0, 0, 0.1, 0.85, 0)
  scene.add(keyFill)
  scene.add(keyFill.target)
  const top = new THREE.PointLight(0xdfe8ff, 0, 3.2, 2)
  top.position.set(0.4, 1.6, 0.8)
  D.drone.add(top)
  const bounce = new THREE.PointLight(0xe8f1ff, 0, 6, 1.5)
  bounce.position.set(0, -1.4, 1.6)
  D.drone.add(bounce)

  // Headlight spots (light the floor ahead) + volumetric cones + flares
  const BEAM_LEN = 16
  const beamGeo = new THREE.ConeGeometry(2.0, BEAM_LEN, 48, 1, true)
  beamGeo.translate(0, -BEAM_LEN / 2, 0)
  beamGeo.rotateX(-Math.PI / 2)
  const beamUniforms = { uI: { value: 0 }, uColor: { value: new THREE.Color(0xd9ecff) }, uLen: { value: BEAM_LEN } }
  const beamMat = new THREE.ShaderMaterial({
    uniforms: beamUniforms,
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })
  const spots = []
  const glows = []
  const reflections = []
  const glowMat = new THREE.SpriteMaterial({ map: tex.glow, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true })
  const reflMat = new THREE.SpriteMaterial({ map: tex.reflect, color: 0xdbe9ff, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true })
  for (const p of D.headlights) {
    const s = new THREE.SpotLight(0xf1f6ff, 0, 40, 0.22, 0.8, 1.2)
    s.position.copy(p)
    const tgt = new THREE.Object3D()
    tgt.position.set(p.x * 1.5, -2.2, p.z + 14)
    D.body.add(tgt)
    s.target = tgt
    D.body.add(s)
    spots.push(s)

    const cone = new THREE.Mesh(beamGeo, beamMat)
    cone.position.copy(p)
    cone.rotation.x = 0.1
    cone.renderOrder = 2
    D.body.add(cone)

    const g = new THREE.Sprite(glowMat)
    g.renderOrder = 3
    scene.add(g)
    glows.push({ sprite: g, local: p.clone().add(new THREE.Vector3(0, 0, 0.03)) })
    const rf = new THREE.Sprite(reflMat)
    scene.add(rf)
    reflections.push(rf)
  }

  // Wet studio floor
  const FLOOR_Y = -2.3
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x08090c, metalness: 0.6, roughness: 0.32 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = FLOOR_Y
  scene.add(floor)

  // Haze particles that stretch into speed streaks
  const N = 520
  const pData = new Float32Array(N * 4) // x, y, z, tint
  const lineGeo = new THREE.BufferGeometry()
  const linePos = new Float32Array(N * 6)
  const lineCol = new Float32Array(N * 6)
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3))
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3))
  const respawn = (i, zMin, zMax) => {
    let x, y
    do {
      x = (Math.random() * 2 - 1) * 16
      y = FLOOR_Y + 0.15 + Math.random() * 11
    } while (Math.abs(x) < 0.6 && Math.abs(y - 0.3) < 0.5)
    pData[i * 4] = x
    pData[i * 4 + 1] = y
    pData[i * 4 + 2] = lerp(zMin, zMax, Math.random())
    pData[i * 4 + 3] = Math.random()
  }
  for (let i = 0; i < N; i++) respawn(i, -90, 1)
  const lines = new THREE.LineSegments(
    lineGeo,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  )
  lines.frustumCulled = false
  scene.add(lines)

  // Post
  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(dpr)
  composer.setSize(W(), H())
  composer.addPass(new RenderPass(scene, camera))
  const blurPass = new ShaderPass(RadialBlurShader)
  composer.addPass(blurPass)
  const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), 0.4, 0.5, 0.85)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())
  const finish = new ShaderPass(FinishShader)
  composer.addPass(finish)

  function resize() {
    const w = W()
    const h = H()
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    composer.setSize(w, h)
    finish.uniforms.uRes.value.set(w * dpr, h * dpr)
  }
  resize()
  window.addEventListener('resize', resize)

  // --- state ---
  let t = 0 // intro clock
  let g = -1 // seconds since go(); -1 while hovering
  let powerAt = TL.powerOn
  let beamsAt = TL.beams
  let last = performance.now()
  let raf = 0
  let revealed = false
  let rush = null
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 }
  const tmpV = new THREE.Vector3()
  const lookTarget = new THREE.Vector3()
  const idleLook = new THREE.Vector3(0, 0.95, IDLE_Z)

  function idlePos(time, out) {
    const ent = 1 - Math.pow(1 - clamp(time / TL.settle), 3)
    out.ent = ent
    out.x = lerp(-3.4, 0, ent) + Math.sin(time * 0.33) * 1.1 * ent
    out.y = lerp(2.5, 1.38, ent) + Math.sin(time * 0.9) * 0.14 * ent + Math.sin(time * 2.1) * 0.03
    out.z = lerp(-40, IDLE_Z, ent) + Math.sin(time * 0.45 + 1.2) * 0.7 * ent
    return out
  }
  const pA = {}
  const pB = {}
  // Free flight: attitude follows velocity (bank into turns, nose into travel), slow yaw shows its form
  function idlePose(time) {
    const p = idlePos(time, {})
    idlePos(time - 0.05, pA)
    idlePos(time + 0.05, pB)
    const vx = (pB.x - pA.x) / 0.1
    const vz = (pB.z - pA.z) / 0.1
    p.roll = clamp(-vx * 0.16, -0.32, 0.32)
    p.pitch = clamp(vz * 0.035, -0.22, 0.22)
    p.yaw = lerp(0.85, 0, p.ent) + Math.sin(time * 0.21) * 0.3 * p.ent
    return p
  }
  // After the click: brief anticipation, then a geometric close-in (constant-rate zoom, eased in)
  function rushPose(gt) {
    const r = rush
    const hold = smooth(0, R.launch, gt) * (1 - smooth(R.launch, R.launch + 0.12, gt))
    const p = clamp((gt - R.launch) / (R.arrive - R.launch))
    const d = r.d0 * Math.pow(ARRIVE_D / r.d0, Math.pow(p, 1.7))
    const e = (r.d0 - d) / (r.d0 - ARRIVE_D)
    const settle = smooth(0, R.launch + 0.35, gt)
    const flareAt = R.launch + (R.arrive - R.launch) * 0.72
    return {
      x: lerp(r.x, 0, smooth(0, 0.85, p)),
      y: lerp(r.y, 0.12, smooth(0, 0.8, e)) + lerp(0, 0.5, smooth(0.9, 1, e)) + hold * 0.14,
      z: -d - hold * 0.55,
      pitch: lerp(r.pitch, -0.07, smooth(0, R.launch, gt)) + 0.49 * smooth(R.launch, R.launch + 0.26, gt) - 0.36 * smooth(flareAt, R.arrive, gt),
      yaw: r.yaw * (1 - settle),
      roll: r.roll * (1 - settle),
    }
  }

  function update(dt) {
    const rushing = g >= 0
    const s = rushing ? rushPose(g) : idlePose(t)
    const v01 = rushing ? Math.pow(smooth(R.launch + 0.1, R.arrive - 0.05, g), 1.3) : 0
    const near = smooth(8.5, 1.5, -s.z)
    const flood = rushing ? smooth(R.whiteStart, R.whitePeak, g) : 0

    D.drone.position.set(s.x, s.y, s.z)
    D.drone.rotation.set(s.pitch, s.yaw, s.roll, 'YXZ')
    D.gimbal.rotation.x = -s.pitch * 0.85

    // Power-on
    const pow = smooth(powerAt, powerAt + 0.35, t)
    const beam = beamLevel(t - beamsAt)
    const blink = t > powerAt && (Math.floor((t - powerAt) * 7) % 3 !== 2 || t > powerAt + 0.45) ? 1 : 0
    D.mats.navFront.color.setScalar(4 * pow * blink)
    const strobe = Math.sin(t * 9) > 0.6 ? 1 : 0.15
    D.mats.navRear.color.setRGB(5 * strobe * pow, 0.25 * strobe * pow, 0.25 * strobe * pow)
    const seam = smooth(powerAt + 0.1, powerAt + 0.6, t)
    D.mats.accentCyan.color.setRGB(0.13 * 3.5 * seam, 0.83 * 3.5 * seam, 0.93 * 3.5 * seam)
    D.mats.accentPurple.color.setRGB(0.55 * 3 * seam, 0.36 * 3 * seam, 0.96 * 3 * seam)
    D.mats.led.color.setScalar(0.02 + beam * 7)
    D.mats.ledBrow.color.setScalar(0.02 + Math.max(beam, seam * 0.1) * 5)

    // Rotors
    const omega = 46 * smooth(powerAt, powerAt + 0.5, t) + (rushing ? 50 * smooth(R.launch - 0.1, R.launch + 0.3, g) : 0)
    for (const pr of D.props) {
      pr.angle += pr.dir * omega * dt
      pr.blades.rotation.y = pr.angle
    }
    const spin = clamp(omega / 46)
    D.mats.prop.opacity = lerp(1, 0.22, spin)
    D.mats.discMat.opacity = spin * 0.9

    const envAmt = 0.08 + pow * 0.14 + beam * 0.16
    for (const m of D.mats.envMats) m.envMapIntensity = envAmt * m.userData.envK
    hemi.intensity = 0.06 + beam * 0.12
    rimP.intensity = 1.2 * pow + 1.6 * beam
    rimC.intensity = 1.0 * pow + 1.4 * beam
    top.intensity = 0.6 * pow + 2.2 * beam
    bounce.intensity = beam * 3.5
    for (const sp of spots) sp.intensity = beam * 0.6

    // Camera: soft-follow + pointer parallax while hovering, hard track + FOV punch on the rush
    const ease = 1 - Math.exp(-dt * 2.5)
    pointer.sx = lerp(pointer.sx, pointer.x, ease)
    pointer.sy = lerp(pointer.sy, pointer.y, ease)
    const par = rushing ? 1 - smooth(0, R.launch + 0.3, g) : 1
    const track = rushing ? lerp(0.55, 0.9, smooth(R.launch, R.arrive, g)) : 0.55
    D.drone.updateMatrixWorld(true)
    lookTarget.copy(idleLook).lerp(tmpV.set(s.x, s.y - 0.05, s.z + 0.8 * smooth(6, 1.5, -s.z)), track)
    const kick = t > beamsAt ? Math.exp(-(t - beamsAt) * 9) * 0.025 : 0
    const shake = kick + v01 * 0.004 * (1 - near)
    const n1 = Math.sin(t * 37.1) * 0.5 + Math.sin(t * 61.3) * 0.3 + Math.sin(t * 23.7) * 0.2
    const n2 = Math.sin(t * 41.9) * 0.5 + Math.sin(t * 53.1) * 0.3 + Math.sin(t * 29.3) * 0.2
    camera.position.set(pointer.sx * 0.7 * par + n1 * shake, 0.62 + pointer.sy * 0.3 * par + n2 * shake, lerp(0, -0.3, near))
    camera.lookAt(lookTarget)
    {
      const dp = D.drone.position
      key.position.set(camera.position.x - 1.6, camera.position.y + 2.4, camera.position.z + 0.5)
      key.target.position.copy(dp)
      key.angle = Math.min(1.2, Math.atan(2.6 / Math.max(0.5, key.position.distanceTo(dp))))
      key.intensity = lerp(0.55, 2.4, pow) * (1 - flood * 0.5)
      keyFill.position.set(camera.position.x + 2.2, camera.position.y - 0.4, camera.position.z + 0.5)
      keyFill.target.position.copy(dp)
      keyFill.angle = Math.min(1.2, Math.atan(2.4 / Math.max(0.5, keyFill.position.distanceTo(dp))))
      keyFill.intensity = lerp(0.2, 0.9, pow)
    }
    beamUniforms.uI.value = beam * 0.045 * (1 - near * 0.9)
    camera.fov = baseFov() + (rushing ? 17 * smooth(R.launch + 0.6, R.arrive, g) : 0)
    camera.updateProjectionMatrix()

    // Headlight glow + wet-floor reflections
    for (let i = 0; i < glows.length; i++) {
      const gl = glows[i]
      const wp = D.body.localToWorld(tmpV.copy(gl.local))
      const dist = wp.distanceTo(camera.position)
      gl.sprite.position.copy(wp)
      const gs = (dist * 0.014 + 0.08) * beam * (1 + near * 1.1)
      gl.sprite.scale.set(gs, gs, 1)
      glowMat.color.setScalar(beam * (0.8 + near * 1.2) + flood * 6)
      const rf = reflections[i]
      rf.position.set(wp.x, FLOOR_Y + 0.02 - (wp.y - FLOOR_Y) * 0.55, wp.z + 0.2)
      const rh = Math.max(0.01, (wp.y - FLOOR_Y) * 1.15)
      rf.scale.set(rh * 0.09 + dist * 0.004, rh, 1)
      reflMat.opacity = beam * 0.04
    }

    // Haze drifts while hovering, stretches into speed streaks on the rush
    const flow = 0.35 + v01 * 42
    const len = 0.02 + v01 * 2.8
    for (let i = 0; i < N; i++) {
      let z = pData[i * 4 + 2] + flow * dt
      if (z > camera.position.z + 0.4) {
        respawn(i, -95, -70)
        z = pData[i * 4 + 2]
      }
      pData[i * 4 + 2] = z
      const x = pData[i * 4]
      const y = pData[i * 4 + 1]
      const k = i * 6
      linePos[k] = x
      linePos[k + 1] = y
      linePos[k + 2] = z
      linePos[k + 3] = x
      linePos[k + 4] = y
      linePos[k + 5] = z - len
      let b = 0.06
      if (z > s.z) {
        const ahead = z - s.z
        const rad = 0.5 + ahead * 0.16
        const dx = x - s.x
        const dy = y - s.y
        b += beam * Math.exp(-(dx * dx + dy * dy) / (rad * rad)) * Math.max(0, 1 - ahead / 30) * 1.6
      }
      b *= 0.6 + v01 * 1.2
      const tint = pData[i * 4 + 3]
      const cr = tint < 0.15 ? 0.55 : tint < 0.3 ? 0.35 : 0.85
      const cg = tint < 0.15 ? 0.36 : tint < 0.3 ? 0.83 : 0.9
      const cb = tint < 0.15 ? 0.96 : tint < 0.3 ? 0.93 : 1.0
      lineCol[k] = cr * b
      lineCol[k + 1] = cg * b
      lineCol[k + 2] = cb * b
      lineCol[k + 3] = cr * b * 0.15
      lineCol[k + 4] = cg * b * 0.15
      lineCol[k + 5] = cb * b * 0.15
    }
    lineGeo.attributes.position.needsUpdate = true
    lineGeo.attributes.color.needsUpdate = true

    // Post: zoom blur toward the drone, bloom flood, exposure ramp, white impact
    tmpV.copy(D.drone.position).project(camera)
    blurPass.uniforms.uCenter.value.set(clamp(tmpV.x * 0.5 + 0.5), clamp(tmpV.y * 0.5 + 0.5))
    blurPass.uniforms.uStrength.value = 0.13 * Math.pow(v01, 1.35)
    bloom.strength = 0.4 + beam * 0.15 + v01 * 0.25 + flood * 2.8
    bloom.radius = 0.5 + flood * 0.4
    bloom.threshold = lerp(0.85, 0.15, flood)
    renderer.toneMappingExposure = 1 + flood * 3
    finish.uniforms.uTime.value = t
    finish.uniforms.uCA.value = 0.004 * v01 + 0.01 * near
    finish.uniforms.uVig.value = 1 - flood * 0.7
    finish.uniforms.uWhite.value = rushing ? smooth(R.whiteStart + 0.08, R.whitePeak, g) : 0
  }

  function frame(dt) {
    t += dt
    if (g >= 0) g += dt
    update(dt)
    composer.render()
    if (!revealed && g >= R.reveal) {
      revealed = true
      cancelAnimationFrame(raf)
      raf = 0
      onReveal && onReveal()
    }
  }

  function tick(now) {
    if (disposed || revealed) return
    raf = requestAnimationFrame(tick)
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    frame(dt)
  }

  function onPointer(e) {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1
    pointer.y = -((e.clientY / window.innerHeight) * 2 - 1)
  }

  let disposed = false
  let detach
  if (reducedMotion) {
    // One still frame: powered, lights on, hovering. No flight, no flash.
    t = TL.settle + 1.5
    powerAt = beamsAt = 0
    const still = () => {
      update(0)
      composer.render()
    }
    still()
    window.addEventListener('resize', still)
    detach = () => window.removeEventListener('resize', still)
  } else {
    window.addEventListener('pointermove', onPointer)
    raf = requestAnimationFrame(tick)
    detach = () => window.removeEventListener('pointermove', onPointer)
  }

  return {
    supported: true,
    state: () => ({ t, g }),
    /** Launch the rush toward the camera. Safe to call more than once. */
    go() {
      if (disposed || g >= 0 || revealed) return
      if (reducedMotion) {
        revealed = true
        onReveal && onReveal()
        return
      }
      rush = idlePose(t)
      rush.d0 = Math.max(ARRIVE_D + 1, -rush.z)
      g = 0
      powerAt = Math.min(powerAt, t)
      if (t < beamsAt) beamsAt = t + 0.02
    },
    /** Test hook: advance a fixed step without waiting for animation frames. */
    step(dt) {
      if (!disposed && !revealed) frame(dt)
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(raf)
      raf = 0
      detach()
      window.removeEventListener('resize', resize)
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
      })
      Object.values(tex).forEach((x) => x.dispose())
      envTex.dispose()
      pmrem.dispose()
      roomEnv.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) o.material.dispose()
      })
      composer.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    },
  }
}
