import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { buildQuadcopter } from '../lib/drone3d'

/**
 * Cinematic intro backdrop: a quadcopter flying over a dark river, projecting a
 * scan cone + expanding scan rings that sweep over drifting debris ("diagnosing
 * river waste"). Original scene, no external assets. Phone-safe: dpr capped,
 * pauses when hidden, honours reduced-motion, disposes on unmount, and if WebGL
 * is unavailable it simply renders nothing (CSS gradient shows through).
 */
export default function IntroScene() {
  const mountRef = useRef(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
    } catch {
      return
    }
    if (!renderer.getContext()) return

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const W = () => mount.clientWidth || window.innerWidth
    const H = () => mount.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setSize(W(), H())
    renderer.setClearColor(0x05080a, 1)
    mount.appendChild(renderer.domElement)
    Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' })

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x05080a, 0.02)
    const camera = new THREE.PerspectiveCamera(52, W() / H(), 0.1, 200)
    camera.position.set(0, 6, 16)
    camera.lookAt(0, 1.5, -2)

    scene.add(new THREE.HemisphereLight(0x9fc7d6, 0x0a1014, 0.9))
    const key = new THREE.DirectionalLight(0xbfe6ff, 1.1)
    key.position.set(-8, 14, 6)
    scene.add(key)
    const orange = new THREE.PointLight(0xf26b2e, 2.0, 40)
    scene.add(orange)

    // --- Water (animated wave shader) ---
    const waterUniforms = { uTime: { value: 0 } }
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200, 120, 120),
      new THREE.ShaderMaterial({
        uniforms: waterUniforms,
        transparent: true,
        vertexShader: `
          uniform float uTime; varying float vH; varying vec2 vUv;
          void main(){
            vUv = uv; vec3 p = position;
            float w = sin(p.x*0.35 + uTime*1.2)*0.35 + cos(p.y*0.3 + uTime*0.9)*0.3
                    + sin((p.x+p.y)*0.15 + uTime*0.6)*0.25;
            p.z += w; vH = w;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
          }`,
        fragmentShader: `
          precision highp float; varying float vH; varying vec2 vUv;
          void main(){
            vec3 deep = vec3(0.02,0.09,0.11);
            vec3 shal = vec3(0.05,0.20,0.22);
            vec3 col = mix(deep, shal, smoothstep(-0.5,0.6,vH));
            col += vec3(0.10,0.45,0.42) * pow(max(vH,0.0),2.0)*0.6; // crests
            float d = distance(vUv, vec2(0.5));
            col *= smoothstep(0.85,0.2,d)+0.15; // vignette toward edges
            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    )
    water.rotation.x = -Math.PI / 2
    water.position.y = 0
    scene.add(water)

    // --- Drifting debris on the water ---
    const debris = []
    const debrisGeo = new THREE.BoxGeometry(0.5, 0.16, 0.7)
    const debrisMat = new THREE.MeshStandardMaterial({ color: 0x2a2f2c, roughness: 0.9 })
    for (let i = 0; i < 22; i++) {
      const m = new THREE.Mesh(debrisGeo, debrisMat)
      const a = (i * 2.399) % (Math.PI * 2)
      const r = 3 + ((i * 7) % 18)
      m.position.set(Math.cos(a) * r, 0.1, -4 + Math.sin(a) * r * 0.6)
      m.rotation.y = a
      m.scale.setScalar(0.6 + ((i * 13) % 10) / 10)
      scene.add(m)
      // marker ring for "detected debris"
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.62, 20),
        new THREE.MeshBasicMaterial({ color: 0xf26b2e, transparent: true, opacity: 0, side: THREE.DoubleSide })
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.copy(m.position)
      ring.position.y = 0.12
      scene.add(ring)
      debris.push({ m, ring, base: m.position.clone(), phase: i })
    }

    // --- Drone + scan cone ---
    const { group: drone, rotors } = buildQuadcopter(THREE, { wire: false })
    drone.scale.setScalar(0.9)
    drone.position.set(0, 4.5, 2)
    scene.add(drone)

    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(2.4, 4.4, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
    )
    cone.position.set(0, 2.3, 2)
    scene.add(cone)

    // expanding scan ring on the water
    const scan = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.35, 48),
      new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
    )
    scan.rotation.x = -Math.PI / 2
    scan.position.set(0, 0.14, 2)
    scene.add(scan)

    let raf = 0, running = true, t = 0
    const clock = new THREE.Clock()
    const render = () => renderer.render(scene, camera)

    function loop() {
      if (!running) return
      const dt = Math.min(clock.getDelta(), 0.05)
      t += dt
      waterUniforms.uTime.value = t
      // drone hover + drift
      drone.position.x = Math.sin(t * 0.5) * 3
      drone.position.z = 2 + Math.cos(t * 0.35) * 2
      drone.position.y = 4.5 + Math.sin(t * 1.2) * 0.25
      drone.rotation.z = Math.sin(t * 0.5) * 0.12
      drone.rotation.y = Math.sin(t * 0.3) * 0.4
      for (const r of rotors) r.rotation.y += dt * 55
      cone.position.x = drone.position.x
      cone.position.z = drone.position.z
      orange.position.set(drone.position.x, 2.5, drone.position.z)
      // scan ring expands under the drone and resets
      const sc = (t % 3) / 3
      scan.position.x = drone.position.x
      scan.position.z = drone.position.z
      scan.scale.setScalar(0.5 + sc * 10)
      scan.material.opacity = 0.6 * (1 - sc)
      // debris bob + highlight when the scan passes
      const scanR = (0.5 + sc * 10) * 0.35
      for (const d of debris) {
        d.m.position.y = 0.1 + Math.sin(t * 1.4 + d.phase) * 0.06
        const dist = Math.hypot(d.base.x - scan.position.x, d.base.z - scan.position.z)
        const near = Math.abs(dist - scanR) < 1.2
        d.ring.material.opacity += ((near ? 0.9 : 0) - d.ring.material.opacity) * 0.1
        d.ring.position.y = 0.13
      }
      // slow cinematic camera drift
      camera.position.x = Math.sin(t * 0.12) * 2
      camera.lookAt(drone.position.x * 0.4, 1.6, 0)
      render()
      raf = requestAnimationFrame(loop)
    }
    function onResize() {
      camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); render()
    }
    function onVis() {
      if (document.hidden) { running = false; cancelAnimationFrame(raf) }
      else if (!reduce) { running = true; clock.getDelta(); loop() }
    }
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVis)
    if (reduce) render(); else loop()

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
}
