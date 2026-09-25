// A printable "cleanup certificate" summarising the impact so far. Opened in
// a new tab as plain HTML and triggers the browser's print dialog — the
// operator can Save as PDF from there. Zero new dependencies.

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtHours(sec) {
  const h = sec / 3600
  if (h >= 1) return `${h.toFixed(1)} hours`
  return `${Math.max(1, Math.round(sec / 60))} minutes`
}
function fmtArea(m2) {
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(2)} hectares`
  return `${Math.round(m2)} m²`
}

export function buildCertificateHtml({ stats, operatorName, date } = {}) {
  const s = stats || { itemsFound: 0, areaCoveredM2: 0, flightSeconds: 0, missionsCompleted: 0 }
  const when = date || new Date().toLocaleDateString()
  const who = operatorName || 'Operator'
  return `<!doctype html><html><head><meta charset="utf-8"><title>VARUNA Cleanup Certificate</title><style>
    @page { size: A4 landscape; margin: 1.2cm; }
    body { font-family: 'Georgia', 'Times New Roman', serif; color: #0b3d2e; margin: 0; padding: 0; }
    .frame { border: 8px double #16A34A; padding: 40px 60px; margin: 20px; min-height: calc(100vh - 40px); box-sizing: border-box; }
    .brand { letter-spacing: 3pt; font-weight: bold; color: #16A34A; font-size: 12pt; font-family: 'Inter', Arial, sans-serif; }
    h1 { font-size: 42pt; margin: 6pt 0 2pt 0; letter-spacing: 1pt; }
    .sub { font-size: 14pt; color: #4b5563; margin: 0 0 30pt 0; font-style: italic; }
    .stats { display: flex; justify-content: space-around; margin: 30pt 0; }
    .stat { text-align: center; padding: 10pt 18pt; }
    .stat .num { font-family: 'Inter', sans-serif; font-size: 32pt; font-weight: 800; color: #0e5a3f; }
    .stat .lbl { font-size: 10pt; text-transform: uppercase; letter-spacing: 2pt; color: #4b5563; }
    .body-text { font-size: 12pt; line-height: 1.7; margin: 24pt 0; }
    .sign { display: flex; justify-content: space-between; margin-top: 60pt; font-size: 11pt; }
    .sign > div { text-align: center; width: 40%; }
    .line { border-top: 1pt solid #0b3d2e; margin-bottom: 4pt; padding-top: 40pt; }
    @media print { .noprint { display: none; } }
    .noprint { text-align: center; padding: 14pt; background: #f4f9f6; }
    .noprint button { font: bold 12pt Inter, Arial; background: #16A34A; color: #fff; border: none; padding: 10pt 24pt; border-radius: 8pt; cursor: pointer; }
  </style></head><body>
    <div class="noprint">
      <button onclick="window.print()">Print / save as PDF</button>
      <span style="margin-left:14pt;color:#4b5563;font-family:Inter,sans-serif;font-size:11pt">This is your certificate — close the tab when you're done.</span>
    </div>
    <div class="frame">
      <div class="brand">VARUNA &middot; AUTONOMOUS RIVER CLEANUP</div>
      <h1>Certificate of Impact</h1>
      <p class="sub">In recognition of contribution to river and lake cleanup</p>
      <p class="body-text">
        This certifies that <strong>${esc(who)}</strong> has, using the VARUNA autonomous
        cleanup drone platform, contributed to the surveillance and removal of floating
        debris from local waterways, as summarised below.
      </p>
      <div class="stats">
        <div class="stat"><div class="num">${s.itemsFound}</div><div class="lbl">Items spotted</div></div>
        <div class="stat"><div class="num">${fmtArea(s.areaCoveredM2)}</div><div class="lbl">Area covered</div></div>
        <div class="stat"><div class="num">${fmtHours(s.flightSeconds)}</div><div class="lbl">Flight time</div></div>
        <div class="stat"><div class="num">${s.missionsCompleted}</div><div class="lbl">Missions</div></div>
      </div>
      <div class="sign">
        <div><div class="line"></div>Operator</div>
        <div style="text-align:right;font-family:Inter,sans-serif;color:#4b5563">Issued ${esc(when)}</div>
        <div><div class="line"></div>VARUNA Ground Control</div>
      </div>
    </div>
  </body></html>`
}

/** Open the certificate in a new tab and trigger the print dialog. */
export function openCertificatePrintView(html) {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  // Give the browser a moment to parse before print(); some engines otherwise
  // print a blank page.
  setTimeout(() => {
    try {
      w.focus()
      w.print()
    } catch {
      /* fall through — user still has the button */
    }
  }, 400)
  return true
}
