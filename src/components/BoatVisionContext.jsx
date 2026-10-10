import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { boatApi } from '../api/boatClient'
import { useBoat } from './BoatContext'
import { usePolling } from '../hooks/usePolling'
import {
  isVisionRunning, setVisionConfig, setVisionSim, startBoatVision, stopBoatVision, subscribeVision,
} from '../lib/boatVision'

const Ctx = createContext(null)
export const useBoatVision = () => useContext(Ctx)

const PREF_KEY = 'varuna.boatVision'

function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * Runs the boat camera's AI (lib/boatVision.js) whenever the boat is online
 * with its camera streaming and the operator hasn't switched it off — on any
 * tab, because homing and wildlife-safe mode depend on it. Also holds the
 * boat's vision settings, shared by the Boat Vision and Water Lab tabs.
 */
export function BoatVisionProvider({ children }) {
  const boat = useBoat()
  const [enabled, setEnabledState] = useState(readPref)
  const [engine, setEngine] = useState(null)
  const t = boat?.telemetry?.data
  const online = boat?.reachable === true && !!t
  const cameraUp = online && t.camera?.connected === true

  const cfgPoll = usePolling(() => (boat?.reachable === true ? boatApi.visionConfig() : Promise.resolve(null)), 20000, [boat?.reachable])
  const [cfgOverride, setCfgOverride] = useState(null)
  const cfg = cfgOverride || (cfgPoll.data && !cfgPoll.data._httpError ? cfgPoll.data : null)

  useEffect(() => subscribeVision(setEngine), [])

  // Start / stop the engine.
  useEffect(() => {
    const want = enabled && cameraUp && !!cfg
    if (want && !isVisionRunning()) startBoatVision({ cfg, sim: boat.simulated })
    if (!want && isVisionRunning()) stopBoatVision()
  }, [enabled, cameraUp, cfg, boat?.simulated])
  useEffect(() => () => stopBoatVision(), [])
  useEffect(() => { setVisionConfig(cfg) }, [cfg])
  useEffect(() => { setVisionSim(!!boat?.simulated) }, [boat?.simulated])

  const setEnabled = useCallback((on) => {
    setEnabledState(on)
    try {
      localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
    } catch {
      /* private mode */
    }
  }, [])

  // A save shows its result at once; the next poll then takes over again, so
  // changes made on the boat or from another screen keep arriving.
  const updateConfig = useCallback(async (patch) => {
    const res = await boatApi.setVisionConfig(patch)
    if (res?.config) setCfgOverride(res.config)
    await cfgPoll.refresh()
    setCfgOverride(null)
    return res
  }, [cfgPoll])

  const value = useMemo(() => ({
    enabled, setEnabled, engine, cfg, updateConfig,
    online, cameraUp,
    vision: online ? t.vision || null : null,
    water: online ? t.water || null : null,
  }), [enabled, setEnabled, engine, cfg, updateConfig, online, cameraUp, t?.vision, t?.water]) // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
