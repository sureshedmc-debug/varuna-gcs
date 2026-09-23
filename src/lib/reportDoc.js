// Assembles the trash-detection report as a Word-compatible document (.doc) and
// downloads it. The file is MHTML (multipart/related, the same "single file web
// page" format Word itself saves): the HTML body plus each chart PNG as its own
// MIME part. Desktop Microsoft Word renders these embedded images reliably
// (unlike base64 data: URIs in plain HTML), and it also opens in Word-for-web,
// Google Docs and LibreOffice.

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtNum(v) {
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

/** Build the analysis dataset from the raw detection list + live-cam stats. */
export function buildTrashDataset(list = [], trashStats = { peak: 0, last: 0, updatedAt: 0 }) {
  const byClass = {}
  const buckets = { '0-50': 0, '50-70': 0, '70-85': 0, '85-100': 0 }
  let confSum = 0
  let confN = 0
  let located = 0
  const detections = []

  for (const d of list) {
    const cls = d.class || 'debris'
    byClass[cls] = (byClass[cls] || 0) + 1
    const rawConf = Number(d.confidence)
    const pct = Number.isNaN(rawConf) ? null : Math.round((rawConf <= 1 ? rawConf * 100 : rawConf))
    if (pct != null) {
      confSum += pct
      confN++
      if (pct < 50) buckets['0-50']++
      else if (pct < 70) buckets['50-70']++
      else if (pct < 85) buckets['70-85']++
      else buckets['85-100']++
    }
    const isLoc = d.located !== false && d.lat != null && d.lng != null
    if (isLoc) located++
    detections.push({
      class: cls,
      confidence: pct,
      lat: isLoc ? Number(d.lat) : null,
      lng: isLoc ? Number(d.lng) : null,
      located: isLoc,
      timestamp: d.timestamp ?? null,
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    liveCamera: {
      peakTrash: trashStats.peak || 0,
      lastTrash: trashStats.last || 0,
      lastSeen: trashStats.updatedAt ? new Date(trashStats.updatedAt).toISOString() : null,
    },
    summary: {
      total: list.length,
      located,
      unlocated: list.length - located,
      avgConfidence: confN ? Math.round(confSum / confN) : null,
      byClass,
      confidenceBuckets: buckets,
    },
    detections: detections.slice(0, 300),
  }
}

function bullets(arr) {
  if (!Array.isArray(arr) || !arr.length) return ''
  return `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
}

function section(title, body) {
  if (!body) return ''
  return `<h2>${esc(title)}</h2><p>${esc(body).replace(/\n+/g, '</p><p>')}</p>`
}

function metricsTable(data) {
  const s = data.summary
  const rows = [
    ['Total detections', s.total],
    ['Located (with GPS)', s.located],
    ['Unlocated', s.unlocated],
    ['Average confidence', s.avgConfidence != null ? s.avgConfidence + '%' : '—'],
    ['Live-camera peak trash', data.liveCamera.peakTrash],
    ['Live-camera last reading', data.liveCamera.lastTrash],
  ]
  return `<table class="tbl"><tr><th>Metric</th><th>Value</th></tr>${rows
    .map((r) => `<tr><td>${esc(r[0])}</td><td class="num">${fmtNum(r[1])}</td></tr>`)
    .join('')}</table>`
}

function byClassTable(data) {
  const bc = data.summary.byClass || {}
  const entries = Object.entries(bc)
  if (!entries.length) return ''
  return `<h2>Breakdown by Type</h2><table class="tbl"><tr><th>Type</th><th>Count</th></tr>${entries
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${fmtNum(v)}</td></tr>`)
    .join('')}</table>`
}

function detectionTable(data) {
  const rows = data.detections || []
  if (!rows.length) return ''
  const body = rows
    .map((d, i) => {
      const loc = d.located ? `${d.lat?.toFixed?.(5) ?? d.lat}, ${d.lng?.toFixed?.(5) ?? d.lng}` : 'Unlocated'
      return `<tr><td class="num">${i + 1}</td><td>${esc(d.class)}</td><td class="num">${
        d.confidence != null ? d.confidence + '%' : '—'
      }</td><td>${esc(loc)}</td><td>${fmtTime(d.timestamp)}</td></tr>`
    })
    .join('')
  return `<h2>Detection Log (${rows.length})</h2><table class="tbl"><tr><th>#</th><th>Type</th><th>Confidence</th><th>Location</th><th>Time</th></tr>${body}</table>`
}

function chartsBlock(charts) {
  if (!charts || !charts.length) return ''
  return (
    `<h2>Visual Analysis</h2>` +
    charts
      .map(
        (c) =>
          `<p class="chart"><img src="${c.name}" style="width:640px;height:auto;" alt="${esc(
            c.title,
          )}"/></p><p class="cap">${esc(c.title)}</p>`,
      )
      .join('')
  )
}

function buildHtml({ data, narrative, charts }) {
  const n = narrative || {}
  const title = n.title || 'River Trash Detection Report'
  const generated = new Date(data.generatedAt || Date.now()).toLocaleString()

  const styles = `
    <style>
      @page { size: A4; margin: 1in; }
      body { font-family: 'Calibri', Arial, sans-serif; color: #1a1a1a; font-size: 11pt; line-height: 1.5; }
      h1 { font-size: 26pt; color: #0b3d2e; margin: 0 0 4pt 0; }
      h2 { font-size: 15pt; color: #0e5a3f; border-bottom: 1.5pt solid #16A34A; padding-bottom: 3pt; margin-top: 20pt; }
      .sub { color: #555; font-size: 11pt; margin: 0 0 2pt 0; }
      .brand { color: #16A34A; font-weight: bold; letter-spacing: 2pt; font-size: 12pt; }
      .tbl { border-collapse: collapse; width: 100%; margin: 8pt 0 4pt 0; }
      .tbl th { background: #0e5a3f; color: #fff; text-align: left; padding: 6pt 8pt; font-size: 10pt; }
      .tbl td { border: 0.5pt solid #cbd5e1; padding: 5pt 8pt; font-size: 10pt; }
      .tbl td.num { text-align: right; font-family: 'Consolas', monospace; }
      .chart { text-align: center; margin: 12pt 0 2pt 0; }
      .cap { text-align: center; color: #555; font-size: 9pt; font-style: italic; margin: 0 0 10pt 0; }
      ul { margin: 4pt 0 8pt 18pt; }
      li { margin: 2pt 0; }
      .cover { border-left: 6pt solid #16A34A; padding: 8pt 0 8pt 14pt; margin-bottom: 12pt; }
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

  const body = `<body>
    ${cover}
    ${section('Executive Summary', n.executiveSummary)}
    <h2>Key Metrics</h2>
    ${metricsTable(data)}
    ${n.keyFindings ? `<h2>Key Findings</h2>${bullets(n.keyFindings)}` : ''}
    ${chartsBlock(charts)}
    ${byClassTable(data)}
    ${section('Detection Type Analysis', n.classAnalysis)}
    ${section('Spatial Analysis', n.spatialAnalysis)}
    ${section('Temporal Analysis', n.temporalAnalysis)}
    ${section('Environmental Impact', n.environmentalImpact)}
    ${n.recommendations ? `<h2>Recommendations</h2>${bullets(n.recommendations)}` : ''}
    ${section('Data Quality Notes', n.dataQualityNotes)}
    ${detectionTable(data)}
    <p class="cap">Report produced by VARUNA GCS. Analysis generated with Google Gemini.</p>
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
// per chart, referenced by relative Content-Location so Word resolves them.
function buildMhtml({ data, narrative, charts }) {
  const named = (charts || [])
    .filter((c) => c && c.dataUrl)
    .map((c, i) => ({ ...c, name: `image${String(i + 1).padStart(3, '0')}.png` }))

  const html = buildHtml({ data, narrative, charts: named })
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
  for (const c of named) {
    const b64 = (c.dataUrl.split(',')[1] || '').trim()
    if (!b64) continue
    parts.push(`--${boundary}`)
    parts.push(`Content-Type: image/png`)
    parts.push(`Content-Transfer-Encoding: base64`)
    parts.push(`Content-Location: ${c.name}`)
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

/** Deterministic built-in narrative used when Gemini is unavailable. */
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
      `Live-camera peak trash: ${data.liveCamera.peakTrash}`,
    ],
    classAnalysis: classes
      ? `The detected debris breaks down as: ${classes}. Plastic items typically dominate river waste and are a priority for removal.`
      : 'No classified debris types were available in this dataset.',
    spatialAnalysis:
      s.located > 0
        ? `${s.located} detection(s) carried GPS coordinates and can be mapped to cleanup waypoints. ${s.unlocated} lacked a fix and should be re-surveyed.`
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
        : 'AI narrative was generated locally (Gemini was not used for this run).',
  }
}
