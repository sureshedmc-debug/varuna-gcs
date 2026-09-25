// Alert channel settings for WhatsApp and Email (both client-side — no
// backend of ours). Same pub/sub + localStorage + CustomEvent pattern as
// detectionStats.js, so the operator can save the EmailJS public key once
// and every screen picks it up. Values live only in this browser.

import { useEffect, useState } from 'react'

const KEY = 'varuna.alertSettings'
const EVT = 'varuna:alertSettings'

const DEFAULTS = {
  // WhatsApp: a phone number in international format (no + / no spaces).
  // wa.me deep-link only — the operator taps Send in WhatsApp itself.
  whatsappNumber: '',
  // EmailJS: public keys only (safe to expose in the browser).
  emailjsServiceId: '',
  emailjsTemplateId: '',
  emailjsPublicKey: '',
  emailjsToAddress: '',
  // Fires an auto-alert as soon as this many trash items are seen at once.
  bigDumpThreshold: 8,
  // Auto-alert switches: off by default so nothing is sent until the
  // operator has entered credentials and turned it on themselves.
  enableEmailOnBigDump: false,
  enableEmailOnReport: false,
}

export function getAlertSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setAlertSettings(patch) {
  const next = { ...getAlertSettings(), ...(patch || {}) }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode / quota */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: next }))
  } catch {
    /* SSR */
  }
  return next
}

export function useAlertSettings() {
  const [s, setS] = useState(getAlertSettings)
  useEffect(() => {
    const onEvt = (e) => setS(e.detail && typeof e.detail === 'object' ? e.detail : getAlertSettings())
    const onStorage = (e) => {
      if (e.key === KEY) setS(getAlertSettings())
    }
    window.addEventListener(EVT, onEvt)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVT, onEvt)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return s
}
