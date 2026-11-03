// "Save map for offline" for a Live Mission Plan: downloads the satellite
// tiles inside the planned-area circle (the same store the System tab's
// Offline maps panel fills), so the map still draws at the riverbank with no
// signal. Tiles already saved are skipped.

import { useRef, useState } from 'react'
import { useToast } from './Toast'
import { SAT_URL } from './MapCanvas'
import { boundsAround, countTiles, prefetchArea } from '../lib/tileCache'
import { useOnline } from '../lib/online'

const MIN_ZOOM = 12
const MAX_ZOOM = 17 // buildings and banks; 18 would quadruple the download

export default function SavePlanMapButton({ area }) {
  const toast = useToast()
  const online = useOnline()
  const [progress, setProgress] = useState(null)
  const stopRef = useRef(false)
  if (!area) return null

  const bounds = boundsAround(area.center[0], area.center[1], area.radius)
  const total = countTiles(bounds, MIN_ZOOM, MAX_ZOOM)
  const mb = Math.max(1, Math.round((total * 20) / 1024)) // ~20 KB a tile

  async function save() {
    stopRef.current = false
    setProgress({ processed: 0, total })
    try {
      const r = await prefetchArea({ bounds, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, urlTemplate: SAT_URL, onProgress: setProgress, shouldStop: () => stopRef.current })
      toast.push({
        level: r.failed > r.done ? 'warn' : 'ok',
        title: r.stopped ? 'Stopped saving the map' : 'Map saved for offline use',
        msg: r.stopped ? 'What was saved so far stays.' : `This river's map now works with no internet${r.failed ? ` (${r.failed} tiles failed — press again to retry)` : ''}.`,
      })
    } catch (e) {
      toast.push({ level: 'warn', title: 'Could not save the map', msg: String(e?.message || e) })
    } finally {
      setProgress(null)
    }
  }

  if (progress) {
    const pct = Math.round((100 * (progress.processed || 0)) / (progress.total || 1))
    return (
      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'rgba(167,139,250,0.2)' }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: '#a78bfa' }} />
        </div>
        <span className="font-mono tnum text-muted">{pct}%</span>
        <button onClick={() => { stopRef.current = true }} className="font-semibold text-muted hover:text-bad">Stop</button>
      </div>
    )
  }
  return (
    <button
      onClick={save}
      disabled={!online}
      title={online ? `About ${mb} MB` : 'Needs the internet'}
      className="mt-2 w-full rounded-lg px-2 py-1.5 font-semibold transition-colors disabled:opacity-50"
      style={{ background: 'rgba(167,139,250,0.16)', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.35)' }}
    >
      {online ? `Save map for offline use (~${mb} MB)` : 'Save map for offline use — needs internet'}
    </button>
  )
}
