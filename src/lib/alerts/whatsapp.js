// WhatsApp "click to chat" deep link — no SDK, no backend. Opens WhatsApp
// (web or app) with the text prefilled; the operator taps Send.

import { getAlertSettings } from '../alertSettings'

/** Build a wa.me link. `number` is international, digits only ("+91..." → "91..."). */
export function whatsappDeepLink({ text = '', number = '' } = {}) {
  const clean = String(number || '').replace(/[^0-9]/g, '')
  const base = clean ? `https://wa.me/${clean}` : 'https://wa.me/'
  return `${base}?text=${encodeURIComponent(String(text || ''))}`
}

/** Open the deep link in a new tab. Returns whether the popup was allowed. */
export function openWhatsApp(text) {
  const s = getAlertSettings()
  const url = whatsappDeepLink({ text, number: s.whatsappNumber })
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer')
    return !!w
  } catch {
    return false
  }
}
