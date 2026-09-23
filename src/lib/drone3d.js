// Shared procedural quadcopter builder used by the intro scene and the
// holographic diagnostics view. Original, more-realistic model built from
// primitives (no external model asset — keeps the bundle lean & same-origin).
// Pass the THREE namespace in so callers control the import.
//
// Returns { group, rotors } where rotors is an array of spinnable propeller
// groups (rotate each around its local Y).

export function buildQuadcopter(THREE, { wire = false, color = 0x3b9eff } = {}) {
  const group = new THREE.Group()
  const rotors = []

  const std = (opts) =>
    wire
      ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.5 })
      : new THREE.MeshStandardMaterial(opts)

  const carbon = std({ color: 0x1a1e24, metalness: 0.65, roughness: 0.4 })
  const shell = std({ color: 0x2b3138, metalness: 0.5, roughness: 0.5 })
  const plastic = std({ color: 0x11151a, metalness: 0.3, roughness: 0.7 })
  const glass = std({ color: 0x05070a, metalness: 0.9, roughness: 0.15 })
  const accentMat = wire
    ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
    : new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4, metalness: 0.3, roughness: 0.3 })
  const led = (hex) =>
    wire
      ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
      : new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 2.2 })

  // --- Fuselage: sleek tapered body (capsule + canopy) ---
  const bodyLen = 1.5
  const body = new THREE.Mesh(
    THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(0.32, bodyLen - 0.64, 8, 16) : new THREE.CylinderGeometry(0.32, 0.32, bodyLen, 20),
    shell
  )
  body.rotation.z = Math.PI / 2 // lay along X
  body.scale.set(1, 1, 0.72) // flatten it a little
  group.add(body)

  // top canopy (dark glossy)
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), glass)
  canopy.scale.set(0.95, 0.55, 0.62)
  canopy.position.set(0.12, 0.18, 0)
  group.add(canopy)

  // underside accent strip (nav glow)
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.34), accentMat)
  strip.position.y = -0.2
  group.add(strip)

  // --- Camera gimbal under the nose ---
  const gimbal = new THREE.Group()
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 16), carbon)
  gimbal.add(ball)
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.1, 16), glass)
  lens.rotation.x = Math.PI / 2
  lens.position.set(0, -0.02, 0.14)
  gimbal.add(lens)
  const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.015, 8, 20), accentMat)
  lensRing.position.set(0, -0.02, 0.15)
  gimbal.add(lensRing)
  gimbal.position.set(0.5, -0.24, 0)
  group.add(gimbal)

  // --- Arms + motors + props (X configuration) ---
  const reach = 1.05
  const corners = [
    [reach, reach, 0xffffff],
    [reach, -reach, 0xffffff],
    [-reach, reach, 0xff3b30],
    [-reach, -reach, 0xff3b30],
  ]
  corners.forEach(([x, z, ledColor]) => {
    const len = Math.hypot(x, z)
    const ang = Math.atan2(z, x)

    // tapered arm (cylinder from body to motor)
    const armMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, len, 12), carbon)
    armMesh.rotation.z = Math.PI / 2
    armMesh.rotation.y = -ang
    armMesh.position.set(x / 2, -0.03, z / 2)
    group.add(armMesh)

    // motor pod
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.2, 18), plastic)
    motor.position.set(x, 0.02, z)
    group.add(motor)
    const motorCap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.05, 18), accentMat)
    motorCap.position.set(x, 0.13, z)
    group.add(motorCap)

    // nav LED at the pod
    const navLed = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), led(ledColor))
    navLed.position.set(x, -0.06, z)
    group.add(navLed)

    // two-blade propeller (spins)
    const prop = new THREE.Group()
    const bladeGeo = new THREE.BoxGeometry(0.9, 0.015, 0.11)
    for (let b = 0; b < 2; b++) {
      const blade = new THREE.Mesh(
        bladeGeo,
        wire ? accentMat : new THREE.MeshStandardMaterial({ color: 0x0d1013, metalness: 0.2, roughness: 0.7, transparent: true, opacity: 0.85 })
      )
      blade.rotation.y = b * (Math.PI / 2)
      // slight taper by scaling one end
      prop.add(blade)
    }
    // faint motion-blur disc
    if (!wire) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.46, 24),
        new THREE.MeshBasicMaterial({ color: 0x9fb2c8, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })
      )
      disc.rotation.x = -Math.PI / 2
      prop.add(disc)
    }
    prop.position.set(x, 0.18, z)
    group.add(prop)
    rotors.push(prop)
  })

  // --- Landing skids ---
  ;[-0.35, 0.35].forEach((zoff) => {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), plastic)
    skid.rotation.z = Math.PI / 2
    skid.position.set(0, -0.4, zoff)
    group.add(skid)
    ;[-0.32, 0.32].forEach((xoff) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 8), plastic)
      leg.position.set(xoff, -0.28, zoff)
      group.add(leg)
    })
  })

  return { group, rotors }
}
