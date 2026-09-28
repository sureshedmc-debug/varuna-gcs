import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

/**
 * Realistic, drag-to-orbit quadcopter for the Home dashboard's aircraft card.
 * Self-contained (the Missions tab keeps its own preview from drone3d.js).
 * Pauses while off screen / tab hidden and frees its GL context on unmount.
 * @param {number|null} battery  0..1 — lights the pack's 4-LED level gauge
 */
export default function HomeDrone3D({ battery = null }) {
  const mountRef = useRef(null)
  const batteryRef = useRef(battery)
  const [failed, setFailed] = useState(false)
  batteryRef.current = battery

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return undefined
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      if (!renderer.getContext()) throw new Error('no GL')
    } catch {
      setFailed(true)
      return undefined
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.setClearColor(0x000000, 0)
    const el = renderer.domElement
    el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab;touch-action:pan-y'
    mount.appendChild(el)

    const scene = new THREE.Scene()
    const textures = []

    // Studio environment (dark room + soft-box panels) for believable reflections.
    const pmrem = new THREE.PMREMGenerator(renderer)
    const env = new THREE.Scene()
    env.add(new THREE.Mesh(new THREE.BoxGeometry(20, 12, 20), new THREE.MeshBasicMaterial({ color: 0x1c2229, side: THREE.BackSide })))
    const panel = (w, h, c, x, y, z, rx = 0, ry = 0) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }))
      m.position.set(x, y, z)
      m.rotation.set(rx, ry, 0)
      env.add(m)
    }
    panel(12, 5, 0xffffff, 0, 5.9, 0, Math.PI / 2)
    panel(5, 6, 0xdfefff, -9.9, 1.5, 2, 0, Math.PI / 2)
    panel(4, 6, 0x8ef3e4, 9.9, 0.5, -3, 0, -Math.PI / 2)
    panel(8, 2.5, 0xffffff, 0, 1.5, -9.9)
    panel(8, 2, 0x9fb3c8, 0, -2, 9.9)
    const envRT = pmrem.fromScene(env, 0.04)
    scene.environment = envRT.texture
    env.traverse((o) => {
      o.geometry?.dispose()
      o.material?.dispose()
    })

    // Physically-based light units (three r155+): intensities are ×π the legacy values.
    scene.add(new THREE.HemisphereLight(0xdfeaff, 0x0b0f14, 1.1))
    const key = new THREE.DirectionalLight(0xffffff, 6.9)
    key.position.set(2.5, 5, 3)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    Object.assign(key.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -2.2, near: 0.5, far: 14 })
    key.shadow.radius = 4
    key.shadow.bias = -0.0005
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x2dd4bf, 4.4)
    rim.position.set(-3, 1.5, -4)
    scene.add(rim)

    const canvasTex = (size, draw, repeat) => {
      const c = document.createElement('canvas')
      c.width = c.height = size
      draw(c.getContext('2d'), size)
      const t = new THREE.CanvasTexture(c)
      t.colorSpace = THREE.SRGBColorSpace
      if (repeat) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.repeat.set(repeat[0], repeat[1])
      }
      t.anisotropy = 4
      textures.push(t)
      return t
    }
    const weave = canvasTex(64, (g, s) => {
      g.fillStyle = '#15181c'
      g.fillRect(0, 0, s, s)
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const odd = (x + y) % 2
          const lg = g.createLinearGradient(x * 16, y * 16, x * 16 + (odd ? 16 : 0), y * 16 + (odd ? 0 : 16))
          lg.addColorStop(0, '#101316')
          lg.addColorStop(0.5, '#2a2f35')
          lg.addColorStop(1, '#101316')
          g.fillStyle = lg
          g.fillRect(x * 16 + 1, y * 16 + 1, 14, 14)
        }
    }, [2, 10])
    const radial = (stops) =>
      canvasTex(128, (g, s) => {
        const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
        stops.forEach(([o, c]) => r.addColorStop(o, c))
        g.fillStyle = r
        g.fillRect(0, 0, s, s)
      })
    const blurTex = radial([[0, 'rgba(255,255,255,0)'], [0.16, 'rgba(255,255,255,0)'], [0.2, 'rgba(255,255,255,.35)'], [0.55, 'rgba(255,255,255,.14)'], [0.9, 'rgba(255,255,255,.3)'], [0.96, 'rgba(255,255,255,.08)'], [1, 'rgba(255,255,255,0)']])
    const glowTex = radial([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,.45)'], [1, 'rgba(255,255,255,0)']])
    const blobTex = radial([[0, 'rgba(0,0,0,.55)'], [0.5, 'rgba(0,0,0,.18)'], [1, 'rgba(0,0,0,0)']])

    const M = {
      shell: new THREE.MeshPhysicalMaterial({ color: 0xe6eaee, roughness: 0.36, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.22 }),
      under: new THREE.MeshStandardMaterial({ color: 0x2b3139, roughness: 0.6, metalness: 0.1 }),
      carbon: new THREE.MeshPhysicalMaterial({ map: weave, roughness: 0.32, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.12 }),
      alu: new THREE.MeshStandardMaterial({ color: 0xb4bcc5, roughness: 0.26, metalness: 1 }),
      aluDark: new THREE.MeshStandardMaterial({ color: 0x3b424b, roughness: 0.34, metalness: 0.9 }),
      black: new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.55, metalness: 0.2 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.92 }),
      prop: new THREE.MeshPhysicalMaterial({ color: 0x15181c, roughness: 0.4, clearcoat: 0.6, transparent: true, opacity: 0.55 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x05080f, roughness: 0.02, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 2.2 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x2dd4bf, emissive: 0x2dd4bf, emissiveIntensity: 1.6, roughness: 0.4 }),
    }
    const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, z)
      m.castShadow = true
      return m
    }
    const UP = new THREE.Vector3(0, 1, 0)
    const tube = (a, b, r1, r2, mat, seg = 16) => {
      const A = new THREE.Vector3(...a)
      const dir = new THREE.Vector3(...b).sub(A)
      const m = mesh(new THREE.CylinderGeometry(r2, r1, dir.length(), seg), mat)
      m.position.copy(A).addScaledVector(dir, 0.5)
      m.quaternion.setFromUnitVectors(UP, dir.normalize())
      return m
    }

    const drone = new THREE.Group()
    scene.add(drone)
    // Fuselage: glossy white top shell over a dark belly, with accent side strips.
    const top = new THREE.CapsuleGeometry(0.27, 0.5, 12, 40)
    top.rotateX(Math.PI / 2)
    top.scale(1.12, 0.52, 1)
    drone.add(mesh(top, M.shell, 0, 0.03, 0))
    const belly = new THREE.CapsuleGeometry(0.25, 0.46, 8, 32)
    belly.rotateX(Math.PI / 2)
    belly.scale(1.08, 0.42, 1)
    drone.add(mesh(belly, M.under, 0, -0.06, 0))
    for (const s of [-1, 1]) drone.add(mesh(new THREE.BoxGeometry(0.012, 0.018, 0.46), M.accent, s * 0.3, 0, 0.02))
    // Battery pack with a 4-LED charge gauge.
    drone.add(mesh(new THREE.BoxGeometry(0.3, 0.09, 0.5), M.black, 0, 0.18, -0.02))
    drone.add(mesh(new THREE.BoxGeometry(0.31, 0.012, 0.51), M.aluDark, 0, 0.225, -0.02))
    const battLeds = [0, 1, 2, 3].map((i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.015), new THREE.MeshBasicMaterial({ color: 0x1b1f24 }))
      m.position.set(-0.06 + i * 0.04, 0.18, -0.275)
      drone.add(m)
      return m
    })
    // GPS mast + puck.
    drone.add(tube([0, 0.23, -0.18], [0, 0.42, -0.2], 0.012, 0.012, M.aluDark, 10))
    drone.add(mesh(new THREE.CylinderGeometry(0.085, 0.09, 0.035, 32), M.shell, 0, 0.44, -0.2))
    drone.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.008, 32), M.black, 0, 0.46, -0.2))
    // Front obstacle sensors.
    for (const s of [-1, 1]) drone.add(mesh(new THREE.SphereGeometry(0.028, 16, 12), M.glass, s * 0.075, 0.04, 0.53))
    // Camera gimbal under the nose.
    const gimbal = new THREE.Group()
    gimbal.position.set(0, -0.17, 0.36)
    drone.add(gimbal)
    gimbal.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 16), M.aluDark, 0, 0.05, 0))
    for (const s of [-1, 1]) gimbal.add(mesh(new THREE.BoxGeometry(0.018, 0.13, 0.05), M.aluDark, s * 0.085, -0.02, 0))
    gimbal.add(mesh(new THREE.BoxGeometry(0.15, 0.11, 0.12), M.black, 0, -0.05, 0))
    const lens = new THREE.CylinderGeometry(0.042, 0.046, 0.04, 32)
    lens.rotateX(Math.PI / 2)
    gimbal.add(mesh(lens, M.glass, 0, -0.05, 0.075))
    gimbal.add(mesh(new THREE.TorusGeometry(0.046, 0.007, 10, 32), M.alu, 0, -0.05, 0.094))

    // Two-blade propeller geometry (shared by all four rotors).
    const blade = new THREE.Shape()
    blade.moveTo(0.03, -0.022)
    blade.bezierCurveTo(0.12, -0.058, 0.32, -0.05, 0.5, -0.014)
    blade.quadraticCurveTo(0.535, 0, 0.5, 0.013)
    blade.bezierCurveTo(0.32, 0.028, 0.12, 0.038, 0.03, 0.022)
    blade.closePath()
    const bladeGeo = new THREE.ExtrudeGeometry(blade, { depth: 0.007, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2, curveSegments: 18 })
    bladeGeo.translate(0, 0, -0.0035)
    bladeGeo.rotateX(Math.PI / 2)
    const discMat = new THREE.MeshBasicMaterial({ map: blurTex, color: 0x9aa7b4, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })

    // Arms, motors, props and navigation lights (front: red port / green starboard, rear: white strobes).
    const props = []
    const strobes = []
    ;[[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([sx, sz], i) => {
      const ang = Math.atan2(sz, sx)
      const x = Math.cos(ang)
      const z = Math.sin(ang)
      const dir = i % 2 === 0 ? 1 : -1
      drone.add(tube([x * 0.22, -0.01, z * 0.22], [x, -0.01, z], 0.062, 0.045, M.carbon, 20))
      drone.add(tube([x * 0.2, -0.07, z * 0.2], [x * 0.55, -0.03, z * 0.55], 0.02, 0.015, M.aluDark, 10))
      drone.add(mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.06, 36), M.aluDark, x, -0.01, z))
      drone.add(mesh(new THREE.CylinderGeometry(0.098, 0.098, 0.1, 48), M.alu, x, 0.07, z))
      drone.add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.028, 48, 1, true), M.black, x, 0.055, z))
      drone.add(mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.022, 36), i < 2 ? M.black : M.aluDark, x, 0.13, z))
      drone.add(mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.04, 12), M.alu, x, 0.155, z))
      const prop = new THREE.Group()
      prop.position.set(x, 0.16, z)
      drone.add(prop)
      for (const r of [0, Math.PI]) {
        const b = new THREE.Mesh(bladeGeo, M.prop)
        b.rotation.set(0.22 * dir, r, 0)
        b.castShadow = true
        prop.add(b)
      }
      prop.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.025, 24), i < 2 ? M.alu : M.black))
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.54, 64), discMat)
      disc.rotation.x = -Math.PI / 2
      disc.position.set(x, 0.165, z)
      drone.add(disc)
      props.push({ g: prop, dir })
      const col = sz > 0 ? (sx < 0 ? 0xff3b3b : 0x35ff8a) : 0xffffff
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 10), new THREE.MeshBasicMaterial({ color: col }))
      led.position.set(x * 0.93, -0.05, z * 0.93)
      drone.add(led)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }))
      glow.scale.set(0.22, 0.22, 1)
      glow.position.copy(led.position)
      drone.add(glow)
      if (sz < 0) strobes.push(led, glow)
    })
    // Landing gear.
    for (const s of [-1, 1]) {
      for (const f of [-1, 1]) drone.add(tube([s * 0.15, -0.12, f * 0.17], [s * 0.33, -0.6, f * 0.22], 0.017, 0.014, M.carbon, 12))
      drone.add(tube([s * 0.33, -0.62, -0.42], [s * 0.33, -0.62, 0.42], 0.022, 0.022, M.rubber, 14))
      for (const f of [-1, 1]) drone.add(mesh(new THREE.SphereGeometry(0.024, 12, 10), M.rubber, s * 0.33, -0.62, f * 0.42))
    }

    // Ground: real shadow + soft contact blob + landing-pad rings in the theme accent.
    const gy = -1.05
    const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.32 }))
    shadowPlane.rotation.x = -Math.PI / 2
    shadowPlane.position.y = gy
    shadowPlane.receiveShadow = true
    scene.add(shadowPlane)
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }))
    blob.rotation.x = -Math.PI / 2
    blob.position.y = gy + 0.002
    scene.add(blob)
    const padMat = new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide })
    for (const [a, b] of [[1.5, 1.52], [1.1, 1.11]]) {
      const r = new THREE.Mesh(new THREE.RingGeometry(a, b, 128), padMat)
      r.rotation.x = -Math.PI / 2
      r.position.y = gy + 0.003
      scene.add(r)
    }
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2
      const t = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.16), padMat)
      t.rotation.set(-Math.PI / 2, 0, a)
      t.position.set(Math.sin(a) * 1.62, gy + 0.003, Math.cos(a) * 1.62)
      scene.add(t)
    }

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)
    const view = { yaw: -0.7, elev: 0.3, drag: null, idleAt: 0 }
    let dirty = true
    const size = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.fov = w / h < 1.2 ? 40 : 30
      camera.updateProjectionMatrix()
      dirty = true
    }
    const ro = new ResizeObserver(size)
    ro.observe(mount)
    size()
    let onScreen = true
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting
      dirty = true
    })
    io.observe(mount)

    const onDown = (e) => {
      view.drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, elev: view.elev }
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
    }
    const onMove = (e) => {
      if (!view.drag) return
      view.yaw = view.drag.yaw - (e.clientX - view.drag.x) * 0.01
      view.elev = Math.max(0.02, Math.min(0.9, view.drag.elev + (e.clientY - view.drag.y) * 0.006))
      dirty = true
    }
    const onUp = () => {
      view.drag = null
      view.idleAt = performance.now()
      el.style.cursor = 'grab'
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)

    // Theme accent + battery gauge are refreshed about once a second, not per frame.
    let lastSync = -1e9
    let lastBatt = null
    const sync = (now) => {
      if (now - lastSync < 1000) return
      lastSync = now
      const accent = getComputedStyle(mount).getPropertyValue('--hd-accent').trim()
      if (accent) padMat.color.set(accent)
      const b = batteryRef.current
      if (b !== lastBatt) {
        lastBatt = b
        const lit = b == null ? 0 : Math.ceil(Math.max(0, Math.min(1, b)) * 4)
        const on = b != null && b < 0.2 ? 0xef4444 : 0x34d399
        battLeds.forEach((m, i) => m.material.color.set(i < lit ? on : 0x1b1f24))
      }
      dirty = true
    }

    let raf = 0
    let last = performance.now()
    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!onScreen || document.hidden) return
      sync(now)
      const t = now / 1000
      if (!reduce) {
        if (!view.drag && now - view.idleAt > 2500) view.yaw += dt * 0.22
        const bob = Math.sin(t * 1.7) * 0.045
        drone.position.y = bob
        drone.rotation.x = Math.sin(t * 1.1) * 0.025 + 0.03
        drone.rotation.z = Math.cos(t * 0.9) * 0.03
        for (const p of props) p.g.rotation.y += p.dir * dt * 38
        gimbal.rotation.x = Math.sin(t * 0.5) * 0.08
        const lit = t % 1.3 < 0.09
        for (const s of strobes) s.visible = lit
        const k = 1 - bob * 1.5
        blob.scale.set(k, k, 1)
        blob.material.opacity = 0.9 - bob * 2
        dirty = true
      }
      if (!dirty) return
      dirty = false
      const r = 4.0
      camera.position.set(Math.sin(view.yaw) * Math.cos(view.elev) * r, Math.sin(view.elev) * r - 0.1, Math.cos(view.yaw) * Math.cos(view.elev) * r)
      camera.lookAt(0, -0.38, 0)
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      scene.traverse((o) => {
        o.geometry?.dispose()
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
      })
      textures.forEach((t) => t.dispose())
      envRT.dispose()
      pmrem.dispose()
      renderer.forceContextLoss() // browsers cap live GL contexts at ~16
      renderer.dispose()
      if (el.parentNode === mount) mount.removeChild(el)
    }
  }, [])

  return (
    <div ref={mountRef} className="absolute inset-0" aria-label="3D model of the VARUNA-01 drone — drag to rotate" role="img">
      {failed && <div className="grid h-full place-items-center text-xs" style={{ color: 'var(--hd-muted)' }}>3D preview needs WebGL</div>}
    </div>
  )
}
