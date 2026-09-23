import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { buildQuadcopter } from '../lib/drone3d'

/**
 * Rotating drone viewport. Two modes:
 *  - wire=true  → holographic green wireframe with a sweeping scan grid (the
 *                 "diagnostic reveal" on the home Diagnostics widget)
 *  - wire=false → a lit, solid realistic drone (mission-planner aircraft preview)
 * Compact, transparent, phone-safe (dpr capped, pauses when hidden, disposes).
 */
export default function HoloDrone({ height = 150, wire = true, color }) {
  const mountRef = useRef(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    } catch {
      return
    }
    if (!renderer.getContext()) return
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const W = () => mount.clientWidth || 260
    const H = () => mount.clientHeight || height
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setSize(W(), H())
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)
    Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' })

    const accent = color ?? (wire ? 0x34d399 : 0x3b9eff)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, W() / H(), 0.1, 100)
    camera.position.set(0, 1.5, 6.4)
    camera.lookAt(0, 0, 0)

    if (!wire) {
      scene.add(new THREE.HemisphereLight(0xdfefff, 0x0a0e14, 1.1))
      const key = new THREE.DirectionalLight(0xffffff, 1.5)
      key.position.set(4, 8, 6)
      scene.add(key)
      const fill = new THREE.PointLight(accent, 1.6, 25)
      fill.position.set(-5, 2, 4)
      scene.add(fill)
    }

    const { group: drone, rotors } = buildQuadcopter(THREE, { wire, color: accent })
    scene.add(drone)

    // scan plane + grid (diagnostic mode only)
    let scan = null, grid = null
    if (wire) {
      scan = new THREE.Mesh(
        new THREE.PlaneGeometry(4.2, 4.2),
        new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })
      )
      scan.rotation.x = -Math.PI / 2
      scene.add(scan)
      const gridMat = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.5 })
      const gpts = []
      for (let i = -2; i <= 2; i++) {
        gpts.push(new THREE.Vector3(i, 0, -2), new THREE.Vector3(i, 0, 2))
        gpts.push(new THREE.Vector3(-2, 0, i), new THREE.Vector3(2, 0, i))
      }
      grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gpts), gridMat)
      grid.position.y = -1.1
      scene.add(grid)
    }

    let raf = 0, running = true, t = 0
    const clock = new THREE.Clock()
    const render = () => renderer.render(scene, camera)
    function loop() {
      if (!running) return
      const dt = Math.min(clock.getDelta(), 0.05)
      t += dt
      drone.rotation.y += dt * 0.5
      drone.position.y = Math.sin(t * 1.1) * 0.12
      drone.rotation.z = Math.sin(t * 0.6) * 0.05
      for (const r of rotors) r.rotation.y += dt * 42
      if (scan) {
        const sy = ((t * 0.6) % 2) - 1
        scan.position.y = sy * 1.2
        scan.material.opacity = 0.16 * (1 - Math.abs(sy))
      }
      render()
      raf = requestAnimationFrame(loop)
    }
    function onVis() {
      if (document.hidden) { running = false; cancelAnimationFrame(raf) }
      else if (!reduce) { running = true; clock.getDelta(); loop() }
    }
    function onResize() { camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); render() }
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
  }, [height, wire, color])

  return <div ref={mountRef} style={{ height }} className="w-full" aria-hidden="true" />
}
