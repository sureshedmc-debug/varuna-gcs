// System tab — download satellite tiles ahead of a flight so the maps still
// draw with no connection.
//
// Panning over an area already caches it (see CachedTileLayer); this is for
// the case that actually bites, which is arriving at a riverbank with no
// signal having never opened the map there.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Btn } from './ui'
import { useToast } from './Toast'
import { SAT_URL } from './MapCanvas'
import { useSystem } from './SystemContext'
import { useHomePoint, useLivePosition } from '../hooks/useLaptopGps'
import { boundsAround, countTiles, prefetchArea, tileStats, clearTiles, MAX_PREFETCH_TILES } from '../lib/tileCache'
import { fmtCoord } from '../lib/format'

// Zoom 13 is "the whole lake fits on screen"; 18 is "individual boats".
// Each extra level quadruples the tile count, so the ceiling is a real choice.
const ZOOM_MIN = 13
const ZOOM_CHOICES = [
  { max: 16, label: 'Overview', hint: 'street level' },
  { max: 17, label: 'Detailed', hint: 'buildings' },
  { max: 18, label: 'Maximum', hint: 'individual objects' },
]
const RADII = [1000, 2000, 5000]

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB'
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export default function OfflineMapsPanel() {
  const toast = useToast()
  const { telemetry, simulated } = useSystem()
  const live = useLivePosition(telemetry.data)
  const home = useHomePoint(telemetry.data, live, simulated)
  const centre = live.position || home

  const [radiusM, setRadiusM] = useState(2000)
  const [maxZoom, setMaxZoom] = useState(17)
  const [stats, setStats] = useState({ count: 0, bytes: 0 })
  const [progress, setProgress] = useState(null)
  const stopRef = useRef(false)

  const refresh = useCallback(async () => setStats(await tileStats()), [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const bounds = centre ? boundsAround(centre[0], centre[1], radiusM) : null
  const estimate = bounds ? countTiles(bounds, ZOOM_MIN, maxZoom) : 0
  // Esri imagery tiles run roughly 15–25 KB each at these zooms.
  const estBytes = estimate * 20 * 1024
  const tooBig = estimate > MAX_PREFETCH_TILES

  async function download() {
    if (!bounds) return
    stopRef.current = false
    setProgress({ processed: 0, total: estimate, done: 0, skipped: 0, failed: 0 })
    try {
      const r = await prefetchArea({
        bounds,
        minZoom: ZOOM_MIN,
        maxZoom,
        urlTemplate: SAT_URL,
        onProgress: setProgress,
        shouldStop: () => stopRef.current,
      })
      toast.push({
        level: r.failed > r.done ? 'warn' : 'ok',
        title: r.stopped ? 'Download stopped' : 'Offline area ready',
        msg: `${r.done} new tile${r.done === 1 ? '' : 's'}, ${r.skipped} already cached${r.failed ? `, ${r.failed} failed` : ''}. These maps now work with no connection.`,
      })
    } catch (e) {
      toast.push({ level: 'warn', title: 'Could not download the area', msg: String(e?.message || e) })
    } finally {
      setProgress(null)
      refresh()
    }
  }

  async function wipe() {
    if (!window.confirm('Delete every cached map tile? Maps will need a connection again until they re-cache.')) return
    await clearTiles()
    await refresh()
    toast.push({ level: 'ok', title: 'Offline maps cleared' })
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] leading-relaxed text-muted">
        Every tile any map in the app draws is kept on this machine and re-served from there — including with no
        internet. Download an area in advance below so the map is already there when you arrive.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="glass-soft flex flex-col gap-2 p-3">
          <div className="text-xs font-semibold text-ink">Area</div>
          <div className="font-mono text-[11px] tnum text-muted">
            {centre ? `${fmtCoord(centre[0])}, ${fmtCoord(centre[1])}` : 'No position yet — needs a drone or laptop GPS fix.'}
          </div>
          <div className="mt-1 flex gap-1.5">
            {RADII.map((r) => (
              <button
                key={r}
                onClick={() => setRadiusM(r)}
                className="flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors"
                style={radiusM === r
                  ? { background: 'rgba(59,158,255,0.2)', color: '#3B9EFF', border: '1px solid rgba(59,158,255,0.45)' }
                  : { background: 'var(--chip,#1A1F27)', color: '#8A9099', border: '1px solid transparent' }}
              >
                {r / 1000} km
              </button>
            ))}
          </div>
        </div>

        <div className="glass-soft flex flex-col gap-2 p-3">
          <div className="text-xs font-semibold text-ink">Detail</div>
          <div className="text-[11px] text-muted">Each extra level is four times the tiles.</div>
          <div className="mt-1 flex gap-1.5">
            {ZOOM_CHOICES.map((z) => (
              <button
                key={z.max}
                onClick={() => setMaxZoom(z.max)}
                title={z.hint}
                className="flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors"
                style={maxZoom === z.max
                  ? { background: 'rgba(59,158,255,0.2)', color: '#3B9EFF', border: '1px solid rgba(59,158,255,0.45)' }
                  : { background: 'var(--chip,#1A1F27)', color: '#8A9099', border: '1px solid transparent' }}
              >
                {z.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {progress ? (
        <div className="rounded-lg bg-chip px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="text-muted">
              Downloading… <span className="font-mono tnum text-ink">{progress.processed}</span> / {progress.total}
              {progress.failed > 0 && <span className="ml-1 text-warn">({progress.failed} failed)</span>}
            </span>
            <button onClick={() => { stopRef.current = true }} className="font-semibold text-muted hover:text-bad">Stop</button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.min(100, (progress.processed / Math.max(1, progress.total)) * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <Btn disabled={!centre || tooBig} onClick={download}>
          {!centre
            ? 'Waiting for a GPS fix'
            : tooBig
              ? `Too large — ${estimate.toLocaleString()} tiles`
              : `Download ${estimate.toLocaleString()} tiles (~${fmtBytes(estBytes)})`}
        </Btn>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[11px] text-muted">
        <span>
          Cached: <span className="font-mono tnum text-ink">{stats.count.toLocaleString()}</span> tiles ·{' '}
          <span className="font-mono tnum text-ink">{fmtBytes(stats.bytes)}</span>
        </span>
        <button onClick={wipe} className="font-semibold text-muted transition-colors hover:text-bad">Clear offline maps</button>
      </div>
    </div>
  )
}
