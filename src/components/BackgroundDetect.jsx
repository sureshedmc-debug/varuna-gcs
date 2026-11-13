import { lazy, Suspense, useEffect, useState } from 'react'
import { getDetectModel } from '../lib/detector'

// Keeps the drone's AI finding plastic while another tab is open, for as long
// as the boat's live collect runs: the boat goes after the drone's finds as
// they come in (liveCollectFeed.js), so the drone has to keep finding while
// the operator watches the boat. The app shell mounts this off screen whenever
// live collect runs and the Live tab (which runs its own detection) isn't open.

const WebcamDetect = lazy(() => import('./WebcamDetect'))

/**
 * The confidence the selected model's training run found best
 * (public/models/<model>.json), snapped to the slider's 5% steps.
 * Returns [conf, setConf] so a slider can still move it.
 */
export function useRecommendedConf(fallback = 0.25) {
  const [conf, setConf] = useState(fallback)
  useEffect(() => {
    let alive = true
    fetch(`/models/${getDetectModel()}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        const rec = Number(m?.recommended_conf)
        if (alive && rec > 0) setConf(Math.min(0.9, Math.max(0.1, Math.round(rec * 20) / 20)))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return [conf, setConf]
}

export default function BackgroundDetect({ onOpen }) {
  const [conf] = useRecommendedConf()
  return (
    <>
      {/* Real size, just off screen: the detector sizes its canvas from the layout. */}
      <div aria-hidden className="pointer-events-none fixed top-0 h-[720px] w-[1280px] overflow-hidden"
        style={{ left: -10000, visibility: 'hidden' }}>
        <Suspense fallback={null}>
          <WebcamDetect confThr={conf} defaultSource="auto" autoStart />
        </Suspense>
      </div>
      <button type="button" onClick={onOpen} title="Open the Live tab"
        className="fixed bottom-3 right-3 z-40 flex items-center gap-2 rounded-full px-3 py-1.5 text-[11.5px] font-bold text-ink"
        style={{ background: 'rgba(13,17,26,0.88)', border: '1px solid rgba(50,215,75,0.4)', backdropFilter: 'blur(10px)', boxShadow: '0 4px 18px rgba(0,0,0,0.4)' }}>
        <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: '#32D74B' }} />
        Drone AI finding plastic for the boat
      </button>
    </>
  )
}
