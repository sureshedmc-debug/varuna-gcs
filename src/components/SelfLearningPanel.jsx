// System tab — what the detector has taught itself, and how to turn that into
// new weights. The loop itself runs unattended during flight (selfLearn.js);
// this panel only reports on it and hands over the dataset.

import { useCallback, useEffect, useState } from 'react'
import { Btn } from './ui'
import { useToast } from './Toast'
import {
  selfLearnStats,
  setSelfLearnEnabled,
  onSelfLearnChange,
  clearLearning,
} from '../lib/selfLearn'
import { exportDataset, trainingSetStats } from '../lib/datasetExport'
import { photoStats, clearPhotos } from '../lib/photoStore'

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB'
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function Stat({ label, value, hint, color }) {
  return (
    <div className="rounded-lg bg-chip px-3 py-2">
      <div className="font-mono text-lg font-bold tnum" style={{ color: color || '#3B9EFF' }}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      {hint && <div className="mt-0.5 text-[10px] leading-tight text-faint">{hint}</div>}
    </div>
  )
}

export default function SelfLearningPanel() {
  const toast = useToast()
  const [stats, setStats] = useState(selfLearnStats())
  const [train, setTrain] = useState({ total: 0, withFrame: 0, positive: 0, negative: 0, untrained: 0 })
  const [media, setMedia] = useState({ count: 0, bytes: 0 })
  const [busy, setBusy] = useState(false)
  const [onlyNew, setOnlyNew] = useState(true)

  const refresh = useCallback(async () => {
    setStats(selfLearnStats())
    setTrain(await trainingSetStats())
    setMedia(await photoStats())
  }, [])

  useEffect(() => {
    refresh()
    const off = onSelfLearnChange(() => setStats(selfLearnStats()))
    const t = setInterval(refresh, 8000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

  async function doExport() {
    setBusy(true)
    try {
      const { filename, counts, bytes } = await exportDataset({ onlyNew })
      toast.push({
        level: 'ok',
        title: `Dataset exported · ${filename}`,
        msg: `${counts.train} train / ${counts.val} val frames · ${counts.positive} positive, ${counts.negative} background · ${fmtBytes(bytes)}. Unzip it and run: python train.py`,
      })
      refresh()
    } catch (e) {
      toast.push({ level: 'warn', title: 'Nothing to export yet', msg: String(e?.message || e) })
    } finally {
      setBusy(false)
    }
  }

  async function doClear() {
    if (!window.confirm('Forget everything the detector has learned, and delete the collected training frames? This cannot be undone.')) return
    await clearLearning()
    await refresh()
    toast.push({ level: 'ok', title: 'Learning reset', msg: 'The detector is back to the shipped model with no memory.' })
  }

  async function doClearPhotos() {
    if (!window.confirm('Delete every stored detection photo? The Detections tab and past reports lose their images.')) return
    await clearPhotos()
    await refresh()
    toast.push({ level: 'ok', title: 'Stored photos deleted' })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg bg-chip px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-ink">Learn from every flight</div>
          <div className="text-[11px] leading-snug text-muted">
            On by default. Runs during detection with nothing to click.
          </div>
        </div>
        <button
          onClick={() => {
            setSelfLearnEnabled(!stats.enabled)
            setStats(selfLearnStats())
          }}
          className="shrink-0 rounded-md px-3 py-1.5 text-[11px] font-bold"
          style={stats.enabled
            ? { background: 'rgba(50,215,75,0.18)', color: '#32D74B', border: '1px solid rgba(50,215,75,0.4)' }
            : { background: 'rgba(255,255,255,0.06)', color: '#8A9099', border: '1px solid rgba(255,255,255,0.12)' }}
        >
          {stats.enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Confirmed trash" value={stats.positive} color="#32D74B" hint="boxes that held across frames" />
        <Stat label="False positives" value={stats.negative} color="#FF453A" hint="flicker, or overlapped a person" />
        <Stat label="Suppressed live" value={stats.suppressed} color="#BF5AF2" hint="blocked this session by memory" />
        <Stat label="Your ✓/✗" value={stats.operator} color="#FF9F0A" hint="optional, weighted highest" />
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Nothing here was labelled by hand. A box that survives while the aircraft moves is real; one that flickers for a
        frame is not; and anything the trash model calls debris while the person model calls it a human is a false
        positive by disagreement. Those verdicts suppress look-alikes <em>immediately</em>, and pile up as a training set.
      </p>

      <div className="rounded-lg border border-line px-3 py-2.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-ink">Retrain the model</div>
          <span className="font-mono text-[11px] tnum text-muted">
            {train.withFrame} frame{train.withFrame === 1 ? '' : 's'} ready
            {train.untrained < train.total ? ` · ${train.untrained} new` : ''}
          </span>
        </div>
        <p className="mb-2 text-[11px] leading-snug text-muted">
          Changing the weights needs Python, which a browser can&apos;t run — so the app exports a ready-to-train YOLO
          dataset instead. Unzip it, <span className="font-mono text-ink">pip install ultralytics</span>, run{' '}
          <span className="font-mono text-ink">python train.py</span>, then copy the new{' '}
          <span className="font-mono text-ink">best.onnx</span> over{' '}
          <span className="font-mono text-ink">public/models/trash.onnx</span>. Keep the old one: if validation mAP
          isn&apos;t better, don&apos;t ship it.
        </p>
        <label className="mb-2 flex items-center gap-2 text-[11px] text-muted">
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} className="accent-accent" />
          Only frames not exported before (incremental)
        </label>
        <Btn disabled={busy || !train.withFrame} onClick={doExport}>
          {busy ? 'Packaging…' : `Export training dataset (.zip)`}
        </Btn>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[11px] text-muted">
        <span>
          Stored imagery: <span className="font-mono tnum text-ink">{media.count}</span> frames ·{' '}
          <span className="font-mono tnum text-ink">{fmtBytes(media.bytes)}</span>
        </span>
        <div className="flex gap-3">
          <button onClick={doClearPhotos} className="font-semibold text-muted transition-colors hover:text-bad">Delete photos</button>
          <button onClick={doClear} className="font-semibold text-muted transition-colors hover:text-bad">Reset learning</button>
        </div>
      </div>
    </div>
  )
}
