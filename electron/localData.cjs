// Local data store for the GCS: CSV records, the state/river catalog, and the
// operator's sign-in (username + password, or Google).
//
// It runs inside whichever Node server delivers the app to the window, so the
// page reaches it same-origin under /local/*:
//   - the desktop app's loopback server (electron/server.cjs), data kept in
//     Electron's per-user folder: %APPDATA%\VARUNA GCS\data
//   - Vite's dev server (vite.config.js), data kept in <project>/data
// When the app is served some other way (e.g. from the drone Pi) /local/* is
// absent and the page says so instead of pretending records were saved.
//
// What is stored where:
//   *.csv              non-sensitive records only (profiles, missions, coordinates,
//                      detections, events, face check results) and the editable
//                      state/river catalog.
//   credentials.json   password hashes (scrypt, per-user salt). Never a password,
//                      never a Google token. Not a CSV on purpose.
//   faces.json         each operator's face templates (numbers, no photo), which
//                      sign-in compares against. A login secret, so not a CSV.
//   fingerprints.json  Windows Hello public keys (one per operator). The fingerprint
//                      itself never leaves the sensor; only Windows sees it.
//   data_lock.json     the Data tab PIN, hashed like a password.
//   auth_config.json   the Google OAuth *client ID* (public by design, not a secret).
//
// Excel keeps a CSV it has open locked on Windows; a write then fails with
// EBUSY/EPERM and is reported as `locked`, and the page retries it later.

'use strict'

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const crypto = require('node:crypto')

// ---------------------------------------------------------------- schemas
// key: the columns that identify a row (upserts replace the row with that key).
// page: the page may write this file through POST /local/records. users.csv is
// written only by the sign-in code here; states/rivers are edited by hand.
const SCHEMAS = {
  users: {
    key: ['user_id'],
    cols: ['user_id', 'username', 'name', 'email', 'provider', 'profession', 'organisation', 'created_at', 'last_login_at', 'login_count',
      'face_enrolled', 'face_enrolled_at', 'last_face_check_at', 'fingerprint_enrolled', 'fingerprint_enrolled_at', 'last_fingerprint_at'],
  },
  // One row per fingerprint added or used. No key or fingerprint data here.
  fingerprint_checks: {
    key: ['check_id'],
    cols: ['check_id', 'at', 'user_id', 'username', 'name', 'action', 'result'],
  },
  // One row per face check at sign-in. The face template itself is never
  // written here: it is kept with the password hashes (faces.json).
  face_checks: {
    key: ['check_id'],
    cols: ['check_id', 'at', 'user_id', 'username', 'name', 'sign_in_method', 'result', 'distance', 'threshold', 'samples'],
  },
  missions: {
    page: true,
    key: ['mission_id'],
    cols: ['mission_id', 'name', 'source', 'status', 'user_id', 'user_name', 'user_email', 'state_id', 'state_name', 'river_id',
      'river_name', 'section_count', 'vehicle_target', 'altitude_m', 'speed_kmh', 'waypoint_count', 'start_lat', 'start_lng',
      'end_lat', 'end_lng', 'created_at', 'updated_at'],
  },
  mission_sections: {
    page: true,
    key: ['mission_id', 'section_no'],
    cols: ['mission_id', 'section_no', 'status', 'waypoint_count', 'start_lat', 'start_lng', 'end_lat', 'end_lng', 'updated_at'],
  },
  coordinates: {
    page: true,
    key: ['coordinate_id'],
    cols: ['coordinate_id', 'mission_id', 'section_no', 'kind', 'seq', 'lat', 'lng', 'alt_m', 'speed_kmh', 'action', 'recorded_at'],
  },
  detections: {
    page: true,
    key: ['detection_id'],
    cols: ['detection_id', 'mission_id', 'section_no', 'first_seen', 'last_seen', 'lat', 'lng', 'alt_m', 'located', 'accuracy_m',
      'position_method', 'position_source', 'class', 'confidence', 'count', 'frames', 'est_width_m', 'est_height_m',
      'size_largest_m', 'image_ref', 'sensor', 'user_id'],
  },
  // The drone-to-boat workflow: one row per plastic find sent to the boat, with
  // the drone's crop of it saved as drone_images/<image_file> next to the CSVs,
  // and what the boat made of it (boat_state, match_score...).
  drone_targets: {
    page: true,
    key: ['target_id'],
    cols: ['target_id', 'detection_id', 'first_seen', 'last_seen', 'lat', 'lng', 'class', 'confidence', 'image_file',
      'image_w', 'image_h', 'sent_to_boat_at', 'boat_state', 'retry_count', 'match_score', 'verified', 'updated_at'],
  },
  mission_events: {
    page: true,
    key: ['event_id'],
    cols: ['event_id', 'at', 'mission_id', 'section_no', 'event', 'details', 'user_id', 'user_name'],
  },
  states: {
    key: ['state_id'],
    cols: ['state_id', 'state_name', 'enabled', 'sort_order'],
  },
  rivers: {
    key: ['state_id', 'river_id'],
    cols: ['river_id', 'state_id', 'river_name', 'center_lat', 'center_lng', 'zoom', 'enabled', 'notes'],
  },
}

const MAX_BODY = 4 * 1024 * 1024
const MAX_DRONE_IMAGE = 300 * 1024
const IMAGE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.jpg$/
const MAX_OPS = 50
const MAX_ROWS_PER_OP = 5000
const MAX_CELL = 2000
const GOOGLE_TTL_MS = 5 * 60 * 1000
// Face check (src/lib/face.js sends face-api templates: 128 numbers each).
const FACE_DIM = 128
const FACE_MAX_SAMPLES = 5
const FACE_MATCH = 0.5 // mean distance below this = same person (face-api's own guide uses 0.6)
const FACE_TTL_MS = 5 * 60 * 1000 // time to finish the face step after the password / Google
const FACE_TRIES = 3
// The Data tab's PIN until it is changed in data_lock.json (stored hashed).
const DEFAULT_DATA_PIN = '1234'
const FP_TTL_MS = 2 * 60 * 1000 // one Windows Hello window
const FP_SETUP_TTL_MS = 10 * 60 * 1000 // time to add a fingerprint after signing in
// WebAuthn names the site the key belongs to and refuses an IP address, so the
// fingerprint page always runs at http://localhost:<port>.
const RP_ID = 'localhost'
const CLIENT_ID_RE = /^[A-Za-z0-9-]{4,100}\.apps\.googleusercontent\.com$/
// The app's own Google sign-in client, used unless one is saved in
// auth_config.json or set in VARUNA_GOOGLE_CLIENT_ID. A client ID is a public
// identifier, not a secret; no client secret exists or is stored.
const DEFAULT_GOOGLE_CLIENT_ID = '181949410341-bjenar1o4loong9glrl3fk96ik74j3pu.apps.googleusercontent.com'
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/
const EMAIL_RE = /^[^\s@,]{1,64}@[^\s@,]{1,190}\.[^\s@,]{2,20}$/
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

// ---------------------------------------------------------------- CSV text
// A cell starting with = + - @ would run as a formula when the file is opened in
// Excel. Such text gets a leading apostrophe; plain numbers (-77.21) are left alone.
const FORMULA_RE = /^[=+\-@\t\r]/
const NUMBER_RE = /^-?\d+(\.\d+)?(e-?\d+)?$/i

function toCell(v) {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'string' ? v : String(v)
  if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL)
  if (FORMULA_RE.test(s) && !NUMBER_RE.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function fromCell(s) {
  return s.length > 1 && s[0] === "'" && FORMULA_RE.test(s.slice(1)) && !NUMBER_RE.test(s.slice(1)) ? s.slice(1) : s
}

/** RFC 4180 parser. Throws on an unterminated quote (a truncated or mangled file). */
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let i = 0
  let quoted = false
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      cell += c
      i++
      continue
    }
    if (c === '"' && cell === '') {
      quoted = true
      i++
    } else if (c === ',') {
      row.push(cell)
      cell = ''
      i++
    } else if (c === '\r' || c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else {
      cell += c
      i++
    }
  }
  if (quoted) throw new Error('unterminated quoted field')
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function serialize(header, rows) {
  const lines = [header.map(toCell).join(',')]
  for (const r of rows) lines.push(header.map((h) => toCell(r[h])).join(','))
  // BOM: Excel otherwise reads UTF-8 (Hindi names, ° signs) as ANSI.
  return '﻿' + lines.join('\r\n') + '\r\n'
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function lockedError(err) {
  return err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
}

class StoreError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------- the store
function createLocalData({ dataDir, seedFile, log = console } = {}) {
  dataDir = path.resolve(dataDir)
  const warnings = [] // recoveries since start (shown on the Basic data page)
  const queues = new Map()
  const pendingGoogle = new Map() // nonce → { at, status, profile?, message?, face? }
  const pendingFace = new Map() // ticket → { at, fields, extra, method, enroll, tries }
  const failures = new Map() // username → { n, until }
  const pendingFp = new Map() // window id → { at, status, kind, token, challenge, origin } | finished result
  const fpSetup = new Map() // token → { at, row }: this operator just signed in, may add a fingerprint

  function warn(text) {
    warnings.push({ at: new Date().toISOString(), text })
    if (warnings.length > 50) warnings.shift()
    log.warn(`[local-data] ${text}`)
  }

  const fileOf = (name) => path.join(dataDir, `${name}.csv`)

  /** Run fn with the file to itself: reads and rewrites never interleave. */
  function withFile(name, fn) {
    const prev = queues.get(name) || Promise.resolve()
    const next = prev.then(fn, fn)
    queues.set(name, next.catch(() => {}))
    return next
  }

  async function ensureDir() {
    try {
      await fsp.mkdir(dataDir, { recursive: true })
    } catch (err) {
      throw new StoreError('io', `Cannot create the data folder ${dataDir} (${err.code || err.message})`, 500)
    }
  }

  /** Rows of one CSV as objects. Missing or empty → []. A file that can't be
   *  read as this table is moved aside (never deleted) and a fresh one started. */
  async function load(name) {
    const schema = SCHEMAS[name]
    let text
    try {
      text = await fsp.readFile(fileOf(name), 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return { header: schema.cols, rows: [] }
      if (lockedError(err)) throw new StoreError('locked', `${name}.csv is open in another program (close it in Excel)`, 423)
      throw new StoreError('io', `Cannot read ${name}.csv (${err.code || err.message})`, 500)
    }
    text = text.replace(/^﻿/, '')
    if (!text.trim()) return { header: schema.cols, rows: [] }
    let table
    try {
      table = parseCsv(text)
    } catch (err) {
      return quarantine(name, err.message)
    }
    const header = (table[0] || []).map((h) => h.trim())
    if (!schema.key.every((k) => header.includes(k))) {
      return quarantine(name, `header has no ${schema.key.join('/')} column`)
    }
    const rows = []
    for (const cells of table.slice(1)) {
      if (!cells.some((c) => c.trim() !== '')) continue
      const o = {}
      header.forEach((h, i) => {
        if (h) o[h] = fromCell(cells[i] ?? '')
      })
      rows.push(o)
    }
    // Columns someone added by hand in Excel are kept on rewrite.
    const extra = header.filter((h) => h && !schema.cols.includes(h))
    return { header: [...schema.cols, ...extra], rows }
  }

  async function quarantine(name, why) {
    const aside = path.join(dataDir, `${name}.corrupt-${stamp()}.csv`)
    try {
      await fsp.rename(fileOf(name), aside)
    } catch (err) {
      if (lockedError(err)) throw new StoreError('locked', `${name}.csv is open in another program (close it in Excel)`, 423)
      throw new StoreError('io', `${name}.csv is unreadable (${why}) and could not be moved aside`, 500)
    }
    warn(`${name}.csv could not be read (${why}); kept it as ${path.basename(aside)} and started a new file`)
    return { header: SCHEMAS[name].cols, rows: [] }
  }

  async function write(name, header, rows) {
    await ensureDir()
    const target = fileOf(name)
    const tmp = path.join(dataDir, `.${name}.csv.${process.pid}.tmp`)
    try {
      await fsp.writeFile(tmp, serialize(header, rows), 'utf8')
      await fsp.rename(tmp, target)
    } catch (err) {
      fsp.unlink(tmp).catch(() => {})
      if (lockedError(err)) throw new StoreError('locked', `${name}.csv is open in another program (close it in Excel); it will be saved once it is closed`, 423)
      throw new StoreError('io', `Cannot write ${name}.csv (${err.code || err.message})`, 500)
    }
  }

  const keyOf = (schema, row) => schema.key.map((k) => String(row[k] ?? '')).join('\u0001')

  /** Keep only this table's columns, as strings; undefined = "leave as it is". */
  function clean(schema, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StoreError('invalid', 'each row must be an object')
    const row = {}
    for (const c of schema.cols) {
      const v = raw[c]
      if (v === undefined) continue
      row[c] = v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      if (row[c].length > MAX_CELL) row[c] = row[c].slice(0, MAX_CELL)
    }
    for (const k of schema.key) {
      if (!row[k] || row[k].length > 200) throw new StoreError('invalid', `every row needs a ${k}`)
    }
    return row
  }

  /**
   * One operation on one table:
   *   upsert   rows replace/extend the row with the same key (missing fields kept)
   *   insert   rows whose key already exists are skipped (event logs)
   *   replace  rows matching `where` are removed first (e.g. a section's waypoints
   *            when that section is uploaded again with fewer points)
   */
  function apply(name, op, rawRows, where) {
    const schema = SCHEMAS[name]
    if (!schema) throw new StoreError('invalid', `unknown table ${name}`)
    if (!['upsert', 'insert', 'replace'].includes(op)) throw new StoreError('invalid', `unknown operation ${op}`)
    if (!Array.isArray(rawRows) || rawRows.length > MAX_ROWS_PER_OP) throw new StoreError('invalid', 'rows must be a list')
    const rows = rawRows.map((r) => clean(schema, r))
    let filter = null
    if (op === 'replace') {
      if (!where || typeof where !== 'object' || !Object.keys(where).length) throw new StoreError('invalid', 'replace needs a where')
      filter = Object.entries(where).filter(([k]) => schema.cols.includes(k)).map(([k, v]) => [k, String(v)])
      if (!filter.length) throw new StoreError('invalid', 'replace where has no known column')
    }
    return withFile(name, async () => {
      const table = await load(name)
      let list = table.rows
      if (filter) list = list.filter((r) => !filter.every(([k, v]) => String(r[k] ?? '') === v))
      const index = new Map(list.map((r, i) => [keyOf(schema, r), i]))
      let added = 0
      let updated = 0
      for (const row of rows) {
        const k = keyOf(schema, row)
        const at = index.get(k)
        if (at === undefined) {
          index.set(k, list.length)
          list.push(row)
          added++
        } else if (op !== 'insert') {
          list[at] = { ...list[at], ...row }
          updated++
        }
      }
      if (added || updated || filter) await write(name, table.header, list)
      return { table: name, added, updated }
    })
  }

  // ---------------------------------------------------------------- catalog
  function seed() {
    try {
      const j = JSON.parse(fs.readFileSync(seedFile, 'utf8'))
      if (Array.isArray(j.states) && j.states.length) return j
    } catch (err) {
      warn(`default river catalog ${seedFile} unreadable (${err.code || err.message})`)
    }
    return { states: [{ id: 'DL', name: 'Delhi', rivers: [{ id: 'YAMUNA', name: 'Yamuna' }] }] }
  }

  function seedRows() {
    const j = seed()
    const states = []
    const rivers = []
    j.states.forEach((s, i) => {
      states.push({ state_id: s.id, state_name: s.name, enabled: 'yes', sort_order: String(i + 1) })
      for (const r of s.rivers || []) {
        rivers.push({
          river_id: r.id, state_id: s.id, river_name: r.name,
          center_lat: r.center?.[0] ?? '', center_lng: r.center?.[1] ?? '', zoom: r.zoom ?? '',
          enabled: 'yes', notes: r.notes || '',
        })
      }
    })
    return { states, rivers }
  }

  /** First run: write states.csv / rivers.csv from the bundled defaults, so the
   *  lists can be edited in Excel from then on without touching code. */
  async function ensureCatalogFiles() {
    const rows = seedRows()
    for (const name of ['states', 'rivers']) {
      await withFile(name, async () => {
        try {
          await fsp.access(fileOf(name))
        } catch {
          await write(name, SCHEMAS[name].cols, rows[name])
        }
      })
    }
  }

  const enabled = (v) => !/^(no|false|0|off|disabled)$/i.test(String(v ?? '').trim())
  const numOrNull = (v) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

  async function catalog() {
    const notes = []
    let source = 'csv'
    let states
    let rivers
    try {
      await ensureCatalogFiles()
      states = (await withFile('states', () => load('states'))).rows
      rivers = (await withFile('rivers', () => load('rivers'))).rows
    } catch (err) {
      notes.push(`Using the built-in list: ${err.message}`)
      source = 'default'
    }
    if (source === 'csv' && !states.some((s) => s.state_id && s.state_name && enabled(s.enabled))) {
      notes.push('states.csv lists no enabled states; using the built-in list.')
      source = 'default'
    }
    if (source === 'default') ({ states, rivers } = seedRows())

    const out = []
    const seen = new Set()
    for (const s of states) {
      const id = String(s.state_id || '').trim()
      const name = String(s.state_name || '').trim()
      if (!id || !name) {
        notes.push('A row in states.csv has no state_id or state_name and was skipped.')
        continue
      }
      if (seen.has(id.toUpperCase())) {
        notes.push(`State ${id} is listed twice in states.csv; the first one is used.`)
        continue
      }
      seen.add(id.toUpperCase())
      if (!enabled(s.enabled)) continue
      out.push({ id, name, order: numOrNull(s.sort_order) ?? 999, rivers: [] })
    }
    out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    const byId = new Map(out.map((s) => [s.id.toUpperCase(), s]))
    for (const r of rivers) {
      const id = String(r.river_id || '').trim()
      const name = String(r.river_name || '').trim()
      const st = byId.get(String(r.state_id || '').trim().toUpperCase())
      if (!id || !name) {
        notes.push('A row in rivers.csv has no river_id or river_name and was skipped.')
        continue
      }
      if (!st) continue // its state is disabled or unknown
      if (!enabled(r.enabled) || st.rivers.some((x) => x.id === id)) continue
      const lat = numOrNull(r.center_lat)
      const lng = numOrNull(r.center_lng)
      st.rivers.push({
        id,
        name,
        center: lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null,
        zoom: numOrNull(r.zoom),
        notes: String(r.notes || ''),
      })
    }
    return { states: out.map(({ order, ...s }) => s), source, notes, dataDir }
  }

  // ---------------------------------------------------------------- accounts
  const credFile = path.join(dataDir, 'credentials.json')
  const authCfgFile = path.join(dataDir, 'auth_config.json')

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return fallback
      if (err instanceof SyntaxError) {
        const aside = `${file}.corrupt-${stamp()}`
        await fsp.rename(file, aside).catch(() => {})
        warn(`${path.basename(file)} was unreadable; kept it as ${path.basename(aside)}`)
        return fallback
      }
      throw new StoreError('io', `Cannot read ${path.basename(file)} (${err.code || err.message})`, 500)
    }
  }

  async function writeJson(file, data) {
    await ensureDir()
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fsp.rename(tmp, file)
    } catch (err) {
      fsp.unlink(tmp).catch(() => {})
      throw new StoreError('io', `Cannot save ${path.basename(file)} (${err.code || err.message})`, 500)
    }
  }

  function scrypt(password, salt, p = SCRYPT) {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
        err ? reject(err) : resolve(key),
      )
    })
  }

  const text = (v, max) => String(v ?? '').trim().slice(0, max)

  function profileOf(row, extra = {}) {
    return {
      userId: row.user_id,
      username: row.username || '',
      name: row.name || row.username || '',
      email: row.email || '',
      provider: row.provider || '',
      profession: row.profession || '',
      organisation: row.organisation || '',
      createdAt: row.created_at || '',
      loginAt: row.last_login_at || '',
      fingerprint: row.fingerprint_enrolled === 'yes' ? 'yes' : '',
      ...extra,
    }
  }

  /** Record a successful sign-in in users.csv; returns the stored row. */
  function recordLogin(fields) {
    return withFile('users', async () => {
      const table = await load('users')
      const now = new Date().toISOString()
      const at = table.rows.findIndex((r) => r.user_id === fields.user_id)
      const prev = at >= 0 ? table.rows[at] : null
      const row = {
        ...(prev || {}),
        ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')),
        created_at: prev?.created_at || now,
        last_login_at: now,
        login_count: String((Number(prev?.login_count) || 0) + 1),
      }
      if (at >= 0) table.rows[at] = row
      else table.rows.push(row)
      await write('users', table.header, table.rows)
      return row
    })
  }

  /** recordLogin, but a users.csv that can't be written (open in Excel) doesn't
   *  stop the sign-in: the row is written later and the profile returned now. */
  async function recordLoginSafe(fields, tries = 0) {
    try {
      return await recordLogin(fields)
    } catch (err) {
      if (tries === 0) warn(`users.csv not updated for ${fields.user_id} (${err.message}); will retry`)
      if (tries < 20) setTimeout(() => recordLoginSafe(fields, tries + 1).catch(() => {}), 30000).unref?.()
      const now = new Date().toISOString()
      return { ...fields, created_at: fields.created_at || now, last_login_at: now }
    }
  }

  // One writer for credentials.json at a time (two registrations racing for a name).
  const withCreds = (fn) => withFile('__credentials', fn)

  async function register(body) {
    const username = text(body.username, 32)
    const password = String(body.password ?? '')
    const name = text(body.name, 80)
    const email = text(body.email, 254)
    if (!USERNAME_RE.test(username)) throw new StoreError('invalid', 'Username: 3–32 letters, digits, dot, dash or underscore.')
    if (password.length < 8 || password.length > 200) throw new StoreError('invalid', 'Password: at least 8 characters.')
    if (!name) throw new StoreError('invalid', 'Enter your name.')
    if (email && !EMAIL_RE.test(email)) throw new StoreError('invalid', 'That email address does not look right.')
    // The face is taken when the account is made; every sign-in is checked against it.
    const face = faceSamples(body.face)
    const lower = username.toLowerCase()
    const userId = 'U-' + crypto.randomBytes(5).toString('hex')
    await withCreds(async () => {
      const creds = await readJson(credFile, { version: 1, users: {} })
      if (!creds.users || typeof creds.users !== 'object') creds.users = {}
      if (creds.users[lower]) throw new StoreError('duplicate', 'That username is already taken.', 409)
      const salt = crypto.randomBytes(16)
      const hash = await scrypt(password, salt)
      creds.users[lower] = {
        user_id: userId, salt: salt.toString('base64'), hash: hash.toString('base64'), ...SCRYPT,
        created_at: new Date().toISOString(),
        // Profile copy so sign-in still knows the name if users.csv is unreadable.
        username, name, email,
      }
      await writeJson(credFile, creds)
    })
    const at = await saveFace(userId, face)
    const fields = {
      user_id: userId, username, name, email, provider: 'local',
      profession: text(body.profession, 80), organisation: text(body.organisation, 120),
      face_enrolled: 'yes', face_enrolled_at: at, last_face_check_at: at,
    }
    logFaceCheck(fields, 'new account', 'enrolled', null, face.length)
    const row = await recordLoginSafe(fields)
    return finished(row)
  }

  async function login(body) {
    const username = text(body.username, 64)
    const password = String(body.password ?? '')
    if (!username || !password) throw new StoreError('invalid', 'Enter your username and password.')
    const lower = username.toLowerCase()
    const f = failures.get(lower)
    if (f && f.until > Date.now()) {
      throw new StoreError('locked_out', `Too many wrong attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} s.`, 429)
    }
    const creds = await readJson(credFile, { version: 1, users: {} })
    const entry = creds.users?.[lower]
    // Same work whether or not the user exists, so timing doesn't reveal names.
    const salt = entry ? Buffer.from(entry.salt, 'base64') : crypto.randomBytes(16)
    const key = await scrypt(password, salt, entry || SCRYPT)
    const ok = !!entry && crypto.timingSafeEqual(key, Buffer.from(entry.hash, 'base64'))
    if (!ok) {
      const n = (f?.n || 0) + 1
      failures.set(lower, { n, until: n >= 5 ? Date.now() + 60000 : 0 })
      throw new StoreError('bad_login', 'Wrong username or password.', 401)
    }
    failures.delete(lower)
    let prev = null
    try {
      prev = (await withFile('users', () => load('users'))).rows.find((r) => r.user_id === entry.user_id) || null
    } catch {
      /* users.csv locked: fall back to the copy kept with the password hash */
    }
    // The password is right; the sign-in finishes once the face matches (faceComplete).
    return beginFace({
      ...(prev || { username: entry.username, name: entry.name, email: entry.email }),
      user_id: entry.user_id, username: prev?.username || entry.username || username, provider: 'local',
    }, 'password')
  }

  // ---------------------------------------------------------------- face check
  const facesFile = path.join(dataDir, 'faces.json')
  const withFaces = (fn) => withFile('__faces', fn)

  /** The face templates sent by the page, checked: 1–5 lists of 128 numbers. */
  function faceSamples(raw) {
    if (!Array.isArray(raw) || !raw.length) throw new StoreError('face_required', 'Take the face picture first.', 400)
    if (raw.length > FACE_MAX_SAMPLES) throw new StoreError('invalid', 'Too many face samples.')
    return raw.map((d) => {
      if (!Array.isArray(d) || d.length !== FACE_DIM || !d.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 2)) {
        throw new StoreError('invalid', 'The face sample is not valid. Take the picture again.')
      }
      return d.map((x) => Math.round(x * 1e5) / 1e5)
    })
  }

  async function savedFace(userId) {
    const all = await readJson(facesFile, { version: 1, users: {} })
    return all.users?.[userId] || null
  }

  /** Keep this user's face templates (replacing any older ones); returns when. */
  async function saveFace(userId, samples) {
    const at = new Date().toISOString()
    await withFaces(async () => {
      const all = await readJson(facesFile, { version: 1, users: {} })
      if (!all.users || typeof all.users !== 'object') all.users = {}
      all.users[userId] = { samples, enrolled_at: at }
      await writeJson(facesFile, all)
    })
    return at
  }

  const dist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0))

  /** Mean over the new samples of the distance to the nearest saved one. */
  function faceDistance(saved, samples) {
    const near = samples.map((s) => Math.min(...saved.map((t) => dist(s, t))))
    return near.reduce((a, b) => a + b, 0) / near.length
  }

  /** face_checks.csv row. A locked CSV must not block the sign-in, so this never throws. */
  function logFaceCheck(fields, method, result, distance, samples) {
    const row = {
      check_id: 'F-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
      at: new Date().toISOString(),
      user_id: fields.user_id, username: fields.username || '', name: fields.name || '',
      sign_in_method: method, result,
      distance: distance == null ? '' : distance.toFixed(3), threshold: String(FACE_MATCH), samples: String(samples),
    }
    apply('face_checks', 'insert', [row]).catch((err) => warn(`face_checks.csv not updated (${err.message})`))
  }

  function pruneFace() {
    const now = Date.now()
    for (const [k, v] of pendingFace) if (now - v.at > FACE_TTL_MS) pendingFace.delete(k)
  }

  /** After the password or Google: a ticket for the face step. `enroll` = no face saved yet. */
  async function beginFace(fields, method, extra = {}) {
    pruneFace()
    if (pendingFace.size > 50) throw new StoreError('busy', 'Too many sign-ins in progress; try again in a few minutes.', 429)
    const enroll = !(await savedFace(fields.user_id))?.samples?.length
    const ticket = crypto.randomBytes(16).toString('hex')
    pendingFace.set(ticket, { at: Date.now(), fields, extra, method, enroll, tries: 0 })
    // With a fingerprint saved, the operator may use it instead of the face.
    const fingerprint = !enroll && fpIdsOf(await fpCredentials(), fields.user_id).length > 0
    return { face: { ticket, enroll, fingerprint, expiresInS: FACE_TTL_MS / 1000 } }
  }

  /** The face step: save it (first time) or match it, then finish the sign-in. */
  async function faceComplete(body) {
    pruneFace()
    const ticket = String(body.ticket || '')
    const p = pendingFace.get(ticket)
    if (!p) throw new StoreError('expired', 'The sign-in took too long. Sign in again.', 410)
    const samples = faceSamples(body.face)
    const now = new Date().toISOString()
    let fields = { ...p.fields, last_face_check_at: now }
    const saved = p.enroll ? null : await savedFace(p.fields.user_id)
    if (!saved?.samples?.length) {
      const at = await saveFace(p.fields.user_id, samples)
      fields = { ...fields, face_enrolled: 'yes', face_enrolled_at: at }
      logFaceCheck(fields, p.method, 'enrolled', null, samples.length)
    } else {
      const d = faceDistance(saved.samples, samples)
      if (!(d < FACE_MATCH)) {
        p.tries++
        logFaceCheck(fields, p.method, 'no match', d, samples.length)
        if (p.tries >= FACE_TRIES) {
          pendingFace.delete(ticket)
          throw new StoreError('face_locked', 'The face did not match 3 times. Sign in again.', 401)
        }
        throw new StoreError('face_mismatch', `That does not look like the person who made this account. Face the camera in good light and try again (${FACE_TRIES - p.tries} left).`, 401)
      }
      logFaceCheck(fields, p.method, 'match', d, samples.length)
    }
    pendingFace.delete(ticket)
    const row = await recordLoginSafe(fields)
    return finished(row, p.extra)
  }

  // ---------------------------------------------------------------- fingerprint
  // Windows Hello through WebAuthn. The fingerprint never leaves the sensor:
  // Windows checks it, then signs a fresh challenge with a key kept in the
  // laptop's security chip, and this checks that signature with the public key
  // saved when the fingerprint was added. The app opens a small page at
  // http://localhost:<port> for it (the desktop window is on 127.0.0.1, which
  // WebAuthn refuses); that page and the app meet here under a random window id.
  const fpFile = path.join(dataDir, 'fingerprints.json')
  const withFp = (fn) => withFile('__fingerprints', fn)
  const b64u = (b) => Buffer.from(b).toString('base64url')
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
  const RP_HASH = sha256(RP_ID)
  const FP_ID_RE = /^[a-f0-9]{32}$/

  async function fpCredentials() {
    const all = await readJson(fpFile, { version: 1, credentials: {} })
    if (!all.credentials || typeof all.credentials !== 'object') all.credentials = {}
    return all
  }

  const fpIdsOf = (all, userId) => Object.keys(all.credentials).filter((id) => all.credentials[id].user_id === userId)

  function pruneFp() {
    const now = Date.now()
    for (const [k, v] of pendingFp) if (now - v.at > FP_TTL_MS) pendingFp.delete(k)
    for (const [k, v] of fpSetup) if (now - v.at > FP_SETUP_TTL_MS) fpSetup.delete(k)
  }

  /** A finished sign-in: the profile, and a short-lived token to add a fingerprint with. */
  function finished(row, extra = {}) {
    pruneFp()
    const token = crypto.randomBytes(16).toString('hex')
    if (fpSetup.size < 50) fpSetup.set(token, { at: Date.now(), row })
    return { profile: profileOf(row, extra), fingerprintSetup: token }
  }

  /** fingerprint_checks.csv row; never throws (a locked CSV must not block sign-in). */
  function logFp(row, action, result) {
    apply('fingerprint_checks', 'insert', [{
      check_id: 'P-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
      at: new Date().toISOString(),
      user_id: row.user_id, username: row.username || '', name: row.name || '', action, result,
    }]).catch((err) => warn(`fingerprint_checks.csv not updated (${err.message})`))
  }

  /** Change a few columns of one users.csv row (not a sign-in). */
  function updateUser(userId, fields) {
    return withFile('users', async () => {
      const table = await load('users')
      const at = table.rows.findIndex((r) => r.user_id === userId)
      if (at < 0) return
      table.rows[at] = { ...table.rows[at], ...fields }
      await write('users', table.header, table.rows)
    }).catch((err) => warn(`users.csv not updated for ${userId} (${err.message})`))
  }

  /** The users.csv row of an operator (or the copy kept with the password). */
  async function userRow(userId) {
    try {
      const row = (await withFile('users', () => load('users'))).rows.find((r) => r.user_id === userId)
      if (row) return row
    } catch {
      /* users.csv locked: fall back below */
    }
    const creds = await readJson(credFile, { version: 1, users: {} })
    const e = Object.values(creds.users || {}).find((u) => u.user_id === userId)
    return e ? { user_id: userId, username: e.username, name: e.name, email: e.email, provider: 'local' } : null
  }

  /** The page asks what to show Windows Hello: a new key (add) or a signature (sign in). */
  async function fingerprintOptions(req, body) {
    pruneFp()
    const id = String(body.id || '')
    if (!FP_ID_RE.test(id)) throw new StoreError('invalid', 'Bad fingerprint request.')
    const host = String(req.headers.host || '').toLowerCase()
    if (!/^localhost(:\d+)?$/.test(host)) throw new StoreError('invalid', 'The fingerprint page must run on http://localhost.')
    const prev = pendingFp.get(id)
    if (prev && prev.status !== 'waiting') throw new StoreError('expired', 'This fingerprint window has finished. Start again from VARUNA.', 410)
    if (!prev && pendingFp.size > 50) throw new StoreError('busy', 'Too many fingerprint windows open; try again in a few minutes.', 429)
    const kind = String(body.kind || '')
    const token = String(body.token || '')
    const challenge = b64u(crypto.randomBytes(32)) // a fresh one on every try
    const all = await fpCredentials()
    let publicKey
    try {
      if (kind === 'add') {
        const s = fpSetup.get(token)
        if (!s) throw new StoreError('expired', 'Adding a fingerprint took too long. Sign in again, then add it.', 410)
        publicKey = {
          challenge,
          rp: { id: RP_ID, name: 'VARUNA AI' },
          // The same user id each time, so adding again replaces the old key in Windows.
          user: { id: b64u(sha256(s.row.user_id).subarray(0, 16)), name: s.row.username || s.row.email || s.row.user_id, displayName: s.row.name || s.row.username || s.row.user_id },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          attestation: 'none',
          timeout: FP_TTL_MS / 2,
        }
      } else if (kind === 'verify' || kind === 'login') {
        let allow = []
        if (kind === 'verify') {
          // After the password / Google, instead of the face.
          const f = pendingFace.get(token)
          if (!f) throw new StoreError('expired', 'The sign-in took too long. Sign in again.', 410)
          allow = fpIdsOf(all, f.fields.user_id)
          if (!allow.length) throw new StoreError('no_fingerprint', 'No fingerprint is saved for this account yet. Use the face check; you can add a fingerprint after signing in.', 400)
        } else if (!Object.keys(all.credentials).length) {
          throw new StoreError('no_fingerprint', 'No fingerprint is saved on this computer yet. Sign in once, then add one.', 400)
        }
        publicKey = { challenge, rpId: RP_ID, userVerification: 'required', timeout: FP_TTL_MS / 2, allowCredentials: allow.map((x) => ({ type: 'public-key', id: x })) }
      } else {
        throw new StoreError('invalid', 'Bad fingerprint request.')
      }
    } catch (err) {
      // Nothing to retry: tell the app why, so it does not wait for nothing.
      pendingFp.set(id, { at: prev?.at || Date.now(), status: 'error', code: err.code, message: err.message })
      throw err
    }
    pendingFp.set(id, { at: prev?.at || Date.now(), status: 'waiting', kind, token, challenge, origin: `http://${host}` })
    return { kind, publicKey }
  }

  const fpBad = (message = 'The fingerprint answer is not valid. Try again.') => new StoreError('invalid', message, 400)

  function fpPart(v, max) {
    if (typeof v !== 'string' || !v || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) throw fpBad()
    return Buffer.from(v, 'base64url')
  }

  function checkClientData(p, raw, type) {
    let cd = null
    try {
      cd = JSON.parse(raw.toString('utf8'))
    } catch {
      /* checked below */
    }
    if (cd?.type !== type || cd.challenge !== p.challenge || cd.origin !== p.origin) throw fpBad('The fingerprint answer does not belong to this sign-in.')
  }

  /** authenticatorData: made for this site, with the person's presence and identity checked. */
  function checkAuthData(ad) {
    if (ad.length < 37 || !ad.subarray(0, 32).equals(RP_HASH)) throw fpBad()
    const flags = ad[32]
    if (!(flags & 0x01) || !(flags & 0x04)) throw new StoreError('not_verified', 'Windows did not confirm it was you. Try again.', 401)
    return { flags, count: ad.readUInt32BE(33) }
  }

  async function fpAdd(p, cred) {
    const s = fpSetup.get(p.token)
    if (!s) throw new StoreError('expired', 'Adding a fingerprint took too long. Sign in again, then add it.', 410)
    const rawId = fpPart(cred?.rawId, 1400)
    const clientData = fpPart(cred?.response?.clientDataJSON, 4000)
    const ad = fpPart(cred?.response?.authenticatorData, 4000)
    const spki = fpPart(cred?.response?.publicKey, 4000)
    const alg = Number(cred?.response?.publicKeyAlgorithm)
    checkClientData(p, clientData, 'webauthn.create')
    const { flags, count } = checkAuthData(ad)
    // The key Windows made must be the one the page reports.
    if (!(flags & 0x40) || ad.length < 55 || !ad.subarray(55, 55 + ad.readUInt16BE(53)).equals(rawId)) throw fpBad()
    let key
    try {
      key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' })
    } catch {
      throw fpBad()
    }
    if (!((alg === -7 && key.asymmetricKeyType === 'ec') || (alg === -257 && key.asymmetricKeyType === 'rsa'))) throw fpBad()
    const row = s.row
    const at = new Date().toISOString()
    await withFp(async () => {
      const all = await fpCredentials()
      for (const old of fpIdsOf(all, row.user_id)) delete all.credentials[old] // one per operator
      all.credentials[b64u(rawId)] = { user_id: row.user_id, public_key: b64u(spki), alg, sign_count: count, created_at: at, last_used_at: '' }
      await writeJson(fpFile, all)
    })
    fpSetup.delete(p.token)
    await updateUser(row.user_id, { fingerprint_enrolled: 'yes', fingerprint_enrolled_at: at })
    logFp(row, 'added', 'ok')
    return { added: true }
  }

  async function fpSignIn(p, cred) {
    const rawId = fpPart(cred?.rawId, 1400)
    const clientData = fpPart(cred?.response?.clientDataJSON, 4000)
    const ad = fpPart(cred?.response?.authenticatorData, 4000)
    const sig = fpPart(cred?.response?.signature, 1400)
    checkClientData(p, clientData, 'webauthn.get')
    const { count } = checkAuthData(ad)
    const face = p.kind === 'verify' ? pendingFace.get(p.token) : null
    if (p.kind === 'verify' && !face) throw new StoreError('expired', 'The sign-in took too long. Sign in again.', 410)
    const userId = await withFp(async () => {
      const all = await fpCredentials()
      const c = all.credentials[b64u(rawId)]
      if (!c) throw new StoreError('unknown_fingerprint', 'That fingerprint is not saved in VARUNA. Sign in another way, then add it.', 401)
      if (face && c.user_id !== face.fields.user_id) throw new StoreError('wrong_fingerprint', 'That fingerprint belongs to a different account.', 401)
      const key = crypto.createPublicKey({ key: Buffer.from(c.public_key, 'base64url'), format: 'der', type: 'spki' })
      if (!crypto.verify('sha256', Buffer.concat([ad, sha256(clientData)]), key, sig)) {
        throw new StoreError('bad_fingerprint', 'The fingerprint check failed. Try again.', 401)
      }
      // Windows Hello keeps the counter at 0; a key that counts must only go up.
      if ((count || c.sign_count) && !(count > c.sign_count)) throw new StoreError('bad_fingerprint', 'This fingerprint key was refused (its counter went back). Add the fingerprint again.', 401)
      c.sign_count = count
      c.last_used_at = new Date().toISOString()
      await writeJson(fpFile, all)
      return c.user_id
    })
    const now = new Date().toISOString()
    if (face) {
      pendingFace.delete(p.token)
      const fields = { ...face.fields, last_fingerprint_at: now }
      logFp(fields, `sign-in (${face.method}, instead of face)`, 'match')
      return finished(await recordLoginSafe(fields), face.extra)
    }
    const row = await userRow(userId)
    if (!row) throw new StoreError('unknown_fingerprint', 'The account for this fingerprint no longer exists.', 401)
    const fields = { ...row, last_fingerprint_at: now }
    logFp(fields, 'sign-in', 'match')
    return finished(await recordLoginSafe(fields))
  }

  /** The page sends what Windows Hello answered. */
  async function fingerprintAnswer(body) {
    pruneFp()
    const id = String(body.id || '')
    const p = pendingFp.get(id)
    if (!FP_ID_RE.test(id) || !p || p.status !== 'waiting') throw new StoreError('expired', 'This fingerprint window has expired. Start again from VARUNA.', 410)
    try {
      const result = p.kind === 'add' ? await fpAdd(p, body.credential) : await fpSignIn(p, body.credential)
      pendingFp.set(id, { at: p.at, status: 'done', result })
      return { kind: p.kind } // the page only learns that it worked
    } catch (err) {
      const who = p.kind === 'add' ? fpSetup.get(p.token)?.row : pendingFace.get(p.token)?.fields
      if (err.code !== 'invalid' && err.code !== 'expired') logFp(who || { user_id: '' }, p.kind === 'add' ? 'add' : 'sign-in', err.code)
      pendingFp.set(id, { at: p.at, status: 'error', code: err.code, message: err.message })
      throw err
    }
  }

  /** The page was closed or cancelled. */
  function fingerprintCancel(body) {
    pruneFp()
    const id = String(body.id || '')
    if (!FP_ID_RE.test(id)) return {}
    const p = pendingFp.get(id)
    if (p && p.status !== 'waiting') return {}
    if (p || pendingFp.size <= 50) pendingFp.set(id, { at: p?.at || Date.now(), status: 'cancelled', message: text(body.message, 200) || 'Fingerprint cancelled.' })
    return {}
  }

  /** The app waits here for the page: { status: waiting | done | error | cancelled }. */
  function fingerprintResult(body) {
    pruneFp()
    const id = String(body.id || '')
    const p = FP_ID_RE.test(id) ? pendingFp.get(id) : null
    if (!p || p.status === 'waiting') return { status: 'waiting' }
    pendingFp.delete(id) // handed over once
    if (p.status === 'done') return { status: 'done', ...p.result }
    return { status: p.status, code: p.code, message: p.message }
  }

  const FP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VARUNA AI — Fingerprint</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8f7ff;font-family:Inter,system-ui,sans-serif;color:#1e1b4b}
  main{background:#fff;border-radius:16px;padding:26px 30px;box-shadow:0 12px 40px rgba(109,40,217,.18);text-align:center;width:300px}
  h1{margin:0 0 10px;font-size:20px;background:linear-gradient(135deg,#4c1d95,#7c3aed,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent}
  svg{width:64px;height:64px;color:#7c3aed}
  #msg{margin:12px 0 4px;font-size:14px;font-weight:600;min-height:40px}
  .bad{color:#b91c1c}.ok{color:#047857}
  .row{display:flex;gap:8px;justify-content:center;margin-top:12px}
  button{border:0;border-radius:10px;padding:9px 16px;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;background:#7c3aed;color:#fff}
  button.ghost{background:#ede9fe;color:#4c1d95}
</style></head>
<body><main>
<h1>VARUNA AI</h1>
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 11c0 3.5-1 6.5-2.5 9"/><path d="M8.5 7.5A5 5 0 0 1 17 11c0 2.5-.3 5-1 7"/><path d="M5.5 15c.3-1.3.5-2.6.5-4a6 6 0 0 1 9-5.2"/><path d="M14.5 20.5c.5-1.5.8-3 1-4.5"/><path d="M3.5 10a8.5 8.5 0 0 1 13-6.6"/><path d="M19.5 9c.4 1.6.5 3.2.3 5"/></svg>
<div id="msg" role="status">Starting Windows Hello…</div>
<div class="row"><button id="again" hidden>Try again</button><button id="close" class="ghost">Cancel</button></div>
</main>
<script src="/local/auth/fingerprint/page.js"></script>
</body></html>`

  const FP_PAGE_JS = `(function () {
  var q = new URLSearchParams(location.hash.slice(1));
  var id = q.get('id') || '', kind = q.get('kind') || '', token = q.get('t') || '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var msg = document.getElementById('msg'), again = document.getElementById('again'), closeBtn = document.getElementById('close');
  var over = false;
  function say(t, cls) { msg.textContent = t; msg.className = cls || ''; }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) { var e = new Error(j.error || 'Failed'); e.code = j.code || 'failed'; throw e; } return j; });
  }
  function bin(s) { var b = atob(s.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
  function b64(buf) { var u = new Uint8Array(buf), s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }
  function end(t, cls) { over = true; say(t, cls); again.hidden = true; closeBtn.hidden = true; setTimeout(function () { window.close(); }, cls === 'ok' ? 300 : 2500); }
  function cancel(t) { if (over) return; over = true; navigator.sendBeacon('/local/auth/fingerprint/cancel', JSON.stringify({ id: id, message: t })); }
  function run() {
    again.hidden = true;
    say(kind === 'add' ? 'Add your fingerprint: touch the sensor when Windows asks.' : 'Touch the fingerprint sensor.');
    post('/local/auth/fingerprint/options', { id: id, kind: kind, token: token }).then(function (j) {
      var o = j.publicKey;
      o.challenge = bin(o.challenge);
      if (o.user) o.user.id = bin(o.user.id);
      (o.allowCredentials || []).forEach(function (c) { c.id = bin(c.id); });
      return kind === 'add' ? navigator.credentials.create({ publicKey: o }) : navigator.credentials.get({ publicKey: o });
    }).then(function (c) {
      var r = c.response, out = { rawId: b64(c.rawId), response: { clientDataJSON: b64(r.clientDataJSON) } };
      if (kind === 'add') {
        out.response.authenticatorData = b64(r.getAuthenticatorData());
        out.response.publicKey = b64(r.getPublicKey());
        out.response.publicKeyAlgorithm = r.getPublicKeyAlgorithm();
      } else {
        out.response.authenticatorData = b64(r.authenticatorData);
        out.response.signature = b64(r.signature);
      }
      say('Checking…');
      return post('/local/auth/fingerprint/answer', { id: id, credential: out });
    }).then(function () {
      end(kind === 'add' ? 'Fingerprint added.' : 'Done.', 'ok');
    }, function (e) {
      if (e.code) return end(e.message, 'bad'); // VARUNA refused: this window is finished
      // Windows Hello was closed, timed out or did not know the finger: try again.
      say(e.name === 'NotAllowedError' ? 'Cancelled, or Windows did not recognise you. Try again.' : (e.message || 'Windows Hello is not available.'), 'bad');
      again.hidden = false;
    });
  }
  again.onclick = run;
  closeBtn.onclick = function () { cancel('Fingerprint cancelled.'); window.close(); };
  window.addEventListener('pagehide', function () { cancel('Fingerprint cancelled.'); });
  if (!window.PublicKeyCredential) { cancel('Windows Hello is not available here.'); return end('Windows Hello is not available here.', 'bad'); }
  run();
})();`

  // ---------------------------------------------------------------- Data tab PIN
  const lockFile = path.join(dataDir, 'data_lock.json')
  let pinFailures = { n: 0, until: 0 }

  async function unlockData(body) {
    if (pinFailures.until > Date.now()) {
      throw new StoreError('locked_out', `Too many wrong PINs. Try again in ${Math.ceil((pinFailures.until - Date.now()) / 1000)} s.`, 429)
    }
    const pin = String(body.pin ?? '')
    if (!pin || pin.length > 64) throw new StoreError('invalid', 'Enter the PIN.')
    let lock = await readJson(lockFile, null)
    if (!lock?.salt || !lock?.hash) {
      // First use: keep the default PIN hashed, like a password.
      const salt = crypto.randomBytes(16)
      lock = { salt: salt.toString('base64'), hash: (await scrypt(DEFAULT_DATA_PIN, salt)).toString('base64'), ...SCRYPT }
      await writeJson(lockFile, lock)
    }
    const key = await scrypt(pin, Buffer.from(lock.salt, 'base64'), lock)
    if (!crypto.timingSafeEqual(key, Buffer.from(lock.hash, 'base64'))) {
      pinFailures = { n: pinFailures.n + 1, until: pinFailures.n + 1 >= 5 ? Date.now() + 60000 : 0 }
      throw new StoreError('bad_pin', 'Wrong PIN.', 401)
    }
    pinFailures = { n: 0, until: 0 }
    return true
  }

  // ---------------------------------------------------------------- Google
  async function googleClientId() {
    const cfg = await readJson(authCfgFile, {})
    const id = String(cfg.googleClientId || process.env.VARUNA_GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID).trim()
    return CLIENT_ID_RE.test(id) ? id : ''
  }

  async function setGoogleClientId(raw) {
    const id = text(raw, 200)
    if (id && !CLIENT_ID_RE.test(id)) throw new StoreError('invalid', 'That is not a Google OAuth client ID (…apps.googleusercontent.com).')
    const cfg = await readJson(authCfgFile, {})
    await writeJson(authCfgFile, { ...cfg, googleClientId: id })
    return id
  }

  function prune() {
    const now = Date.now()
    for (const [k, v] of pendingGoogle) if (now - v.at > GOOGLE_TTL_MS) pendingGoogle.delete(k)
  }

  /** The origin the Google sign-in page is served from — the one to list under
   *  "Authorised JavaScript origins" in Google Cloud Console. */
  function signInOrigin(req) {
    const port = String(req.headers.host || '').split(':').pop()
    return `http://localhost${/^\d+$/.test(port) ? ':' + port : ''}`
  }

  async function googleBegin(req) {
    const clientId = await googleClientId()
    if (!clientId) throw new StoreError('not_configured', 'Google sign-in is not set up yet: add your OAuth client ID first.', 400)
    prune()
    if (pendingGoogle.size > 20) throw new StoreError('busy', 'Too many sign-ins in progress; try again in a few minutes.', 429)
    const nonce = crypto.randomBytes(16).toString('hex')
    pendingGoogle.set(nonce, { at: Date.now(), status: 'pending' })
    // Google only accepts "localhost" (not 127.0.0.1) as a development origin.
    // The desktop window runs on 127.0.0.1, so the sign-in page is opened at
    // localhost — a different origin, which the desktop shell sends to the
    // system browser, the only place Google allows its sign-in.
    const url = `${signInOrigin(req)}/local/auth/google/page?nonce=${nonce}`
    return { nonce, url, expiresInS: GOOGLE_TTL_MS / 1000 }
  }

  async function verifyGoogleToken(credential, nonce) {
    const clientId = await googleClientId()
    if (!clientId) throw new StoreError('not_configured', 'Google sign-in is not set up.', 400)
    if (typeof credential !== 'string' || credential.length > 8000 || credential.split('.').length !== 3) {
      throw new StoreError('invalid', 'Google did not return a sign-in token.', 400)
    }
    let info
    try {
      // Google's own check of the signature and expiry.
      const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
        signal: AbortSignal.timeout(10000),
      })
      info = await r.json().catch(() => ({}))
      if (!r.ok) throw new StoreError('google_rejected', `Google rejected the sign-in (${info.error_description || info.error || r.status}).`, 401)
    } catch (err) {
      if (err instanceof StoreError) throw err
      throw new StoreError('google_unreachable', `Could not reach Google to confirm the sign-in (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`, 502)
    }
    if (info.aud !== clientId) throw new StoreError('google_rejected', 'The sign-in was issued for a different app.', 401)
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) throw new StoreError('google_rejected', 'The sign-in did not come from Google.', 401)
    if (!(Number(info.exp) * 1000 > Date.now())) throw new StoreError('google_rejected', 'The sign-in has expired; try again.', 401)
    if (info.nonce !== nonce) throw new StoreError('google_rejected', 'The sign-in does not belong to this request; try again.', 401)
    if (String(info.email_verified) !== 'true') throw new StoreError('google_rejected', 'That Google account has no verified email.', 401)
    return info
  }

  async function googleComplete(body) {
    prune()
    const nonce = String(body.nonce || '')
    const p = pendingGoogle.get(nonce)
    if (!p || p.status !== 'pending') throw new StoreError('expired', 'This sign-in window has expired. Start again from VARUNA.', 410)
    try {
      const info = await verifyGoogleToken(body.credential, nonce)
      // Google vouches for the account; the app then checks the face (faceComplete).
      // Only the profile is kept — the ID token itself is dropped here.
      const { face } = await beginFace({
        user_id: 'G-' + String(info.sub).slice(0, 40),
        username: String(info.email || '').split('@')[0],
        name: text(info.name || info.given_name || info.email, 80),
        email: text(info.email, 254),
        provider: 'google',
        organisation: text(info.hd, 120), // Google Workspace domain, if any
      }, 'google', { picture: /^https:\/\//.test(info.picture || '') ? info.picture : '' })
      const profile = { name: text(info.name || info.given_name || info.email, 80), email: text(info.email, 254) }
      pendingGoogle.set(nonce, { at: p.at, status: 'face', face })
      return profile
    } catch (err) {
      pendingGoogle.set(nonce, { at: p.at, status: 'error', message: err.message })
      throw err
    }
  }

  function googleResult(nonce) {
    prune()
    const p = pendingGoogle.get(String(nonce || ''))
    if (!p) return { status: 'expired', message: 'The sign-in window expired. Try again.' }
    if (p.status !== 'pending') pendingGoogle.delete(String(nonce)) // handed over once
    return { status: p.status, profile: p.profile, message: p.message, face: p.face }
  }

  function googlePage(clientId, nonce) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VARUNA AI — Sign in with Google</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8f7ff;font-family:Inter,system-ui,sans-serif;color:#1e1b4b}
  main{background:#fff;border-radius:16px;padding:32px 36px;box-shadow:0 12px 40px rgba(109,40,217,.18);text-align:center;max-width:380px}
  h1{margin:0 0 6px;font-size:22px;background:linear-gradient(135deg,#4c1d95,#7c3aed,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent}
  p{margin:0 0 20px;font-size:13px;color:#5b21b6}
  #btn{display:flex;justify-content:center;min-height:44px}
  #msg{margin-top:16px;font-size:13px;font-weight:600}
  .bad{color:#b91c1c}.ok{color:#047857}
</style></head>
<body><main id="app" data-client-id="${esc(clientId)}" data-nonce="${esc(nonce)}">
<h1>VARUNA AI</h1><p>Sign in with your Google account to continue in the VARUNA ground station.</p>
<div id="btn"></div><div id="msg"></div>
</main>
<script src="https://accounts.google.com/gsi/client" async></script>
<script src="/local/auth/google/page.js" defer></script>
</body></html>`
  }

  const GOOGLE_PAGE_JS = `(function () {
  var app = document.getElementById('app');
  var msg = document.getElementById('msg');
  function say(t, cls) { msg.textContent = t; msg.className = cls || ''; }
  function done(credential) {
    say('Checking with Google…');
    fetch('/local/auth/google/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: app.dataset.nonce, credential: credential })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) return say(j.error || 'Sign-in failed.', 'bad');
      document.getElementById('btn').innerHTML = '';
      say('Google confirmed ' + (j.profile.name || j.profile.email) + '. Return to VARUNA to finish with the face check.', 'ok');
      setTimeout(function () { try { window.close(); } catch (e) {} }, 1500);
    }).catch(function () { say('Could not reach VARUNA. Is the app still open?', 'bad'); });
  }
  var tries = 0;
  (function init() {
    if (!(window.google && google.accounts && google.accounts.id)) {
      if (++tries > 100) return say('Google sign-in did not load. Check the internet connection.', 'bad');
      return setTimeout(init, 100);
    }
    google.accounts.id.initialize({
      client_id: app.dataset.clientId, nonce: app.dataset.nonce, auto_select: false,
      callback: function (res) { res && res.credential ? done(res.credential) : say('Google did not sign you in.', 'bad'); }
    });
    google.accounts.id.renderButton(document.getElementById('btn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill' });
  })();
})();`

  // ---------------------------------------------------------------- status
  async function status() {
    const files = []
    for (const name of Object.keys(SCHEMAS)) {
      try {
        const st = await fsp.stat(fileOf(name))
        const { rows } = await withFile(name, () => load(name))
        files.push({ name: `${name}.csv`, rows: rows.length, bytes: st.size, updatedAt: st.mtime.toISOString() })
      } catch (err) {
        files.push({ name: `${name}.csv`, rows: 0, bytes: 0, updatedAt: null, missing: err.code === 'ENOENT', error: err.code === 'ENOENT' ? null : err.message })
      }
    }
    const clientId = await googleClientId().catch(() => '')
    return { dataDir, files, warnings: warnings.slice(-10), google: { configured: !!clientId, clientId } }
  }

  // ---------------------------------------------------------------- HTTP
  function sendJson(res, statusCode, obj) {
    if (res.headersSent) return res.end()
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(obj))
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) {
          reject(new StoreError('too_large', 'Request too large', 413))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch {
          reject(new StoreError('invalid', 'Request body is not JSON', 400))
        }
      })
      req.on('error', reject)
    })
  }

  // Only this app's own pages may use the store: the browser marks their
  // requests same-origin, and a hostile site (or a DNS-rebound name) cannot.
  function sameOrigin(req) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false
    return req.headers['sec-fetch-site'] === 'same-origin'
  }

  // Headers can be forged by any program, so the connection itself must come
  // from this computer. (The desktop server only listens on 127.0.0.1 anyway;
  // `npm run dev` listens on the LAN, where this is what keeps others out.)
  function fromThisMachine(req) {
    const a = String(req.socket?.remoteAddress || '')
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local')
    const p = url.pathname
    const method = req.method
    if (!fromThisMachine(req)) return sendJson(res, 403, { ok: false, code: 'forbidden', error: 'The local data store only answers this computer.' })
    try {
      // Top-level navigations (the Google page) carry Sec-Fetch-Site: none.
      if (method === 'GET' && p === '/local/auth/google/page') {
        const clientId = await googleClientId()
        const nonce = url.searchParams.get('nonce') || ''
        prune()
        const live = /^[a-f0-9]{32}$/.test(nonce) && pendingGoogle.get(nonce)?.status === 'pending'
        res.writeHead(clientId && live ? 200 : 410, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          // Google's button checks the page origin, which it reads from the referrer.
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Content-Security-Policy': [
            "default-src 'none'",
            "script-src 'self' https://accounts.google.com/gsi/client",
            "frame-src https://accounts.google.com/gsi/",
            "connect-src 'self' https://accounts.google.com/gsi/",
            "style-src 'unsafe-inline' https://accounts.google.com/gsi/style",
            'img-src https: data:',
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; '),
        })
        return res.end(clientId && live
          ? googlePage(clientId, nonce)
          : '<!doctype html><meta charset="utf-8"><title>VARUNA AI</title><p style="font-family:system-ui;padding:2em">This sign-in link has expired. Go back to VARUNA and press “Continue with Google” again.</p>')
      }
      if (method === 'GET' && p === '/local/auth/google/page.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        return res.end(GOOGLE_PAGE_JS)
      }
      // The Windows Hello page (fingerprintOptions explains why it is separate).
      if (method === 'GET' && p === '/local/auth/fingerprint/page') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        return res.end(FP_PAGE)
      }
      if (method === 'GET' && p === '/local/auth/fingerprint/page.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        return res.end(FP_PAGE_JS)
      }
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, code: 'forbidden', error: 'Forbidden' })

      if (method === 'GET' && p === '/local/status') return sendJson(res, 200, { ok: true, ...(await status()) })
      if (method === 'GET' && p === '/local/catalog') return sendJson(res, 200, { ok: true, ...(await catalog()) })
      if (method === 'GET' && p.startsWith('/local/export/')) {
        const name = p.slice('/local/export/'.length).replace(/\.csv$/, '')
        if (!SCHEMAS[name] || name === 'users') return sendJson(res, 404, { ok: false, error: 'No such table' })
        const table = await withFile(name, () => load(name))
        const body = serialize(table.header, table.rows)
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}.csv"`,
          'Cache-Control': 'no-store',
        })
        return res.end(body)
      }
      // Drone crops of plastic finds (the boat matches its camera against them).
      if (method === 'POST' && p === '/local/drone-image') {
        const body = await readBody(req)
        const id = String(body.id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''))
        const bytes = m ? Buffer.from(m[1], 'base64') : null
        if (!id || !bytes || bytes.length > MAX_DRONE_IMAGE || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
          throw new StoreError('invalid', 'send {id, data: a JPEG data URL} under 300 KB')
        }
        const dir = path.join(dataDir, 'drone_images')
        await fsp.mkdir(dir, { recursive: true })
        const file = `${id}.jpg`
        await fsp.writeFile(path.join(dir, file), bytes)
        return sendJson(res, 200, { ok: true, file, bytes: bytes.length })
      }
      if (method === 'GET' && p.startsWith('/local/drone-image/')) {
        const file = decodeURIComponent(p.slice('/local/drone-image/'.length))
        if (!IMAGE_NAME_RE.test(file)) return sendJson(res, 404, { ok: false, error: 'No such image' })
        try {
          const bytes = await fsp.readFile(path.join(dataDir, 'drone_images', file))
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
          return res.end(bytes)
        } catch {
          return sendJson(res, 404, { ok: false, error: 'No such image' })
        }
      }
      if (method === 'POST' && p === '/local/records') {
        const body = await readBody(req)
        const ops = Array.isArray(body.ops) ? body.ops : []
        if (!ops.length || ops.length > MAX_OPS) throw new StoreError('invalid', `send 1–${MAX_OPS} operations`)
        // Check every op before writing any, so a bad request changes nothing.
        for (const op of ops) {
          if (!SCHEMAS[op?.table]?.page) throw new StoreError('invalid', `the page cannot write ${op?.table}`)
          if (!Array.isArray(op.rows)) throw new StoreError('invalid', 'rows must be a list')
          op.rows.forEach((r) => clean(SCHEMAS[op.table], r))
        }
        const results = []
        for (const op of ops) results.push(await apply(op.table, op.op || 'upsert', op.rows, op.where))
        return sendJson(res, 200, { ok: true, results })
      }
      if (method === 'POST' && p === '/local/auth/register') return sendJson(res, 200, { ok: true, ...(await register(await readBody(req))) })
      if (method === 'POST' && p === '/local/auth/login') return sendJson(res, 200, { ok: true, ...(await login(await readBody(req))) })
      if (method === 'POST' && p === '/local/auth/face') return sendJson(res, 200, { ok: true, ...(await faceComplete(await readBody(req))) })
      if (method === 'POST' && p === '/local/auth/fingerprint/options') return sendJson(res, 200, { ok: true, ...(await fingerprintOptions(req, await readBody(req))) })
      if (method === 'POST' && p === '/local/auth/fingerprint/answer') return sendJson(res, 200, { ok: true, ...(await fingerprintAnswer(await readBody(req))) })
      if (method === 'POST' && p === '/local/auth/fingerprint/cancel') return sendJson(res, 200, { ok: true, ...fingerprintCancel(await readBody(req)) })
      if (method === 'POST' && p === '/local/auth/fingerprint/result') return sendJson(res, 200, { ok: true, ...fingerprintResult(await readBody(req)) })
      if (method === 'POST' && p === '/local/data/unlock') return sendJson(res, 200, { ok: await unlockData(await readBody(req)) })
      if (method === 'GET' && p === '/local/auth/config') {
        const clientId = await googleClientId()
        const fingerprints = Object.keys((await fpCredentials()).credentials).length
        return sendJson(res, 200, { ok: true, google: { configured: !!clientId, clientId, origin: signInOrigin(req) }, fingerprint: { saved: fingerprints, origin: signInOrigin(req) } })
      }
      if (method === 'POST' && p === '/local/auth/config') {
        const clientId = await setGoogleClientId((await readBody(req)).googleClientId)
        return sendJson(res, 200, { ok: true, google: { configured: !!clientId, clientId, origin: signInOrigin(req) } })
      }
      if (method === 'POST' && p === '/local/auth/google/begin') return sendJson(res, 200, { ok: true, ...(await googleBegin(req)) })
      if (method === 'POST' && p === '/local/auth/google/complete') return sendJson(res, 200, { ok: true, profile: await googleComplete(await readBody(req)) })
      if (method === 'GET' && p === '/local/auth/google/result') return sendJson(res, 200, { ok: true, ...googleResult(url.searchParams.get('nonce')) })
      return sendJson(res, 404, { ok: false, code: 'not_found', error: 'Not found' })
    } catch (err) {
      if (err instanceof StoreError) return sendJson(res, err.status, { ok: false, code: err.code, error: err.message })
      log.error('[local-data]', err)
      return sendJson(res, 500, { ok: false, code: 'internal', error: 'Internal error in the local data store' })
    }
  }

  return { handle, dataDir, apply, catalog, status }
}

module.exports = { createLocalData, parseCsv, serialize, SCHEMAS }
