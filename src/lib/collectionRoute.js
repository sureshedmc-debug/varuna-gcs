// Build a shareable Google Maps route through a list of trash locations.
//
// Google Maps' directions URL supports one origin, one destination, and up to
// ~23 waypoints in between (~25 stops total). We clamp to that cap and warn
// if any stops had to be dropped, rather than silently truncating.

const MAX_STOPS = 25

/** Encode a [lat,lng] pair into the format Google Maps expects. */
function ll(p) {
  return `${Number(p[0]).toFixed(6)},${Number(p[1]).toFixed(6)}`
}

/**
 * Build a `google.com/maps/dir/?api=1&...` URL from an ordered list of stops.
 * The first point is the origin, the last is the destination, everything in
 * between is a via-waypoint (Google shows them as ordered stops on the route).
 * @returns { url, stops, dropped } — `dropped` is how many stops didn't fit.
 */
export function googleMapsMultiStopUrl(points = []) {
  const pts = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
  if (!pts.length) return { url: null, stops: 0, dropped: 0 }
  const dropped = Math.max(0, pts.length - MAX_STOPS)
  const kept = pts.slice(0, MAX_STOPS)
  if (kept.length === 1) {
    return { url: `https://www.google.com/maps?q=${ll(kept[0])}`, stops: 1, dropped }
  }
  const origin = ll(kept[0])
  const destination = ll(kept[kept.length - 1])
  const via = kept.slice(1, -1).map(ll).join('|')
  const params = new URLSearchParams({ api: '1', travelmode: 'walking', origin, destination })
  if (via) params.set('waypoints', via)
  return { url: `https://www.google.com/maps/dir/?${params.toString()}`, stops: kept.length, dropped }
}
