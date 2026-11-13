import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  createPlasticDetector, mergeBoxes, makeTileGrid, overlapRatio, suppressByPerson,
  DETECT_MODELS, DEFAULT_DETECT_MODEL, getDetectModel, setDetectModel,
} from '../lib/detector'
import { BoxTracker } from '../lib/track'
import { api } from '../api/client'
import { recordTrashCount } from '../lib/detectionStats'
import { recordTrashSighting } from '../lib/trashLog'
import { startMissionRecording, stopMissionRecording } from '../lib/missionRecording'
import { useSystem } from './SystemContext'
import { useLivePosition, useLaptopGps } from '../hooks/useLaptopGps'
import { pick } from '../lib/format'
import { StatusOrb } from './ui'
import { fmtLength, getFovSettings, metersPerPixel, pixelBoxToRealSize, summarizeSizes } from '../lib/sizeEstimate'
import { projectBoxes } from '../lib/geoProject'
import { getAlertSettings } from '../lib/alertSettings'
import { sendBigDumpEmail } from '../lib/alerts/email'
import { releaseStream } from './StreamImg'
import { h264Supported, playH264 } from '../lib/h264Stream'
import {
  createLearner, boxFeatures, cropInfo, saveFeedback, deleteFeedback, feedbackCount, clearFeedback, exportFeedback,
  learnerEnabled, setLearnerEnabled, showFilteredEnabled, setShowFilteredEnabled,
} from '../lib/feedbackLearner'

// One auto-alert at most every this many seconds, no matter how many frames
// still contain a big dump. Prevents spamming the email channel.
const ALERT_COOLDOWN_MS = 60000

const ACCENT = '#3b82f6'        // generic / fallback
const HUMAN_COLOR = '#FFD60A'
const RIVER_COLOR = '#00ffd4'

// Per-class accent colours — extend freely
const CLASS_COLOR = {
  'plastic bottle': '#3b82f6',   // blue
  'plastic bag':    '#a78bfa',   // violet
  'styrofoam':      '#f472b6',   // pink
  'can':            '#fb923c',   // orange
  'glass':          '#34d399',   // emerald
  'paper':          '#fbbf24',   // amber
  'tire':           '#f87171',   // red
  'cloth':          '#60a5fa',   // sky blue
  'river trash':    '#00ffd4',   // cyan
  'trash':          '#3b82f6',   // blue (generic)
  'human':          '#FFD60A',   // yellow
}
function classColor(label) {
  if (!label) return ACCENT
  return CLASS_COLOR[label.toLowerCase()] || ACCENT
}

// Emoji icon shown inside the label pill for quick glance
const CLASS_ICON = {
  'plastic bottle': '🍶',
  'plastic bag':    '🛍',
  'styrofoam':      '☕',
  'can':            '🥫',
  'glass':          '🍾',
  'paper':          '📄',
  'tire':           '🛞',
  'cloth':          '🧻',
  'river trash':    '🌊',
  'trash':          '🗑',
  'human':          '🧍',
}
function classIcon(label) {
  return CLASS_ICON[label?.toLowerCase()] || '📦'
}
const TILE_TTL = 1500
const TILE_OVERLAP = 0.35
const BUDGET_MS = 80
const MERGE_IOU = 0.4
const FACE_SUPPRESS_IOU = 0.20

// Confidence thresholds, kept here so they're easy to retune.
//
// Humans are held to a HIGH bar: a human box doesn't just get drawn, it also
// deletes every trash box overlapping it (suppressByPerson / suppressByFace).
// So a false "Human" costs a real trash detection as well as looking wrong.
//
// At 0.70 far fewer objects get mislabelled "Human". Note the second-order
// effect this has, because it runs the other way: fewer human boxes means
// fewer trash boxes get deleted by them, so trash near a person is now MORE
// likely to survive, not less. Whether a bag is called trash is decided by
// the detection threshold below, not by these.
const FACE_CONF = 0.70
const PERSON_CONF = 0.70
// Detection (public/models/plastic.onnx) uses the operator's slider directly,
// never below DETECT_CONF_FLOOR. Long-range tiles zoom in, so they may go a
// little lower (TILE_CONF_FACTOR) to pick up small, distant objects.
const DETECT_CONF_FLOOR = 0.2
// An answered object keeps its answer at its last position this long after it
// was last seen (detections flicker, and the tracker then starts a new track).
const ANSWER_HOLD_MS = 15000
const TILE_CONF_FACTOR = 0.85
// The face and person models only stop people being counted as plastic, and
// people move slowly: running them on every frame tripled each frame's work.
// They run at most this often; frames in between reuse their last answer.
const HUMAN_EVERY_MS = 350

// One CPU copy of the current picture per detection pass. Every model, box
// check and crop then reads from it. Reading pixels straight from the live
// <video> / video canvas blocks the page ~16 ms EACH time (a GPU readback),
// and a pass did it 4-15 times (each model, each box the self-learner
// checks): the Live tab stuttered. VideoFrame.copyTo reads it once, without
// blocking. Returns null where it isn't supported; callers then use the element.
// `snap` is the caller's own { cv, ctx, buf, ok } (one per detector on screen).
async function snapshotFrame(el, snap) {
  if (!snap.ok || !el) return null
  let vf = null
  try {
    vf = new VideoFrame(el, { timestamp: 0 })
    const w = vf.displayWidth, h = vf.displayHeight
    if (!w || !h) return null
    const size = vf.allocationSize({ format: 'RGBA' })
    if (!snap.buf || snap.buf.length !== size) snap.buf = new Uint8ClampedArray(size)
    await vf.copyTo(snap.buf, { format: 'RGBA' })
    if (!snap.cv) {
      snap.cv = document.createElement('canvas')
      snap.ctx = snap.cv.getContext('2d', { willReadFrequently: true })
    }
    if (snap.cv.width !== w || snap.cv.height !== h) { snap.cv.width = w; snap.cv.height = h }
    snap.ctx.putImageData(new ImageData(snap.buf, w, h), 0, 0)
    return snap.cv
  } catch (e) {
    // e.g. an older runtime without RGBA copyTo: stop trying, read the element.
    console.info('[detect] reading frames directly:', e?.message ?? e)
    snap.ok = false
    return null
  } finally {
    vf?.close()
  }
}

// Hand the main thread back to the browser between model runs, so the UI can
// paint and take clicks mid-frame instead of freezing while all models run.
const yieldToUI = () =>
  globalThis.scheduler?.yield
    ? globalThis.scheduler.yield()
    : new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0) })

// The public website (Vercel, `--mode site`): its drone is a demo on a server
// with a test camera, so the visitor's own webcam is the camera instead.
const WEB_SITE = import.meta.env.VITE_SITE === '1'
const NO_SYSTEM = { telemetry: { data: null }, simulated: false }

// controlsLift: extra px to raise the Start/Stop/Record row, for hosts that
// overlay their own bottom panel (e.g. the Live tab's flight commands).
// demo: the website's public "Try the AI" page — webcam only, nothing saved,
// no location asked for. background: the off-screen detector (BackgroundDetect).
export default function WebcamDetect({ confThr = 0.15, defaultSource: sourceProp = 'webcam', autoStart: autoProp = false, onCount, controlsLift = 0, demo = false, background = false }) {
  // On the website the webcam comes first and starts on a click, so a visitor
  // is never asked for their camera before they choose to try it.
  const webcamFirst = demo || (WEB_SITE && sourceProp === 'auto' && !background)
  const defaultSource = webcamFirst ? 'webcam' : sourceProp
  const autoStart = webcamFirst ? false : autoProp
  const videoRef     = useRef(null)
  const streamImgRef = useRef(null)
  const streamCanvasRef = useRef(null)   // drone H.264, decoded into it
  const h264Ref = useRef(null)
  const canvasRef    = useRef(null)
  const srcElRef     = useRef(null)
  const detRef       = useRef(null)
  const faceDetRef   = useRef(null)
  const personDetRef = useRef(null)
  const boxesRef     = useRef([])
  const runningRef   = useRef(false)
  const confRef      = useRef(confThr)
  const rafRef       = useRef(0)
  const mediaRecorderRef  = useRef(null)
  const chunksRef         = useRef([])
  const videoCountRef     = useRef(0)
  const snapshotCountRef  = useRef(0)
  const folderHandleRef   = useRef(null)
  const tileGridRef    = useRef(null)
  const tileIndexRef   = useRef(0)
  const tileBoxesRef   = useRef(new Map())
  const activeTileRef  = useRef(null)
  const tileSkipRef    = useRef(0)
  const emaRef         = useRef(60)
  const trackerRef     = useRef(new BoxTracker({ matchIou: 0.25, smoothing: 0.6, maxAgeMs: 500 }))
  const longRangeRef        = useRef(false)
  const gridSizeRef         = useRef(2)
  const humanDetectionRef   = useRef(true)
  const trashDetectionRef   = useRef(true)
  // Self-learning (lib/feedbackLearner.js): the learner, the operator's answers
  // per tracked box (id -> 1 plastic / 0 not), and where the frame is drawn on
  // the canvas so a tap can be matched to a box.
  const learnerRef      = useRef(null)
  const answeredRef     = useRef(new Map())
  const recentAnswersRef = useRef([])   // [{y, box, t}] — answers remembered by position
  const lastAnswerRef   = useRef(null)  // for Undo
  const learnOnRef      = useRef(learnerEnabled())
  const showFilteredRef = useRef(showFilteredEnabled())
  const xformRef        = useRef(null)
  const mppRef          = useRef(null)   // metres per pixel of the drone frame (null = no usable altitude)
  const frameCanvasRef  = useRef(null)
  const frameElRef      = useRef(null)   // this pass's CPU copy of the picture (snapshotFrame)
  const snapRef         = useRef({ cv: null, ctx: null, buf: null, ok: typeof VideoFrame === 'function' })

  const [status, setStatus]               = useState('init')
  const [msg,    setMsg]                  = useState('Loading AI models...')
  const [ep,     setEp]                   = useState('')
  const [fps,    setFps]                  = useState(0)
  const [count,  setCount]                = useState(0)
  const [facing, setFacing]               = useState('environment')
  // 'auto' = the drone's camera when it is streaming, else the laptop webcam.
  const [source, setSource]               = useState(defaultSource === 'auto' ? 'webcam' : defaultSource)
  const [longRange,        setLongRange]        = useState(false)
  const [gridSize,         setGridSize]         = useState(2)
  const [humanDetection,   setHumanDetection]   = useState(true)
  const [trashDetection,   setTrashDetection]   = useState(true)
  const [isRecording,      setIsRecording]      = useState(false)
  const [learnOn,          setLearnOn]          = useState(learnOnRef.current)
  const [showFiltered,     setShowFiltered]     = useState(showFilteredRef.current)
  const [ask,              setAsk]              = useState(null)   // the box the operator tapped
  const [learnStats,       setLearnStats]       = useState(null)
  const [savedAnswers,     setSavedAnswers]     = useState(0)
  const [learnNote,        setLearnNote]        = useState('')
  const [canUndo,          setCanUndo]          = useState(false)
  const [modelKey,         setModelKey]         = useState(getDetectModel)  // which detection model is loaded
  const [modelBusy,        setModelBusy]        = useState(false)

  // The gear slider's value. It has to be state, not a bare ref assignment:
  // `confRef.current = confThr` in the component body re-ran on EVERY render,
  // and setCount/setFps re-render several times a second, so dragging the
  // slider was overwritten back to the prop within milliseconds — the control
  // silently did nothing. The prop (the Live tab's own slider) still wins when
  // it changes, so the two stay in sync.
  const [conf, setConf] = useState(confThr)
  useEffect(() => { setConf(confThr) }, [confThr])
  confRef.current = conf

  // Position for geotagging trash, matched to where the camera actually is:
  //  - Drone mode: the drone GPS streamed over the WebSocket (telemetry), or
  //    the laptop's GPS when the drone has no fix.
  //  - Webcam mode: the camera is the laptop's, so always the laptop's own
  //    location — never the drone's (or the simulator's) position.
  // Kept in refs so the detect loop always reads the latest fix.
  const { telemetry, simulated } = useSystem() || NO_SYSTEM
  const live = useLivePosition(telemetry.data)
  const laptop = useLaptopGps(!demo)
  const geoRef = useRef({ pos: null, posSource: null, alt: null, accuracy: null })
  geoRef.current =
    source === 'webcam'
      ? {
          pos: laptop.pos ? [laptop.pos.lat, laptop.pos.lng] : null,
          posSource: laptop.pos ? 'laptop' : null,
          alt: null,
          accuracy: laptop.pos?.accuracy ?? null,
        }
      : {
          pos: live.position,
          posSource: live.source === 'drone' && simulated ? 'sim' : live.source,
          alt: live.source === 'drone' ? Number(pick(telemetry.data, ['altitude', 'alt', 'relative_alt'])) : null,
          accuracy: live.accuracy ?? null,
          // Attitude, to place each item on the water from where it is in the picture.
          heading: live.source === 'drone' ? pick(telemetry.data, ['heading', 'yaw']) : null,
          roll: live.source === 'drone' ? pick(telemetry.data, ['roll']) : null,
          pitch: live.source === 'drone' ? pick(telemetry.data, ['pitch']) : null,
        }
  const sourceRef = useRef(source)
  sourceRef.current = source
  const lastGeoTagRef = useRef(0)
  const lastAlertAtRef = useRef(0)
  useEffect(() => { longRangeRef.current        = longRange        }, [longRange])
  useEffect(() => { humanDetectionRef.current   = humanDetection   }, [humanDetection])
  useEffect(() => { trashDetectionRef.current   = trashDetection   }, [trashDetection])
  useEffect(() => { learnOnRef.current = learnOn; setLearnerEnabled(learnOn) }, [learnOn])
  useEffect(() => { showFilteredRef.current = showFiltered; setShowFilteredEnabled(showFiltered) }, [showFiltered])

  function suppressByFace(trashBoxes, faceBoxes) {
    if (!faceBoxes.length) return trashBoxes
    return trashBoxes.filter(t => { for (const f of faceBoxes) { if (overlapRatio(f, t) > FACE_SUPPRESS_IOU) return false } return true })
  }

  useEffect(() => {
    let alive = true
    // Read now: React clears the ref before the cleanup below runs, and an
    // MJPEG <img> that is only removed keeps streaming (see StreamImg).
    const streamImg = streamImgRef.current
    ;(async () => {
      try {
        let d
        try {
          d = await createPlasticDetector((m) => alive && setMsg(m), getDetectModel())
        } catch (me) {
          // A test model that won't load must never leave the operator without detection.
          if (getDetectModel() === DEFAULT_DETECT_MODEL) throw me
          console.warn('[model] test model failed, using the default:', me)
          setDetectModel(DEFAULT_DETECT_MODEL)
          d = await createPlasticDetector((m) => alive && setMsg(m), DEFAULT_DETECT_MODEL)
        }
        if (!alive) return d.dispose()
        detRef.current = d
        setModelKey(d.meta.key)
        learnerRef.current = createLearner(d.meta.names)
        setLearnStats(learnerRef.current.stats())
        feedbackCount().then((n) => alive && setSavedAnswers(n))
        try {
          const { createFaceDetector } = await import('../lib/faceDetector')
          const fd = await createFaceDetector((m) => alive && setMsg(m))
          if (!alive) { fd.dispose(); return }
          faceDetRef.current = fd; setEp(d.ep + '+face'); setMsg('Models ready')
        } catch (fe) { console.warn('[face] load failed:', fe); setEp(d.ep); setMsg('Model ready') }
        try {
          const { createPersonDetector } = await import('../lib/personDetector')
          const pd = await createPersonDetector((m) => alive && setMsg(m))
          if (!alive) { pd.dispose(); return }
          personDetRef.current = pd; setEp(d.ep + '+face+person')
        } catch (pe) { console.warn('[person] load failed:', pe) }
        setStatus('ready')
        if (autoStart) {
          const first = defaultSource === 'auto' ? await pickSource() : defaultSource
          if (!alive) return
          setSource(first)
          start(first)
        }
      } catch (e) {
        if (!alive) return
        // "memory access out of bounds" is a WASM trap. Once the shared
        // onnxruntime module traps, nothing can use it again until the page is
        // reloaded, so say so rather than leaving a dead Start button.
        const raw = String(e?.message ?? e)
        const trapped = /memory access out of bounds|out of memory|abort/i.test(raw)
        setStatus('error')
        setMsg(trapped
          ? `Failed to load model: ${raw}. Reload the page to recover — if it keeps happening, the GPU path is at fault.`
          : 'Failed to load model: ' + raw)
      }
    })()
    return () => { alive=false; stop(); releaseStream(streamImg); detRef.current?.dispose(); faceDetRef.current?.dispose(); personDetRef.current?.dispose() }
  }, [defaultSource, autoStart])

  function fitCanvas() { const cv=canvasRef.current; if(!cv) return; const r=cv.getBoundingClientRect(); cv.width=Math.max(2,Math.round(r.width)); cv.height=Math.max(2,Math.round(r.height)) }
  function srcSize(el) { return [el.videoWidth||el.naturalWidth||el.width||0, el.videoHeight||el.naturalHeight||el.height||0] }

  function drawBoxes(ctx, cw, ch, vw, vh, ox, oy, dw, dh) {
    // At least 15 px so the labels stay readable on a phone screen.
    const fontSize = Math.max(15, Math.round(cw / 52))
    ctx.textBaseline = 'middle'

    for (const b of boxesRef.current) {
      const isHuman = b.label === 'Human'
      // Self-learning state: unsure boxes are dashed with a '?', filtered ones
      // (only drawn with 'Show filtered' on) are grey and faded.
      const filtered = b.rl === 'hide' || b.rl === 'rejected'
      const unsure = b.rl === 'explore'
      const fade = filtered ? 0.45 : 1
      const dash = isHuman ? [8, 5] : unsure || filtered ? [6, 4] : []
      const col = filtered ? '#9ca3af' : b.color || classColor(b.label)
      const conf = Number(b.score) || 0

      // Box coordinates in canvas space
      const x = ox + (b.x1 / vw) * dw
      const y = oy + (b.y1 / vh) * dh
      const w = ((b.x2 - b.x1) / vw) * dw
      const h = ((b.y2 - b.y1) / vh) * dh

      // ── 1. Soft filled tint inside the box ──────────────────────────
      ctx.save()
      ctx.globalAlpha = 0.08 * fade
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, 6)
      ctx.fill()
      ctx.restore()

      // ── 2. Double-stroke glow (wide faint + thin sharp) ─────────────
      // Outer glow
      ctx.save()
      ctx.globalAlpha = 0.22 * fade
      ctx.strokeStyle = col
      ctx.lineWidth = 8
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, 6)
      ctx.stroke()
      ctx.restore()

      // Inner crisp stroke
      ctx.save()
      ctx.globalAlpha = 1 * fade
      ctx.strokeStyle = col
      ctx.lineWidth = isHuman ? 1.5 : 2
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, 6)
      ctx.stroke()
      ctx.restore()

      // ── 3. Corner accent brackets ────────────────────────────────────
      const arm = Math.min(w, h) * 0.18   // length of each bracket arm
      const r   = 4                        // corner radius of bracket
      ctx.save()
      ctx.strokeStyle = col
      ctx.lineWidth   = 3
      ctx.lineCap     = 'round'
      ctx.setLineDash([])
      ctx.globalAlpha = 1 * fade
      // top-left
      ctx.beginPath(); ctx.moveTo(x + arm, y); ctx.lineTo(x + r, y); ctx.arcTo(x, y, x, y + r, r); ctx.lineTo(x, y + arm); ctx.stroke()
      // top-right
      ctx.beginPath(); ctx.moveTo(x + w - arm, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + arm); ctx.stroke()
      // bottom-left
      ctx.beginPath(); ctx.moveTo(x, y + h - arm); ctx.lineTo(x, y + h - r); ctx.arcTo(x, y + h, x + r, y + h, r); ctx.lineTo(x + arm, y + h); ctx.stroke()
      // bottom-right
      ctx.beginPath(); ctx.moveTo(x + w - arm, y + h); ctx.lineTo(x + w - r, y + h); ctx.arcTo(x + w, y + h, x + w, y + h - r, r); ctx.lineTo(x + w, y + h - arm); ctx.stroke()
      ctx.restore()

      // ── 4. Label pill ────────────────────────────────────────────────
      ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`
      const icon     = classIcon(b.label)
      const confTxt  = isHuman ? '' : ` ${Math.round(conf * 100)}%`
      const mark = b.answered === 1 || (b.why === 'rule' && b.rl === 'show') ? '  ✔'
        : b.answered === 0 ? '  ✖ not plastic'
        : unsure ? '  ?'
        : filtered ? (b.why === 'rule' ? '  ✖ your answer' : '  · filtered') : ''
      // Real-world size from the drone's altitude ("≈30 cm"), plastic only.
      const mpp = mppRef.current
      const sizeTxt = mpp && !isHuman && !filtered ? `  ${fmtLength(Math.max(b.x2 - b.x1, b.y2 - b.y1) * mpp)}` : ''
      const pillText = `${icon}  ${b.label}${confTxt}${sizeTxt}${mark}`

      const textW  = ctx.measureText(pillText).width
      const pillH  = fontSize + 10
      const pillW  = textW + 22
      const pillR  = pillH / 2        // fully rounded ends
      const pillX  = x
      const pillY  = y - pillH - 5    // float just above the box
      const clampY = Math.max(2, pillY) // never go off the top edge

      // pill background — frosted glass effect (dark fill + colored border)
      ctx.save()
      ctx.globalAlpha = 0.88 * fade
      ctx.fillStyle = 'rgba(8, 14, 26, 0.82)'
      ctx.beginPath()
      ctx.roundRect(pillX, clampY, pillW, pillH, pillR)
      ctx.fill()
      ctx.restore()

      // pill border in class colour
      ctx.save()
      ctx.strokeStyle = col
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.9 * fade
      ctx.beginPath()
      ctx.roundRect(pillX, clampY, pillW, pillH, pillR)
      ctx.stroke()
      ctx.restore()

      // pill text
      ctx.save()
      ctx.fillStyle   = '#ffffff'
      ctx.globalAlpha = 1 * fade
      ctx.font        = `600 ${fontSize}px Inter, system-ui, sans-serif`
      ctx.textBaseline = 'middle'
      ctx.fillText(pillText, pillX + 11, clampY + pillH / 2)
      ctx.restore()

      // ── 5. Confidence bar — thin strip at the bottom of the box ─────
      if (!isHuman && w > 40) {
        const barH  = 3
        const barY  = y + h - barH - 2
        const barX  = x + 2
        const barW  = w - 4

        // track
        ctx.save()
        ctx.globalAlpha = 0.25 * fade
        ctx.fillStyle   = '#ffffff'
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, 2)
        ctx.fill()
        ctx.restore()

        // fill
        ctx.save()
        ctx.globalAlpha = 0.9 * fade
        ctx.fillStyle   = col
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW * conf, barH, 2)
        ctx.fill()
        ctx.restore()
      }
    }
  }

  function draw() {
    const cv=canvasRef.current, el=srcElRef.current
    if(!cv||!el) return
    const ctx=cv.getContext('2d'), cw=cv.width, ch=cv.height
    ctx.clearRect(0,0,cw,ch)
    const [vw,vh]=srcSize(el)
    if(vw&&vh){
      const scale=Math.min(cw/vw,ch/vh), dw=vw*scale, dh=vh*scale, ox=(cw-dw)/2, oy=(ch-dh)/2
      ctx.drawImage(el,ox,oy,dw,dh)
      xformRef.current={ox,oy,dw,dh,vw,vh}
      if(longRangeRef.current&&activeTileRef.current&&runningRef.current){
        const t=activeTileRef.current; ctx.save(); ctx.setLineDash([5,5]); ctx.lineWidth=1.5
        ctx.strokeStyle='rgba(255,255,255,0.35)'
        ctx.strokeRect(ox+t.x1*dw,oy+t.y1*dh,(t.x2-t.x1)*dw,(t.y2-t.y1)*dh); ctx.restore()
      }
      drawBoxes(ctx,cw,ch,vw,vh,ox,oy,dw,dh)
    }
    if(runningRef.current) rafRef.current=requestAnimationFrame(draw)
  }

  function ensureTileGrid() {
    if(!tileGridRef.current||tileGridRef.current.size!==gridSizeRef.current){
      const size=gridSizeRef.current
      tileGridRef.current={size,tiles:makeTileGrid(size,size,TILE_OVERLAP)}
      tileIndexRef.current=0; tileBoxesRef.current.clear(); setGridSize(size)
    }
    return tileGridRef.current.tiles
  }

  async function detectLoop() {
    let frames=0, t0=performance.now(), taintWarned=false, lastShotTs=null
    let humanAt=-Infinity, lastFaces=[], lastPersons=[]
    while(runningRef.current&&detRef.current&&srcElRef.current){
      const tickStart=performance.now()
      const loopFrame={} // the person filter shares one COCO model pass per loop
      // The drone's pose when this picture was taken (H.264 from the drone Pi):
      // the detections are placed from it, not from telemetry that arrived later.
      const shot=srcElRef.current===streamCanvasRef.current?h264Ref.current?.frame():null
      // Drone video arrives at ~15 fps: don't run the models again on a picture
      // they have already seen (long range does, a different tile each time).
      // The next new frame then starts straight away instead of queueing on the GPU.
      if(shot&&!longRangeRef.current&&shot.tsUs===lastShotTs){await new Promise(r=>requestAnimationFrame(r));continue}
      lastShotTs=shot?.tsUs??null
      const src=(await snapshotFrame(srcElRef.current,snapRef.current))||srcElRef.current
      if(!runningRef.current) break
      frameElRef.current=src
      let faceBoxes=[], personBoxes=[], trashBoxes=[]
      if(trashDetectionRef.current){
        try { trashBoxes=await detRef.current.detect(src,{confThr:Math.max(DETECT_CONF_FLOOR,confRef.current),iouThr:0.40}) }
        catch(e){ if(!taintWarned&&/tainted|cross.origin|SecurityError/i.test(e?.message??'')){taintWarned=true;setMsg('Drone stream blocked by CORS')} }
      }
      await yieldToUI()
      if(humanDetectionRef.current&&tickStart-humanAt>=HUMAN_EVERY_MS){
        humanAt=tickStart
        if(faceDetRef.current){
          try{lastFaces=await faceDetRef.current.detectFaces(src,{confThr:FACE_CONF,iouThr:0.25})}catch(e){console.warn('[face]',e)}
        }
        await yieldToUI()
        if(personDetRef.current){
          try{lastPersons=await personDetRef.current.detectPersons(src,{confThr:PERSON_CONF,iouThr:0.30,frame:loopFrame})}catch(e){console.warn('[person]',e)}
        }
      }
      if(humanDetectionRef.current){faceBoxes=lastFaces;personBoxes=lastPersons}
      else{lastFaces=[];lastPersons=[];humanAt=-Infinity}
      let runTile=false
      if(longRangeRef.current){
        if(emaRef.current<=BUDGET_MS){runTile=true;if(emaRef.current<=BUDGET_MS*0.4)gridSizeRef.current=3;else if(emaRef.current>BUDGET_MS*0.7)gridSizeRef.current=2}
        else if(emaRef.current<=BUDGET_MS*1.8){runTile=tileSkipRef.current++%2===0;gridSizeRef.current=2}
        else{gridSizeRef.current=2}
      }
      if(runTile){
        const tiles=ensureTileGrid(),idx=tileIndexRef.current%tiles.length,rect=tiles[idx]
        activeTileRef.current=rect
        try{const tc=Math.max(DETECT_CONF_FLOOR,confRef.current*TILE_CONF_FACTOR),tb=await detRef.current.detect(src,{confThr:tc,iouThr:0.40,rect});tileBoxesRef.current.set(idx,{boxes:tb,ts:performance.now()})}catch{}
        tileIndexRef.current=idx+1
      } else { activeTileRef.current=null }
      const now=performance.now()
      emaRef.current=emaRef.current*0.8+(now-tickStart)*0.2
      const ft=[];for(const{boxes,ts}of tileBoxesRef.current.values()){if(now-ts<=TILE_TTL)ft.push(boxes)}
      const merged=ft.length?mergeBoxes([trashBoxes,...ft],MERGE_IOU):trashBoxes
      let finalTrash=merged
      if(humanDetectionRef.current){finalTrash=suppressByPerson(suppressByFace(merged,faceBoxes),personBoxes)}
      // Self-learning: score every box. 'show' = counted as before, 'explore' =
      // drawn with a '?' for the operator to answer (not counted), 'hide' = a
      // learned false alarm. Features are computed even with learning off, so
      // the operator can still teach it.
      const el=src
      const [fw,fh]=el?srcSize(el):[0,0]
      const lrn=learnerRef.current
      const scored=finalTrash.map(b=>{
        if(!lrn) return {...b,rl:'show'}
        const ci=cropInfo(el,b) // colour stats + appearance fingerprint
        const feat=boxFeatures(b,fw,fh,lrn.nClasses,ci?.stats)
        const fp=ci?.fp||null
        if(!learnOnRef.current) return {...b,feat,fp,rl:'show'}
        const d=lrn.decide(feat,fp)
        return {...b,feat,fp,rl:d.action,why:d.reason}
      })
      const visible=scored.filter(b=>b.rl!=='hide'||showFilteredRef.current)
      const lf=[] // face boxes are used for trash suppression above but never drawn - show body only
      const lp=humanDetectionRef.current?personBoxes.map(b=>({...b,label:'Human',color:HUMAN_COLOR,cls:'human'})):[]
      const topT=visible.sort((a,b)=>b.score-a.score).slice(0,12)
      // The operator's answer for a box always wins: while it stays tracked, and
      // for ANSWER_HOLD_MS after it was last seen at that spot — so an answered
      // object that flickers out and back (a new track) keeps its answer.
      const answers=answeredRef.current
      const nowMs=Date.now()
      const recentAns=recentAnswersRef.current=recentAnswersRef.current.filter(r=>nowMs-r.t<ANSWER_HOLD_MS)
      const tracked=trackerRef.current.update([...lf,...lp,...topT],now).map(b=>{
        if(b.cls==='human'||!learnOnRef.current) return b
        let a=answers.get(b.id)
        const near=recentAns.find(r=>overlapRatio(b,r.box)>=0.5&&overlapRatio(r.box,b)>=0.5)
        if(a===undefined&&near){a=near.y;answers.set(b.id,a)}
        if(a===undefined) return b
        if(near){near.box={x1:b.x1,y1:b.y1,x2:b.x2,y2:b.y2};near.t=nowMs} // follow it while in view
        return {...b,answered:a,rl:a?'show':'rejected'}
      })
      if(answers.size){const live=new Set(tracked.map(b=>b.id));for(const id of answers.keys()){if(!live.has(id))answers.delete(id)}}
      boxesRef.current=tracked.filter(b=>b.rl!=='rejected'||showFilteredRef.current)
      const counted=tracked.filter(b=>b.cls!=='human'&&b.rl==='show')
      if(!demo)recordTrashCount(counted.length) // share plastic-only count with the Detections tab
      // Stamp plastic with the aircraft's live position (≤ 2x/sec) for the Detections tab + report,
      // and grab a photo of this frame (the boxed view, exactly what the operator saw).
      // Real-world scale of this frame (drone feed with a known altitude only):
      // the boxes are drawn with their size, and the sighting records it.
      const fovH=getFovSettings().fovHorizontalDeg
      const fp=shot?.pose
      const g=sourceRef.current!=='webcam'&&fp&&Number.isFinite(fp.lat)&&Number.isFinite(fp.lng)
        ?{...geoRef.current,pos:[fp.lat,fp.lng],posSource:'drone',alt:fp.alt,heading:fp.hdg,roll:fp.roll,pitch:fp.pitch}
        :geoRef.current
      mppRef.current=sourceRef.current!=='webcam'?metersPerPixel({frameW:fw,altitudeM:g.alt,fovHDeg:fovH}):null
      if(!demo&&counted.length>0&&now-lastGeoTagRef.current>=500){
        lastGeoTagRef.current=now
        const biggestOf=(bs)=>bs.reduce((m,b)=>((b.x2-b.x1)*(b.y2-b.y1)>(m.x2-m.x1)*(m.y2-m.y1)?b:m))
        const biggest=biggestOf(counted)
        const cls=biggest.label||'plastic'
        const photo=capturePhoto()
        // Drone feed with a GPS fix, altitude and heading: place each item where it
        // is on the water (from where it sits in the straight-down picture), one
        // sighting per group of items within 5 m, so the boat goes to the plastic
        // itself rather than to the point under the drone. Otherwise: the camera's position.
        const cam=getFovSettings()
        const groups=sourceRef.current!=='webcam'&&g.posSource!=='laptop'&&g.pos?projectBoxes(counted,{
          frameW:fw,frameH:fh,lat:g.pos[0],lng:g.pos[1],altitudeM:g.alt,headingDeg:g.heading,rollDeg:g.roll,pitchDeg:g.pitch,
          fovHDeg:fovH,rotationDeg:cam.cameraRotationDeg,levelled:cam.cameraGimbal,
        }):null
        const record=(bs,lat,lng,where)=>{
          const big=biggestOf(bs)
          // The drone's crop of the item: the boat later checks it collects this same piece.
          const crop=sourceRef.current!=='webcam'?cropBox(big):null
          const size=mppRef.current?pixelBoxToRealSize({boxW:big.x2-big.x1,boxH:big.y2-big.y1,frameW:fw,altitudeM:g.alt,fovDeg:{horizontal:fovH}}):null
          recordTrashSighting({
            lat, lng, alt:g.alt,
            count:bs.length, confidence:Math.max(...bs.map(b=>Number(b.score)||0)),
            source:sourceRef.current, posSource:g.posSource, posMethod:where, accuracy:g.accuracy,
            photo, crop:crop?.url, cropW:crop?.w, cropH:crop?.h,
            className:big.label||cls, estWidthM:size?.widthM??null, estHeightM:size?.heightM??null,
            sizes:mppRef.current?summarizeSizes(bs,{frameW:fw,altitudeM:g.alt,fovHDeg:fovH}):null,
          })
        }
        if(groups) for(const grp of groups) record(grp.boxes,grp.lat,grp.lng,'picture')
        else record(counted,g.pos?g.pos[0]:null,g.pos?g.pos[1]:null,g.pos?'camera':null)
        // Big-dump auto alerts. Guarded by cooldown and per-channel toggles.
        const settings=getAlertSettings()
        if(counted.length>=Math.max(1,Number(settings.bigDumpThreshold)||8)&&Date.now()-lastAlertAtRef.current>ALERT_COOLDOWN_MS){
          lastAlertAtRef.current=Date.now()
          const alert={itemCount:counted.length,cls,lat:g.pos?g.pos[0]:null,lng:g.pos?g.pos[1]:null,source:sourceRef.current}
          if(settings.enableEmailOnBigDump){sendBigDumpEmail(alert).catch(()=>{})}
        }
      }
      const shownCount=boxesRef.current.filter(b=>b.rl!=='hide'&&b.rl!=='rejected').length
      setCount(shownCount); onCount?.(shownCount)
      frames++
      if(now-t0>600){setFps(Math.round(frames*1000/(now-t0)));frames=0;t0=now}
      await new Promise(r=>requestAnimationFrame(r))
    }
  }

  async function startWebcam(f){
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:f,width:{ideal:1280},height:{ideal:720}},audio:false})
    const v=videoRef.current; v.srcObject=stream; await v.play(); srcElRef.current=v
  }
  /** The drone camera: H.264 (camera module, browsers with WebCodecs), else MJPEG. */
  function startStream(){
    return h264Supported()?startH264().catch(()=>startMjpeg()):startMjpeg()
  }
  async function startH264(){
    const st=await api.cameraStatus().catch(()=>null)
    if(st?.codec!=='h264') throw new Error('the camera sends MJPEG')
    return new Promise((resolve,reject)=>{
      const cv=streamCanvasRef.current
      let started=false
      const fail=(why)=>{if(started)return;started=true;h264Ref.current?.close();h264Ref.current=null;reject(new Error(why))}
      const timer=setTimeout(()=>fail('no H.264 picture'),6000)
      h264Ref.current=playH264({url:api.h264Url()+'?pose=1',canvas:cv,
        onFirstFrame:()=>{if(started)return;started=true;clearTimeout(timer);srcElRef.current=cv;resolve()},
        onFatal:(why)=>{
          clearTimeout(timer)
          if(!started){fail(why);return}
          // The camera switched to MJPEG while running (e.g. a webcam was plugged in).
          h264Ref.current=null
          if(runningRef.current) startMjpeg().catch(()=>{})
        }})
    })
  }
  function startMjpeg(){
    return new Promise((resolve,reject)=>{
      const img=streamImgRef.current; img.crossOrigin='anonymous'
      const onLoad=()=>{img.removeEventListener('load',onLoad);srcElRef.current=img;resolve()}
      img.addEventListener('load',onLoad)
      img.addEventListener('error',()=>reject(new Error('stream unavailable')),{once:true})
      img.src=api.streamUrl()+(api.streamUrl().includes('?')?'&':'?')+'t='+Date.now()
      setTimeout(()=>{if(img.naturalWidth){srcElRef.current=img;resolve()}},1500)
    })
  }
  /** The drone's camera if it is streaming, else the laptop webcam. */
  async function pickSource(){
    try{const r=await api.cameraStatus();return r?.camera_connected?'drone':'webcam'}catch{return 'webcam'}
  }
  async function start(src=source,f=facing){
    if(!detRef.current) return
    try{
      if(src==='webcam'){
        try{await startWebcam(f)}
        catch(e){
          // No laptop camera (or no permission): use the drone's if it is streaming.
          if(defaultSource!=='auto'||(await pickSource())!=='drone')throw e
          src='drone';setSource('drone');await startStream()
        }
      } else await startStream()
      fitCanvas(); runningRef.current=true; setStatus('running'); draw(); detectLoop()
      // Record the whole mission (the boxed view, exactly what the operator saw)
      // from Start to Stop, so a full video — not just still detections — is
      // available for the report.
      if(!demo)try{startMissionRecording(canvasRef.current.captureStream(15))}catch(e){console.warn('[mission-video]',e)}
    }catch(e){
      setStatus('error'); setMsg(src==='webcam'?'Camera unavailable: '+(e?.message??e)+' (needs HTTPS + permission)':'Drone stream unavailable: '+(e?.message??e))
    }
  }
  function stop(){
    runningRef.current=false; cancelAnimationFrame(rafRef.current)
    stopMissionRecording()
    const v=videoRef.current; if(v?.srcObject){v.srcObject.getTracks().forEach(t=>t.stop());v.srcObject=null}
    releaseStream(streamImgRef.current)
    h264Ref.current?.close(); h264Ref.current=null
    srcElRef.current=null; boxesRef.current=[]; tileBoxesRef.current.clear()
    tileGridRef.current=null; activeTileRef.current=null; trackerRef.current.reset()
    answeredRef.current.clear(); xformRef.current=null; mppRef.current=null; setAsk(null)
    emaRef.current=60; gridSizeRef.current=2; setStatus(s=>s==='running'?'ready':s)
  }
  async function switchSource(next){
    if(next===source)return
    // Start the new source if the old one was running, or if this view starts by
    // itself (a failed webcam must not leave the drone feed waiting for Start).
    const go=runningRef.current||autoStart
    stop();setSource(next)
    if(detRef.current){setStatus(s=>s==='error'?'ready':s);setMsg('')}
    if(go)await start(next)
  }
  async function flip(){const next=facing==='environment'?'user':'environment';setFacing(next);if(runningRef.current&&source==='webcam'){stop();await start('webcam',next)}}

  async function getSaveFolder(){
    if(folderHandleRef.current)return folderHandleRef.current
    if(typeof window.showDirectoryPicker==='function'){
      try{const h=await window.showDirectoryPicker({mode:'readwrite',startIn:'downloads'});folderHandleRef.current=h;return h}catch{}
    }
    return null
  }
  async function saveBlob(blob,filename){
    const folder=await getSaveFolder()
    if(folder){try{const fh=await folder.getFileHandle(filename,{create:true}),w=await fh.createWritable();await w.write(blob);await w.close();return}catch(e){console.warn('[save]',e)}}
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  function toggleRecording(){
    if(isRecording){if(mediaRecorderRef.current&&mediaRecorderRef.current.state!=='inactive')mediaRecorderRef.current.stop();setIsRecording(false);return}
    const cv=canvasRef.current; if(!cv)return
    const stream=cv.captureStream(30)
    // VP8 first: same .webm output, several times cheaper to encode than VP9 (keeps the UI smooth while recording)
    const mimeType=['video/webm; codecs=vp8','video/webm; codecs=vp9'].find(t=>MediaRecorder.isTypeSupported(t))||'video/webm'
    const recorder=new MediaRecorder(stream,{mimeType})
    mediaRecorderRef.current=recorder; chunksRef.current=[]
    recorder.ondataavailable=e=>{if(e.data&&e.data.size>0)chunksRef.current.push(e.data)}
    recorder.onstop=async()=>{
      videoCountRef.current++
      const blob=new Blob(chunksRef.current,{type:'video/webm'}),filename=`video${videoCountRef.current}.webm`
      await saveBlob(blob,filename); setMsg(`Saved ${filename}`); setTimeout(()=>setMsg(''),2000)
    }
    recorder.start(); setIsRecording(true)
  }
  // Small JPEG of the current (already-boxed) canvas frame, for a trash
  // sighting's photo in the Detections tab + report. Downscaled to keep each
  // photo a few KB — this runs up to twice a second while trash is on screen.
  const photoCanvasRef = useRef(null)
  function capturePhoto(){
    const cv=canvasRef.current; if(!cv||!cv.width||!cv.height) return null
    if(!photoCanvasRef.current) photoCanvasRef.current=document.createElement('canvas')
    const pc=photoCanvasRef.current
    const scale=Math.min(1,360/cv.width)
    pc.width=Math.round(cv.width*scale); pc.height=Math.round(cv.height*scale)
    const ctx=pc.getContext('2d'); if(!ctx) return null
    ctx.drawImage(cv,0,0,pc.width,pc.height)
    try{return pc.toDataURL('image/jpeg',0.6)}catch{return null}
  }

  // ── Self-learning: tap a box, answer ✔ / ✖ ─────────────────────────────
  // The clean camera frame (no boxes drawn) as a JPEG, saved with each answer
  // so the answers can later be exported as a training dataset.
  function captureFrame(){
    const el=srcElRef.current; if(!el) return null
    const [vw,vh]=srcSize(el); if(!vw||!vh) return null
    if(!frameCanvasRef.current) frameCanvasRef.current=document.createElement('canvas')
    const fc=frameCanvasRef.current, scale=Math.min(1,640/Math.max(vw,vh))
    fc.width=Math.round(vw*scale); fc.height=Math.round(vh*scale)
    const ctx=fc.getContext('2d'); if(!ctx) return null
    ctx.drawImage(el,0,0,fc.width,fc.height)
    try{return fc.toDataURL('image/jpeg',0.85)}catch{return null}
  }

  // The clean frame around one box (with some water around it), at most 128 px:
  // the drone's reference image of that item for the boat (droneTargets.js).
  function cropBox(b){
    const el=frameElRef.current||srcElRef.current; if(!el||!b) return null
    const [vw,vh]=srcSize(el); if(!vw||!vh) return null
    const bw=b.x2-b.x1, bh=b.y2-b.y1; if(bw<2||bh<2) return null
    const x1=Math.max(0,b.x1-0.35*bw), y1=Math.max(0,b.y1-0.35*bh)
    const x2=Math.min(vw,b.x2+0.35*bw), y2=Math.min(vh,b.y2+0.35*bh)
    const k=Math.min(1,128/Math.max(x2-x1,y2-y1))
    const cv=document.createElement('canvas')
    cv.width=Math.max(1,Math.round((x2-x1)*k)); cv.height=Math.max(1,Math.round((y2-y1)*k))
    const ctx=cv.getContext('2d'); if(!ctx) return null
    try{ctx.drawImage(el,x1,y1,x2-x1,y2-y1,0,0,cv.width,cv.height);return {url:cv.toDataURL('image/jpeg',0.85),w:cv.width,h:cv.height}}
    catch{return null} // a cross-origin stream can't be read back
  }

  function onCanvasTap(e){
    const cv=canvasRef.current, xf=xformRef.current
    if(!cv||!xf||!runningRef.current||!learnerRef.current){setAsk(null);return}
    const r=cv.getBoundingClientRect(), px=e.clientX-r.left, py=e.clientY-r.top
    const PAD=12 // small boxes are hard to hit — accept taps just outside them
    let hit=null, hitArea=Infinity
    for(const b of boxesRef.current){
      if(b.cls==='human'||!b.feat) continue
      const x=xf.ox+(b.x1/xf.vw)*xf.dw, y=xf.oy+(b.y1/xf.vh)*xf.dh
      const w=((b.x2-b.x1)/xf.vw)*xf.dw, h=((b.y2-b.y1)/xf.vh)*xf.dh
      if(px>=x-PAD&&px<=x+w+PAD&&py>=y-PAD&&py<=y+h+PAD&&w*h<hitArea){hit=b;hitArea=w*h}
    }
    if(!hit){setAsk(null);return}
    const cl=(v)=>Math.min(1,Math.max(0,v))
    setAsk({
      id:hit.id, label:hit.label, score:hit.score, feat:hit.feat, fp:hit.fp||null,
      srcBox:{x1:hit.x1,y1:hit.y1,x2:hit.x2,y2:hit.y2},
      box:{x1:cl(hit.x1/xf.vw),y1:cl(hit.y1/xf.vh),x2:cl(hit.x2/xf.vw),y2:cl(hit.y2/xf.vh)},
      image:captureFrame(), // the frame as it was when tapped
      cx:e.clientX, cy:e.clientY, // screen position of the tap, for the floating question
    })
  }

  const noteTimerRef = useRef(0)
  function flashNote(text,ms=2500){clearTimeout(noteTimerRef.current);setLearnNote(text);noteTimerRef.current=setTimeout(()=>setLearnNote(''),ms)}

  function answer(y){
    const a=ask, lrn=learnerRef.current
    setAsk(null)
    if(!a||!lrn) return
    lrn.update(a.feat,y,a.fp)
    answeredRef.current.set(a.id,y)
    const rec={y,box:a.srcBox,t:Date.now()}
    recentAnswersRef.current.push(rec)
    const last={id:a.id,rec,savedId:null}
    lastAnswerRef.current=last
    setLearnStats(lrn.stats())
    setCanUndo(true)
    flashNote(y?`Learned: ${a.label} ✔ — always shown`:'Learned: not plastic ✖ — hidden from now on',6000)
    saveFeedback({image:a.image,box:a.box,label:y,className:a.label,score:a.score})
      .then(id=>{last.savedId=id;return feedbackCount()}).then(setSavedAnswers).catch(()=>{})
  }

  function undoLast(){
    const last=lastAnswerRef.current, lrn=learnerRef.current
    if(!last||!lrn||!lrn.undo()) return
    lastAnswerRef.current=null
    answeredRef.current.delete(last.id)
    recentAnswersRef.current=recentAnswersRef.current.filter(r=>r!==last.rec)
    setLearnStats(lrn.stats())
    setCanUndo(false)
    flashNote('Undone',1500)
    const del=last.savedId?deleteFeedback(last.savedId):Promise.resolve()
    del.then(()=>feedbackCount()).then(setSavedAnswers).catch(()=>{})
  }

  // Swap the detection model. Detection is paused while the new model loads
  // (two models must not run at the same time on the shared AI runtime), and
  // it restarts by itself if it was running.
  async function switchModel(key){
    if(key===modelKey||modelBusy||!detRef.current) return
    setModelBusy(true)
    const wasRunning=runningRef.current
    stop()
    await new Promise(r=>setTimeout(r,400)) // let an in-flight detection finish
    try{
      const d=await createPlasticDetector((m)=>setMsg(m),key)
      const old=detRef.current
      detRef.current=d
      old?.dispose()
      learnerRef.current=createLearner(d.meta.names) // each model has its own memory
      setLearnStats(learnerRef.current.stats())
      recentAnswersRef.current=[]; lastAnswerRef.current=null; setCanUndo(false)
      setDetectModel(key); setModelKey(key)
      setConf(Math.min(0.9,Math.max(0.1,Math.round(d.meta.recommendedConf*20)/20)))
      flashNote(`Model: ${DETECT_MODELS.find(m=>m.key===key)?.label||key}${d.meta.test?' (test)':''}`)
    }catch(e){
      console.warn('[model] switch failed:',e)
      flashNote('Could not load that model — kept the current one',4000)
    }finally{
      setModelBusy(false)
      if(wasRunning) start()
    }
  }

  function resetLearning(){
    if(!learnerRef.current) return
    if(!window.confirm('Forget everything the self-learning filter has learned and delete the saved answers?')) return
    learnerRef.current.reset(); answeredRef.current.clear(); recentAnswersRef.current=[]; lastAnswerRef.current=null; setCanUndo(false)
    setLearnStats(learnerRef.current.stats())
    clearFeedback().then(()=>setSavedAnswers(0))
  }

  async function exportAnswers(){
    try{
      const n=await exportFeedback(detRef.current?.meta?.names||[])
      flashNote(n?`Exported ${n} answers`:'No answers saved yet')
    }catch(e){console.warn('[export]',e)}
  }

  async function takeSnapshot(){
    const cv=canvasRef.current,el=srcElRef.current; if(!cv||!el)return
    const [vw,vh]=srcSize(el); if(!vw||!vh)return
    const ctx=cv.getContext('2d'),cw=cv.width,ch=cv.height
    const scale=Math.min(cw/vw,ch/vh),dw=vw*scale,dh=vh*scale,ox=(cw-dw)/2,oy=(ch-dh)/2
    ctx.clearRect(0,0,cw,ch); ctx.drawImage(el,ox,oy,dw,dh); drawBoxes(ctx,cw,ch,vw,vh,ox,oy,dw,dh)
    snapshotCountRef.current++
    const filename=`pic${snapshotCountRef.current}.png`
    cv.toBlob(async blob=>{await saveBlob(blob,filename);setMsg(`Saved ${filename}`);setTimeout(()=>setMsg(''),2000)},'image/png')
  }

  useEffect(()=>{const f=()=>fitCanvas();window.addEventListener('resize',f);return()=>window.removeEventListener('resize',f)},[defaultSource,autoStart])

  const allModelsOn = trashDetection && humanDetection
  const tryCard = webcamFirst && source === 'webcam' && status !== 'running'
  function toggleAllModels(){const next=!allModelsOn;setTrashDetection(next);setHumanDetection(next)}

  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl cam-stage">
      <video ref={videoRef} playsInline muted className="hidden" />
      <img   ref={streamImgRef} alt="" className="hidden" />
      <canvas ref={streamCanvasRef} className="hidden" />
      <canvas ref={canvasRef} className="h-full w-full" onClick={onCanvasTap} />

      {/* ✔ / ✖ for the tapped box — the self-learning filter's reward. Rendered
          into <body> so no panel of the host screen (telemetry, flight
          commands) can ever cover it. */}
      {ask&&createPortal(
        <div className="fixed rounded-2xl p-3" style={{zIndex:2147483000,width:210,
          left:Math.max(8,Math.min(ask.cx+10,window.innerWidth-218)),
          top:Math.max(8,Math.min(ask.cy+10,window.innerHeight-128)),
          background:'rgba(11,18,32,0.97)',border:'1px solid rgba(255,255,255,0.18)',boxShadow:'0 10px 30px rgba(0,0,0,0.55)'}}>
          <div className="mb-2 text-[12px] font-semibold text-white/90">Is this {ask.label}?</div>
          <div className="flex gap-2">
            <button type="button" onClick={()=>answer(1)} className="flex-1 rounded-xl py-1.5 text-[12px] font-bold text-white active:scale-95" style={{background:'rgba(50,215,75,0.85)'}}>✔ Plastic</button>
            <button type="button" onClick={()=>answer(0)} className="flex-1 rounded-xl py-1.5 text-[12px] font-bold text-white active:scale-95" style={{background:'rgba(255,69,58,0.85)'}}>✖ Not</button>
          </div>
          <button type="button" onClick={()=>setAsk(null)} className="mt-1.5 w-full text-[10px] text-white/50">cancel</button>
        </div>,
        document.body,
      )}

      {/* teaching hint / last answer */}
      {status==='running'&&(learnNote||learnOn)&&(
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2">
          <div className="pointer-events-none rounded-full px-3 py-1 text-[10.5px] font-semibold text-white/85"
            style={{background:learnNote?'rgba(50,215,75,0.35)':'rgba(11,18,32,0.7)',border:'1px solid rgba(255,255,255,0.08)'}}>
            {learnNote||'🧠 Tap a box to teach: ✔ plastic / ✖ not'}
          </div>
          {canUndo&&(
            <button type="button" onClick={undoLast}
              className="rounded-full px-3 py-1 text-[10.5px] font-bold text-white active:scale-95"
              style={{background:'rgba(255,159,10,0.85)'}}>↶ Undo last answer</button>
          )}
        </div>
      )}

      {/* status pill */}
      <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-full chip-solid backdrop-blur px-3 py-1.5 shadow-lg"
        style={{border:'1px solid rgba(255,255,255,0.08)'}}>
        <StatusOrb level={status==='running'?'ok':status==='error'?'bad':'warn'} size={9} pulse={status!=='running'} />
        <span className="text-[11px] font-semibold text-white/90">
          {status==='running'?`AI LIVE · ${fps} fps · ${count} found`:status==='error'?'AI ERROR':msg}
        </span>
      </div>

      {DETECT_MODELS.find(m=>m.key===modelKey)?.test&&(
        <div className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-full px-3 py-1 text-[10.5px] font-extrabold tracking-wider text-white"
          style={{background:'rgba(255,159,10,0.9)'}}>
          TEST MODEL · {DETECT_MODELS.find(m=>m.key===modelKey)?.label}
        </div>
      )}

      {/* website: what this is, and one big button to start the webcam */}
      {tryCard&&(
        <div className="absolute inset-0 z-[25] flex items-center justify-center p-4"
          style={{paddingBottom:controlsLift?controlsLift+70:undefined,background:'radial-gradient(ellipse at center,rgba(8,12,22,0.55),rgba(5,8,14,0.92))'}}>
          <div className="w-full max-w-[420px] rounded-3xl p-6 text-center"
            style={{background:'rgba(11,18,32,0.9)',border:'1px solid rgba(255,255,255,0.1)',boxShadow:'0 24px 60px rgba(0,0,0,0.5)',backdropFilter:'blur(14px)'}}>
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl text-2xl"
              style={{background:'linear-gradient(135deg,#5EEAD4,#6BB8FF 55%,#A78BFA)',color:'#04121f'}}>◉</div>
            <div className="text-[18px] font-extrabold text-white">Try VARUNA's AI on your webcam</div>
            <p className="mt-2 text-[13px] leading-relaxed text-white/65">
              Hold up a plastic bottle, a wrapper or a bag. The AI draws a box round each piece of plastic it finds, live.
            </p>
            {status==='error'?(
              <p className="mt-3 rounded-xl px-3 py-2 text-[12px] font-semibold" style={{background:'rgba(255,69,58,0.14)',color:'#FF8A80'}}>
                {/permission|denied|notallowed/i.test(msg)?'The browser blocked the camera. Allow camera access for this site (the camera icon in the address bar), then try again.':msg}
              </p>
            ):null}
            <button type="button" disabled={status==='init'||(status==='error'&&!detRef.current)}
              onClick={()=>{setStatus('ready');setMsg('');start('webcam')}}
              className="mt-5 w-full rounded-2xl px-6 py-3.5 text-[14px] font-extrabold text-[#04121f] transition-all active:scale-[0.98] disabled:opacity-50"
              style={{background:'linear-gradient(135deg,#5EEAD4,#6BB8FF 55%,#A78BFA)',boxShadow:'0 10px 30px rgba(107,184,255,0.35)'}}>
              {status==='init'?msg||'Loading the AI…':status==='error'?'Try again':'▶  Start webcam detection'}
            </button>
            <p className="mt-3 text-[11px] leading-relaxed text-white/45">
              The AI runs inside your browser. Your video never leaves your device and nothing is saved.
            </p>
          </div>
        </div>
      )}

      {/* source toggle */}
      {!demo&&<div className="absolute right-3 top-3 z-20 flex gap-1 rounded-xl p-0.5"
        style={{background:'rgba(11,18,32,0.88)',border:'1px solid rgba(255,255,255,0.08)'}}>
        {[['webcam','Webcam'],['stream','Drone']].map(([id,label])=>(
          <button key={id} type="button" onClick={()=>switchSource(id)}
            className="rounded-lg px-3 py-1 text-[11px] font-bold transition-all"
            style={{background:source===id?'linear-gradient(180deg,#6BB8FF,#3B9EFF)':'transparent',color:source===id?'#04121f':'rgba(255,255,255,0.55)'}}>
            {label}
          </button>
        ))}
      </div>}

      {/* ALL MODELS master button */}
      {status!=='init'&&status!=='error'&&(
        <div className="absolute bottom-5 left-1/2 z-20 -translate-x-1/2">
          <button onClick={toggleAllModels}
            className="rounded-2xl px-8 py-3 text-[13px] font-extrabold tracking-widest transition-all duration-200 active:scale-95"
            style={{
              background:allModelsOn?'linear-gradient(135deg,#32D74B,#0e8f28)':'linear-gradient(135deg,#FF453A,#8b1a14)',
              boxShadow:allModelsOn?'0 0 28px rgba(50,215,75,0.5)':'0 0 28px rgba(255,69,58,0.5)',
              color:'#fff',border:allModelsOn?'1px solid rgba(50,215,75,0.4)':'1px solid rgba(255,69,58,0.4)',
            }}>
            {allModelsOn?'⬡  ALL MODELS  ON':'⬡  ALL MODELS  OFF'}
          </button>
        </div>
      )}

      {/* start/stop row */}
      <div className="absolute left-1/2 z-20 -translate-x-1/2 flex flex-wrap items-center justify-center gap-2" style={{bottom:80+controlsLift}}>
        {tryCard?null:status!=='running'?(
          <button disabled={status==='init'} onClick={()=>start()}
            className="rounded-2xl px-6 py-2.5 text-sm font-bold text-white disabled:opacity-40 transition-all active:scale-95"
            style={{background:'linear-gradient(180deg,var(--accent2,#6BB8FF),var(--accent-hex,#3B9EFF))',boxShadow:'0 0 18px rgba(59,158,255,0.35)'}}>
            {status==='init'?'Loading...':(source==='webcam'?'▶  Start Detection':'▶  Start Drone Feed')}
          </button>
        ):(
          <>
            <button onClick={toggleRecording}
              className="rounded-2xl px-4 py-2 text-[12px] font-bold text-white transition-all active:scale-95"
              style={{background:isRecording?'linear-gradient(135deg,#FF453A,#8b1a14)':'rgba(255,69,58,0.18)',border:'1px solid rgba(255,69,58,0.5)',boxShadow:isRecording?'0 0 16px rgba(255,69,58,0.6)':'none'}}>
              {isRecording?'⏹  Stop Rec':'⏺  Record'}
            </button>
            <button onClick={takeSnapshot}
              className="rounded-2xl px-4 py-2 text-[12px] font-bold text-white transition-all active:scale-95"
              style={{background:'rgba(50,215,75,0.15)',border:'1px solid rgba(50,215,75,0.4)'}}>
              📸  Snap
            </button>
            <button onClick={stop}
              className="rounded-2xl px-4 py-2 text-[12px] font-semibold text-white/70 transition-all active:scale-95"
              style={{background:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.12)'}}>
              ■  Stop
            </button>
            {source==='webcam'&&(
              <button onClick={flip}
                className="rounded-2xl px-4 py-2 text-[12px] font-semibold text-white/70 transition-all active:scale-95"
                style={{background:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.12)'}}>
                ⇄  Flip
              </button>
            )}
          </>
        )}
      </div>

      {/* settings gear — bottom right, hover reveals panel */}
      <div className="group absolute bottom-5 right-4 z-30">
        {/* slide-up settings panel */}
        <div className="pointer-events-none mb-3 flex flex-col items-end gap-2
          opacity-0 translate-y-3 scale-95
          group-hover:pointer-events-auto group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100"
          style={{transition:'opacity 0.25s ease,transform 0.25s cubic-bezier(.34,1.56,.64,1)',transformOrigin:'bottom right'}}>

          {/* Detection model (the test one is marked) */}
          <div className="flex items-center gap-2 rounded-2xl px-4 py-2.5"
            style={{background:'rgba(11,18,32,0.85)',border:'1px solid rgba(255,255,255,0.09)',boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:'220px'}}>
            <span>🤖</span>
            <span className="text-[12px] font-semibold text-white/80">Model</span>
            <div className="ml-auto flex gap-1">
              {DETECT_MODELS.map(m=>(
                <button key={m.key} type="button" disabled={modelBusy} onClick={()=>switchModel(m.key)}
                  className="rounded-lg px-2 py-1 text-[10.5px] font-bold disabled:opacity-50"
                  style={{background:modelKey===m.key?(m.test?'#FF9F0A':'#3B9EFF'):'rgba(255,255,255,0.08)',color:modelKey===m.key?'#fff':'rgba(255,255,255,0.6)'}}>
                  {m.label}{m.test?' · test':''}
                </button>
              ))}
            </div>
          </div>

          {/* Confidence */}
          <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5"
            style={{background:'rgba(11,18,32,0.85)',border:'1px solid rgba(255,255,255,0.09)',boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:'220px'}}>
            <span>🎯</span>
            <span className="flex-1 text-[12px] font-semibold text-white/80">Confidence</span>
            <input type="range" min={0.05} max={0.9} step={0.05} value={conf}
              onChange={e=>setConf(Number(e.target.value))}
              className="w-24 accent-[#3B9EFF]" />
            <span className="w-8 text-right font-mono text-[11px] text-[#3B9EFF]">{Math.round(conf*100)}%</span>
          </div>

          {/* Long Range */}
          <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 cursor-pointer"
            onClick={()=>setLongRange(v=>!v)}
            style={{background:'rgba(11,18,32,0.85)',border:'1px solid rgba(255,255,255,0.09)',boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:'220px'}}>
            <span>🗺️</span>
            <span className="flex-1 text-[12px] font-semibold text-white/80">Long Range</span>
            <SToggle on={longRange} color="#3B9EFF" />
          </div>

          {/* Trash */}
          <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 cursor-pointer"
            onClick={()=>setTrashDetection(v=>!v)}
            style={{background:'rgba(11,18,32,0.85)',border:'1px solid rgba(255,255,255,0.09)',boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:'220px'}}>
            <span>🍶</span>
            <span className="flex-1 text-[12px] font-semibold text-white/80">Plastic Detect</span>
            <SToggle on={trashDetection} color="#3B9EFF" />
          </div>

          {/* Human */}
          <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 cursor-pointer"
            onClick={()=>setHumanDetection(v=>!v)}
            style={{background:'rgba(11,18,32,0.85)',border:'1px solid rgba(255,255,255,0.09)',boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:'220px'}}>
            <span>🧑</span>
            <span className="flex-1 text-[12px] font-semibold text-white/80">Human Detect</span>
            <SToggle on={humanDetection} color="#FF6B6B" />
          </div>

          {/* Self-learning (reinforcement learning from the operator's ✔ / ✖) */}
          <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 cursor-pointer"
            onClick={()=>setLearnOn(v=>!v)}
            title="Learns from your ✔ / ✖ taps which detections are false alarms, and hides them"
            style={{background:'rgba(11,18,32,0.85)',border:'1px solid rgba(255,255,255,0.09)',boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:'220px'}}>
            <span>🧠</span>
            <span className="flex-1 text-[12px] font-semibold text-white/80">Self-learning</span>
            <SToggle on={learnOn} color="#32D74B" />
          </div>
          <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 cursor-pointer"
            onClick={()=>setShowFiltered(v=>!v)}
            title="Also draw (faded) the boxes the self-learning filter hides"
            style={{background:'rgba(11,18,32,0.85)',border:'1px solid rgba(255,255,255,0.09)',boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:'220px'}}>
            <span>👁️</span>
            <span className="flex-1 text-[12px] font-semibold text-white/80">Show filtered</span>
            <SToggle on={showFiltered} color="#9ca3af" />
          </div>
          <div className="rounded-2xl px-4 py-2.5"
            style={{background:'rgba(11,18,32,0.85)',border:'1px solid rgba(255,255,255,0.09)',boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:'220px',maxWidth:'260px'}}>
            <div className="text-[11px] text-white/75">
              {learnStats?.answers
                ? <>Learned from <b className="text-white">{learnStats.answers}</b> answers ({learnStats.plastic} ✔ · {learnStats.notPlastic} ✖) · <b className="text-white">{learnStats.rules}</b> remembered objects
                    {learnStats.recentAccuracy!=null&&<> · predicts <b className="text-white">{Math.round(learnStats.recentAccuracy*100)}%</b> right</>}</>
                : 'No answers yet — tap boxes on the video to teach it.'}
            </div>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={exportAnswers} disabled={!savedAnswers}
                className="flex-1 rounded-lg py-1 text-[11px] font-bold text-white disabled:opacity-40"
                style={{background:'rgba(59,158,255,0.35)',border:'1px solid rgba(59,158,255,0.5)'}}>
                Export ({savedAnswers})
              </button>
              <button type="button" onClick={resetLearning}
                className="flex-1 rounded-lg py-1 text-[11px] font-semibold text-white/80"
                style={{background:'rgba(255,69,58,0.18)',border:'1px solid rgba(255,69,58,0.4)'}}>
                Reset
              </button>
            </div>
          </div>

        </div>

        {/* Gear icon */}
        <button className="flex h-12 w-12 items-center justify-center rounded-full
          transition-all duration-300 group-hover:rotate-90 group-hover:scale-110"
          style={{background:'linear-gradient(135deg,rgba(59,65,255,0.6),rgba(107,184,255,0.3))',border:'1px solid rgba(107,184,255,0.35)',boxShadow:'0 0 20px rgba(59,158,255,0.3),0 4px 12px rgba(0,0,0,0.5)'}}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>

      {status==='error'&&(
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="max-w-sm rounded-2xl px-6 py-4 text-sm text-white/80"
            style={{background:'rgba(255,69,58,0.15)',border:'1px solid rgba(255,69,58,0.3)'}}>
            {msg}
          </p>
        </div>
      )}
    </div>
  )
}

function SToggle({ on, color }) {
  return (
    <div style={{
      position:'relative',width:44,height:24,borderRadius:12,flexShrink:0,
      background:on?color:'rgba(255,255,255,0.15)',
      border:on?`1px solid ${color}`:'1px solid rgba(255,255,255,0.2)',
      boxShadow:on?`0 0 10px ${color}88`:'none',
      transition:'background 0.2s,box-shadow 0.2s',
    }}>
      <span style={{
        position:'absolute',top:2,left:on?22:2,width:18,height:18,borderRadius:'50%',
        background:'#fff',boxShadow:'0 1px 4px rgba(0,0,0,0.35)',
        transition:'left 0.2s cubic-bezier(.34,1.56,.64,1)',
      }} />
    </div>
  )
}
