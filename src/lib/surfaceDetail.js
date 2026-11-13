import * as THREE from 'three'

// Procedural surface detail shared by the drone and the boat: the small
// imperfections that make a CG object read as a real one — roughness that
// varies (smudges, wear, polish), micro-scratches and pitting in the bump, a
// real 2x2 twill carbon weave, brushed metal. All drawn once into canvases.

function rng(seed) {
  let s = seed >>> 0 || 1
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

// Tileable value-noise fBm into a Float32Array (0..1).
function fbm(size, seed, { cells = 6, octaves = 5, stretch = 1 } = {}) {
  const out = new Float32Array(size * size)
  const r = rng(seed)
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    const cx = Math.max(1, Math.round(cells * Math.pow(2, o)))
    const cy = Math.max(1, Math.round((cells * Math.pow(2, o)) / stretch))
    const lat = new Float32Array(cx * cy).map(() => r())
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cy
      const y0 = Math.floor(fy)
      const ty = fy - y0
      const sy = ty * ty * (3 - 2 * ty)
      const r0 = (y0 % cy) * cx
      const r1 = ((y0 + 1) % cy) * cx
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cx
        const x0 = Math.floor(fx)
        const tx = fx - x0
        const sx = tx * tx * (3 - 2 * tx)
        const a = lat[r0 + (x0 % cx)]
        const b = lat[r0 + ((x0 + 1) % cx)]
        const c = lat[r1 + (x0 % cx)]
        const d = lat[r1 + ((x0 + 1) % cx)]
        out[y * size + x] += (a + (b - a) * sx + (c + (d - c) * sx - a - (b - a) * sx) * sy) * amp
      }
    }
    total += amp
    amp *= 0.5
  }
  for (let i = 0; i < out.length; i++) out[i] /= total
  return out
}

function toTex(canvas, srgb, repeat) {
  const t = new THREE.CanvasTexture(canvas)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 16
  if (repeat) t.repeat.set(repeat[0], repeat[1])
  return t
}

function greyCanvas(size, values, lo, hi) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const img = g.createImageData(size, size)
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(255 * (lo + (hi - lo) * values[i]))
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return [c, g]
}

function scratches(g, size, r, n, light, maxLen = 0.25) {
  g.lineCap = 'round'
  for (let i = 0; i < n; i++) {
    const x = r() * size
    const y = r() * size
    const a = r() * Math.PI * 2
    const len = (0.02 + r() * maxLen) * size
    g.strokeStyle = light ? `rgba(255,255,255,${(0.08 + r() * 0.25).toFixed(2)})` : `rgba(0,0,0,${(0.1 + r() * 0.3).toFixed(2)})`
    g.lineWidth = 0.6 + r() * 1.2
    g.beginPath()
    g.moveTo(x, y)
    g.quadraticCurveTo(x + Math.cos(a + 0.3) * len * 0.5, y + Math.sin(a + 0.3) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len)
    g.stroke()
  }
}

/** Roughness variation: polish, smudges and fine scuffs (multiplies material.roughness). */
export function grungeRoughness(seed = 1, size = 1024, lo = 0.6, hi = 1.0) {
  const n = fbm(size, seed, { cells: 5, octaves: 6 })
  const [c, g] = greyCanvas(size, n, lo, hi)
  const r = rng(seed * 7 + 3)
  for (let i = 0; i < 26; i++) {
    // fingerprint-ish smudges: rougher blotches
    const x = r() * size
    const y = r() * size
    const rad = (0.03 + r() * 0.08) * size
    const gr = g.createRadialGradient(x, y, 0, x, y, rad)
    gr.addColorStop(0, `rgba(255,255,255,${(0.12 + r() * 0.16).toFixed(2)})`)
    gr.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = gr
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2)
  }
  scratches(g, size, r, 260, true, 0.12)
  return toTex(c, false)
}

/** Height detail for bumpMap: pitting, orange-peel and hairline scratches (grooves). */
export function microBump(seed = 2, size = 1024) {
  const n = fbm(size, seed, { cells: 40, octaves: 3 })
  const [c, g] = greyCanvas(size, n, 0.42, 0.58)
  const r = rng(seed * 13 + 5)
  scratches(g, size, r, 320, false, 0.1)
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(0,0,0,${(0.15 + r() * 0.3).toFixed(2)})`
    g.beginPath()
    g.arc(r() * size, r() * size, 0.5 + r() * 1.3, 0, Math.PI * 2)
    g.fill()
  }
  return toTex(c, false)
}

/** Brushed metal: long fine streaks along u (roughness and bump). */
export function brushed(seed = 3, size = 1024) {
  const n = fbm(size, seed, { cells: 3, octaves: 7, stretch: 60 })
  const [c, g] = greyCanvas(size, n, 0.55, 1.0)
  const r = rng(seed * 5 + 1)
  for (let i = 0; i < 1600; i++) {
    const y = r() * size
    g.strokeStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${(0.05 + r() * 0.12).toFixed(2)})`
    g.lineWidth = 0.5 + r()
    g.beginPath()
    const x = r() * size
    g.moveTo(x, y)
    g.lineTo(x + (0.2 + r() * 0.8) * size, y + (r() - 0.5) * 2)
    g.stroke()
  }
  return toTex(c, false)
}

/** 2x2 twill carbon fibre: colour map with per-tow sheen, plus a matching bump. */
export function twillCarbon(size = 1024, tows = 16) {
  const s = size / tows
  const mk = (draw) => {
    const c = document.createElement('canvas')
    c.width = c.height = size
    draw(c.getContext('2d'))
    return c
  }
  const r = rng(77)
  const colour = mk((g) => {
    g.fillStyle = '#0d0e10'
    g.fillRect(0, 0, size, size)
    for (let j = 0; j < tows; j++)
      for (let i = 0; i < tows; i++) {
        const warp = Math.floor((i + j) / 2) % 2 === 0 // 2x2 twill: diagonal steps
        const x = i * s
        const y = j * s
        const lg = warp ? g.createLinearGradient(x, y, x + s, y) : g.createLinearGradient(x, y, x, y + s)
        const k = 0.85 + r() * 0.3
        lg.addColorStop(0, `rgb(${Math.round(16 * k)},${Math.round(17 * k)},${Math.round(20 * k)})`)
        lg.addColorStop(0.5, `rgb(${Math.round(58 * k)},${Math.round(61 * k)},${Math.round(68 * k)})`)
        lg.addColorStop(1, `rgb(${Math.round(16 * k)},${Math.round(17 * k)},${Math.round(20 * k)})`)
        g.fillStyle = lg
        g.fillRect(x + 0.8, y + 0.8, s - 1.6, s - 1.6)
        // individual filaments along the tow
        g.strokeStyle = 'rgba(0,0,0,0.25)'
        g.lineWidth = 0.6
        for (let f = 1; f < 6; f++) {
          g.beginPath()
          if (warp) {
            g.moveTo(x + 1, y + (f * s) / 6)
            g.lineTo(x + s - 1, y + (f * s) / 6)
          } else {
            g.moveTo(x + (f * s) / 6, y + 1)
            g.lineTo(x + (f * s) / 6, y + s - 1)
          }
          g.stroke()
        }
      }
  })
  const bump = mk((g) => {
    g.fillStyle = '#404040'
    g.fillRect(0, 0, size, size)
    for (let j = 0; j < tows; j++)
      for (let i = 0; i < tows; i++) {
        const warp = Math.floor((i + j) / 2) % 2 === 0
        const x = i * s
        const y = j * s
        const lg = warp ? g.createLinearGradient(x, y, x, y + s) : g.createLinearGradient(x, y, x + s, y)
        lg.addColorStop(0, '#5a5a5a')
        lg.addColorStop(0.5, '#c8c8c8')
        lg.addColorStop(1, '#5a5a5a')
        g.fillStyle = lg
        g.fillRect(x + 0.8, y + 0.8, s - 1.6, s - 1.6)
      }
  })
  return { map: toTex(colour, true), bump: toTex(bump, false) }
}

/** A text decal on transparent ground (for stickers / printed labels). */
export function labelTex(lines, { w = 1024, h = 160, color = '#e8eaee', font = 'Arial' } = {}) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  g.clearRect(0, 0, w, h)
  g.fillStyle = color
  g.textBaseline = 'middle'
  const rows = lines.length
  lines.forEach((ln, i) => {
    const size = ln.size || Math.floor((h / rows) * 0.72)
    g.font = `${ln.weight || 800} ${size}px ${font}`
    if (ln.spacing) g.letterSpacing = `${ln.spacing}px`
    g.textAlign = ln.align || 'center'
    const x = ln.align === 'left' ? 8 : ln.align === 'right' ? w - 8 : w / 2
    g.globalAlpha = ln.alpha ?? 1
    g.fillText(ln.text, x, (h / rows) * (i + 0.5))
  })
  g.globalAlpha = 1
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 16
  return t
}

/** clone a texture with its own repeat (shares the image) */
export function rep(tex, u, v) {
  const t = tex.clone()
  t.repeat.set(u, v)
  t.needsUpdate = true
  return t
}

/**
 * Strip every highlight and reflection from a model's lit materials: no
 * specular, no metal, no clearcoat or sheen. Surfaces keep their colour,
 * texture and bump and are still lit (diffusely) by the lights and the sky,
 * so they read as dead-matte. Chains any existing shader patch on a material.
 */
export function matteAll(root) {
  root.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || !m.isMeshStandardMaterial || m.userData.matte) continue
      m.userData.matte = true
      m.metalness = 0
      m.metalnessMap = null
      m.roughness = 1
      m.roughnessMap = null
      if (m.isMeshPhysicalMaterial) {
        m.clearcoat = 0
        m.sheen = 0
        m.specularIntensity = 0
      }
      const baseKey = m.customProgramCacheKey.call(m)
      const prev = m.onBeforeCompile
      m.onBeforeCompile = (s, r) => {
        prev.call(m, s, r)
        s.fragmentShader = s.fragmentShader.replace(
          '#include <lights_physical_fragment>',
          '#include <lights_physical_fragment>\nmaterial.specularColor = vec3(0.0);\nmaterial.specularF90 = 0.0;',
        )
      }
      m.customProgramCacheKey = () => baseKey + '|matte'
      m.needsUpdate = true
    }
  })
}

// GLSL: hash + value noise in object space, for weathering inside shaders.
export const NOISE_GLSL = /* glsl */ `
  float sdH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float sdN(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(sdH(i), sdH(i + vec3(1,0,0)), f.x), mix(sdH(i + vec3(0,1,0)), sdH(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(sdH(i + vec3(0,0,1)), sdH(i + vec3(1,0,1)), f.x), mix(sdH(i + vec3(0,1,1)), sdH(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float sdF(vec3 p) { return sdN(p) * 0.5 + sdN(p * 2.03 + 7.1) * 0.25 + sdN(p * 4.01 + 3.3) * 0.125 + sdN(p * 8.02 + 1.7) * 0.0625; }
`
