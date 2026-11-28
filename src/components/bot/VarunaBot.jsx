import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/**
 * The VARUNA Assistant: a small floating 3D robot (three.js) with a glass face.
 *
 *   state   idle | listening | thinking | speaking | happy | alert | sleep | error
 *   gesture { name: 'wave' | 'nod' | 'shake' | 'bounce' | 'alert', id }  (one-shot; a new id replays it)
 *   levelRef.current  0..1 voice level, read every frame (mouth, chest light) so audio never re-renders React
 *
 * Lifelike touches: blinks at random, eyes and head follow the pointer, leans in
 * to listen, looks up while thinking, mouth and chest light move with its voice,
 * happy eyes and a hop on success, a quick shake and red eyes on danger.
 * Respects prefers-reduced-motion, pauses when off screen or the tab is hidden.
 */

export const BOT_COLORS = {
  idle: '#22d3ee',
  listening: '#0ea5e9',
  thinking: '#8b5cf6',
  speaking: '#14b8a6',
  happy: '#22c55e',
  alert: '#f43f5e',
  error: '#f59e0b',
  sleep: '#64748b',
}

const GESTURE_S = { wave: 1.8, nod: 1.0, shake: 1.0, bounce: 1.2, alert: 0.9 }

function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  r.addColorStop(0, 'rgba(255,255,255,1)')
  r.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

const ease = (x) => 1 - Math.pow(1 - x, 3)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

function buildBot(renderer) {
  const disposables = []
  const keep = (o) => (disposables.push(o), o)
  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()
  scene.environment = envTex
  disposables.push(envTex)

  const shell = keep(new THREE.MeshPhysicalMaterial({ color: '#f5f8fc', roughness: 0.32, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12 }))
  const trim = keep(new THREE.MeshPhysicalMaterial({ color: '#cfd8e3', roughness: 0.4, metalness: 0.35, clearcoat: 0.6 }))
  const glass = keep(new THREE.MeshPhysicalMaterial({ color: '#0a1020', roughness: 0.16, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 0.3, emissive: new THREE.Color('#0b2a3a'), emissiveIntensity: 0.25 }))
  const lit = keep(new THREE.MeshBasicMaterial({ color: BOT_COLORS.idle, toneMapped: false }))
  const litSoft = keep(new THREE.MeshBasicMaterial({ color: BOT_COLORS.idle, toneMapped: false, transparent: true, opacity: 0.9 }))
  const gtex = keep(glowTexture())
  const glowMat = () => keep(new THREE.SpriteMaterial({ map: gtex, color: BOT_COLORS.idle, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 }))

  const bot = new THREE.Group()
  scene.add(bot)

  // ── head ──
  const head = new THREE.Group()
  head.position.y = 0.35
  bot.add(head)
  head.add(new THREE.Mesh(keep(new RoundedBoxGeometry(1.95, 1.55, 1.5, 6, 0.52)), shell))
  const face = new THREE.Mesh(keep(new RoundedBoxGeometry(1.58, 1.12, 0.12, 4, 0.06)), glass)
  face.position.z = 0.71
  head.add(face)
  const faceGroup = new THREE.Group() // eyes + mouth, slides a little toward the pointer
  faceGroup.position.z = 0.785
  head.add(faceGroup)

  const eyeGeo = keep(new THREE.CapsuleGeometry(0.105, 0.17, 6, 16))
  const arcGeo = keep(new THREE.TorusGeometry(0.13, 0.042, 8, 24, Math.PI))
  const eyes = [-1, 1].map((s) => {
    const g = new THREE.Group()
    g.position.set(0.36 * s, 0.08, 0)
    const open = new THREE.Mesh(eyeGeo, lit)
    const happy = new THREE.Mesh(arcGeo, lit)
    happy.position.y = -0.05
    happy.visible = false
    const glow = new THREE.Sprite(glowMat())
    glow.scale.set(0.85, 0.95, 1)
    glow.position.z = -0.02
    g.add(glow, open, happy)
    faceGroup.add(g)
    return { g, open, happy, glow }
  })
  const mouth = new THREE.Mesh(keep(new THREE.CapsuleGeometry(0.03, 0.2, 4, 12)), litSoft)
  mouth.rotation.z = Math.PI / 2
  mouth.position.set(0, -0.27, 0)
  faceGroup.add(mouth)
  const smile = new THREE.Mesh(keep(new THREE.TorusGeometry(0.15, 0.028, 8, 24, Math.PI)), litSoft)
  smile.rotation.z = Math.PI
  smile.position.set(0, -0.2, 0)
  smile.visible = false
  faceGroup.add(smile)

  // ears with light rings
  const earGeo = keep(new THREE.CylinderGeometry(0.27, 0.27, 0.14, 32))
  const ringGeo = keep(new THREE.TorusGeometry(0.19, 0.035, 10, 40))
  const ears = [-1, 1].map((s) => {
    const ear = new THREE.Mesh(earGeo, trim)
    ear.rotation.z = Math.PI / 2
    ear.position.x = 0.99 * s
    const ring = new THREE.Mesh(ringGeo, lit)
    ring.rotation.y = Math.PI / 2
    ring.position.x = 1.07 * s
    head.add(ear, ring)
    return ring
  })

  // antenna
  const stalk = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.025, 0.035, 0.36, 10)), trim)
  stalk.position.set(0, 0.92, 0)
  const tip = new THREE.Mesh(keep(new THREE.SphereGeometry(0.075, 16, 12)), lit)
  tip.position.set(0, 1.12, 0)
  const tipGlow = new THREE.Sprite(glowMat())
  tipGlow.scale.setScalar(0.5)
  tipGlow.position.copy(tip.position)
  head.add(stalk, tip, tipGlow)

  // ── body ──
  const body = new THREE.Group()
  body.position.y = -1.2
  bot.add(body)
  const torso = new THREE.Mesh(keep(new THREE.SphereGeometry(0.72, 40, 28)), shell)
  torso.scale.set(1, 0.92, 0.86)
  body.add(torso)
  const collar = new THREE.Mesh(keep(new THREE.TorusGeometry(0.42, 0.06, 12, 40)), trim)
  collar.rotation.x = Math.PI / 2
  collar.position.y = 0.6
  body.add(collar)
  const core = new THREE.Mesh(keep(new THREE.CircleGeometry(0.15, 32)), lit)
  core.position.set(0, 0.04, 0.625)
  const coreRing = new THREE.Mesh(keep(new THREE.TorusGeometry(0.21, 0.03, 10, 40)), trim)
  coreRing.position.set(0, 0.04, 0.6)
  const coreGlow = new THREE.Sprite(glowMat())
  coreGlow.scale.setScalar(0.9)
  coreGlow.position.set(0, 0.04, 0.66)
  body.add(core, coreRing, coreGlow)

  // floating hands
  const handGeo = keep(new THREE.CapsuleGeometry(0.13, 0.22, 6, 16))
  const hands = [-1, 1].map((s) => {
    const h = new THREE.Mesh(handGeo, shell)
    h.position.set(1.02 * s, -1.25, 0.08)
    h.rotation.z = 0.25 * s
    bot.add(h)
    return h
  })

  // thruster glow under the body
  const thrust = new THREE.Sprite(glowMat())
  thrust.scale.set(0.9, 0.55, 1)
  thrust.position.set(0, -1.98, 0)
  bot.add(thrust)

  // lights
  scene.add(new THREE.HemisphereLight('#ffffff', '#9fb3c8', 0.9))
  const key = new THREE.DirectionalLight('#ffffff', 1.6)
  key.position.set(-3, 4, 5)
  scene.add(key)
  const rim = new THREE.PointLight(BOT_COLORS.idle, 6, 9, 1.6)
  rim.position.set(2.2, 1.2, -1.8)
  scene.add(rim)

  const glows = [...eyes.map((e) => e.glow), tipGlow, coreGlow, thrust]
  return { scene, bot, head, faceGroup, eyes, mouth, smile, ears, tip, core, hands, glows, thrust, rim, lit, litSoft, disposables }
}

export default function VarunaBot({ state = 'idle', gesture = null, levelRef, size, className = '', onClick, title = 'VARUNA Assistant' }) {
  const hostRef = useRef(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const gestureRef = useRef(null)
  const [fallback, setFallback] = useState(false)

  // Replay a gesture whenever a new id arrives.
  useEffect(() => {
    if (gesture?.name) gestureRef.current = { name: gesture.name, t0: performance.now() }
  }, [gesture?.id, gesture?.name])
  // Some states carry a gesture of their own.
  useEffect(() => {
    if (state === 'happy') gestureRef.current = { name: 'bounce', t0: performance.now() }
    if (state === 'alert') gestureRef.current = { name: 'alert', t0: performance.now() }
  }, [state])

  useEffect(() => {
    const host = hostRef.current
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    } catch {
      setFallback(true)
      return undefined
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    host.appendChild(renderer.domElement)

    const B = buildBot(renderer)
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)
    camera.position.set(0, 0.05, 8.4)
    camera.lookAt(0, -0.2, 0)

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const pointer = { x: 0, y: 0, tx: 0, ty: 0, last: 0 }
    const onMove = (e) => {
      const r = host.getBoundingClientRect()
      const span = Math.max(window.innerWidth, window.innerHeight) * 0.45
      pointer.tx = clamp((e.clientX - (r.left + r.width / 2)) / span, -1, 1)
      pointer.ty = clamp(-(e.clientY - (r.top + r.height * 0.4)) / span, -1, 1)
      pointer.last = performance.now()
    }
    window.addEventListener('pointermove', onMove, { passive: true })

    let w = 0, h = 0
    const resize = () => {
      const r = host.getBoundingClientRect()
      const nw = Math.max(16, Math.round(r.width)), nh = Math.max(16, Math.round(r.height))
      if (nw === w && nh === h) return
      w = nw; h = nh
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      // keep the whole robot in view whatever the box shape
      camera.position.z = w / h < 0.8 ? 8.4 / Math.max(0.55, w / h / 0.8) : 8.4
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()

    let visible = true
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting })
    io.observe(host)

    const col = new THREE.Color(BOT_COLORS.idle)
    const target = new THREE.Color()
    let blinkAt = performance.now() + 1500 + Math.random() * 2500
    let blinkT = -1
    let level = 0
    let yaw = 0, pitch = 0, roll = 0, lean = 0
    let happyMix = 0
    let last = performance.now()
    let raf = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      if (!visible || document.hidden) { last = now; return }
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const t = now / 1000
      const s = stateRef.current
      const amp = reduce ? 0.25 : 1

      // voice level
      const lt = clamp(levelRef?.current || 0, 0, 1)
      level += (lt - level) * (s === 'speaking' ? 0.3 : 0.35)
      if (s === 'speaking' && levelRef) levelRef.current *= 0.9

      // colour
      target.set(BOT_COLORS[s] || BOT_COLORS.idle)
      col.lerp(target, 1 - Math.pow(0.002, dt))
      B.lit.color.copy(col)
      B.litSoft.color.copy(col)
      B.rim.color.copy(col)
      for (const g of B.glows) g.material.color.copy(col)

      // pointer: drift back to centre when the mouse is idle
      if (now - pointer.last > 4000) { pointer.tx *= 0.98; pointer.ty *= 0.98 }
      pointer.x += (pointer.tx - pointer.x) * 0.08
      pointer.y += (pointer.ty - pointer.y) * 0.08

      // pose targets per state
      let ty = pointer.x * 0.5, tp = pointer.y * 0.3, tr = 0, tl = 0 // tp > 0 looks up
      if (s === 'thinking') { ty = 0.35 + Math.sin(t * 0.9) * 0.08; tp = 0.2; tr = 0.08 }
      if (s === 'listening') { tp -= 0.05; tr = 0.12; tl = 0.35 }
      if (s === 'sleep') { ty = 0; tp = -0.2; tr = 0.05 }
      if (s === 'speaking') { tp += Math.sin(t * 7.5) * 0.025 * (0.4 + level) }
      const k = 1 - Math.pow(0.004, dt)
      yaw += (ty * amp - yaw) * k
      pitch += (tp * amp - pitch) * k
      roll += (tr * amp - roll) * k
      lean += (tl * amp - lean) * k

      // float
      const bob = Math.sin(t * (s === 'sleep' ? 0.8 : 1.5)) * 0.09 * amp
      B.bot.position.set(0, bob, lean)
      B.bot.rotation.set(0, 0, 0)
      B.head.rotation.set(-pitch, yaw, roll)
      B.head.position.y = 0.35 + Math.sin(t * 1.5 + 0.6) * 0.03 * amp
      B.hands[0].position.set(-1.02, -1.25 + Math.sin(t * 1.5 + 1) * 0.06 * amp, 0.08)
      B.hands[1].position.set(1.02, -1.25 + Math.sin(t * 1.5 + 2) * 0.06 * amp, 0.08)
      B.hands[0].rotation.set(0, 0, -0.25)
      B.hands[1].rotation.set(0, 0, 0.25)
      B.faceGroup.position.x = pointer.x * 0.06 * amp
      B.faceGroup.position.y = pointer.y * 0.04 * amp

      // gestures
      const gst = gestureRef.current
      if (gst) {
        const dur = GESTURE_S[gst.name] || 1
        const p = (now - gst.t0) / 1000 / dur
        if (p >= 1) gestureRef.current = null
        else {
          const env = Math.sin(Math.PI * p)
          if (gst.name === 'wave') {
            const hnd = B.hands[1]
            hnd.position.set(1.25, -1.25 + 1.0 * ease(Math.min(1, p * 3)) * (p > 0.8 ? (1 - p) * 5 : 1), 0.25)
            hnd.rotation.z = 0.25 + Math.sin(p * Math.PI * 7) * 0.55 * env
            B.head.rotation.z += 0.12 * env
          } else if (gst.name === 'nod') {
            B.head.rotation.x += Math.sin(p * Math.PI * 4) * 0.22 * env * amp
          } else if (gst.name === 'shake') {
            B.head.rotation.y += Math.sin(p * Math.PI * 6) * 0.32 * env * amp
          } else if (gst.name === 'bounce') {
            B.bot.position.y += Math.abs(Math.sin(p * Math.PI * 2)) * 0.38 * (1 - p) * amp
            B.bot.rotation.y = reduce ? 0 : ease(p) * Math.PI * 2
            B.hands[0].position.y += 0.5 * env
            B.hands[1].position.y += 0.5 * env
          } else if (gst.name === 'alert') {
            B.bot.position.x += Math.sin(p * Math.PI * 12) * 0.12 * (1 - p) * amp
          }
        }
      }

      // eyes: blink, happy arcs, squint
      if (now > blinkAt && blinkT < 0 && s !== 'sleep') { blinkT = 0; blinkAt = now + 2200 + Math.random() * 4200 }
      let open = 1
      if (blinkT >= 0) {
        blinkT += dt
        open = blinkT < 0.07 ? 1 - blinkT / 0.07 : blinkT < 0.16 ? (blinkT - 0.07) / 0.09 : 1
        open = Math.max(0.08, open)
        if (blinkT >= 0.16) blinkT = -1
      }
      if (s === 'sleep') open = 0.18
      if (s === 'alert') open *= 0.62
      if (s === 'listening') open *= 1.12
      const wantHappy = s === 'happy' || (gst && gst.name === 'bounce') ? 1 : 0
      happyMix += (wantHappy - happyMix) * k
      const thinkScan = s === 'thinking' ? Math.sin(t * 3.2) * 0.05 : 0
      for (const e of B.eyes) {
        e.open.scale.set(1, open * (1 - happyMix), 1)
        e.open.visible = happyMix < 0.95
        e.happy.visible = happyMix > 0.05
        e.happy.scale.setScalar(Math.max(0.01, happyMix))
        e.g.position.x = Math.sign(e.g.position.x) * 0.36 + thinkScan
        e.glow.material.opacity = 0.35 + 0.25 * open + (s === 'listening' ? 0.15 : 0)
      }

      // mouth + smile
      const talking = s === 'speaking'
      B.mouth.visible = happyMix < 0.5
      B.mouth.scale.set(1 + (talking ? level * 3.2 : 0), talking ? 1 - level * 0.25 : s === 'sleep' ? 0.5 : 0.75, 1)
      B.mouth.material.opacity = talking ? 0.95 : 0.55
      B.smile.visible = happyMix >= 0.5
      B.smile.scale.setScalar(Math.max(0.01, happyMix))

      // ears, chest, antenna, thruster
      const pulse = s === 'listening' ? 0.6 + level * 0.8 : s === 'thinking' ? 0.6 + Math.abs(Math.sin(t * 5)) * 0.6 : talking ? 0.6 + level : s === 'alert' ? 0.4 + Math.abs(Math.sin(t * 9)) * 0.9 : 0.55 + Math.sin(t * 2) * 0.1
      for (const r of B.ears) r.scale.setScalar(1 + (s === 'listening' ? level * 0.25 : 0))
      B.glows[3].material.opacity = clamp(0.25 + pulse * 0.45, 0, 1) // chest glow
      B.glows[3].scale.setScalar(0.8 + pulse * 0.35)
      B.core.scale.setScalar(0.85 + (talking ? level * 0.35 : 0) + (s === 'alert' ? Math.abs(Math.sin(t * 9)) * 0.2 : 0))
      B.glows[2].material.opacity = s === 'thinking' ? 0.35 + Math.abs(Math.sin(t * 6)) * 0.6 : 0.4 // antenna tip
      B.thrust.material.opacity = (s === 'sleep' ? 0.25 : 0.45) + Math.sin(t * 13) * 0.06
      B.thrust.scale.set(0.9 + Math.sin(t * 9) * 0.05, 0.55 + Math.sin(t * 11) * 0.05, 1)
      B.rim.intensity = 4 + pulse * 4

      renderer.render(B.scene, camera)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      ro.disconnect()
      io.disconnect()
      for (const d of B.disposables) d.dispose?.()
      renderer.forceContextLoss() // dispose() alone keeps the GL context; browsers cap them (~16)
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [levelRef])

  const c = BOT_COLORS[state] || BOT_COLORS.idle
  const box = size ? { width: size, height: size } : undefined
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={onClick ? title : undefined}
      aria-label={title}
      role={onClick ? undefined : 'img'}
      className={`vbot relative block shrink-0 ${onClick ? 'cursor-pointer focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-400/50 rounded-full' : ''} ${className}`}
      style={box}
    >
      <span aria-hidden className="pointer-events-none absolute inset-[8%] rounded-full blur-2xl transition-colors duration-700"
        style={{ background: `radial-gradient(circle at 50% 45%, ${c}40 0%, ${c}14 45%, transparent 70%)` }} />
      {fallback ? <BotFallback color={c} state={state} /> : <span ref={hostRef} className="absolute inset-0 block" />}
    </Tag>
  )
}

// No WebGL: a flat robot face that still shows its mood.
function BotFallback({ color, state }) {
  return (
    <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
      <rect x="18" y="16" width="64" height="52" rx="20" fill="#f5f8fc" stroke="#cfd8e3" strokeWidth="2" />
      <rect x="25" y="24" width="50" height="36" rx="10" fill="#0a1020" />
      {state === 'happy'
        ? <><path d="M35 44 q5 -8 10 0" stroke={color} strokeWidth="4" fill="none" strokeLinecap="round" /><path d="M55 44 q5 -8 10 0" stroke={color} strokeWidth="4" fill="none" strokeLinecap="round" /></>
        : <><rect x="36" y="33" width="7" height="13" rx="3.5" fill={color} /><rect x="57" y="33" width="7" height="13" rx="3.5" fill={color} /></>}
      <ellipse cx="50" cy="82" rx="18" ry="12" fill="#f5f8fc" stroke="#cfd8e3" strokeWidth="2" />
      <circle cx="50" cy="82" r="4" fill={color} />
    </svg>
  )
}
