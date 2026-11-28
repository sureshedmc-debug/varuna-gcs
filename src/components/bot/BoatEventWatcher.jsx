import { useEffect, useRef } from 'react'
import { boatApi } from '../../api/boatClient'
import { useBoat } from '../BoatContext'
import { usePolling } from '../../hooks/usePolling'
import { postBoatMessage, useBotState, getBot, setDemo } from '../../lib/assistant/botStore'
import { registerDemo, setBoatSnapshot } from '../../lib/assistant/boatCommands'

/**
 * Turns what the boat and its AI captain are doing into short messages for the
 * VARUNA Assistant to say: telemetry changes, camera AI homing and catches,
 * live-collect progress, the boat's own event logs and, once it runs on the
 * boat, the AI captain's notes (telemetry `captain`). Mounted once for the app.
 *
 * Each message has a level (info / ok / warn / bad), a dedupe key and a
 * cooldown (botStore.postBoatMessage), so nothing floods the operator.
 */

const MODE_SAY = {
  AUTO: ['The boat is driving itself now.', 'info'],
  RTL: ['Heading home.', 'info'],
  SMART_RTL: ['Heading home.', 'info'],
  HOLD: ['Holding position.', 'info'],
  LOITER: ['Holding position.', 'info'],
  MANUAL: ['Manual mode: you are driving.', 'warn'],
  GUIDED: ['The boat is following the app.', 'info'],
}
const LIVE_SAY = {
  running: ['Collecting. Heading to the next piece of plastic.', 'ok'],
  paused: ['Collection paused.', 'info'],
  returning: ['Coming home.', 'info'],
  waiting: ['All known plastic collected. Waiting for the drone to find more.', 'info'],
}
const HOMING_SAY = {
  search: (h) => [`Looking for the ${h.item || 'plastic'} with the camera.`, 'info'],
  track: (h) => [`${cap(h.item) || 'Plastic'} ${h.distance_m != null ? `${Math.round(h.distance_m)} metres ahead` : 'ahead'}. Going for it.`, 'info'],
  capture: () => ['Driving through it now, ramp down.', 'info'],
  confirm: () => ['Checking the ramp…', 'info'],
}
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '')

function crossedBelow(prev, now, th) {
  return prev != null && now != null && prev > th && now <= th
}
function crossedAbove(prev, now, th) {
  return prev != null && now != null && prev < th && now >= th
}

// ── demo: a believable run, so the assistant can be shown without the boat ────
const DEMO_SCRIPT = [
  { text: 'Demo mode. I’ll tell you everything the boat and its AI captain do.', level: 'info', doing: 'Getting ready.' },
  { text: 'AI captain online. Scanning the water for plastic.', level: 'info', doing: 'The boat is scanning the water.' },
  { text: 'Plastic bottle spotted, 12 metres ahead. Going for it.', level: 'info', doing: 'The boat is heading to a plastic bottle.', dist: 12 },
  { text: 'Lowering the ramp.', level: 'info', doing: 'The boat is lowering its ramp.', dist: 3 },
  { text: 'Got it! One bottle on the ramp.', level: 'ok', mood: 'happy', doing: 'The boat just caught a bottle.', got: 1 },
  { text: 'Tipping it into the bin.', level: 'info', doing: 'The boat is tipping its catch into the bin.', bin: 8 },
  { text: 'Weeds ahead. Raising the ramp so we don’t get snagged.', level: 'warn', doing: 'The boat is steering around weeds.' },
  { text: 'Wind from the left. Holding the boat straight.', level: 'info', doing: 'The boat is holding its line against the wind.' },
  { text: 'Two bottles close together, 7 metres ahead. Collecting both.', level: 'info', doing: 'The boat is heading to two bottles.', dist: 7 },
  { text: 'Got them both! The bin is 40 percent full.', level: 'ok', mood: 'happy', doing: 'The boat just caught two bottles.', got: 2, bin: 40 },
  { text: 'Battery at 52 percent. Plenty left.', level: 'info', doing: 'The boat is scanning for more plastic.', battery: 52 },
  { text: 'Bin 80 percent full. I’ll finish this one, then head home.', level: 'warn', doing: 'The boat is finishing its last catch.', bin: 80 },
  { text: 'Heading home to empty the bin.', level: 'info', doing: 'The boat is heading home.', home: true },
  { text: 'Home safe. Nine pieces collected this run.', level: 'ok', mood: 'happy', doing: 'The boat is home.', got: 6, done: true },
]

function useDemo(on) {
  const ref = useRef({ i: 0, timer: 0, stopped: false, d: { battery: 78, bin: 0, collected: 0, doing: 'Getting ready.', dist: null, state: 'idle' } })
  useEffect(() => {
    const st = ref.current
    const publish = () => setBoatSnapshot({ demo: { ...st.d } })
    const step = () => {
      if (st.stopped) return
      const s = DEMO_SCRIPT[st.i % DEMO_SCRIPT.length]
      if (st.i % DEMO_SCRIPT.length === 0) Object.assign(st.d, { battery: 78, bin: 0, collected: 0 })
      st.d.doing = s.doing
      st.d.dist = s.dist ?? null
      st.d.state = s.done ? 'home' : s.home ? 'returning' : 'running'
      if (s.got) st.d.collected += s.got
      if (s.bin != null) st.d.bin = s.bin
      st.d.battery = s.battery ?? Math.max(20, st.d.battery - 2)
      publish()
      postBoatMessage({ text: s.text, level: s.level, kind: 'captain', key: `demo-${st.i}`, cooldownMs: 0, mood: s.mood })
      st.i += 1
      st.timer = setTimeout(step, s.done ? 12000 : 5200 + Math.random() * 2600)
    }
    if (!on) {
      clearTimeout(st.timer)
      setBoatSnapshot({ demo: null })
      return undefined
    }
    st.stopped = false
    st.i = 0
    st.timer = setTimeout(step, 900)
    registerDemo({
      command(id) {
        clearTimeout(st.timer)
        if (id === 'stop' || id === 'pause') {
          st.stopped = true
          st.d.state = 'stopped'
          st.d.doing = 'The boat is stopped.'
          publish()
          return { ok: true, text: id === 'stop' ? 'Stopped. The boat is holding still. (Demo)' : 'Paused. Say “go collect” to carry on. (Demo)' }
        }
        st.stopped = false
        if (id === 'collect') { st.i = 1; st.timer = setTimeout(step, 1500); return { ok: true, text: 'On my way. I’ll tell you when I find plastic. (Demo)' } }
        if (id === 'home') { st.i = DEMO_SCRIPT.length - 2; st.timer = setTimeout(step, 1500); return { ok: true, text: 'Heading home. (Demo)' } }
        st.timer = setTimeout(step, 4000)
        return { ok: true, text: id === 'ramp_down' ? 'Ramp going down. (Demo)' : 'Ramp coming up. (Demo)' }
      },
    })
    return () => { st.stopped = true; clearTimeout(st.timer) }
  }, [on])
}

export default function BoatEventWatcher() {
  const boat = useBoat()
  const demo = useBotState((s) => s.demo)
  const reachable = boat?.reachable
  const t = boat?.telemetry?.data || null
  const ops = usePolling(() => (reachable === true ? boatApi.opsStatus() : Promise.resolve(null)), 3000, [reachable])
  const o = ops.data && !ops.data._httpError && ops.data.success !== false ? ops.data : null

  useDemo(demo)
  // A real boat answering ends the demo, so made-up messages never mix with real ones.
  useEffect(() => {
    if (reachable === true && t && !t.simulated && getBot().demo) {
      setDemo(false)
      postBoatMessage({ text: 'The real boat is connected, so I switched demo mode off.', level: 'info', key: 'demo-off' })
    }
  }, [reachable, t])

  useEffect(() => { setBoatSnapshot({ reachable, t, ops: o }) }, [reachable, t, o])

  // ── link ──
  const linkRef = useRef(undefined)
  useEffect(() => {
    const prev = linkRef.current
    linkRef.current = reachable
    if (reachable === true && prev === false) postBoatMessage({ text: 'The link to the boat is back.', level: 'ok', key: 'link', cooldownMs: 8000 })
    if (reachable === true && prev === undefined) postBoatMessage({ text: `Connected to the boat${t?.simulated ? ' simulator' : ''}.`, level: 'ok', key: 'link-first', cooldownMs: 600000, speak: false })
    if (reachable === false && prev === true) postBoatMessage({ text: 'I’ve lost the link to the boat. If it is moving, take over with the radio.', level: 'bad', key: 'link', cooldownMs: 8000, mood: 'alert' })
  }, [reachable]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── telemetry changes ──
  const prevRef = useRef(null)
  useEffect(() => {
    if (!t) return
    const p = prevRef.current
    prevRef.current = t
    if (!p) return // first sample: just the baseline
    const say = (text, level = 'info', key, extra) => postBoatMessage({ text, level, key: key || text, ...extra })

    // AI captain (on the boat, when it reports one)
    const cp = t.captain, cpp = p.captain
    if (cp?.say && cp.say !== cpp?.say) say(cp.say, cp.level || 'info', `captain-${cp.say}`, { kind: 'captain', cooldownMs: 6000 })

    if (p.fc_connected && t.fc_connected === false) say('The boat’s controller stopped answering.', 'bad', 'fc', { mood: 'alert' })
    if (p.fc_connected === false && t.fc_connected) say('The boat’s controller is back.', 'ok', 'fc')
    if (!p.armed && t.armed) say('Motors armed. Stand clear of the propellers.', 'warn', 'armed')
    if (p.armed && !t.armed) say('Motors disarmed.', 'info', 'armed')
    if (t.flight_mode && p.flight_mode && t.flight_mode !== p.flight_mode && MODE_SAY[t.flight_mode]) {
      const [text, level] = MODE_SAY[t.flight_mode]
      say(text, level, `mode-${t.flight_mode}`, { cooldownMs: 10000 })
    }
    const b0 = p.battery_percent, b1 = t.battery_percent
    if (crossedBelow(b0, b1, 50)) say('Battery at half.', 'info', 'bat50', { cooldownMs: 600000 })
    if (crossedBelow(b0, b1, 25)) say(`Battery low, ${Math.round(b1)} percent. Bring the boat home soon.`, 'warn', 'bat25', { cooldownMs: 600000 })
    if (crossedBelow(b0, b1, 12)) say(`Battery critical, ${Math.round(b1)} percent! Bring the boat home now.`, 'bad', 'bat12', { cooldownMs: 300000, mood: 'alert' })
    if (p.drive?.source && t.drive?.source && p.drive.source !== t.drive.source) {
      if (t.drive.source === 'transmitter') say('The radio has control. The FS-i6 overrides everything.', 'warn', 'drive')
      else say('The app has control of the boat.', 'info', 'drive')
    }
    if (p.camera?.connected && t.camera?.connected === false) say('The boat camera went offline.', 'warn', 'cam')
    if (p.camera?.connected === false && t.camera?.connected) say('The boat camera is back on.', 'ok', 'cam')

    // camera AI: homing and catches
    const h0 = p.vision?.homing || {}, h1 = t.vision?.homing || {}
    if (h1.state && h1.state !== h0.state && HOMING_SAY[h1.state]) {
      const [text, level] = HOMING_SAY[h1.state](h1)
      say(text, level, `homing-${h1.state}-${h1.item_id || ''}`, { kind: 'camera', cooldownMs: 8000 })
    }
    if ((h1.collected ?? 0) > (h0.collected ?? 0)) say(`Got it! ${cap(h1.item) || 'Plastic'} on the ramp.`, 'ok', `got-${h1.collected}`, { kind: 'camera', mood: 'happy', cooldownMs: 0 })
    const bin0 = p.vision?.catch?.bin?.pct, bin1 = t.vision?.catch?.bin?.pct
    if (crossedAbove(bin0, bin1, 80)) say('The bin is 80 percent full.', 'warn', 'bin80', { cooldownMs: 600000 })
    if (crossedAbove(bin0, bin1, 100)) say('The bin is full. Bring the boat home to empty it.', 'bad', 'bin100', { cooldownMs: 600000 })

    // live collect
    const l0 = p.live || {}, l1 = t.live || {}
    if (l1.state !== l0.state) {
      if (LIVE_SAY[l1.state]) {
        const [text, level] = LIVE_SAY[l1.state]
        say(text, level, `live-${l1.state}`, { cooldownMs: 8000 })
      } else if ((l0.state === 'running' || l0.state === 'returning') && (l1.state === 'off' || l1.state === 'done')) {
        say(`Collection finished. ${l1.counts?.collected ?? 0} pieces collected.`, 'ok', 'live-done', { mood: 'happy' })
      }
    }
    if ((l1.counts?.collected ?? 0) > (l0.counts?.collected ?? 0)) {
      say(`Collected another one. ${l1.counts.collected} so far.`, 'ok', `live-got-${l1.counts.collected}`, { mood: 'happy', cooldownMs: 0 })
    }
  }, [t])

  // ── the boat's own event logs (ops, camera, live, drive) ──
  const seenRef = useRef(null)
  useEffect(() => {
    const lists = [
      ['ops', o?.events],
      ['camera', t?.vision?.events],
      ['live', t?.live?.events],
      ['drive', t?.drive?.events],
    ]
    if (seenRef.current == null) seenRef.current = {}
    for (const [src, evs] of lists) {
      if (!Array.isArray(evs)) continue
      const first = seenRef.current[src] == null // the first list from each source is only the baseline
      const last = seenRef.current[src] ?? 0
      let max = last
      for (const ev of evs) {
        const et = Number(ev?.t) || 0
        if (et > max) max = et
        if (first || et <= last || !ev?.text) continue
        const level = ev.level === 'warn' ? 'warn' : ev.level === 'error' || ev.level === 'bad' ? 'bad' : ev.level === 'ok' ? 'ok' : 'info'
        // log lines are shown, and only warnings and errors are spoken
        postBoatMessage({ text: ev.text, level, kind: src, key: `${src}-${ev.text}`, cooldownMs: 15000, speak: level === 'warn' || level === 'bad' })
      }
      seenRef.current[src] = max
    }
    for (const a of o?.alerts || []) {
      const text = typeof a === 'string' ? a : a?.text
      if (text) postBoatMessage({ text, level: a?.level === 'info' ? 'info' : 'warn', kind: 'ops', key: `alert-${text}`, cooldownMs: 60000 })
    }
  }, [o, t])

  return null
}
