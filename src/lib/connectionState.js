// Tiny module-level mirror of SystemContext's `backendReachable`, so plain
// (non-React) code — like the command router — can synchronously check
// whether we're talking to a real drone or must fall back to the simulator.
// SystemContext.jsx is the single writer (via setBackendReachable in an
// effect); everything else only reads.

let reachable // undefined = unknown/connecting, true = real backend, false = offline → simulate
// Once a real drone has answered this session we NEVER fall back to the
// simulator again: a single slow ping over the Netbird link must not re-route
// STOP / RTL / LAND to a virtual aircraft while the real one is airborne.
// Commands keep going to the real API (and fail loudly if it's truly down).
let everReal = false
const subs = new Set()

export function setBackendReachable(v) {
  if (v === true) everReal = true
  if (v === reachable) return
  reachable = v
  subs.forEach((fn) => fn(v))
}

export function getBackendReachable() {
  return reachable
}

// Simulate only once we've positively confirmed the backend is unreachable —
// never during the initial "connecting" (undefined) state, so the app doesn't
// flash fake telemetry before it's had a chance to find a real drone — and
// never after a real drone has been seen (see everReal above).
export function isSimulated() {
  return reachable === false && !everReal
}

/** Which aircraft commands currently go to: 'sim' or 'real'. */
export function commandTarget() {
  return isSimulated() ? 'sim' : 'real'
}

export function subscribeBackendReachable(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}
