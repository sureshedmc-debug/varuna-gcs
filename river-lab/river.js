// Night river under the drone: a planar-reflection water surface (real mirror
// of the scene, distorted by flowing ripples + rotor downwash), dark banks with
// tree silhouettes, a distant ridge, and a moonlit gradient sky.

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
  uniform float uTime, uWash, uPoolI;
  uniform vec3 uCam, uDrone, uPool0, uPool1;
  varying vec4 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>

  vec2 nmap(vec2 uv) { return texture2D(tNormal, uv).xy * 2.0 - 1.0; }

  void main() {
    vec2 p = vWorld.xz;
    float t = uTime;
    // Current flows toward the camera (+z); crests run across the river.
    vec2 n = nmap(p * vec2(0.045, 0.10) + vec2(0.0, -t * 0.060)) * 0.55
           + nmap(p * vec2(0.11, 0.21) + vec2(t * 0.010, -t * 0.130)) * 0.30
           + nmap(p * vec2(0.36, 0.55) + vec2(-t * 0.020, -t * 0.280)) * 0.15;

    // Rotor downwash: rings radiating out from under the drone, stronger the lower it flies.
    vec2 d = p - uDrone.xz;
    float r = length(d);
    float h = max(uDrone.y, 0.4);
    float wash = uWash * exp(-r * r / (1.5 + h * h * 0.5)) * clamp(6.0 / (h * h), 0.0, 1.6);
    float ring = sin(r * 5.5 - t * 9.0);
    n += (d / (r + 1e-3)) * ring * wash * 0.9;

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
    vec3 col = mix(color, refl * 0.92, fres);

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
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    float y = vDir.y;
    vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.42, y));
    // Soft moon halo in the sky
    float m = max(dot(vDir, uMoonDir), 0.0);
    col += vec3(0.32, 0.40, 0.55) * pow(m, 60.0) * 0.5 + vec3(0.10, 0.13, 0.2) * pow(m, 8.0) * 0.25;
    // Sparse stars, fading out toward the hazy horizon
    vec3 c = floor(vDir * 340.0);
    float s = step(0.9965, hash(c)) * smoothstep(0.06, 0.3, y);
    col += vec3(0.8, 0.85, 1.0) * s * (0.4 + 0.6 * hash(c + 3.1));
    gl_FragColor = vec4(col, 1.0);
  }
`

// Tileable ripple normal map, generated once (no texture download).
function makeNormalTex(THREE, size = 256) {
  const hgt = new Float32Array(size * size)
  const octave = (period, amp, seed) => {
    let st = seed
    const rnd = () => (st = (st * 16807) % 2147483647) / 2147483647
    const grid = new Float32Array(period * period).map(rnd)
    const sm = (x) => x * x * (3 - 2 * x)
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * period
      const iy = Math.floor(fy)
      const ty = sm(fy - iy)
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * period
        const ix = Math.floor(fx)
        const tx = sm(fx - ix)
        const g = (i, j) => grid[((j % period) * period) + (i % period)]
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
      let nx = -(H(x + 1, y) - H(x - 1, y)) * k
      let ny = -(H(x, y + 1) - H(x, y - 1)) * k
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

function glowTex(THREE) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const x = c.getContext('2d')
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.18, 'rgba(255,255,255,1)')
  g.addColorStop(0.24, 'rgba(220,230,255,0.35)')
  g.addColorStop(1, 'rgba(160,180,255,0)')
  x.fillStyle = g
  x.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// Bank edge (distance of the shoreline from the river centre) along z.
const edgeAt = (z) => 15 + Math.sin(z * 0.045) * 2.6 + Math.sin(z * 0.13 + 1.3) * 1.1 + Math.max(0, -z - 60) * 0.05

export function makeRiver({ THREE, Reflector, scene, FLOOR_Y, W, H, dpr }) {
  const horizon = new THREE.Color(0x0b1626)
  const zenith = new THREE.Color(0x010204)
  const RT_SCALE = 0.6
  const normalTex = makeNormalTex(THREE)

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
        uWash: { value: 0 },
        uPoolI: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uDrone: { value: new THREE.Vector3(0, 99, 0) },
        uPool0: { value: new THREE.Vector3(0, 0, 999) },
        uPool1: { value: new THREE.Vector3(0, 0, 999) },
      },
    ]),
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
  }
  const water = new Reflector(new THREE.PlaneGeometry(420, 420), {
    textureWidth: Math.round(W() * dpr * RT_SCALE),
    textureHeight: Math.round(H() * dpr * RT_SCALE),
    clipBias: 0.003,
    color: 0x03070c,
    shader: waterShader,
    multisample: 4,
  })
  water.material.fog = true
  water.material.uniforms.tNormal.value = normalTex
  water.rotation.x = -Math.PI / 2
  water.position.set(0, FLOOR_Y, -150)
  scene.add(water)
  const U = water.material.uniforms

  // --- banks ---
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x07090b, roughness: 1, metalness: 0 })
  const ACROSS = [-0.6, 0, 1.2, 3.5, 9, 30, 220] // offsets from the shoreline
  const LIFT = [-0.35, 0.05, 0.42, 0.62, 0.8, 1.4, 4]
  const zs = []
  for (let z = 12; z >= -260; z -= 2) zs.push(z)
  const makeBank = (side) => {
    const pos = []
    const idx = []
    zs.forEach((z, zi) => {
      const e = edgeAt(z)
      ACROSS.forEach((a, ai) => {
        const bump = ai > 1 ? Math.sin(z * 0.21 + ai * 2 + side) * 0.15 * ai : 0
        pos.push(side * (e + a), FLOOR_Y + LIFT[ai] + bump, z)
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
    geo.setIndex(idx)
    geo.computeVertexNormals()
    const m = new THREE.Mesh(geo, bankMat)
    scene.add(m)
    return m
  }
  makeBank(-1)
  makeBank(1)

  // --- tree silhouettes along both banks ---
  const treeGeo = new THREE.ConeGeometry(1, 1, 7)
  treeGeo.translate(0, 0.5, 0)
  const treeMat = new THREE.MeshBasicMaterial({ color: 0x020305 })
  const TREES = 520
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, TREES)
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const sc = new THREE.Vector3()
  const ps = new THREE.Vector3()
  let seed = 4242
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < TREES; i++) {
    const side = i % 2 ? 1 : -1
    const z = -16 - rnd() * 230
    const off = 3 + Math.pow(rnd(), 1.6) * 26
    const hgt = 3.5 + rnd() * 7
    const wid = hgt * (0.22 + rnd() * 0.12)
    ps.set(side * (edgeAt(z) + off), FLOOR_Y + 0.5, z)
    sc.set(wid, hgt, wid)
    q.setFromAxisAngle(ps.set(0, 1, 0), rnd() * 6.28)
    ps.set(side * (edgeAt(z) + off), FLOOR_Y + 0.5, z)
    m4.compose(ps, q, sc)
    trees.setMatrixAt(i, m4)
  }
  trees.instanceMatrix.needsUpdate = true
  scene.add(trees)

  // --- distant ridge (unfogged silhouette just darker than the horizon) ---
  {
    const pos = []
    const idx = []
    const N = 120
    for (let i = 0; i <= N; i++) {
      const x = -320 + (640 * i) / N
      const top = 4 + Math.abs(Math.sin(i * 0.37)) * 5 + Math.sin(i * 0.11 + 2) * 4 + Math.sin(i * 1.7) * 0.8
      pos.push(x, FLOOR_Y - 1, -228, x, FLOOR_Y + Math.max(1.5, top), -228)
      if (i > 0) {
        const a = (i - 1) * 2
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setIndex(idx)
    const ridge = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x050a12, fog: false, side: THREE.DoubleSide }))
    scene.add(ridge)
  }

  // --- sky + moon ---
  const moonDir = new THREE.Vector3(-0.2, 0.2, -1).normalize()
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(240, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: { uHorizon: { value: horizon }, uZenith: { value: zenith }, uMoonDir: { value: moonDir } },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  )
  sky.renderOrder = -10
  scene.add(sky)
  const moonTex = glowTex(THREE)
  const moon = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: moonTex, color: new THREE.Color(2.2, 2.3, 2.6), fog: false, depthWrite: false, transparent: true }),
  )
  moon.position.copy(moonDir).multiplyScalar(225)
  moon.scale.setScalar(11)
  moon.renderOrder = -9
  scene.add(moon)

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const hitWater = (from, to, out) => {
    const dy = to.y - from.y
    if (dy > -1e-3) return out.set(0, 0, 999)
    const k = (FLOOR_Y - from.y) / dy
    return out.copy(from).lerp(to, k)
  }

  return {
    horizon,
    /** wash: rotor downwash 0..1, poolI: headlight level 0..1, beams: [[from, to], ...] in world space */
    update(dt, camera, dronePos, wash, poolI, beams) {
      U.uTime.value += dt
      U.uCam.value.copy(camera.position)
      U.uDrone.value.set(dronePos.x, dronePos.y - FLOOR_Y, dronePos.z)
      U.uWash.value = wash
      U.uPoolI.value = poolI
      if (beams[0]) hitWater(a.copy(beams[0][0]), b.copy(beams[0][1]), U.uPool0.value)
      if (beams[1]) hitWater(a.copy(beams[1][0]), b.copy(beams[1][1]), U.uPool1.value)
    },
    resize(w, h) {
      water.getRenderTarget().setSize(Math.round(w * dpr * RT_SCALE), Math.round(h * dpr * RT_SCALE))
    },
    dispose() {
      water.dispose()
      normalTex.dispose()
      moonTex.dispose()
    },
  }
}
