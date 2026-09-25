// Email via EmailJS — a client-safe service designed to send email from the
// browser using only a public key + template id (no secret leaves the app).
// Set up at https://www.emailjs.com: pick a service (Gmail/Outlook/…), create
// a template that expects the fields below, and paste the ids into the
// System → Alerts panel.

import { getAlertSettings } from '../alertSettings'
import { mapsLink } from './format'

let emailjs = null
async function client() {
  if (emailjs) return emailjs
  const mod = await import('@emailjs/browser')
  emailjs = mod.default || mod
  return emailjs
}

async function send(params) {
  const s = getAlertSettings()
  const { emailjsServiceId, emailjsTemplateId, emailjsPublicKey } = s
  if (!emailjsServiceId || !emailjsTemplateId || !emailjsPublicKey) {
    return { ok: false, error: 'Fill EmailJS Service, Template and Public Key in System → Alerts first.' }
  }
  try {
    const ej = await client()
    const res = await ej.send(emailjsServiceId, emailjsTemplateId, params, { publicKey: emailjsPublicKey })
    if (res && (res.status === 200 || res.text === 'OK')) return { ok: true }
    return { ok: false, error: `EmailJS: ${res?.text || res?.status || 'failed'}` }
  } catch (e) {
    return { ok: false, error: e?.text || e?.message || String(e) }
  }
}

/** After a Word report is downloaded — quick heads-up email. */
export function sendReportReadyEmail({ filename, summary } = {}) {
  const s = getAlertSettings()
  return send({
    to_email: s.emailjsToAddress,
    subject: 'VARUNA — mission report ready',
    filename: filename || 'varuna-report.doc',
    summary: summary || '',
    message: `Your VARUNA mission report is ready: ${filename || '(downloaded to your Downloads folder)'}. Summary: ${summary || 'see the attached document'}.`,
  })
}

/** On big-dump auto-alert. */
export function sendBigDumpEmail({ itemCount, cls, lat, lng } = {}) {
  const s = getAlertSettings()
  const link = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) ? mapsLink(lat, lng) : ''
  return send({
    to_email: s.emailjsToAddress,
    subject: `VARUNA — ${itemCount} ${cls || 'trash'} items detected`,
    itemCount: String(itemCount ?? ''),
    cls: cls || 'trash',
    lat: Number.isFinite(Number(lat)) ? Number(lat).toFixed(6) : '',
    lng: Number.isFinite(Number(lng)) ? Number(lng).toFixed(6) : '',
    mapUrl: link,
    message: `VARUNA detected ${itemCount} ${cls || 'trash'} items${link ? ` — ${link}` : ''}.`,
  })
}
