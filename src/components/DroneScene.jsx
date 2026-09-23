import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/**
 * The one signature 3D moment: a procedural quadcopter flying over an infinite
 * scrolling neon grid, rendered behind the Dashboard. Built from primitives so
 * it needs no external model/asset and stays light. Phone-safe:
 *   - pixel ratio capped at 2
 *   - render loop pauses while the tab is hidden
 *   - honours prefers-reduced-motion (renders a single static frame)
 *   - degrades to nothing (the CSS ambient shows through) if WebGL is missing
 *   - fully disposes GL resources on unmount
 * Transparent canvas + light fog keep it on-brand with the light theme.
 */
export default function DroneScene() {
  const mountRef = useRef(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
    } catch {
      return // no WebGL — leave the CSS ambient background as-is
    }
    if (!renderer.getContext()) return

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const width = () => mount.clientWidth || window.innerWidth
    const height = () => mount.clientHeight || window.innerHeight

    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setSize(width(), height())
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)
    Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' })

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0xeaf3f8, 14, 42)

    const camera = new THREE.PerspectiveCamera(50, width() / height(), 0.1, 100)
    // Aimed high so the drone flies in the open "sky band" at the top of the page,
    // above the cards, while the grid horizon recedes below.
    camera.position.set(0, 2.2, 10.5)
    camera.lookAt(0, 0.4, 0)

    // --- Lights ---
    scene.add(new THREE.HemisphereLight(0xffffff, 0xbcd3e6, 1.05))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(6, 12, 8)
    scene.add(key)
    const cyanFill = new THREE.PointLight(0x22d3ee, 1.4, 30)
    cyanFill.position.set(-6, 4, 4)
    scene.add(cyanFill)

    const CYAN = new THREE.Color(0x06b6d4)

    // --- Infinite scrolling neon grid (shader plane, fades to transparent) ---
    const gridUniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x06b6d4) },
      uFade: { value: 30.0 },
    }
    const grid = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120, 1, 1),
      new THREE.ShaderMaterial({
        transparent: true,
        uniforms: gridUniforms,
        vertexShader: `
          varying vec3 vWorld;
          void main() {
            vWorld = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vWorld;
          uniform float uTime;
          uniform vec3 uColor;
          uniform float uFade;
          float gridLine(vec2 p, float w) {
            vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
            float l = min(g.x, g.y);
            return 1.0 - min(l * w, 1.0);
          }
          void main() {
            vec2 coord = vec2(vWorld.x, vWorld.y + uTime * 2.2);
            float minor = gridLine(coord * 1.0, 1.2);
            float major = gridLine(coord * 0.25, 1.6) * 0.9;
            float line = max(minor * 0.5, major);
            float dist = length(vWorld.xy);
            float fade = smoothstep(uFade, 4.0, dist);
            float alpha = line * fade * 0.6;
            if (alpha < 0.01) discard;
            gl_FragColor = vec4(uColor, alpha);
          }
        `,
      })
    )
    grid.rotation.x = -Math.PI / 2
    grid.position.y = -1.4
    scene.add(grid)

    // --- Drone (procedural quadcopter) ---
    const drone = new THREE.Group()
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, metalness: 0.5, roughness: 0.35 })
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.6, roughness: 0.4 })
    const accentMat = new THREE.MeshStandardMaterial({ color: 0x06b6d4, emissive: 0x06b6d4, emissiveIntensity: 1.3, metalness: 0.3, roughness: 0.3 })
    const propMat = new THREE.MeshStandardMaterial({ color: 0x334155, transparent: true, opacity: 0.28, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide })

    // central hub
    const hub = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 1.0), bodyMat)
    drone.add(hub)
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), darkMat)
    canopy.scale.set(1.0, 0.7, 0.7)
    canopy.position.set(0.15, 0.16, 0)
    drone.add(canopy)
    // underside cyan glow strip
    const strip = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 0.5), accentMat)
    strip.position.y = -0.18
    drone.add(strip)

    const rotors = []
    const arm = 1.15
    const positions = [
      [arm, 0.7], [arm, -0.7], [-arm, 0.7], [-arm, -0.7],
    ]
    positions.forEach(([x, z]) => {
      const armMesh = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x) + 0.2, 0.12, 0.16), darkMat)
      armMesh.position.set(x / 2, -0.02, z)
      drone.add(armMesh)
      const armZ = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, Math.abs(z) + 0.2), darkMat)
      armZ.position.set(x, -0.02, z / 2)
      drone.add(armZ)

      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.24, 18), bodyMat)
      motor.position.set(x, 0.02, z)
      drone.add(motor)

      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), accentMat)
      tip.position.set(x, 0.16, z)
      drone.add(tip)

      // propeller disc (fast spin gives a motion-blur read via low opacity)
      const prop = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.02, 28), propMat)
      prop.position.set(x, 0.2, z)
      drone.add(prop)
      rotors.push(prop)
    })
    drone.position.y = 3.0
    drone.scale.setScalar(1.15)
    scene.add(drone)

    // soft contact shadow under the drone
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 32),
      new THREE.MeshBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.14 })
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = -1.38
    scene.add(shadow)

    // --- Drifting data particles ---
    const pCount = 90
    const pGeo = new THREE.BufferGeometry()
    const pPos = new Float32Array(pCount * 3)
    for (let i = 0; i < pCount; i++) {
      pPos[i * 3] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 24 - 12
      pPos[i * 3 + 1] = ((Math.sin(i * 78.233) * 43758.5453 % 1) + 1) * 4
      pPos[i * 3 + 2] = (Math.sin(i * 37.719) * 43758.5453 % 1) * 20 - 12
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
    const particles = new THREE.Points(
      pGeo,
      new THREE.PointsMaterial({ color: CYAN, size: 0.06, transparent: true, opacity: 0.55, depthWrite: false })
    )
    scene.add(particles)

    // --- Render loop ---
    let raf = 0
    let running = true
    let t = 0
    const clock = new THREE.Clock()

    function renderFrame() {
      renderer.render(scene, camera)
    }
    function loop() {
      if (!running) return
      const dt = Math.min(clock.getDelta(), 0.05)
      t += dt
      gridUniforms.uTime.value = t
      // drone gently bobs, banks, and yaws — "hovering with intent"
      drone.position.y = 3.0 + Math.sin(t * 1.1) * 0.2
      drone.position.x = Math.sin(t * 0.4) * 1.4
      drone.rotation.z = Math.sin(t * 0.4 + 1) * 0.12
      drone.rotation.y = Math.sin(t * 0.25) * 0.35
      shadow.position.x = drone.position.x
      const s = 1 + Math.sin(t * 1.1) * 0.05
      shadow.scale.set(s, s, s)
      for (const r of rotors) r.rotation.y += dt * 60
      particles.rotation.y = t * 0.03
      const pa = particles.geometry.attributes.position
      for (let i = 0; i < pCount; i++) {
        pa.array[i * 3 + 1] += dt * 0.35
        if (pa.array[i * 3 + 1] > 8) pa.array[i * 3 + 1] = 0
      }
      pa.needsUpdate = true
      renderFrame()
      raf = requestAnimationFrame(loop)
    }

    function onResize() {
      camera.aspect = width() / height()
      camera.updateProjectionMatrix()
      renderer.setSize(width(), height())
      renderFrame()
    }
    function onVisibility() {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!reduce) {
        running = true
        clock.getDelta()
        loop()
      }
    }

    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)

    if (reduce) renderFrame() // single static frame, no animation
    else loop()

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach((m) => m.dispose())
        }
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
}
