// Sci-fi handoff from the intro's white impact into the app. Plain DOM + Web
// Animations so it survives the intro unmounting underneath it.
//
//  - the white splits into two blast doors along a glowing cyan seam
//  - the app settles in through an RGB-split glitch (SVG filter) + zoom/defocus
//  - glitch slices flicker, a scan line + HUD grid sweep down, corner
//    brackets lock on with a status readout, then everything clears.

const DOOR_EASE = 'cubic-bezier(.75,0,.15,1)'
const TOTAL_MS = 1500
const GLITCH_MS = 950
const SVG_NS = 'http://www.w3.org/2000/svg'

function el(tag, style, parent) {
  const n = document.createElement(tag)
  Object.assign(n.style, style)
  if (parent) parent.appendChild(n)
  return n
}

function makeRgbFilter() {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.position = 'absolute'
  svg.innerHTML = `
    <filter id="varuna-rgb-split" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
      <feOffset in="r" dx="0" dy="0" result="ro"/>
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
      <feOffset in="b" dx="0" dy="0" result="bo"/>
      <feBlend mode="screen" in="ro" in2="g" result="rg"/>
      <feBlend mode="screen" in="rg" in2="bo"/>
    </filter>`
  document.body.appendChild(svg)
  const [ro, bo] = svg.querySelectorAll('feOffset')
  return { svg, ro, bo }
}

export function playSciFiReveal() {
  const root = document.getElementById('root')
  const canAnimate = typeof document.body.animate === 'function'

  const fx = el('div', { position: 'fixed', inset: '0', zIndex: '2147483000', pointerEvents: 'none', overflow: 'hidden' }, document.body)
  fx.setAttribute('aria-hidden', 'true')

  // HUD grid + scan line (under the doors)
  const grid = el('div', {
    position: 'absolute',
    inset: '0',
    opacity: '0',
    backgroundImage:
      'linear-gradient(rgba(103,232,249,.13) 1px, transparent 1px), linear-gradient(90deg, rgba(103,232,249,.13) 1px, transparent 1px)',
    backgroundSize: '56px 56px',
    maskImage: 'radial-gradient(ellipse at center, transparent 18%, #000 75%)',
    WebkitMaskImage: 'radial-gradient(ellipse at center, transparent 18%, #000 75%)',
  }, fx)
  const scan = el('div', {
    position: 'absolute',
    left: '0',
    right: '0',
    top: '0',
    height: '22vh',
    opacity: '0',
    background: 'linear-gradient(to bottom, transparent, rgba(103,232,249,.07) 60%, rgba(165,243,252,.45) 97%, rgba(255,255,255,.95) 100%)',
    boxShadow: '0 6px 24px rgba(103,232,249,.55)',
  }, fx)

  // Glitch slices
  const slices = Array.from({ length: 7 }, (_, i) =>
    el('div', {
      position: 'absolute',
      left: '0',
      right: '0',
      opacity: '0',
      mixBlendMode: 'screen',
      background: i % 2 ? 'rgba(139,92,246,.45)' : 'rgba(165,243,252,.5)',
    }, fx),
  )

  // Blast doors + seam
  const top = el('div', {
    position: 'absolute', left: '0', right: '0', top: '0', height: '50.2%',
    background: 'linear-gradient(to bottom, #d3dfff, #f7faff 70%, #ffffff)',
    borderBottom: '2px solid #cffafe',
    boxShadow: '0 10px 40px 2px rgba(103,232,249,.85), 0 2px 90px 10px rgba(139,92,246,.45)',
  }, fx)
  const bottom = el('div', {
    position: 'absolute', left: '0', right: '0', bottom: '0', height: '50.2%',
    background: 'linear-gradient(to top, #d3dfff, #f7faff 70%, #ffffff)',
    borderTop: '2px solid #cffafe',
    boxShadow: '0 -10px 40px 2px rgba(103,232,249,.85), 0 -2px 90px 10px rgba(139,92,246,.45)',
  }, fx)
  const seam = el('div', {
    position: 'absolute', left: '0', right: '0', top: '50%', height: '3px', marginTop: '-1.5px',
    background: '#ffffff',
    boxShadow: '0 0 16px 4px rgba(207,250,254,1), 0 0 70px 16px rgba(103,232,249,.8), 0 0 140px 30px rgba(139,92,246,.5)',
  }, fx)

  // Lock-on brackets + readout
  const B = 'rgba(165,243,252,.95)'
  const corner = (pos, sides) =>
    el('span', {
      position: 'absolute', width: '44px', height: '44px', opacity: '0',
      ...pos,
      ...Object.fromEntries(sides.map((s) => [`border${s}`, `2px solid ${B}`])),
      filter: 'drop-shadow(0 0 6px rgba(103,232,249,.9))',
    }, fx)
  const brackets = [
    corner({ left: '22px', top: '22px' }, ['Left', 'Top']),
    corner({ right: '22px', top: '22px' }, ['Right', 'Top']),
    corner({ left: '22px', bottom: '22px' }, ['Left', 'Bottom']),
    corner({ right: '22px', bottom: '22px' }, ['Right', 'Bottom']),
  ]
  const label = el('div', {
    position: 'absolute', left: '76px', bottom: '34px', opacity: '0',
    font: '600 11px/1 "JetBrains Mono", ui-monospace, monospace', letterSpacing: '.28em',
    color: '#cffafe', textShadow: '0 0 10px rgba(103,232,249,.9)', whiteSpace: 'nowrap',
  }, fx)
  label.textContent = 'VARUNA // LINK ESTABLISHED'

  let done = false
  const cleanup = () => {
    done = true
    fx.remove()
    rgb?.svg.remove()
    if (root) {
      root.style.transform = ''
      root.style.filter = ''
      root.style.transformOrigin = ''
    }
  }

  if (!canAnimate) {
    setTimeout(cleanup, 300)
    return
  }

  const opts = (duration, delay, easing = 'linear') => ({ duration, delay, easing, fill: 'both' })
  top.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-104%)' }], opts(640, 110, DOOR_EASE))
  bottom.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(104%)' }], opts(640, 110, DOOR_EASE))
  seam.animate(
    [
      { transform: 'scaleX(1) scaleY(1)', opacity: 1 },
      { transform: 'scaleX(1) scaleY(2.2)', opacity: 1, offset: 0.25 },
      { transform: 'scaleX(0) scaleY(.4)', opacity: 0 },
    ],
    opts(560, 80, 'cubic-bezier(.6,0,.3,1)'),
  )
  grid.animate([{ opacity: 0 }, { opacity: 0.7, offset: 0.3 }, { opacity: 0 }], opts(1150, 260))
  scan.animate(
    [
      { transform: 'translateY(-24vh)', opacity: 0 },
      { transform: 'translateY(10vh)', opacity: 1, offset: 0.15 },
      { transform: 'translateY(104vh)', opacity: 0.9 },
    ],
    opts(880, 380, 'cubic-bezier(.45,0,.2,1)'),
  )
  brackets.forEach((b, i) =>
    b.animate(
      [
        { opacity: 0, transform: 'scale(1.6)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.3 },
        { opacity: 1, transform: 'scale(1)', offset: 0.78 },
        { opacity: 0, transform: 'scale(.92)' },
      ],
      opts(1050, 330 + i * 40, 'cubic-bezier(.16,1,.3,1)'),
    ),
  )
  label.animate(
    [
      { opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { opacity: 0.15, offset: 0.18 },
      { opacity: 1, offset: 0.26 },
      { opacity: 1, offset: 0.8 },
      { opacity: 0 },
    ],
    opts(950, 420),
  )

  // Frame-driven part: RGB split + zoom/defocus on the app, glitch slices.
  const rgb = root ? makeRgbFilter() : null
  if (root) root.style.transformOrigin = '50% 50%'
  let start = 0
  let lastJitter = -1
  function frame(now) {
    if (done) return
    if (!start) start = now
    const ms = now - start
    const p = Math.min(1, ms / GLITCH_MS)
    const k = 1 - p
    // re-roll the jitter ~every 45ms so it reads as discrete glitch frames
    const step = Math.floor(ms / 45)
    if (step !== lastJitter) {
      lastJitter = step
      const amp = 13 * k
      const jx = (Math.random() * 2 - 1) * amp
      if (rgb) {
        rgb.ro.setAttribute('dx', String((amp + jx * 0.5).toFixed(2)))
        rgb.bo.setAttribute('dx', String((-amp + jx * 0.5).toFixed(2)))
      }
      if (root) {
        const shift = ms < 520 ? (Math.random() * 2 - 1) * 9 * k : 0
        root.style.transform = `translateX(${shift.toFixed(2)}px) scale(${(1 + 0.07 * k).toFixed(4)})`
        root.style.filter = `${k > 0.01 ? 'url(#varuna-rgb-split) ' : ''}blur(${(6 * k * k * k).toFixed(2)}px) brightness(${(1 + 0.9 * k).toFixed(3)}) saturate(${(1 + 0.4 * k).toFixed(3)})`
      }
      for (const s of slices) {
        const on = ms > 90 && ms < 560 && Math.random() < 0.55
        s.style.opacity = on ? String(0.35 + Math.random() * 0.6) : '0'
        if (on) {
          s.style.top = `${(Math.random() * 100).toFixed(1)}%`
          s.style.height = `${(1 + Math.random() * 12).toFixed(0)}px`
          s.style.transform = `translateX(${((Math.random() * 2 - 1) * 30).toFixed(0)}px)`
        }
      }
    }
    if (ms < GLITCH_MS) requestAnimationFrame(frame)
    else if (root) {
      root.style.transform = ''
      root.style.filter = ''
    }
  }
  requestAnimationFrame(frame)
  setTimeout(cleanup, TOTAL_MS)
}
