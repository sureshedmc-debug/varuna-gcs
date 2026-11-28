import { boatApi } from '../../api/boatClient'
import { isOk } from '../commands'
import { askConfirm, gesture } from './botStore'

/**
 * Plain-language boat commands for the VARUNA Assistant (voice or typed), and
 * the quick-command buttons on the Boat Vision tab. Works without any AI
 * provider: a small phrase matcher picks the command.
 *
 * Safety rules (never relaxed here):
 *   - "Stop" acts at once, never asks.
 *   - Anything that makes the boat move (or moves the ramp) asks first.
 *   - The assistant can never arm the boat; the FS-i6 radio overrides everything.
 */

// Live boat state for status answers, kept fresh by the BoatEventWatcher.
let snap = { reachable: undefined, t: null, ops: null, demo: null }
export const setBoatSnapshot = (s) => (snap = { ...snap, ...s })
export const getBoatSnapshot = () => snap

// Demo mode hooks (BoatEventWatcher registers them).
let demoApi = null
export const registerDemo = (api) => (demoApi = api)

export const COMMANDS = {
  collect: { label: 'Go collect', moves: true, ask: 'Send the boat to collect plastic?', detail: 'It drives itself to each piece of waste the drone found. Keep the FS-i6 radio in hand: it overrides everything.', ok: 'Start' },
  stop: { label: 'Stop', moves: false },
  pause: { label: 'Pause', moves: false },
  home: { label: 'Come home', moves: true, ask: 'Bring the boat home?', detail: 'It stops collecting and drives back to where it started.', ok: 'Come home' },
  ramp_down: { label: 'Lower ramp', moves: true, ask: 'Lower the scoop ramp?', detail: 'The ramp tilts down into the water.', ok: 'Lower it' },
  ramp_up: { label: 'Raise ramp', moves: true, ask: 'Raise the scoop ramp?', detail: 'The ramp tilts up and tips its load into the bin.', ok: 'Raise it' },
  status: { label: 'How is it going?' },
  battery: { label: 'Battery?' },
  bin: { label: 'Bin?' },
  catch: { label: 'How many collected?' },
  arm: { label: 'Arm' },
}

const RULES = [
  ['arm', /\b(arm|disarm)\b/i],
  ['stop', /\b(stop|halt|freeze|emergency|abort|ruko|roko|band karo)\b/i],
  ['pause', /\b(pause|wait|hold on|hold position)\b/i],
  ['home', /\b(come (back|home)|go home|return( home)?|head home|rtl|ghar|wapas)\b/i],
  ['ramp_down', /\b(lower|drop|down)\b.*\b(ramp|scoop)\b|\b(ramp|scoop)\b.*\b(down|lower)\b/i],
  ['ramp_up', /\b(raise|lift|up|tip|empty)\b.*\b(ramp|scoop)\b|\b(ramp|scoop)\b.*\b(up|raise|tip)\b/i],
  ['collect', /\b(go (and )?collect|start( collecting| the boat| collection)?|collect( the)? (plastic|waste|trash|it)|clean( up)?|shuru|chalo|kachra uthao)\b/i],
  ['battery', /\b(battery|charge|power left)\b/i],
  ['bin', /\b(bin|full)\b/i],
  ['catch', /\b(how many|collected|caught|catch|count)\b/i],
  ['status', /\b(status|how('?s| is) (it|the boat) going|what('?s| is) (it|the boat) doing|where is the boat|boat status|update)\b/i],
]

/** The boat command a sentence asks for, or null. Only boat-ish sentences match. */
export function matchBoatIntent(text, { boatContext = false } = {}) {
  const t = String(text || '').trim()
  if (!t || t.length > 140) return null
  const boaty = boatContext || /\b(boat|ramp|scoop|bin|collect|captain|nirmal|jalyan|nav|naav)\b/i.test(t)
  for (const [id, re] of RULES) {
    if (!re.test(t)) continue
    if (id === 'stop' && /\b(stop listening|stop talking)\b/i.test(t)) return null
    // "stop", "come home" and "go collect" are clear enough on their own; the rest need boat context.
    if (boaty || id === 'stop' || id === 'home' || id === 'collect') return id
  }
  return null
}

const pct = (v) => (v == null ? null : Math.round(v))

/** A short, spoken-style status line from the live boat state. */
export function boatStatusLine(kind = 'status') {
  const d = snap.demo
  if (d) {
    if (kind === 'battery') return `Battery is at ${d.battery} percent.`
    if (kind === 'bin') return `The bin is ${d.bin} percent full.`
    if (kind === 'catch') return `${d.collected} pieces of plastic collected this run.`
    return `${d.doing} Battery ${d.battery} percent, bin ${d.bin} percent full, ${d.collected} collected so far.`
  }
  if (snap.reachable !== true || !snap.t) return 'I can’t reach the boat right now. Check that it is switched on and connected over Tailscale.'
  const t = snap.t
  const bat = pct(t.battery_percent)
  const bin = t.vision?.catch?.bin
  const live = t.live?.state
  if (kind === 'battery') return bat != null ? `Battery is at ${bat} percent${t.battery_voltage ? `, ${t.battery_voltage.toFixed(1)} volts` : ''}.` : 'The boat is not reporting its battery yet.'
  if (kind === 'bin') return bin ? `The bin holds ${bin.count} of about ${bin.capacity} items, ${Math.min(100, pct(bin.pct))} percent full.` : 'The boat is not reporting the bin yet.'
  if (kind === 'catch') return `${t.live?.counts?.collected ?? 0} pieces collected in this live run${bin ? `, ${bin.count} in the bin` : ''}.`
  const doing = live === 'running' ? 'The boat is out collecting plastic.' : live === 'returning' ? 'The boat is heading home.' : live === 'paused' ? 'Collection is paused.' : t.armed ? `The boat is armed in ${t.flight_mode} mode.` : 'The boat is waiting, motors off.'
  return `${doing}${bat != null ? ` Battery ${bat} percent.` : ''}${t.speed ? ` Speed ${t.speed.toFixed(1)} metres per second.` : ''}`
}

async function call(fn, okText, failText) {
  try {
    const res = await fn()
    if (isOk(res)) {
      gesture('nod')
      return { ok: true, text: okText }
    }
    gesture('shake')
    return { ok: false, text: `${failText} ${res?.message || (res?._httpError ? `The boat answered ${res._httpError}.` : '')}`.trim() }
  } catch (e) {
    gesture('shake')
    return { ok: false, text: `${failText} ${e?.message || ''}`.trim() }
  }
}

/**
 * Run a boat command. Resolves { ok, text } — `text` is what the assistant says.
 * Moving commands open the "Are you sure?" card first.
 */
export async function runBoatCommand(id) {
  const c = COMMANDS[id]
  if (!c) return { ok: false, text: 'I don’t know that boat command.' }
  if (id === 'arm') {
    gesture('shake')
    return { ok: false, text: 'For safety I never arm or disarm the boat. Use the switch on the FS-i6 radio, or the Boat tab.' }
  }
  if (['status', 'battery', 'bin', 'catch'].includes(id)) return { ok: true, text: boatStatusLine(id) }

  const demo = !!snap.demo
  if (!demo && snap.reachable !== true) return { ok: false, text: 'The boat is not connected, so I can’t send that. Check its link on the System tab.' }

  if (c.moves) {
    const yes = await askConfirm({ title: c.ask, detail: c.detail, okLabel: c.ok })
    if (!yes) return { ok: false, text: 'Okay, cancelled. Nothing was sent to the boat.' }
  }
  if (demo) return demoApi?.command(id) || { ok: true, text: 'Done (demo).' }

  const live = snap.t?.live?.state
  switch (id) {
    case 'stop':
      return call(boatApi.hold, 'Stopped. The boat is holding still.', 'The stop command did not go through. Use the radio now!')
    case 'pause':
      return call(boatApi.livePause, 'Paused. Say “go collect” to carry on.', 'Pause failed.')
    case 'collect':
      return call(() => boatApi.liveStart({ whenEmpty: 'wait' }), 'On my way. I’ll tell you when I find plastic.', 'The boat did not start.')
    case 'home':
      return call(live === 'running' || live === 'paused' ? () => boatApi.liveStop(true) : boatApi.rtl, 'Heading home.', 'The boat did not turn home.')
    case 'ramp_down':
      return call(() => boatApi.opsScoop('extreme'), 'Ramp going down.', 'The ramp did not move.')
    case 'ramp_up':
      return call(() => boatApi.opsScoop('zero'), 'Ramp coming up.', 'The ramp did not move.')
    default:
      return { ok: false, text: 'I can’t do that one yet.' }
  }
}
