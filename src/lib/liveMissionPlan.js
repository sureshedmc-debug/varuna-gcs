// Live Mission Plan: the state → river → sections choice made before planning,
// and the recorders that write what then happens into the local CSV store:
//   - every mission upload (from the existing Missions planner) → missions,
//     mission_sections, coordinates, mission_events
//   - the mission starting / ending in flight → status + events
//   - every plastic detection in the trash log → detections
// The planner, uploader and detectors themselves are unchanged; this only
// listens to the stores they already update.

import { useSyncExternalStore } from 'react'
import { saveRecords, eventRow } from './localData'
import { getUser } from './auth'
import { subscribeMission, getActiveMission } from './missionStore'
import { getTrashLog } from './trashLog'

// No vehicle-side limit exists on sections; this keeps a plan to a size one
// crew can fly in a day and the selector usable.
export const MAX_SECTIONS = 20

const PLAN_KEY = 'varuna.livePlan'
const RECORD_KEY = 'varuna.missionRecord' // which CSV mission the uploaded plan belongs to
const DET_KEY = 'varuna.detSync' // detection id → what was last written for it
const NAMED_KEY = 'varuna.livePlanNamed'

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key))
  } catch {
    return null
  }
}
function writeJson(key, v) {
  try {
    if (v == null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode / full: kept in memory for this session */
  }
}

const iso = (t = Date.now()) => new Date(t).toISOString()
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : '')

export function newMissionId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `M-${d}-${t}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

function userCols(u) {
  return { user_id: u?.userId || '', user_name: u?.name || u?.username || '', user_email: u?.email || '' }
}

// ---------------------------------------------------------------- plan store
const planSubs = new Set()
let plan = (() => {
  const p = readJson(PLAN_KEY)
  return p && p.missionId && p.state && p.river && p.sections >= 1 ? p : null
})()

function setPlan(next) {
  plan = next
  writeJson(PLAN_KEY, plan)
  planSubs.forEach((fn) => fn())
}

export function getLivePlan() {
  return plan
}

export function useLivePlan() {
  return useSyncExternalStore(
    (fn) => {
      planSubs.add(fn)
      return () => planSubs.delete(fn)
    },
    () => plan,
  )
}

/** Validate a section count typed by the operator; returns {value} or {error}. */
export function checkSections(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { error: 'Enter how many sections this mission has.' }
  if (!/^\d+$/.test(s)) return { error: 'Sections must be a whole number.' }
  const n = Number(s)
  if (n < 1) return { error: 'A mission needs at least 1 section.' }
  if (n > MAX_SECTIONS) return { error: `At most ${MAX_SECTIONS} sections per mission.` }
  return { value: n }
}

/**
 * Start a planned mission. `state` and `river` are catalog entries
 * ({id, name, ...}); the planner then works one section at a time.
 */
export function startLivePlan({ state, river, sections, sectionPlans = null }) {
  const { value, error } = checkSections(sections)
  if (error) throw new Error(error)
  if (!state?.id || !river?.id) throw new Error('Choose a state and a river first.')
  const user = getUser()
  const now = iso()
  const next = {
    missionId: newMissionId(),
    name: `${river.name} · ${state.name}`,
    state: { id: state.id, name: state.name },
    river: { id: river.id, name: river.name, center: river.center || null, zoom: river.zoom || null },
    sections: value,
    activeSection: 1,
    // Auto-planned waypoints per section ([[lat,lng]]), or null when planned by hand.
    sectionPlans: sectionPlans?.length === value ? sectionPlans.map((p) => ({ waypoints: p.waypoints, lengthM: p.lengthM, minutes: p.minutes, warnings: p.warnings || [] })) : null,
    createdAt: now,
    userId: user?.userId || '',
  }
  setPlan(next)
  const ops = [
    {
      table: 'missions',
      rows: [{
        mission_id: next.missionId, name: next.name, source: 'live-plan', status: 'planned', ...userCols(user),
        state_id: state.id, state_name: state.name, river_id: river.id, river_name: river.name,
        section_count: value, created_at: now, updated_at: now,
      }],
    },
    {
      table: 'mission_sections',
      rows: Array.from({ length: value }, (_, i) => ({ mission_id: next.missionId, section_no: i + 1, status: 'pending', updated_at: now })),
    },
    { table: 'mission_events', op: 'insert', rows: [eventRow('plan_created', { missionId: next.missionId, user, details: { state: state.name, river: river.name, sections: value } })] },
  ]
  if (river.center) {
    ops.push({
      table: 'coordinates',
      rows: [{
        coordinate_id: `${next.missionId}-river-center`, mission_id: next.missionId, section_no: '', kind: 'river_center', seq: 0,
        lat: river.center[0], lng: river.center[1], recorded_at: now,
      }],
    })
  }
  next.sectionPlans?.forEach((p, i) => ops.push({
    table: 'coordinates', op: 'replace', where: { mission_id: next.missionId, section_no: i + 1 },
    rows: p.waypoints.map(([lat, lng], k) => ({
      coordinate_id: `${next.missionId}-S${i + 1}-planned-${k + 1}`, mission_id: next.missionId, section_no: i + 1, kind: 'planned', seq: k + 1,
      lat, lng, recorded_at: now,
    })),
  }))
  saveRecords(ops)
  return next
}

export function setActiveSection(n) {
  if (!plan) return
  const s = Math.min(plan.sections, Math.max(1, Math.round(Number(n)) || 1))
  if (s === plan.activeSection) return
  setPlan({ ...plan, activeSection: s })
  saveRecords([{ table: 'mission_events', op: 'insert', rows: [eventRow('section_selected', { missionId: plan.missionId, sectionNo: s, user: getUser() })] }])
}

/** Stop working on the live plan (its records stay in the CSV files). */
export function endLivePlan() {
  if (!plan) return
  const p = plan
  setPlan(null)
  saveRecords([
    { table: 'missions', rows: [{ mission_id: p.missionId, updated_at: iso() }] },
    { table: 'mission_events', op: 'insert', rows: [eventRow('plan_closed', { missionId: p.missionId, user: getUser() })] },
  ])
}

/** The mission/section new detections belong to ('' when none is underway). */
export function getMissionContext() {
  // What is actually flying wins: the operator may already have picked the
  // next section in the planner while this one is still in the air.
  const rec = readJson(RECORD_KEY)
  const m = getActiveMission()
  if (rec && m && m.status === 'running') return { missionId: rec.missionId, sectionNo: rec.sectionNo }
  if (plan) return { missionId: plan.missionId, sectionNo: plan.activeSection }
  return { missionId: '', sectionNo: '' }
}

/** True when the mission last uploaded is this plan's current section. */
export function isSectionUploaded(p) {
  const rec = readJson(RECORD_KEY)
  return !!(p && rec && rec.missionId === p.missionId && rec.sectionNo === p.activeSection)
}

/** True once the planner has filled in the mission name for this plan section
 *  (kept across reloads so a name the operator edited isn't replaced). */
export function claimPlanName(p) {
  const key = `${p.missionId}#${p.activeSection}`
  if (readJson(NAMED_KEY) === key) return false
  writeJson(NAMED_KEY, key)
  return true
}

// ---------------------------------------------------------------- mission recorder
function recordUpload(m) {
  const user = getUser()
  const now = iso()
  const wps = (m.waypoints || []).filter((w) => Number.isFinite(Number(w?.lat)) && Number.isFinite(Number(w?.lng)))
  const live = plan
  const missionId = live ? live.missionId : newMissionId()
  const sectionNo = live ? live.activeSection : 1
  writeJson(RECORD_KEY, { missionId, sectionNo, live: !!live })

  const first = wps[0]
  const last = wps[wps.length - 1]
  const mission = {
    mission_id: missionId, status: 'uploaded', vehicle_target: m.target || '',
    altitude_m: num(m.altitude), speed_kmh: num(m.speedKmh), updated_at: now,
  }
  if (live) {
    if (sectionNo === 1 && first) Object.assign(mission, { start_lat: first.lat, start_lng: first.lng })
    if (sectionNo === live.sections && last) Object.assign(mission, { end_lat: last.lat, end_lng: last.lng })
  } else {
    Object.assign(mission, {
      name: m.name || '', source: 'mission-planner', ...userCols(user), section_count: 1, waypoint_count: wps.length,
      created_at: now, start_lat: first?.lat ?? '', start_lng: first?.lng ?? '', end_lat: last?.lat ?? '', end_lng: last?.lng ?? '',
    })
  }

  const coord = (kind, seq, w) => ({
    coordinate_id: `${missionId}-S${sectionNo}-${kind}-${seq}`, mission_id: missionId, section_no: sectionNo, kind, seq,
    lat: w.lat, lng: w.lng, alt_m: num(m.altitude), speed_kmh: num(m.speedKmh), action: w.action || '', recorded_at: now,
  })
  const coords = wps.map((w, i) => coord('waypoint', i + 1, w))
  if (first) coords.unshift(coord('start', 0, first))
  if (last) coords.push(coord('end', wps.length + 1, last))

  saveRecords([
    { table: 'missions', rows: [mission] },
    {
      table: 'mission_sections',
      rows: [{
        mission_id: missionId, section_no: sectionNo, status: 'uploaded', waypoint_count: wps.length,
        start_lat: first?.lat ?? '', start_lng: first?.lng ?? '', end_lat: last?.lat ?? '', end_lng: last?.lng ?? '', updated_at: now,
      }],
    },
    // A section uploaded again replaces its earlier waypoints.
    { table: 'coordinates', op: 'replace', where: { mission_id: missionId, section_no: sectionNo }, rows: coords },
    {
      table: 'mission_events', op: 'insert',
      rows: [eventRow('uploaded', { missionId, sectionNo, user, details: { name: m.name, target: m.target, waypoints: wps.length } })],
    },
  ])
}

function recordStatus(status, event) {
  const rec = readJson(RECORD_KEY)
  if (!rec) return
  const now = iso()
  saveRecords([
    { table: 'missions', rows: [{ mission_id: rec.missionId, status, updated_at: now }] },
    { table: 'mission_sections', rows: [{ mission_id: rec.missionId, section_no: rec.sectionNo, status, updated_at: now }] },
    { table: 'mission_events', op: 'insert', rows: [eventRow(event, { missionId: rec.missionId, sectionNo: rec.sectionNo, user: getUser() })] },
  ])
}

function onMissionChange(m, prev) {
  if (!m) return
  const newUpload = !prev || m.name !== prev.name || m.waypoints !== prev.waypoints || m.target !== prev.target ||
    m.altitude !== prev.altitude || m.speedKmh !== prev.speedKmh
  if (newUpload) return recordUpload(m)
  if (m.status === 'running' && prev.status !== 'running') recordStatus('running', 'started')
  else if (m.status !== 'running' && prev.status === 'running') recordStatus('flown', 'ended')
}

// ---------------------------------------------------------------- detection sync
const sensorOf = (src) => (src === 'webcam' ? 'laptop webcam' : src === 'stream' ? 'drone camera' : String(src || ''))

// What was last written per detection. Kept in memory (localStorage is only the
// copy that survives a reload), so a full localStorage can't make every
// sighting look new and get re-filed under whatever mission is current.
let sentDetections = null

function syncDetections(startedAt) {
  const log = getTrashLog()
  const sent = sentDetections || readJson(DET_KEY) || {}
  const next = {}
  const rows = []
  const user = getUser()
  for (const e of log) {
    if (!e || !e.id || !e.firstSeen) continue
    // Ids restart at t-1 when the log is cleared, so the first-seen time makes it unique.
    const key = `${e.firstSeen}-${e.id}`
    const sig = `${e.lastSeen}|${e.frames}|${e.lat}|${e.lng}|${e.class}|${e.hasPhoto ? 1 : 0}|${e.largestM ?? ''}`
    const prev = sent[key]
    if (prev && prev.sig === sig) {
      next[key] = prev
      continue
    }
    // Sightings from before this session can't be tied to a mission after the fact.
    const ctx = prev ? { m: prev.m, s: prev.s } : e.firstSeen >= startedAt - 60000 ? (({ missionId, sectionNo }) => ({ m: missionId, s: sectionNo }))(getMissionContext()) : { m: '', s: '' }
    next[key] = { sig, ...ctx }
    rows.push({
      detection_id: key, mission_id: ctx.m, section_no: ctx.s,
      first_seen: iso(e.firstSeen), last_seen: iso(e.lastSeen || e.firstSeen),
      lat: num(e.lat), lng: num(e.lng), alt_m: num(e.alt), located: e.located ? 'yes' : 'no', accuracy_m: num(e.accuracy),
      position_method: e.posMethod || '', position_source: e.posSource || '',
      class: e.class || 'trash', confidence: num(e.confidence), count: num(e.count), frames: num(e.frames),
      est_width_m: num(e.estWidthM), est_height_m: num(e.estHeightM), size_largest_m: num(e.largestM),
      // The photo itself stays in the app's browser storage (IndexedDB), keyed by the log id.
      image_ref: e.hasPhoto ? `app-photos:${e.id}` : '',
      sensor: sensorOf(e.source), user_id: prev ? undefined : user?.userId || '',
    })
  }
  sentDetections = next
  writeJson(DET_KEY, next)
  for (let i = 0; i < rows.length; i += 1000) saveRecords([{ table: 'detections', rows: rows.slice(i, i + 1000) }])
}

let started = false

/** Begin recording missions and detections. Call once from the app shell. */
export function startDataRecorders() {
  if (started) return () => {}
  started = true
  const startedAt = Date.now()
  let prev = getActiveMission()
  const unsub = subscribeMission((m) => {
    const before = prev
    prev = m
    try {
      onMissionChange(m, before)
    } catch (err) {
      console.warn('[local-data] mission record failed', err)
    }
  })

  let timer = null
  const kick = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      try {
        syncDetections(startedAt)
      } catch (err) {
        console.warn('[local-data] detection sync failed', err)
      }
    }, 3000)
  }
  window.addEventListener('varuna:trashLog', kick)
  kick()
  return () => {
    started = false
    unsub()
    window.removeEventListener('varuna:trashLog', kick)
    clearTimeout(timer)
  }
}
