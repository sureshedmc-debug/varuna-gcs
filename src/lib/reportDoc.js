// Assembles the trash-detection report as a Word-compatible document (.doc) and
// downloads it. The file is MHTML (multipart/related, the same "single file web
// page" format Word itself saves): the HTML body plus each image as its own
// MIME part. Desktop Microsoft Word renders these embedded images (unlike
// base64 data: URIs in plain HTML) as long as they use absolute locations —
// see ASSET_BASE — and it also opens in Word-for-web, Google Docs and LibreOffice.

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtNum(v) {
  if (typeof v === 'string' && v !== '') return esc(v) // pre-formatted, e.g. "63%"
  return v == null || v === '' || Number.isNaN(Number(v)) ? '—' : String(v)
}

function fmtTime(ts) {
  if (ts == null) return '—'
  const n = Number(ts)
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(ts)
  if (!Number.isFinite(ms)) return esc(String(ts))
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return esc(String(ts))
  }
}

const ORIGIN_LABEL = { pi: 'Pi onboard AI', webcam: 'Webcam (live AI)', stream: 'Drone feed (live AI)' }
const POS_LABEL = { drone: 'Drone GPS', laptop: 'Laptop GPS', sim: 'Simulated drone' }

function mapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`
}
function metersBetween(a, b) {
  const R = 6371000
  const r = (d) => (d * Math.PI) / 180
  const s = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * Build the analysis dataset from the detection rows + live-cam stats. Rows
 * may be raw backend records ({class, confidence, lat, lng, located,
 * timestamp}) or the Detections tab's merged rows, which add count, origin,
 * alt, posSource, time and lastSeen (geotagged live-AI sightings).
 */
import { DEFAULT_AVG_WEIGHT_G, DEFAULT_FOV_DEG, estimateWeightG, getFovSettings } from './sizeEstimate'

export function buildTrashDataset(list = [], trashStats = { peak: 0, last: 0, updatedAt: 0 }) {
  const fov = getFovSettings()
  const avgW = fov.avgWeightG || DEFAULT_AVG_WEIGHT_G
  const byClass = {}
  const byOrigin = {}
  const buckets = { '0-50': 0, '50-70': 0, '70-85': 0, '85-100': 0 }
  let confSum = 0
  let confN = 0
  let located = 0
  let totalItems = 0
  const detections = []
  const pts = []

  for (const d of list) {
    const cls = d.class || 'debris'
    const count = Math.max(1, Number(d.count) || 1)
    totalItems += count
    byClass[cls] = (byClass[cls] || 0) + count
    const originLabel = ORIGIN_LABEL[d.origin || 'pi'] || d.origin
    byOrigin[originLabel] = (byOrigin[originLabel] || 0) + 1
    const rawConf = Number(d.confidence)
    const pct = d.confidence == null || Number.isNaN(rawConf) ? null : Math.round(rawConf <= 1 ? rawConf * 100 : rawConf)
    if (pct != null) {
      confSum += pct
      confN++
      if (pct < 50) buckets['0-50']++
      else if (pct < 70) buckets['50-70']++
      else if (pct < 85) buckets['70-85']++
      else buckets['85-100']++
    }
    const lat = Number(d.lat)
    const lng = Number(d.lng)
    const isLoc = d.located !== false && d.lat != null && d.lng != null && Number.isFinite(lat) && Number.isFinite(lng)
    if (isLoc) {
      located++
      pts.push([lat, lng])
    }
    const alt = Number(d.alt)
    const wG = estimateWeightG(cls, count, avgW)
    detections.push({
      class: cls,
      count,
      confidence: pct,
      lat: isLoc ? lat : null,
      lng: isLoc ? lng : null,
      alt: d.alt != null && Number.isFinite(alt) ? Math.round(alt * 10) / 10 : null,
      located: isLoc,
      mapUrl: isLoc ? mapsUrl(lat, lng) : null,
      origin: originLabel,
      positionSource: isLoc ? (POS_LABEL[d.posSource] || 'GPS') + (Number(d.accuracy) > 0 ? ` (±${Math.round(d.accuracy)} m)` : '') : null,
      timestamp: d.time ?? d.timestamp ?? null,
      lastSeen: d.lastSeen ?? null,
      photo: d.photo || null, // captured frame at the moment of detection (data URL), if any
      estWidthM: Number.isFinite(Number(d.estWidthM)) ? Number(d.estWidthM) : null,
      estHeightM: Number.isFinite(Number(d.estHeightM)) ? Number(d.estHeightM) : null,
      estWeightG: wG,
    })
  }

  // Survey area: centre of all trash locations, bounding corners, and diagonal span.
  let area = null
  if (pts.length) {
    const c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
    const lats = pts.map((p) => p[0])
    const lngs = pts.map((p) => p[1])
    const sw = [Math.min(...lats), Math.min(...lngs)]
    const ne = [Math.max(...lats), Math.max(...lngs)]
    area = {
      centre: { lat: +c[0].toFixed(6), lng: +c[1].toFixed(6), mapUrl: mapsUrl(c[0], c[1]) },
      southWest: { lat: +sw[0].toFixed(6), lng: +sw[1].toFixed(6) },
      northEast: { lat: +ne[0].toFixed(6), lng: +ne[1].toFixed(6) },
      spanMeters: Math.round(metersBetween(sw, ne)),
    }
  }

  const totalEstWeightG = detections.reduce((a, d) => a + (Number(d.estWeightG) || 0), 0)
  return {
    generatedAt: new Date().toISOString(),
    liveCamera: {
      peakTrash: trashStats.peak || 0,
      lastTrash: trashStats.last || 0,
      lastSeen: trashStats.updatedAt ? new Date(trashStats.updatedAt).toISOString() : null,
    },
    summary: {
      total: list.length,
      totalItems,
      located,
      unlocated: list.length - located,
      avgConfidence: confN ? Math.round(confSum / confN) : null,
      byClass,
      byOrigin,
      confidenceBuckets: buckets,
      totalEstWeightG,
      fovAssumption: `${Math.round(fov.fovHorizontalDeg || DEFAULT_FOV_DEG.horizontal)}° × ${Math.round(fov.fovVerticalDeg || DEFAULT_FOV_DEG.vertical)}°`,
    },
    area,
    detections: detections.slice(0, 2000),
  }
}

// Alternating row background for tables — computed inline per row rather than
// via a CSS nth-child selector, since Word's HTML renderer (mshtml) has patchy
// CSS3 selector support but always honours an inline style attribute.
function zebra(i) {
  return i % 2 ? ' style="background:#f5f8fa"' : ''
}

// 'check' = affirmative findings (green), 'action' = things to do (amber).
function bullets(arr, variant = 'check') {
  if (!Array.isArray(arr) || !arr.length) return ''
  const cls = variant === 'action' ? 'action' : 'check'
  return `<ul class="${cls}">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
}

function section(title, body) {
  if (!body) return ''
  return `<h2>${esc(title)}</h2><p>${esc(body).replace(/\n+/g, '</p><p>')}</p>`
}

// Big headline numbers as a single-row table of coloured cards — the first
// thing a reader's eye should land on, before the fine-grained metrics table.
function kpiCards(data) {
  const s = data.summary
  const weight = s.totalEstWeightG >= 1000 ? `${(s.totalEstWeightG / 1000).toFixed(1)} kg` : `${s.totalEstWeightG || 0} g`
  const cards = [
    ['Detections', fmtNum(s.total), '#0e5a3f'],
    ['Located (GPS)', fmtNum(s.located), '#0b6e99'],
    ['Avg. Confidence', s.avgConfidence != null ? `${s.avgConfidence}%` : '—', '#9a5b00'],
    ['Est. Weight Removed', weight, '#7c2d92'],
  ]
  return `<table class="kpi"><tr>${cards
    .map(
      (c) =>
        `<td style="border-top:3pt solid ${c[2]}"><div class="kpi-num" style="color:${c[2]}">${esc(c[1])}</div><div class="kpi-lbl">${esc(c[0])}</div></td>`,
    )
    .join('')}</tr></table>`
}

function metricsTable(data) {
  const s = data.summary
  const rows = [
    ['Trash locations / detections', s.total],
    ['Trash items seen (max per location)', s.totalItems ?? s.total],
    ['Located (with GPS)', s.located],
    ['Unlocated', s.unlocated],
    ['Average confidence', s.avgConfidence != null ? s.avgConfidence + '%' : '—'],
    ['Live-camera peak trash', data.liveCamera.peakTrash],
    ['Live-camera last reading', data.liveCamera.lastTrash],
    ['Estimated total weight (rough)', s.totalEstWeightG >= 1000 ? `~${(s.totalEstWeightG / 1000).toFixed(1)} kg` : `~${s.totalEstWeightG || 0} g`],
    ['Camera FOV assumption', s.fovAssumption || '—'],
    ...(data.boat?.catch?.total ? [['Items collected by the boat (counted)', data.boat.catch.total]] : []),
    ...(data.boat?.water?.avgNtu != null ? [['Average water turbidity', `${data.boat.water.avgNtu} NTU`]] : []),
  ]
  return `<table class="tbl"><tr><th>Metric</th><th>Value</th></tr>${rows
    .map((r, i) => `<tr${zebra(i)}><td>${esc(r[0])}</td><td class="num">${fmtNum(r[1])}</td></tr>`)
    .join('')}</table>`
}

function byClassTable(data) {
  const bc = data.summary.byClass || {}
  const entries = Object.entries(bc)
  if (!entries.length) return ''
  return `<h2>Breakdown by Type</h2><table class="tbl"><tr><th>Type</th><th>Count</th></tr>${entries
    .map(([k, v], i) => `<tr${zebra(i)}><td>${esc(k)}</td><td class="num">${fmtNum(v)}</td></tr>`)
    .join('')}</table>`
}

// The boat's own records: items its ramp camera counted one by one, water
// turbidity readings, wildlife pauses (data.boat, see boatReport.js).
function boatBlock(data) {
  const b = data.boat
  if (!b) return ''
  const parts = []
  if (b.catch && b.catch.total > 0) {
    const rows = Object.entries(b.catch.byLabel).sort((x, y) => y[1] - x[1])
      .map(([k, v], i) => `<tr${zebra(i)}><td>${esc(k)}</td><td class="num">${fmtNum(v)}</td></tr>`).join('')
    const kg = b.catch.estWeightG >= 1000 ? `~${(b.catch.estWeightG / 1000).toFixed(1)} kg` : `~${b.catch.estWeightG} g`
    parts.push(`<h2>Collected by the Boat (counted)</h2>
      <p>The boat&rsquo;s ramp camera counted <b>${fmtNum(b.catch.total)}</b> item${b.catch.total === 1 ? '' : 's'} as they came on board (${fmtNum(b.catch.today)} today), about <b>${esc(kg)}</b> by the average weight per type. These are items actually removed from the water, counted one by one.</p>
      <table class="tbl"><tr><th>Type</th><th>Items collected</th></tr>${rows}</table>`)
  }
  const w = b.water
  if (w && (w.readings.length || w.now)) {
    const rows = w.readings.slice(0, 40).map((r, i) => `<tr${zebra(i)}><td>${fmtTime(r.t)}</td><td class="num">${fmtNum(r.ntu)}</td><td>${esc(r.quality || '')}</td><td>${
      Number.isFinite(Number(r.lat)) ? `<a href="${esc(mapsUrl(r.lat, r.lng))}">${Number(r.lat).toFixed(5)}, ${Number(r.lng).toFixed(5)}</a>` : '—'
    }</td></tr>`).join('')
    parts.push(`<h2>Water Quality (Turbidity)</h2>
      <p>${w.readings.length ? `${w.readings.length} reading${w.readings.length === 1 ? '' : 's'} taken by the boat: average <b>${fmtNum(w.avgNtu)} NTU</b> (lowest ${fmtNum(w.minNtu)}, highest ${fmtNum(w.maxNtu)}). ` : ''}${
      w.now ? `Latest live value: ${fmtNum(w.now.ntu)} NTU (${esc(w.now.quality || '')}). ` : ''
    }Lower NTU is clearer water: under 10 looks clear, 10&ndash;50 slightly cloudy, 50&ndash;150 cloudy, over 150 murky.${w.calibrated ? '' : ' <i>The sensor was not calibrated in clear water, so values follow the sensor maker&rsquo;s curve and are approximate.</i>'}</p>
      ${rows ? `<table class="tbl"><tr><th>Time</th><th>NTU</th><th>Clarity</th><th>Location</th></tr>${rows}</table>` : ''}`)
  }
  const wl = b.wildlife
  if (wl && wl.sightings.length) {
    const counts = {}
    for (const s of wl.sightings) counts[s.label] = (counts[s.label] || 0) + 1
    parts.push(`<h2>Wildlife Encounters</h2>
      <p>The boat stopped for animals or people in its path ${fmtNum(wl.sightings.length)} time${wl.sightings.length === 1 ? '' : 's'} in the records (${Object.entries(counts).map(([k, v]) => `${v} &times; ${esc(k)}`).join(', ')}). Today it paused ${fmtNum(wl.pausesToday)} time${wl.pausesToday === 1 ? '' : 's'}, ${fmtNum(wl.waitedSToday)} s in total. Each time it held position until the way was clear, or until the operator chose to move on.</p>`)
  }
  return parts.join('')
}

function byOriginTable(data) {
  const entries = Object.entries(data.summary.byOrigin || {})
  if (!entries.length) return ''
  return `<h2>Detection Sources</h2><table class="tbl"><tr><th>Source</th><th>Records</th></tr>${entries
    .map(([k, v], i) => `<tr${zebra(i)}><td>${esc(k)}</td><td class="num">${fmtNum(v)}</td></tr>`)
    .join('')}</table>`
}

function areaBlock(data) {
  const a = data.area
  if (!a) return ''
  const rows = [
    ['Centre of trash locations', `${a.centre.lat}, ${a.centre.lng}`, a.centre.mapUrl],
    ['South-west corner', `${a.southWest.lat}, ${a.southWest.lng}`, mapsUrl(a.southWest.lat, a.southWest.lng)],
    ['North-east corner', `${a.northEast.lat}, ${a.northEast.lng}`, mapsUrl(a.northEast.lat, a.northEast.lng)],
    ['Area span (diagonal)', `${a.spanMeters} m`, null],
  ]
  return `<h2>Survey Area</h2><table class="tbl"><tr><th>Item</th><th>Coordinates</th><th>Map</th></tr>${rows
    .map(
      (r, i) =>
        `<tr${zebra(i)}><td>${esc(r[0])}</td><td class="num">${esc(r[1])}</td><td>${
          r[2] ? `<a href="${esc(r[2])}">Open in Google Maps</a>` : '—'
        }</td></tr>`,
    )
    .join('')}</table>`
}

// Every trash location: photo, coordinates, altitude, source, time and a clickable map link.
function locationTable(data) {
  const rows = (data.detections || []).filter((d) => d.located)
  if (!rows.length) return ''
  const hasPhotos = rows.some((d) => d.photoName)
  const body = rows
    .map(
      (d, i) =>
        `<tr${zebra(i)}>${hasPhotos ? `<td>${d.photoName ? imgTag(d.photoName, 120, 'trash photo') : '—'}</td>` : ''}<td class="num">${i + 1}</td><td>${esc(d.class)}</td><td class="num">${fmtNum(d.count)}</td><td class="num">${
          d.confidence != null ? d.confidence + '%' : '—'
        }</td><td class="num">${d.lat.toFixed(6)}</td><td class="num">${d.lng.toFixed(6)}</td><td class="num">${
          d.alt != null ? d.alt + ' m' : '—'
        }</td><td>${esc(d.origin)}<br/><span class="small">${esc(d.positionSource || '')}</span></td><td>${fmtTime(
          d.timestamp,
        )}</td><td><a href="${esc(d.mapUrl)}">Open map</a></td></tr>`,
    )
    .join('')
  return `<h2>Trash Locations (${rows.length})</h2>
    <p class="small">Each location is where the camera was when the AI detected trash: the drone&rsquo;s live GPS (WebSocket link) for Drone-feed detections, or the laptop&rsquo;s location for Webcam detections (&plusmn; shows its accuracy). Nearby sightings of the same spot are merged; "Items" is the most pieces seen there at once${
      hasPhotos ? ', and the photo is the frame the AI actually detected it in' : ''
    }.</p>
    <table class="tbl"><tr>${hasPhotos ? '<th>Photo</th>' : ''}<th>#</th><th>Type</th><th>Items</th><th>Conf.</th><th>Latitude</th><th>Longitude</th><th>Alt.</th><th>Source</th><th>Time</th><th>Link</th></tr>${body}</table>
    <h2>Location Links</h2>
    <p class="small">Full links for copying into a browser or GPS app.</p>
    ${rows
      .map((d, i) => `<p class="link">${i + 1}. ${d.lat.toFixed(6)}, ${d.lng.toFixed(6)} &mdash; <a href="${esc(d.mapUrl)}">${esc(d.mapUrl)}</a></p>`)
      .join('')}`
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Final section: the recorded mission video clips. Word/MHTML can't embed a
// playable video (no OLE, no <video> support in Word), so each clip is
// downloaded as its own file alongside the report; this lists them and
// embeds a still frame for reference.
function videoBlock(data) {
  const v = data.video
  if (!v?.clips?.length) return ''
  const total = v.clips.reduce((a, c) => a + c.durationMs, 0)
  const one = v.clips.length === 1
  return `<h2>Mission Video</h2>
    <p>The AI-view video of this mission (${fmtDuration(total)} in total) was recorded every time detection ran and saved alongside this report as ${
      one ? 'a separate file' : `${v.clips.length} separate files, one per detection run`
    }. Word documents cannot hold a playable video, so click a file name below to play it &mdash; keep the video file${one ? '' : 's'} in the same folder as this report (both download to your Downloads folder) &mdash; or open ${one ? 'it' : 'them'} in a browser or a media player such as VLC.</p>
    <table class="tbl"><tr><th>#</th><th>File</th><th>Started</th><th>Length</th><th>Size</th></tr>${v.clips
      .map(
        (c, i) =>
          `<tr><td class="num">${i + 1}</td><td><a href="${esc(c.filename)}">${esc(c.filename)}</a></td><td>${fmtTime(c.startedAt)}</td><td class="num">${fmtDuration(
            c.durationMs,
          )}</td><td class="num">${fmtBytes(c.sizeBytes)}</td></tr>`,
      )
      .join('')}</table>
    ${
      v.posterName
        ? `<p class="chart">${imgTag(v.posterName, 480, 'Mission video preview')}</p><p class="cap">A frame from the mission video</p>`
        : ''
    }`
}

function unlocatedTable(data) {
  const rows = (data.detections || []).filter((d) => !d.located)
  if (!rows.length) return ''
  const hasPhotos = rows.some((d) => d.photoName)
  return `<h2>Unlocated Detections (${rows.length})</h2><p class="small">No GPS fix at the moment of detection &mdash; re-survey these.</p><table class="tbl"><tr>${
    hasPhotos ? '<th>Photo</th>' : ''
  }<th>#</th><th>Type</th><th>Items</th><th>Conf.</th><th>Source</th><th>Time</th></tr>${rows
    .map(
      (d, i) =>
        `<tr${zebra(i)}>${
          hasPhotos ? `<td>${d.photoName ? imgTag(d.photoName, 120, 'trash photo') : '—'}</td>` : ''
        }<td class="num">${i + 1}</td><td>${esc(d.class)}</td><td class="num">${fmtNum(d.count)}</td><td class="num">${
          d.confidence != null ? d.confidence + '%' : '—'
        }</td><td>${esc(d.origin)}</td><td>${fmtTime(d.timestamp)}</td></tr>`,
    )
    .join('')}</table>`
}

function chartsBlock(charts) {
  if (!charts || !charts.length) return ''
  return (
    `<h2>Visual Analysis</h2>` +
    charts
      .map(
        (c) =>
          `<p class="chart">${imgTag(c.name, 620, c.title)}</p><p class="cap">${esc(c.title)}</p>`,
      )
      .join('')
  )
}

// Every embedded image is referenced by the SAME absolute URL in its <img src>
// and in its MIME part's Content-Location. Desktop Word only matches the two
// when they're absolute: with bare relative names it treats each picture as a
// link to a file on disk (C:\varuna\image001.png) and shows a broken image.
const ASSET_BASE = 'file:///C:/varuna/'
let IMG_DIMS = {} // name -> [w, h] in px, filled by buildMhtml before rendering

// Word ignores CSS sizes on MHTML images and keeps each picture's natural size
// unless BOTH width and height attributes are set, so scale to fit here.
function imgTag(name, maxW, alt) {
  const [w0, h0] = IMG_DIMS[name] || [maxW, Math.round(maxW * 0.6)]
  const w = Math.min(maxW, w0)
  const h = Math.max(1, Math.round((h0 * w) / w0))
  return `<img src="${ASSET_BASE}${name}" width="${w}" height="${h}" alt="${esc(alt || '')}"/>`
}

// Pixel size of a PNG/JPEG data URL, read straight from its header bytes.
function imageSize(dataUrl) {
  try {
    const bin = atob((dataUrl.split(',')[1] || '').trim())
    const at = (i) => bin.charCodeAt(i)
    if (at(0) === 0x89 && at(1) === 0x50) {
      // PNG: IHDR width/height are big-endian at bytes 16..23
      const u32 = (i) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0
      return [u32(16), u32(20)]
    }
    if (at(0) === 0xff && at(1) === 0xd8) {
      // JPEG: walk the markers to the first start-of-frame
      let i = 2
      while (i + 9 < bin.length) {
        if (at(i) !== 0xff) { i++; continue }
        const m = at(i + 1)
        if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
          return [(at(i + 7) << 8) | at(i + 8), (at(i + 5) << 8) | at(i + 6)]
        }
        i += 2 + ((at(i + 2) << 8) | at(i + 3))
      }
    }
  } catch {
    /* fall through */
  }
  return null
}

function buildHtml({ data, narrative, charts }) {
  const n = narrative || {}
  const title = n.title || 'River Trash Detection Report'
  const generated = new Date(data.generatedAt || Date.now()).toLocaleString()

  const styles = `
    <style>
      @page { size: A4; margin: 1in; }
      body { font-family: 'Calibri', Arial, sans-serif; color: #1e2430; font-size: 11pt; line-height: 1.55; }
      h1 { font-size: 28pt; color: #0b3d2e; margin: 0 0 4pt 0; letter-spacing: -0.3pt; }
      h2 { font-size: 14pt; color: #0e5a3f; background: #eaf7ef; border-left: 4pt solid #16A34A; padding: 5pt 10pt; margin: 22pt 0 8pt 0; }
      .sub { color: #5b6472; font-size: 11pt; margin: 0 0 2pt 0; }
      .brand { color: #16A34A; font-weight: bold; letter-spacing: 2.5pt; font-size: 11pt; }
      .tbl { border-collapse: collapse; width: 100%; margin: 8pt 0 4pt 0; }
      .tbl th { background: #0e5a3f; color: #fff; text-align: left; padding: 7pt 9pt; font-size: 9.5pt; letter-spacing: 0.3pt; }
      .tbl td { border: 0.5pt solid #dbe3ea; padding: 6pt 9pt; font-size: 10pt; }
      .tbl td.num { text-align: right; font-family: 'Consolas', monospace; }
      .chart { text-align: center; margin: 12pt 0 2pt 0; }
      .cap { text-align: center; color: #5b6472; font-size: 9pt; font-style: italic; margin: 0 0 10pt 0; }
      ul { margin: 4pt 0 8pt 4pt; padding: 0; }
      ul.check, ul.action { list-style: none; margin: 8pt 0; }
      ul.check li, ul.action li { padding: 4pt 0 4pt 20pt; position: relative; font-size: 10.5pt; }
      ul.check li:before { content: "\\2713"; position: absolute; left: 0; color: #16A34A; font-weight: bold; }
      ul.action li:before { content: "\\25B8"; position: absolute; left: 2pt; color: #C2760C; font-weight: bold; }
      .callout { background: #f6fbf8; border-left: 4pt solid #16A34A; border-radius: 3pt; padding: 10pt 14pt; margin: 8pt 0 14pt 0; }
      .callout p { margin: 0; }
      .callout.warn { background: #fff9ec; border-left-color: #C2760C; }
      .cover { border-bottom: 2pt solid #16A34A; padding: 0 0 14pt 0; margin-bottom: 16pt; }
      .small { color: #5b6472; font-size: 9pt; }
      .link { font-size: 9pt; margin: 1pt 0; font-family: 'Consolas', monospace; }
      a { color: #0b57d0; }
      .kpi { border-collapse: separate; border-spacing: 8pt 0; width: 100%; margin: 6pt 0 18pt 0; }
      .kpi td { background: #f7f9fb; text-align: center; padding: 12pt 6pt; width: 25%; }
      .kpi-num { font-size: 22pt; font-weight: 800; font-family: 'Consolas', monospace; }
      .kpi-lbl { font-size: 8.5pt; color: #5b6472; text-transform: uppercase; letter-spacing: 0.5pt; margin-top: 2pt; }
      hr.div { border: none; border-top: 0.75pt solid #dbe3ea; margin: 18pt 0; }
    </style>`

  // MSO word document header
  const head = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(
    title,
  )}</title>${styles}</head>`

  const cover = `
    <div class="cover">
      <div class="brand">VARUNA &middot; AUTONOMOUS RIVER CLEANUP</div>
      <h1>${esc(title)}</h1>
      <p class="sub">AI trash-detection analysis report</p>
      <p class="sub">Generated: ${esc(generated)}</p>
    </div>`

  const exec = n.executiveSummary ? `<h2>Executive Summary</h2><div class="callout"><p>${esc(n.executiveSummary).replace(/\n+/g, '</p><p>')}</p></div>` : ''

  const body = `<body>
    ${cover}
    ${kpiCards(data)}
    ${exec}
    <h2>Key Metrics</h2>
    ${metricsTable(data)}
    ${n.keyFindings ? `<h2>Key Findings</h2>${bullets(n.keyFindings, 'check')}` : ''}
    ${chartsBlock(charts)}
    ${byClassTable(data)}
    ${byOriginTable(data)}
    ${areaBlock(data)}
    ${boatBlock(data)}
    ${section('Detection Type Analysis', n.classAnalysis)}
    ${section('Spatial Analysis', n.spatialAnalysis)}
    ${section('Temporal Analysis', n.temporalAnalysis)}
    ${section('Environmental Impact', n.environmentalImpact)}
    ${n.recommendations ? `<h2>Recommendations</h2><div class="callout warn">${bullets(n.recommendations, 'action')}</div>` : ''}
    ${section('Data Quality Notes', n.dataQualityNotes)}
    <hr class="div" />
    ${locationTable(data)}
    ${unlocatedTable(data)}
    ${videoBlock(data)}
    <p class="cap">Report produced by VARUNA GCS${n.aiWritten ? '. Analysis written by AI (Groq).' : '.'}</p>
  </body></html>`

  return head + body
}

function stamp() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

// Wrap base64 at 76 chars per RFC 2045 for maximum reader compatibility.
function wrap76(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n')
}

const HTML_LOCATION = 'file:///C:/varuna/report.html'

// Assemble the MHTML (multipart/related) document: HTML body + one image part
// per chart/photo/poster (see ASSET_BASE for how Word matches them up).
function buildMhtml({ data, narrative, charts }) {
  const namedCharts = (charts || [])
    .filter((c) => c && c.dataUrl)
    .map((c, i) => ({ ...c, name: `image${String(i + 1).padStart(3, '0')}.png`, mime: 'image/png' }))

  // Trash photos: name each one and embed it as its own JPEG part.
  const imageParts = [...namedCharts]
  let photoSeq = 0
  const detections = (data.detections || []).map((d) => {
    if (!d.photo) return d
    photoSeq++
    const name = `photo${String(photoSeq).padStart(3, '0')}.jpg`
    imageParts.push({ name, dataUrl: d.photo, mime: 'image/jpeg' })
    return { ...d, photoName: name }
  })

  // Mission-video poster frame, if the caller captured one.
  let video = data.video || null
  if (video?.posterDataUrl) {
    const name = 'video-poster.jpg'
    imageParts.push({ name, dataUrl: video.posterDataUrl, mime: 'image/jpeg' })
    video = { ...video, posterName: name }
  }

  IMG_DIMS = {}
  for (const c of imageParts) {
    const d = imageSize(c.dataUrl)
    if (d && d[0] > 0 && d[1] > 0) IMG_DIMS[c.name] = d
  }
  const html = buildHtml({ data: { ...data, detections, video }, narrative, charts: namedCharts })
  const boundary = '----=_NextPart_VARUNA_Report_Boundary'

  const parts = []
  parts.push(`MIME-Version: 1.0`)
  parts.push(`Content-Type: multipart/related; boundary="${boundary}"; type="text/html"`)
  parts.push('')
  parts.push(`--${boundary}`)
  parts.push(`Content-Type: text/html; charset="utf-8"`)
  parts.push(`Content-Transfer-Encoding: 8bit`)
  parts.push(`Content-Location: ${HTML_LOCATION}`)
  parts.push('')
  parts.push(html)
  for (const c of imageParts) {
    const b64 = (c.dataUrl.split(',')[1] || '').trim()
    if (!b64) continue
    parts.push(`--${boundary}`)
    parts.push(`Content-Type: ${c.mime || 'image/png'}`)
    parts.push(`Content-Transfer-Encoding: base64`)
    parts.push(`Content-Location: ${ASSET_BASE}${c.name}`)
    parts.push('')
    parts.push(wrap76(b64))
  }
  parts.push(`--${boundary}--`)
  return parts.join('\r\n')
}

/** Build the .doc (MHTML) and trigger a download. Returns the filename used. */
export function downloadWordReport({ data, narrative, charts }) {
  const mhtml = buildMhtml({ data, narrative, charts })
  // No BOM: an MHTML file must begin with its MIME headers.
  const blob = new Blob([mhtml], { type: 'application/msword' })
  const filename = `varuna-trash-report-${stamp()}.doc`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  return filename
}

/** Deterministic built-in narrative used when the Groq AI is unavailable. */
export function fallbackNarrative(data) {
  const s = data.summary
  const classes = Object.entries(s.byClass || {})
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')
  return {
    title: 'River Trash Detection Report',
    executiveSummary:
      `VARUNA logged ${s.total} trash detection(s), of which ${s.located} had a GPS fix and ${s.unlocated} did not. ` +
      `The onboard live camera peaked at ${data.liveCamera.peakTrash} simultaneous trash item(s). ` +
      (s.avgConfidence != null ? `Average detection confidence was ${s.avgConfidence}%. ` : '') +
      `This report summarizes the detected debris and its distribution.`,
    keyFindings: [
      `Total detections: ${s.total}`,
      classes ? `Composition: ${classes}` : 'No per-type breakdown available',
      `Geolocated: ${s.located} / ${s.total}`,
      ...(data.boat?.catch?.total ? [`The boat collected ${data.boat.catch.total} item(s), counted one by one on board`] : []),
      ...(data.boat?.water?.avgNtu != null ? [`Water turbidity averaged ${data.boat.water.avgNtu} NTU over ${data.boat.water.readings.length} reading(s)`] : []),
      ...(data.area ? [`Survey area centre: ${data.area.centre.lat}, ${data.area.centre.lng} (span ~${data.area.spanMeters} m)`] : []),
      `Live-camera peak trash: ${data.liveCamera.peakTrash}`,
    ],
    classAnalysis: classes
      ? `The detected debris breaks down as: ${classes}. Plastic items typically dominate river waste and are a priority for removal.`
      : 'No classified debris types were available in this dataset.',
    spatialAnalysis:
      s.located > 0
        ? `${s.located} trash location(s) carried GPS coordinates and can be used directly as cleanup waypoints` +
          (data.area ? `, spread across about ${data.area.spanMeters} m around ${data.area.centre.lat}, ${data.area.centre.lng}` : '') +
          `. ${s.unlocated} lacked a fix and should be re-surveyed. Every location is listed below with a Google Maps link.`
        : 'No detections carried GPS coordinates, so spatial hotspots could not be mapped in this run.',
    temporalAnalysis: 'Timestamps for each detection are listed in the detection log below.',
    environmentalImpact:
      'Floating plastic and debris degrade water quality, endanger aquatic life through ingestion and entanglement, and accumulate downstream. Prompt removal reduces microplastic breakdown.',
    recommendations: [
      'Prioritize removal at geolocated hotspots with the highest detection density.',
      'Re-survey areas where detections lacked a GPS fix to obtain coordinates.',
      'Schedule repeat patrols to measure cleanup effectiveness over time.',
    ],
    dataQualityNotes:
      s.total === 0
        ? 'No backend detections were available; this report is based on live-camera counts only.'
        : 'This narrative was generated by the app’s built-in template (no AI service was used for this run).',
  }
}
