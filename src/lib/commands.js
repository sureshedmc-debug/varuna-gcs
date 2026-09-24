// Single place every screen sends flight commands through. Routes to the
// real backend when it's reachable, or to the client-side simulator when
// it's not (see connectionState.js) — so every command button keeps working
// exactly the same way, just against a virtual aircraft instead of a real
// one. Screens should call these instead of the matching `api.*` methods for
// anything that moves or arms the aircraft.

import { api } from '../api/client'
import { isSimulated, commandTarget } from './connectionState'
import { simArm, simTakeoff, simRtl, simLand, simEmergencyStop, simStartMission } from './simulator'
import { getActiveMission, setActiveMission, missionFor } from './missionStore'

export const cmd = {
  arm: (next) => (isSimulated() ? simArm(next) : api.arm(next)),
  takeoff: (altitude) => (isSimulated() ? simTakeoff(altitude) : api.takeoff(altitude)),
  rtl: () => (isSimulated() ? simRtl() : api.rtl()),
  land: () => (isSimulated() ? simLand() : api.land()),
  emergencyStop: () => (isSimulated() ? simEmergencyStop() : api.emergencyStop()),

  // Upload records the plan into the shared mission store (so Home's map can
  // draw the real path and MissionScreen can gate the Run button) — but only
  // once the aircraft has actually accepted it, tagged with which aircraft
  // ('sim' | 'real') that was. `waypoints` is the simple [{lat,lng,action}]
  // shape; the fuller per-point payload the real backend expects
  // (id/alt/speed) is built here, so the wire format sent to a real Pi is
  // unchanged from before this feature.
  missionUpload: async (name, waypoints, { altitude, speedKmh } = {}) => {
    const target = commandTarget()
    let res
    if (target === 'sim') {
      res = { success: true, message: 'Mission uploaded (simulated)' }
    } else {
      const payload = waypoints.map((w, i) => ({ id: i + 1, lat: w.lat, lng: w.lng, alt: altitude, speed: speedKmh, action: w.action }))
      res = await api.missionUpload(name, payload)
      if (!isOk(res)) return { ...res, success: false, message: res?.message || (res?._httpError ? `HTTP ${res._httpError}` : 'Upload failed') }
    }
    setActiveMission({ name, waypoints, altitude, speedKmh, target })
    return res
  },
  missionStart: () => {
    const target = commandTarget()
    if (!missionFor(getActiveMission(), target)) {
      return Promise.resolve({ success: false, message: `Upload a mission to the ${target === 'sim' ? 'simulator' : 'drone'} first` })
    }
    return target === 'sim' ? simStartMission() : api.missionStart()
  },
}

/** True only for a genuine success (no HTTP error, not success:false). */
export function isOk(res) {
  return !!res && res.success !== false && !res._httpError
}
