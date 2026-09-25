// Shared alert message builder. WhatsApp and Email both use this so the
// wording matches everywhere. Kept short — WhatsApp truncates long text in
// the compose window, and email subject/preview lines wrap.

const CLASS_LABEL = { 'plastic bottle': 'plastic bottles', trash: 'trash items', 'river trash': 'river trash items' }

export function mapsLink(lat, lng) {
  return `https://www.google.com/maps?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`
}

export function buildAlertText({ itemCount = 0, cls = 'trash', lat = null, lng = null, source = null } = {}) {
  const label = CLASS_LABEL[cls] || 'trash items'
  const where = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    ? `at ${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)} — ${mapsLink(lat, lng)}`
    : 'at an unlocated spot (no GPS fix)'
  const src = source === 'stream' ? ' (drone camera)' : source === 'webcam' ? ' (laptop webcam)' : ''
  return `VARUNA alert: ${itemCount} ${label} spotted${src}, ${where}`
}
