import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeStatic, hideSmallFromMirror } from './sceneOptim'
import { SURFACE_LAYER } from './riverScene'

// JAL DHARA — the Varuna collection boat, modelled on the real build: a white
// EPS-foam tub with rounded corners, a foam partition that walls off the
// electronics bay at the stern (Pixhawk, Raspberry Pi, ESCs, LiPo), an open
// collection bay amidships, and a mesh conveyor ramp at the bow driven by two
// yellow TT gear motors. Added kit: GPS mast, telemetry whips, a vision
// camera watching the belt, a status LED bar, nav lights and twin thrusters.
//
// Local frame: +z is the bow, y = 0 is the waterline, units match the drone.

const HULL = { hw: 1.3, hl: 2.2, r: 0.72, wall: 0.24, bottom: -0.3, rim: 0.5, floor: 0.04 }
const PARTITION_Z = -0.86
const RAMP_TOP = new THREE.Vector3(0, 0.6, 2.05)
const RAMP_FOOT = new THREE.Vector3(0, -0.16, 3.85)
const ROLLER_R = 0.07
const BELT_W = 0.9

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d'), w, h)
  const t = new THREE.CanvasTexture(c)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function roundedRect(hw, hl, r) {
  const s = new THREE.Shape()
  s.moveTo(-hw + r, -hl)
  s.lineTo(hw - r, -hl)
  s.quadraticCurveTo(hw, -hl, hw, -hl + r)
  s.lineTo(hw, hl - r)
  s.quadraticCurveTo(hw, hl, hw - r, hl)
  s.lineTo(-hw + r, hl)
  s.quadraticCurveTo(-hw, hl, -hw, hl - r)
  s.lineTo(-hw, -hl + r)
  s.quadraticCurveTo(-hw, -hl, -hw + r, -hl)
  return s
}

function tube(points, r, mat, seg = 40) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)))
  return new THREE.Mesh(new THREE.TubeGeometry(curve, seg, r, 6, false), mat)
}

function makeTextures() {
  // Expanded-polystyrene: lumpy bead texture used as a bump map.
  const foamBump = canvasTex(
    256,
    256,
    (g, w, h) => {
      g.fillStyle = '#808080'
      g.fillRect(0, 0, w, h)
      let s = 17
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
      for (let i = 0; i < 1600; i++) {
        const x = rnd() * w
        const y = rnd() * h
        const r = 2 + rnd() * 4
        const gr = g.createRadialGradient(x, y, 0, x, y, r)
        const v = 150 + rnd() * 80
        gr.addColorStop(0, `rgba(${v},${v},${v},0.9)`)
        gr.addColorStop(1, 'rgba(90,90,90,0)')
        g.fillStyle = gr
        g.beginPath()
        g.arc(x, y, r, 0, Math.PI * 2)
        g.fill()
      }
    },
    false,
  )
  foamBump.wrapS = foamBump.wrapT = THREE.RepeatWrapping
  foamBump.repeat.set(3, 3)

  // Conveyor belt: white mesh fabric with grey mesh windows between white straps.
  const belt = canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#ece9e1'
    g.fillRect(0, 0, w, h)
    for (let k = 0; k < 2; k++) {
      const y0 = k * 128 + 22
      g.fillStyle = '#8e8f8c'
      g.fillRect(14, y0, w - 28, 84)
      g.strokeStyle = 'rgba(40,40,40,0.35)'
      g.lineWidth = 1
      for (let x = 14; x < w - 14; x += 4) {
        g.beginPath()
        g.moveTo(x, y0)
        g.lineTo(x, y0 + 84)
        g.stroke()
      }
      for (let y = y0; y < y0 + 84; y += 4) {
        g.beginPath()
        g.moveTo(14, y)
        g.lineTo(w - 14, y)
        g.stroke()
      }
    }
    g.fillStyle = 'rgba(0,0,0,0.08)'
    g.fillRect(0, 0, 6, h)
    g.fillRect(w - 6, 0, 6, h)
  })
  belt.wrapS = belt.wrapT = THREE.RepeatWrapping
  belt.repeat.set(1, 2)

  const pixhawk = canvasTex(128, 192, (g, w, h) => {
    g.fillStyle = '#1b1c1f'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#2a2b30'
    g.fillRect(6, 6, w - 12, h - 12)
    g.fillStyle = '#f2f2f2'
    g.font = 'italic bold 22px Arial'
    g.save()
    g.translate(w / 2, h / 2 + 30)
    g.rotate(-Math.PI / 2)
    g.fillText('pixhawk', -40, 8)
    g.restore()
    g.fillStyle = '#d9d9d9'
    for (let i = 0; i < 8; i++) g.fillRect(14 + i * 13, 12, 8, 6)
    g.fillStyle = '#c33'
    g.fillRect(14, h - 22, 18, 10)
  })

  const lipo = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#121214'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#c9ccd1'
    g.fillRect(0, 34, w, 40)
    g.fillStyle = '#f5c518'
    g.fillRect(0, 74, w, 8)
    g.fillStyle = '#111'
    g.font = 'bold 22px Arial'
    g.fillText('LiPo 3S  5200mAh', 20, 62)
    g.fillStyle = '#ddd'
    g.font = '13px Arial'
    g.fillText('11.1V  35C', 20, 106)
  })

  const decal = canvasTex(1024, 144, (g, w, h) => {
    g.clearRect(0, 0, w, h)
    g.fillStyle = '#0b2a3a'
    g.font = '900 64px Arial'
    g.fillText('VARUNA', 24, 74)
    g.fillStyle = '#0891b2'
    g.fillText('AI', 300, 74)
    g.fillStyle = '#123'
    g.font = '700 34px Arial'
    g.fillText('JAL DHARA  ·  RIVER CLEANUP', 410, 70)
    const lg = g.createLinearGradient(0, 0, w, 0)
    lg.addColorStop(0, '#22d3ee')
    lg.addColorStop(1, '#8b5cf6')
    g.fillStyle = lg
    g.fillRect(24, 96, w - 48, 9)
  })

  const gpsTop = canvasTex(128, 128, (g, w) => {
    g.fillStyle = '#222428'
    g.fillRect(0, 0, w, w)
    g.strokeStyle = '#e8e8e8'
    g.lineWidth = 4
    g.beginPath()
    g.arc(w / 2, w / 2, 30, 0, Math.PI * 2)
    g.stroke()
    g.fillStyle = '#e8e8e8'
    g.beginPath()
    g.moveTo(w / 2, w / 2 - 22)
    g.lineTo(w / 2 + 10, w / 2 + 8)
    g.lineTo(w / 2 - 10, w / 2 + 8)
    g.fill()
  })

  return { foamBump, belt, pixhawk, lipo, decal, gpsTop }
}

export function buildJalDhara(envMap) {
  const tex = makeTextures()
  const env = (m, k = 1) => {
    m.envMap = envMap
    m.envMapIntensity = k
    return m
  }
  const foam = env(
    new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.93, metalness: 0, bumpMap: tex.foamBump, bumpScale: 0.6 }),
    0.22,
  )
  const foamPlain = env(new THREE.MeshStandardMaterial({ color: 0xf1f0ea, roughness: 0.95, bumpMap: tex.foamBump, bumpScale: 0.5 }), 0.22)
  const board = env(new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.7 }), 0.4)
  const pvc = env(new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.35 }), 0.6)
  const beltMat = env(new THREE.MeshStandardMaterial({ map: tex.belt, roughness: 0.85, side: THREE.DoubleSide }), 0.35)
  const beltUnder = new THREE.MeshStandardMaterial({ color: 0x77766f, roughness: 0.9 })
  const yellow = env(new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.45 }), 0.6)
  const silver = env(new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.9, roughness: 0.3 }), 1)
  const black = env(new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.55, metalness: 0.2 }), 0.6)
  const carbon = env(new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.35, metalness: 0.5 }), 0.8)
  const pcb = env(new THREE.MeshStandardMaterial({ color: 0x1f6b3a, roughness: 0.5 }), 0.5)
  const pcbBlue = env(new THREE.MeshStandardMaterial({ color: 0x1d4fa8, roughness: 0.5 }), 0.5)
  const redShrink = env(new THREE.MeshStandardMaterial({ color: 0xb3161b, roughness: 0.5 }), 0.5)
  const wireRed = new THREE.MeshStandardMaterial({ color: 0xc21d1d, roughness: 0.5 })
  const wireBlack = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.5 })
  const wireYellow = new THREE.MeshStandardMaterial({ color: 0xd9b310, roughness: 0.5 })
  const wireGreen = new THREE.MeshStandardMaterial({ color: 0x2f8f3a, roughness: 0.5 })
  const glass = env(new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.05, metalness: 0.1, clearcoat: 1 }), 1.4)
  const propRed = env(new THREE.MeshStandardMaterial({ color: 0xd2261e, roughness: 0.4 }), 0.6)
  const pixMat = env(new THREE.MeshStandardMaterial({ map: tex.pixhawk, roughness: 0.5 }), 0.5)
  const lipoMat = env(new THREE.MeshStandardMaterial({ map: tex.lipo, roughness: 0.45 }), 0.5)
  const decalMat = new THREE.MeshStandardMaterial({ map: tex.decal, transparent: true, roughness: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
  const gpsTopMat = env(new THREE.MeshStandardMaterial({ map: tex.gpsTop, roughness: 0.4 }), 0.5)

  const led = {
    cyan: new THREE.MeshBasicMaterial({ color: 0x22d3ee, toneMapped: false }),
    red: new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false }),
    green: new THREE.MeshBasicMaterial({ color: 0x20ff60, toneMapped: false }),
    white: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    status: new THREE.MeshBasicMaterial({ color: 0x22ff88, toneMapped: false }),
    lens: new THREE.MeshBasicMaterial({ color: 0x8b5cf6, toneMapped: false }),
  }

  const boat = new THREE.Group()
  const body = new THREE.Group() // bobs and rolls on the water
  boat.add(body)

  // --- hull: rounded foam tub with a soft rim ---
  {
    const b = 0.08
    const outer = roundedRect(HULL.hw - b, HULL.hl - b, HULL.r - b)
    const iw = HULL.hw - HULL.wall
    const il = HULL.hl - HULL.wall
    const ir = HULL.r - HULL.wall
    outer.holes.push(roundedRect(iw + b, il + b, ir + b))
    const height = HULL.rim - HULL.bottom
    const g = new THREE.ExtrudeGeometry(outer, { depth: height - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 5, curveSegments: 14 })
    g.rotateX(-Math.PI / 2)
    g.translate(0, HULL.bottom + b, 0)
    // waterline stain + slightly yellowed foam low down
    const pos = g.attributes.position
    const col = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      const k = THREE.MathUtils.smoothstep(y, -0.05, 0.18)
      col[i * 3] = THREE.MathUtils.lerp(0.74, 0.97, k)
      col[i * 3 + 1] = THREE.MathUtils.lerp(0.77, 0.965, k)
      col[i * 3 + 2] = THREE.MathUtils.lerp(0.68, 0.93, k)
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    body.add(new THREE.Mesh(g, foam))

    const floorShape = roundedRect(iw + 0.06, il + 0.06, ir + 0.06)
    const fg = new THREE.ExtrudeGeometry(floorShape, { depth: HULL.floor - (HULL.bottom + 0.04), bevelEnabled: false, curveSegments: 12 })
    fg.rotateX(-Math.PI / 2)
    fg.translate(0, HULL.bottom + 0.04, 0)
    body.add(new THREE.Mesh(fg, foamPlain))

    // foam partition walling off the electronics bay
    const part = new THREE.Mesh(new RoundedBoxGeometry(iw * 2, 0.4, 0.1, 2, 0.02), foamPlain)
    part.position.set(0, HULL.floor + 0.2, PARTITION_Z)
    body.add(part)

    // hull decals, both sides
    for (const sx of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.35), decalMat)
      d.position.set(sx * (HULL.hw + 0.004), 0.17, -0.05)
      d.rotation.y = sx * (Math.PI / 2)
      body.add(d)
    }
  }

  // --- bow conveyor ramp ---
  const ramp = new THREE.Group()
  const rampVec = new THREE.Vector3().subVectors(RAMP_FOOT, RAMP_TOP)
  const RAMP_LEN = rampVec.length()
  ramp.position.copy(RAMP_TOP)
  ramp.rotation.x = Math.atan2(-rampVec.y, rampVec.z)
  body.add(ramp)
  const beltGeo = new THREE.PlaneGeometry(BELT_W, RAMP_LEN)
  beltGeo.rotateX(-Math.PI / 2)
  beltGeo.translate(0, ROLLER_R, RAMP_LEN / 2)
  ramp.add(new THREE.Mesh(beltGeo, beltMat))
  const underGeo = new THREE.PlaneGeometry(BELT_W, RAMP_LEN)
  underGeo.rotateX(Math.PI / 2)
  underGeo.translate(0, -ROLLER_R, RAMP_LEN / 2)
  ramp.add(new THREE.Mesh(underGeo, beltUnder))
  for (const z of [0, RAMP_LEN]) {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(ROLLER_R, ROLLER_R, BELT_W + 0.08, 20), pvc)
    roller.rotation.z = Math.PI / 2
    roller.position.z = z
    ramp.add(roller)
  }
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(new RoundedBoxGeometry(0.045, 0.24, RAMP_LEN + 0.3, 2, 0.012), board)
    rail.position.set(sx * (BELT_W / 2 + 0.07), 0.03, RAMP_LEN / 2)
    ramp.add(rail)
    // yellow TT gear motor + white motor can at the top roller
    const tt = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.2, 0.38, 2, 0.02), yellow)
    tt.position.set(sx * (BELT_W / 2 + 0.19), 0.02, 0.05)
    ramp.add(tt)
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.2, 16), pvc)
    can.rotation.x = Math.PI / 2
    can.position.set(sx * (BELT_W / 2 + 0.19), 0.02, -0.22)
    ramp.add(can)
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.06, 10), pvc)
    hub.rotation.z = Math.PI / 2
    hub.position.set(sx * (BELT_W / 2 + 0.29), 0.0, 0.0)
    ramp.add(hub)
  }
  // raised cleats that ride up the belt
  const cleats = []
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(BELT_W - 0.06, 0.04, 0.025), board)
    ramp.add(c)
    cleats.push(c)
  }

  // --- electronics bay (stern) ---
  const F = HULL.floor
  {
    const lipo = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.2, 0.3, 2, 0.03), [black, black, black, black, lipoMat, lipoMat])
    lipo.position.set(-0.48, F + 0.1, -1.58)
    lipo.rotation.y = 0.06
    body.add(lipo)
    const xt60 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.1), yellow)
    xt60.position.set(-0.1, F + 0.08, -1.42)
    body.add(xt60)

    const pix = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.09, 0.48, 2, 0.02), [black, black, pixMat, black, black, black])
    pix.position.set(0.14, F + 0.06, -1.3)
    pix.rotation.y = -0.12
    body.add(pix)
    const pixLed = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), led.status)
    pixLed.position.set(0.24, F + 0.115, -1.12)
    body.add(pixLed)

    // Raspberry Pi on standoffs
    const pi = new THREE.Group()
    pi.position.set(0.66, F + 0.1, -1.58)
    pi.rotation.y = 0.2
    body.add(pi)
    pi.add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 0.28), pcb))
    for (const [x, z] of [[-0.17, -0.11], [0.17, -0.11], [-0.17, 0.11], [0.17, 0.11]]) {
      const so = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6), silver)
      so.position.set(x, -0.04, z)
      pi.add(so)
    }
    for (const [x, z, w, d] of [[0.17, -0.06, 0.1, 0.07], [0.17, 0.05, 0.1, 0.07]]) {
      const usb = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), silver)
      usb.position.set(x, 0.05, z)
      pi.add(usb)
    }
    const soc = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.015, 0.08), black)
    soc.position.set(-0.04, 0.018, 0.0)
    pi.add(soc)
    const fan = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.1), black)
    fan.position.set(-0.04, 0.035, 0.0)
    pi.add(fan)
    const piLed = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.01, 0.015), led.red)
    piLed.position.set(-0.19, 0.016, 0.11)
    pi.add(piLed)

    for (let i = 0; i < 2; i++) {
      const esc = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.06, 0.27, 2, 0.02), redShrink)
      esc.position.set(-0.08 + i * 0.14, F + 0.04, -1.78)
      esc.rotation.y = 0.04 * (i ? 1 : -1)
      body.add(esc)
    }
    const buck = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.09), pcbBlue)
    buck.position.set(0.7, F + 0.02, -1.08)
    body.add(buck)

    // wiring: thruster leads out over the stern, motor leads forward to the TT motors
    const wy = F + 0.05
    body.add(tube([[-0.08, wy, -1.9], [-0.3, wy + 0.25, -2.0], [-0.7, HULL.rim + 0.08, -2.06], [-0.72, HULL.rim + 0.05, -2.26]], 0.014, wireRed))
    body.add(tube([[0.06, wy, -1.9], [0.3, wy + 0.25, -2.0], [0.7, HULL.rim + 0.08, -2.06], [0.72, HULL.rim + 0.05, -2.26]], 0.014, wireBlack))
    const runs = [
      [wireRed, 0.0, 0],
      [wireBlack, 0.03, 0.02],
      [wireYellow, -0.03, 0.04],
    ]
    for (const [m, dx, dy] of runs) {
      body.add(
        tube(
          [
            [0.3 + dx, wy + dy, -1.2],
            [0.75 + dx, F + 0.35 + dy, PARTITION_Z - 0.05],
            [0.92 + dx, F + 0.12 + dy, 0.0],
            [0.85 + dx, F + 0.25 + dy, 1.4],
            [0.68 + dx, 0.62 + dy, 2.0],
          ],
          0.011,
          m,
        ),
      )
      body.add(
        tube(
          [
            [-0.3 + dx, wy + dy, -1.3],
            [-0.75 + dx, F + 0.38 + dy, PARTITION_Z - 0.05],
            [-0.6 + dx, F + 0.18 + dy, 0.3],
            [-0.86 + dx, F + 0.3 + dy, 1.5],
            [-0.68 + dx, 0.62 + dy, 2.0],
          ],
          0.011,
          m,
        ),
      )
    }
    body.add(tube([[0.2, wy, -1.1], [0.5, wy + 0.2, -1.0], [0.0, F + 0.5, -0.9], [0.0, 0.58, -0.84]], 0.01, wireGreen))
  }

  // --- added equipment ---
  // GPS mast at the stern
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 1.25, 10), carbon)
  mast.position.set(0, F + 0.62, -1.86)
  body.add(mast)
  const gps = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.055, 28), [black, gpsTopMat, black])
  gps.position.set(0, F + 1.27, -1.86)
  body.add(gps)
  const sternLight = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), led.white)
  sternLight.position.set(0, F + 1.33, -1.86)
  body.add(sternLight)
  const mastTop = new THREE.Object3D()
  mastTop.position.set(0, F + 1.36, -1.86)
  body.add(mastTop)
  // telemetry / LTE whips
  for (const sx of [-1, 1]) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.06, 10), black)
    base.position.set(sx * 0.82, HULL.rim + 0.03, -1.82)
    body.add(base)
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.016, 0.85, 6), black)
    whip.position.set(sx * 0.86, HULL.rim + 0.46, -1.84)
    whip.rotation.z = -sx * 0.08
    body.add(whip)
  }
  // vision camera on the partition, watching the belt
  {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), carbon)
    post.position.set(0, F + 0.48, PARTITION_Z)
    body.add(post)
    const cam = new THREE.Mesh(new RoundedBoxGeometry(0.26, 0.15, 0.2, 2, 0.04), black)
    cam.position.set(0, F + 0.6, PARTITION_Z + 0.02)
    cam.rotation.x = 0.18
    body.add(cam)
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.045, 20), glass)
    lens.position.set(0, F + 0.585, PARTITION_Z + 0.125)
    lens.rotation.x = 0.18
    body.add(lens)
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.048, 0.06, 24), led.lens)
    ring.position.set(0, F + 0.585, PARTITION_Z + 0.127)
    ring.rotation.x = 0.18
    body.add(ring)
  }
  // status LED bar along the partition
  const ledBar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.022, 0.025), led.cyan)
  ledBar.position.set(0, F + 0.4, PARTITION_Z + 0.055)
  body.add(ledBar)
  // bow nav lights: starboard green (-x when facing +z), port red (+x)
  const navG = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), led.green)
  navG.position.set(-0.98, HULL.rim + 0.04, 1.62)
  const navR = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), led.red)
  navR.position.set(0.98, HULL.rim + 0.04, 1.62)
  body.add(navG, navR)

  // twin thrusters on stern brackets, guards just breaking the surface
  const props = []
  for (const sx of [-1, 1]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.24), black)
    bracket.position.set(sx * 0.72, HULL.rim + 0.02, -2.2)
    body.add(bracket)
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.05), black)
    leg.position.set(sx * 0.72, 0.2, -2.32)
    body.add(leg)
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.2, 14), black)
    pod.rotation.x = Math.PI / 2
    pod.position.set(sx * 0.72, -0.1, -2.32)
    body.add(pod)
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.018, 8, 28), propRed)
    guard.position.set(sx * 0.72, -0.1, -2.46)
    body.add(guard)
    const prop = new THREE.Group()
    prop.position.copy(guard.position)
    for (let k = 0; k < 3; k++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.012), propRed)
      blade.position.y = 0.06
      const w = new THREE.Group()
      w.rotation.z = (k / 3) * Math.PI * 2
      blade.rotation.y = 0.5
      w.add(blade)
      prop.add(w)
    }
    body.add(prop)
    props.push(prop)
  }

  // helpers for the ecosystem: points along the belt surface (boat-local)
  const beltDir = rampVec.clone().normalize()
  const beltNormal = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), ramp.rotation.x)
  const rampQuat = new THREE.Quaternion().setFromEuler(ramp.rotation)
  function rampPoint(s, lift, out) {
    // s: 0 at the foot (in the water), 1 at the top roller
    return out.copy(RAMP_FOOT).addScaledVector(beltDir, -s * RAMP_LEN).addScaledVector(beltNormal, ROLLER_R + lift)
  }
  const bay = { x0: -0.85, x1: 0.85, z0: PARTITION_Z + 0.25, z1: HULL.hl - HULL.wall - 0.3, floor: F }

  const glowAnchors = { navG, navR, sternLight, ledBar }

  // ~130 parts -> a few draw calls; small parts are skipped by the mirror pass
  hideSmallFromMirror(body, SURFACE_LAYER, 0.22)
  mergeStatic(body, new Set([...cleats, ...props]))
  let beltOffset = 0

  return {
    group: boat,
    body,
    mastTop,
    rampPoint,
    rampQuat,
    rampFoot: RAMP_FOOT,
    rampTop: RAMP_TOP,
    rampLen: RAMP_LEN,
    hull: HULL,
    bay,
    glowAnchors,
    beltSpeed: 0.55,
    /** t: seconds, on: 0..1 power level */
    update(t, dt, on) {
      // belt + cleats run upward
      const move = this.beltSpeed * dt * on
      beltOffset = (beltOffset + move) % RAMP_LEN
      tex.belt.offset.y = -(beltOffset / RAMP_LEN) * tex.belt.repeat.y
      cleats.forEach((c, i) => {
        const z = RAMP_LEN - ((beltOffset + (i * RAMP_LEN) / cleats.length) % RAMP_LEN)
        c.position.set(0, ROLLER_R + 0.02, z)
        c.visible = z > 0.06 && z < RAMP_LEN - 0.06
      })
      for (const p of props) p.rotation.z += dt * 38 * on
      const blink = Math.sin(t * 6) > 0.2 ? 1 : 0.25
      led.status.color.setRGB(0.15 * on, 2.2 * on * blink, 0.9 * on * blink)
      led.red.color.setRGB(3.2 * on, 0.15 * on, 0.12 * on)
      led.green.color.setRGB(0.15 * on, 3.0 * on, 0.5 * on)
      led.white.color.setScalar(3.4 * on)
      const pulse = 0.6 + 0.4 * Math.sin(t * 2.2)
      led.cyan.color.setRGB(0.3 * on * pulse, 2.4 * on * pulse, 3.0 * on * pulse)
      led.lens.color.setRGB(1.4 * on, 0.9 * on, 3.2 * on)
    },
    dispose() {
      Object.values(tex).forEach((x) => x.dispose())
    },
  }
}
