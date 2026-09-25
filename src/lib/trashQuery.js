// Time-range queries over the trash log for the "ask about your data"
// assistant tool. Real dates only — no invented numbers, no fuzzy periods.

import { clusterHotspots } from './hotspots'

const DAY = 24 * 60 * 60 * 1000

function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function endOfDay(ms) {
  return startOfDay(ms) + DAY - 1
}
function daysBack(n) {
  return startOfDay(Date.now() - n * DAY)
}

/** Resolve a named period → [startMs, endMs] and a human label. */
export function resolvePeriod(period, startDate, endDate) {
  const now = Date.now()
  switch (period) {
    case 'today':
      return { start: startOfDay(now), end: now, label: 'today' }
    case 'yesterday':
      return { start: daysBack(1), end: startOfDay(now) - 1, label: 'yesterday' }
    case 'this_week':
      return { start: daysBack(6), end: now, label: 'this week (last 7 days)' }
    case 'last_week':
      return { start: daysBack(13), end: daysBack(6) - 1, label: 'the week before this one' }
    case 'custom': {
      const s = startDate ? Date.parse(startDate) : null
      const e = endDate ? Date.parse(endDate) : null
      if (!Number.isFinite(s) || !Number.isFinite(e)) return null
      return { start: startOfDay(s), end: endOfDay(e), label: `${new Date(s).toLocaleDateString()} to ${new Date(e).toLocaleDateString()}` }
    }
    default:
      return null
  }
}

/** Filter sightings that overlap the [start, end] range (by firstSeen/lastSeen). */
export function filterByDateRange(sightings, start, end) {
  return (sightings || []).filter((s) => {
    const first = Number(s.firstSeen || s.lastSeen || 0)
    const last = Number(s.lastSeen || s.firstSeen || 0)
    return last >= start && first <= end
  })
}

/** Summarise a filtered list into a small JSON object the model can quote. */
export function summarizeSightings(list) {
  const byClass = {}
  let items = 0
  let located = 0
  for (const s of list) {
    const cls = s.class || 'trash'
    const c = Math.max(1, Number(s.count) || 1)
    items += c
    byClass[cls] = (byClass[cls] || 0) + c
    if (s.located) located++
  }
  const clusters = clusterHotspots(list)
  const top = clusters[0]
  return {
    trash_locations: list.length,
    items_total: items,
    located,
    unlocated: list.length - located,
    by_class: byClass,
    worst_hotspot: top ? { lat: +top.lat.toFixed(6), lng: +top.lng.toFixed(6), items: top.itemsTotal } : null,
  }
}
