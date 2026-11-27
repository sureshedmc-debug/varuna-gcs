// The boat's own records for the report: items its ramp camera counted, water
// turbidity readings, and wildlife pauses. Fetched when the report is made;
// null when the boat isn't reachable (the report then simply has no boat part).

import { boatApi } from '../api/boatClient'
import { estimateWeightG } from './sizeEstimate'

const ok = (r) => (r && !r._httpError ? r : null)

export async function fetchBoatReportData() {
  const [c, w, wr, wl] = await Promise.all([
    boatApi.catchSummary(500).then(ok).catch(() => null),
    boatApi.waterStatus().then(ok).catch(() => null),
    boatApi.waterReadings(200).then(ok).catch(() => null),
    boatApi.wildlife(100).then(ok).catch(() => null),
  ])
  if (!c && !w && !wl) return null
  const byLabel = c?.all_time?.by_label || {}
  const readings = Array.isArray(wr) ? wr : []
  const ntus = readings.map((r) => Number(r.ntu)).filter(Number.isFinite)
  return {
    catch: c ? {
      total: c.all_time?.total || 0,
      today: c.today?.total || 0,
      byLabel,
      estWeightG: Object.entries(byLabel).reduce((a, [label, n]) => a + estimateWeightG(label, n), 0),
      bin: c.bin || null,
    } : null,
    water: (w || readings.length) ? {
      now: w && w.connected ? { ntu: w.ntu, quality: w.quality } : null,
      calibrated: !!w?.calibrated,
      readings: readings.map((r) => ({ ntu: r.ntu, quality: r.quality, lat: r.lat, lng: r.lng, t: r.t, reason: r.reason })),
      avgNtu: ntus.length ? Math.round((ntus.reduce((a, b) => a + b, 0) / ntus.length) * 10) / 10 : null,
      minNtu: ntus.length ? Math.min(...ntus) : null,
      maxNtu: ntus.length ? Math.max(...ntus) : null,
    } : null,
    wildlife: wl ? {
      pausesToday: wl.pauses_today || 0,
      waitedSToday: Math.round(wl.paused_s_today || 0),
      sightings: (wl.sightings || []).map((s) => ({ label: s.label, t: s.t, lat: s.lat, lng: s.lng })),
    } : null,
  }
}
