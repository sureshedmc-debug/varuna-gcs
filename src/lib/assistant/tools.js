// Tools the VARUNA assistant (Groq / OpenAI-style tool calling) can use. Declarations
// tell the model what exists; `runTool` executes them against the real app.
// Anything that could move the aircraft goes through the operator's
// swipe-to-confirm pop-up (ctx.requestConfirm) — the model can never fly the
// drone on its own.

import { pick } from '../format'
import { cmd } from '../commands'
import { commandTarget } from '../connectionState'
import { getActiveMission, missionFor } from '../missionStore'
import { getTrashLog } from '../trashLog'
import { boatApi } from '../../api/boatClient'
import { getMissionRecording } from '../missionRecording'
import { findWaterByName, findWaterNear, circleArea } from '../waterBody'
import { buildPlan, clipToWorkArea, distanceM, WORK_RADIUS_M, LONG_FLIGHT_MIN } from '../missionPatterns'
import { setPlanDraft, navigateTo, getMissionMapView } from '../planDraftStore'
import { buildHotspotPlan, clusterHotspots } from '../hotspots'
import { getImpactStats } from '../impactStats'
import { resolvePeriod, filterByDateRange, summarizeSightings } from '../trashQuery'

const TABS = ['home', 'live', 'mission', 'boat', 'collect', 'vision', 'water', 'detections', 'replay', 'system']
const ASSIST_MAX_TAKEOFF = 30 // m
const S = { OBJECT: 'object', STRING: 'string', NUMBER: 'number' }

const DECLARATIONS = [
  {
    name: 'get_app_status',
    description:
      'Current live state: connection (real drone or simulator), aircraft telemetry (mode, armed, altitude, speed, battery, GPS), home point, the uploaded mission and whether it is running, the current tab. Call this before answering status questions or requesting flight commands.',
    parameters: { type: S.OBJECT, properties: {} },
  },
  {
    name: 'navigate',
    description: 'Switch the app to a tab.',
    parameters: {
      type: S.OBJECT,
      properties: { tab: { type: S.STRING, enum: TABS, description: 'home = Home dashboard, live = Live camera, mission = Missions planner, boat = Boat control (the collection boat), collect = plan the boat plastic collection, vision = Boat Vision (boat camera AI: homing, wildlife pauses, catch counter), water = Water Lab (turbidity map and readings), detections, replay = mission replay, system' } },
      required: ['tab'],
    },
  },
  {
    name: 'get_boat_vision_summary',
    description:
      "The boat camera's work: items the catch counter counted today by type (bottle, bag…), bin fill, camera homing results (collected / missed), wildlife pauses and sightings, and water turbidity (live NTU and saved readings). Call this for questions about what the boat collected, the bin, animals, or water quality.",
    parameters: { type: S.OBJECT, properties: {} },
  },
  {
    name: 'get_detections_summary',
    description: 'Summary of trash detected so far (counts, located vs unlocated, sources, last detection) and the recorded mission video clips.',
    parameters: { type: S.OBJECT, properties: {} },
  },
  {
    name: 'plan_mission',
    description:
      'Create a mission plan over a real water body (outline from OpenStreetMap) and load it as a DRAFT on the Missions tab. Use place_name for a named lake/river, or near for "this lake"/"here". Use radius_m to plan a circular area around the point when there is no mapped lake.',
    parameters: {
      type: S.OBJECT,
      properties: {
        place_name: { type: S.STRING, description: 'Name of the lake/river/reservoir, e.g. "Hussain Sagar". Omit for "this lake".' },
        near: { type: S.STRING, enum: ['drone', 'me', 'map'], description: 'Reference point: drone = aircraft position, me = operator/laptop location, map = centre of the Missions map. Default drone.' },
        pattern: { type: S.STRING, enum: ['shoreline', 'sweep', 'auto'], description: 'shoreline = loop along the edge, sweep = cover the whole surface, auto = decide from intent_text.' },
        intent_text: { type: S.STRING, description: "The user's own words about what they want covered (used when pattern is auto)." },
        altitude_m: { type: S.NUMBER, description: 'Only if the user specified it. Default 10.' },
        speed_kmh: { type: S.NUMBER, description: 'Only if the user specified it. Default 5, max 15.' },
        spacing_m: { type: S.NUMBER, description: 'Sweep lane spacing / shoreline point spacing, only if specified.' },
        radius_m: { type: S.NUMBER, description: 'Plan a circle of this radius around the reference point instead of a mapped lake.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'plan_hotspot_mission',
    description:
      'Create a mission that visits the trash hotspots the app has recorded so far (nearest-neighbor route). Use this for phrases like "plan mission on the worst hotspots", "clean the worst spots", "go where the trash is". Draft opens on the Missions tab; operator still reviews then Save → Upload → Start.',
    parameters: {
      type: S.OBJECT,
      properties: {
        max_hotspots: { type: S.NUMBER, description: 'How many worst hotspots to visit (default 8, cap 60).' },
        altitude_m: { type: S.NUMBER, description: 'Only if the user specified it. Default 10.' },
        speed_kmh: { type: S.NUMBER, description: 'Only if the user specified it. Default 5, max 15.' },
      },
    },
  },
  {
    name: 'get_mission_debrief',
    description:
      'How the most recent mission went: items found this session, worst hotspot coordinates, mission video status, cumulative impact totals. Call when the user asks "how did the mission go", "kaisa raha", "mission ka result", "give me a debrief".',
    parameters: { type: S.OBJECT, properties: {} },
  },
  {
    name: 'query_trash_history',
    description:
      'Real-date summary of trash detections over a time period (today, yesterday, this week, last week, or a custom start/end date). Optionally compare two periods side by side. Use real numbers only — do not invent counts or dates.',
    parameters: {
      type: S.OBJECT,
      properties: {
        period: { type: S.STRING, enum: ['today', 'yesterday', 'this_week', 'last_week', 'custom'], description: 'Which period to summarise.' },
        start_date: { type: S.STRING, description: 'ISO date (YYYY-MM-DD) when period=custom.' },
        end_date: { type: S.STRING, description: 'ISO date (YYYY-MM-DD) when period=custom.' },
        compare_to: { type: S.STRING, enum: ['today', 'yesterday', 'this_week', 'last_week'], description: 'Optional: also summarise a second period for comparison.' },
      },
      required: ['period'],
    },
  },
  {
    name: 'request_flight_command',
    description:
      'Ask the operator to confirm a flight command. Opens a swipe-to-confirm pop-up; the command runs only if they swipe. Returns status sent / cancelled / rejected.',
    parameters: {
      type: S.OBJECT,
      properties: {
        command: { type: S.STRING, enum: ['arm', 'disarm', 'takeoff', 'rth', 'land', 'stop', 'start_mission'] },
        altitude_m: { type: S.NUMBER, description: 'Takeoff altitude in metres (takeoff only). Default 5, max 30. Only if the user said it.' },
      },
      required: ['command'],
    },
  },
]

/** Tool list in the OpenAI/Groq `tools` format. */
export const TOOLS = DECLARATIONS.map((f) => ({ type: 'function', function: f }))

function num(v, d = 1) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null
}

function telemetryOf(t) {
  if (!t) return null
  const lat = Number(pick(t, ['lat', 'latitude']))
  const lng = Number(pick(t, ['lng', 'lon', 'longitude']))
  return {
    mode: pick(t, ['flight_mode', 'mode', 'custom_mode']) ?? null,
    armed: t.armed === true || t.armed === 'true',
    altitude_m: num(pick(t, ['altitude', 'alt', 'relative_alt'])),
    speed_kmh: num(Number(pick(t, ['groundspeed', 'speed', 'ground_speed'])) * 3.6),
    battery_percent: num(pick(t, ['battery_percent', 'battery_remaining', 'battery']), 0),
    battery_voltage: num(pick(t, ['battery_voltage', 'voltage']), 2),
    gps_satellites: num(pick(t, ['satellites', 'satellites_visible', 'gps_sats', 'sats']), 0),
    position: Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 ? [num(lat, 6), num(lng, 6)] : null,
  }
}

// Reference point for "this lake" / "here".
function refPoint(ctx, near) {
  const c = ctx()
  if (near === 'me' && c.laptopPos) return { pt: c.laptopPos, label: 'your location' }
  if (near === 'map') {
    const v = getMissionMapView()
    if (v) return { pt: v, label: 'the Missions map centre' }
  }
  if (c.live?.position) return { pt: c.live.position, label: c.live.source === 'drone' ? 'the drone' : 'your location' }
  if (c.laptopPos) return { pt: c.laptopPos, label: 'your location' }
  return null
}

async function planMission(args, ctx) {
  const c = ctx()
  const ref = refPoint(ctx, args.near || 'drone')
  const home = c.homePoint || ref?.pt
  if (!ref && !args.place_name) return { ok: false, error: 'No position available (no drone GPS and no laptop location). Allow location access or connect the drone.' }

  let water
  if (args.radius_m && !args.place_name) {
    water = circleArea(ref.pt, Math.max(20, Math.min(500, Number(args.radius_m))))
  } else if (args.place_name) {
    const list = await findWaterByName(args.place_name, home || ref?.pt)
    if (!list.length) return { ok: false, error: `Couldn't find a water body called "${args.place_name}" on OpenStreetMap. Try another spelling, or say "this lake" while near it.` }
    water = list[0]
  } else {
    const list = await findWaterNear(ref.pt)
    if (!list.length) return { ok: false, error: `No mapped lake or river within 1.5 km of ${ref.label}. You can ask for a circular area instead, e.g. "plan 100 m around here".` }
    water = list[0]
  }

  // Keep huge water (rivers, big lakes) to a working area around where the operator is.
  let clipCenter = ref?.pt || home
  if (water.distanceM > 0 || !clipCenter) {
    // Operator is outside the water: centre the work area on the nearest shore point.
    const anchor = home || ref?.pt
    let best = null
    for (const [lng, lat] of water.poly.geometry.coordinates[0]) {
      const d = anchor ? distanceM(anchor, [lat, lng]) : 0
      if (!best || d < best.d) best = { d, p: [lat, lng] }
    }
    clipCenter = best.p
  }
  // Fit the plan to one battery: shrink the covered area (largest first) until the
  // estimated flight fits LONG_FLIGHT_MIN; small lakes pass whole on the first try.
  const opts = {
    pattern: args.pattern || 'auto',
    intentText: args.intent_text,
    home,
    altitude: args.altitude_m ?? 10,
    speedKmh: args.speed_kmh ?? 5,
    spacingM: args.spacing_m,
  }
  let plan = null // best successful plan so far
  let firstError = null
  let poly = water.poly
  let clipped = false
  let radius = null
  for (const r of [WORK_RADIUS_M, 500, 300, 200, 120, 80, 50]) {
    const cut = clipToWorkArea(water.poly, clipCenter, r)
    const p = buildPlan(cut.poly, opts)
    if (!p.ok) {
      firstError = firstError || p.reason
      if (plan) break // got too small to plan — keep the last good one
      continue
    }
    plan = p
    poly = cut.poly
    clipped = cut.clipped
    radius = r
    if (p.minutes <= LONG_FLIGHT_MIN) break // fits one battery
  }
  if (!plan) return { ok: false, error: firstError || 'Could not fit a flight path on that water.' }

  const patternName = plan.pattern === 'shoreline' ? 'Shoreline loop' : 'Full sweep'
  const summary = `${patternName} · ${water.name} · ${plan.waypoints.length} WP · ${(plan.lengthM / 1000).toFixed(1)} km · ~${plan.minutes} min`
  const warnings = [...(clipped ? [`This water is large, so the plan covers only the part within ~${radius} m of you (one battery). Ask again after this flight for the next part.`] : []), ...plan.warnings]
  setPlanDraft({
    name: `AI · ${water.name}`,
    waypoints: plan.waypoints,
    altitude: plan.altitude,
    speedKmh: plan.speedKmh,
    pattern: plan.pattern,
    lakeName: water.name,
    polygon: poly,
    summary,
    warnings,
  })
  navigateTo('mission')
  return {
    ok: true,
    lake: water.name,
    pattern: plan.pattern,
    waypoints: plan.waypoints.length,
    path_length_km: num(plan.lengthM / 1000, 2),
    estimated_minutes: plan.minutes,
    altitude_m: plan.altitude,
    speed_kmh: plan.speedKmh,
    lane_spacing_m: plan.pattern === 'sweep' ? plan.spacingM : undefined,
    warnings,
    next_step: 'Draft loaded on the Missions tab. The operator must review it, then Save → Upload → swipe Start.',
  }
}

async function planHotspotMission(args, ctx) {
  const c = ctx()
  const home = c.homePoint || c.live?.position || c.laptopPos
  const log = getTrashLog()
  const plan = buildHotspotPlan(log, {
    home,
    maxHotspots: args.max_hotspots,
    altitude: args.altitude_m ?? 10,
    speedKmh: args.speed_kmh ?? 5,
  })
  if (!plan.ok) return { ok: false, error: plan.reason }
  const summary = `Hotspot route · ${plan.waypoints.length} stops · ${(plan.lengthM / 1000).toFixed(1)} km · ~${plan.minutes} min`
  setPlanDraft({
    name: `AI · Hotspots (${plan.waypoints.length})`,
    waypoints: plan.waypoints,
    altitude: plan.altitude,
    speedKmh: plan.speedKmh,
    pattern: 'hotspot',
    lakeName: `${plan.waypoints.length} hotspots`,
    polygon: null,
    summary,
    warnings: plan.warnings,
  })
  navigateTo('mission')
  return {
    ok: true,
    stops: plan.waypoints.length,
    path_length_km: num(plan.lengthM / 1000, 2),
    estimated_minutes: plan.minutes,
    altitude_m: plan.altitude,
    speed_kmh: plan.speedKmh,
    top_items: plan.hotspots.slice(0, 3).map((h) => ({ items: h.itemsTotal, lat: num(h.lat, 6), lng: num(h.lng, 6) })),
    warnings: plan.warnings,
    next_step: 'Draft loaded on the Missions tab. Review, then Save → Upload → swipe Start.',
  }
}

function missionDebrief() {
  const log = getTrashLog()
  const rec = getMissionRecording()
  const hotspots = clusterHotspots(log)
  const top = hotspots[0]
  const items = log.reduce((a, e) => a + (Number(e.count) || 0), 0)
  return {
    items_found: items,
    trash_locations: log.length,
    worst_hotspot: top ? { lat: num(top.lat, 6), lng: num(top.lng, 6), items: top.itemsTotal } : null,
    mission_video_clips: rec.clips.length,
    video_recording_now: rec.recording,
    impact: getImpactStats(),
    last_detection: log[0] ? new Date(log[0].lastSeen || log[0].firstSeen || 0).toLocaleTimeString() : null,
  }
}

function trashHistoryQuery(args) {
  const a = args || {}
  const p = resolvePeriod(a.period, a.start_date, a.end_date)
  if (!p) return { ok: false, error: 'Unknown period. Use today, yesterday, this_week, last_week, or custom with start_date/end_date.' }
  const log = getTrashLog()
  const primary = { period: p.label, ...summarizeSightings(filterByDateRange(log, p.start, p.end)) }
  const out = { ok: true, primary }
  if (a.compare_to) {
    const p2 = resolvePeriod(a.compare_to)
    if (p2) out.compare = { period: p2.label, ...summarizeSightings(filterByDateRange(log, p2.start, p2.end)) }
  }
  return out
}

const CMD_KEY = { arm: 'arm', disarm: 'disarm', takeoff: 'takeoff', rth: 'rth', land: 'land', stop: 'stop', start_mission: 'mission' }

async function flightCommand(args, ctx) {
  const c = ctx()
  const key = CMD_KEY[args.command]
  if (!key) return { status: 'rejected', reason: `Unknown command "${args.command}".` }
  const target = commandTarget()
  if (args.command === 'start_mission' && !missionFor(getActiveMission(), target)) {
    return { status: 'rejected', reason: 'No mission has been uploaded yet. On the Missions tab: Save, then Upload, then Start.' }
  }
  if (args.command === 'start_mission' && getActiveMission()?.status === 'running') {
    return { status: 'rejected', reason: 'The mission is already running.' }
  }
  // Assistant take-offs are capped lower than manual ones: the altitude may come
  // from a misheard voice command, so it's also shown on the confirm pop-up.
  const alt = Math.max(2, Math.min(ASSIST_MAX_TAKEOFF, Number(args.altitude_m) || 5))
  const detail = `${target === 'sim' ? 'SIMULATOR — virtual drone' : 'REAL DRONE'}${key === 'takeoff' ? ` · climb to ${alt} m` : ''}`
  const answer = await c.requestConfirm(key, detail)
  if (answer !== 'confirmed') return { status: 'cancelled', reason: answer === 'timeout' ? 'The operator did not respond.' : 'The operator cancelled.' }
  // The operator confirmed a command for a specific aircraft; if the link switched
  // (simulator ↔ real drone) while the pop-up was open, don't send it anywhere.
  if (commandTarget() !== target) return { status: 'rejected', reason: 'The drone connection changed while waiting for confirmation — ask again.' }
  const run = {
    arm: () => cmd.arm(true),
    disarm: () => cmd.arm(false),
    takeoff: () => cmd.takeoff(alt),
    rth: () => cmd.rtl(),
    land: () => cmd.land(),
    stop: () => cmd.emergencyStop(),
    mission: () => cmd.missionStart(),
  }[key]
  try {
    const res = await run()
    const ok = !!res && res.success !== false && !res._httpError
    return { status: 'sent', success: ok, message: res?.message || (ok ? 'Command accepted' : 'Command rejected'), simulated: target === 'sim' }
  } catch (e) {
    return { status: 'sent', success: false, message: String(e?.message || e) }
  }
}

async function boatVisionSummary() {
  const ok = (r) => (r && !r._httpError ? r : null)
  const [catchS, wild, water, readings, vision] = await Promise.all([
    boatApi.catchSummary(0).then(ok).catch(() => null),
    boatApi.wildlife(5).then(ok).catch(() => null),
    boatApi.waterStatus().then(ok).catch(() => null),
    boatApi.waterReadings(10).then(ok).catch(() => null),
    boatApi.visionStatus().then(ok).catch(() => null),
  ])
  if (!catchS && !water && !vision) return { ok: false, error: 'The boat is not reachable (System → Boat connection).' }
  return {
    catch_today: catchS?.today || null,
    bin: catchS?.bin || null,
    catch_all_time: catchS?.all_time?.total ?? null,
    homing: vision?.homing ? { collected: vision.homing.collected, missed: vision.homing.missed, attempts: vision.homing.attempts, state: vision.homing.state } : null,
    camera_ai_reaching_boat: vision?.link?.alive ?? null,
    wildlife: wild ? { state: wild.state, pauses_today: wild.pauses_today, waited_s_today: wild.paused_s_today, recent: (wild.sightings || []).map((x) => ({ label: x.label, at: new Date(x.t * 1000).toLocaleTimeString() })) } : null,
    water_now: water ? { ntu: water.ntu, quality: water.quality, sensor_connected: water.connected, calibrated: water.calibrated } : null,
    water_readings: Array.isArray(readings) ? readings.map((r) => ({ ntu: r.ntu, quality: r.quality, lat: r.lat, lng: r.lng, at: new Date(r.t * 1000).toLocaleString() })) : null,
  }
}

function detectionsSummary() {
  const log = getTrashLog()
  const rec = getMissionRecording()
  const located = log.filter((e) => e.located)
  return {
    trash_locations: log.length,
    located: located.length,
    unlocated: log.length - located.length,
    items_seen: log.reduce((a, e) => a + (e.count || 0), 0),
    from_webcam: log.filter((e) => e.source === 'webcam').length,
    from_drone_feed: log.filter((e) => e.source === 'stream').length,
    last_detection: log[0] ? new Date(log[0].lastSeen).toLocaleTimeString() : null,
    mission_video_clips: rec.clips.length,
    recording_now: rec.recording,
  }
}

function appStatus(ctx) {
  const c = ctx()
  const m = getActiveMission()
  const target = commandTarget()
  return {
    connection: c.simulated ? 'SIMULATOR (no real drone reachable — commands fly the virtual drone)' : c.backendReachable ? 'real drone connected' : 'connecting / drone link down',
    telemetry: telemetryOf(c.telemetry),
    position_source: c.live?.source || 'none',
    home_point: c.homePoint ? c.homePoint.map((v) => num(v, 6)) : null,
    uploaded_mission: missionFor(m, target) ? { name: m.name, waypoints: m.waypoints.length, altitude_m: m.altitude, speed_kmh: m.speedKmh, status: m.status } : null,
    current_tab: c.tab,
  }
}

/** Execute one tool call. Always resolves with a JSON-able object (errors included). */
export async function runTool(name, args, ctx) {
  // The operator dismissed or interrupted this turn: do nothing (no tab switches, no pop-ups).
  if (ctx()?.active && !ctx().active()) return { ok: false, error: 'Cancelled — the operator dismissed the assistant.' }
  try {
    switch (name) {
      case 'get_app_status':
        return appStatus(ctx)
      case 'navigate':
        if (!TABS.includes(args?.tab)) return { ok: false, error: 'Unknown tab' }
        return { ok: navigateTo(args.tab), tab: args.tab }
      case 'get_detections_summary':
        return detectionsSummary()
      case 'get_boat_vision_summary':
        return await boatVisionSummary()
      case 'plan_mission':
        return await planMission(args || {}, ctx)
      case 'plan_hotspot_mission':
        return await planHotspotMission(args || {}, ctx)
      case 'get_mission_debrief':
        return missionDebrief()
      case 'query_trash_history':
        return trashHistoryQuery(args)
      case 'request_flight_command':
        return await flightCommand(args || {}, ctx)
      default:
        return { ok: false, error: `Unknown tool ${name}` }
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}
