import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../api/client'
import { usePolling, useNow } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Btn, StaleBadge, StatusOrb, TiltCard, Spinner } from '../components/ui'
import { ViewToggle, EYE, EYE_OFF } from '../components/ViewToggle'
import { fmtClock, fmtCoord, num } from '../lib/format'
import { useTrashStats, resetTrashStats } from '../lib/detectionStats'
import { getGeminiKey, setGeminiKey, generateReportNarrative } from '../lib/geminiClient'
import { renderReportCharts } from '../lib/reportChart'
import { buildTrashDataset, downloadWordReport, fallbackNarrative } from '../lib/reportDoc'

function DetectionRow({ d, i, expanded, onToggle }) {
  const located = d.located !== false && d.lat != null && d.lng != null
  const conf = Number(d.confidence)
  const confPct = Number.isNaN(conf) ? null : conf <= 1 ? conf * 100 : conf
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(i * 0.015, 0.3), layout: { type: 'spring', stiffness: 320, damping: 30 } }}
      className="glass-soft overflow-hidden"
    >
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <StatusOrb level={located ? 'ok' : 'warn'} size={10} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-ink">{d.class || 'debris'}</span>
            {confPct != null && (
              <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-mono tnum text-muted">{num(confPct, 0)}%</span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-xs tnum text-muted">
            {located ? `${fmtCoord(d.lat)}, ${fmtCoord(d.lng)}` : 'Unlocated (no GPS fix at capture)'}
          </div>
        </div>
        <span className="shrink-0 font-mono text-xs tnum text-muted">{fmtClock(d.timestamp)}</span>
        <motion.span animate={{ rotate: expanded ? 90 : 0 }} className="shrink-0 text-muted">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }}>
            <div className="grid grid-cols-2 gap-2 border-t border-line px-4 py-3 text-xs">
              <Detail k="Class" v={d.class || 'debris'} />
              <Detail k="Confidence" v={confPct != null ? `${num(confPct, 0)}%` : '—'} />
              <Detail k="Located" v={located ? 'Yes' : 'No (no GPS)'} level={located ? 'ok' : 'warn'} />
              <Detail k="Time" v={fmtClock(d.timestamp)} />
              <Detail k="Latitude" v={located ? fmtCoord(d.lat) : '—'} />
              <Detail k="Longitude" v={located ? fmtCoord(d.lng) : '—'} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
function Detail({ k, v, level }) {
  const c = level ? { ok: '#32D74B', warn: '#FF9F0A' }[level] : '#F2F4F7'
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted">{k}</span>
      <span className="font-mono tnum font-semibold" style={{ color: c }}>{v}</span>
    </div>
  )
}

function Stat({ label, value, level }) {
  const c = level ? { ok: '#32D74B', warn: '#FF9F0A' }[level] : '#3B9EFF'
  return (
    <div className="rounded-lg bg-chip px-3 py-2 text-center">
      <div className="font-mono text-xl font-bold tnum" style={{ color: c }}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
    </div>
  )
}

export default function DetectionsScreen() {
  const now = useNow(1000)
  const det = usePolling(() => api.aiDetections(50), 5000)
  const toast = useToast()
  const trashStats = useTrashStats()
  const [apiKey, setApiKey] = useState(getGeminiKey())
  const [reporting, setReporting] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [showReport, setShowReport] = useState(true)

  const list = det.data?.detections || []
  const locatedCount = list.filter((d) => d.located !== false && d.lat != null && d.lng != null).length
  const keyOf = (d, i) => d.id ?? (d.timestamp != null ? `${d.timestamp}-${d.class || 'debris'}` : `idx-${i}`)

  async function generateReport() {
    setReporting(true)
    // Persist the key for next time (empty is allowed → falls back to a local report).
    setGeminiKey(apiKey)
    try {
      const data = buildTrashDataset(list, trashStats)
      if (data.summary.total === 0 && !trashStats.peak) {
        toast.push({ level: 'warn', title: 'No detection data yet', msg: 'Run the AI camera or wait for detections first.' })
        return
      }
      const charts = renderReportCharts(data)

      let narrative
      if (apiKey.trim()) {
        try {
          narrative = await generateReportNarrative(data, { key: apiKey.trim() })
          toast.push({ level: 'ok', title: 'AI analysis ready', msg: 'Building Word document…' })
        } catch (e) {
          narrative = fallbackNarrative(data)
          toast.push({ level: 'warn', title: 'Gemini unavailable', msg: `${e.message || e}. Used a built-in report instead.` })
        }
      } else {
        narrative = fallbackNarrative(data)
        toast.push({ level: 'warn', title: 'No API key', msg: 'Generated a built-in report (add a Gemini key for AI analysis).' })
      }

      const filename = downloadWordReport({ data, narrative, charts })
      resetTrashStats() // clear the live-cam trash count after each report download
      toast.push({ level: 'ok', title: 'Report downloaded', msg: `${filename} · live-cam count reset` })
    } catch (e) {
      toast.push({ level: 'bad', title: 'Report failed', msg: String(e?.message || e) })
    } finally {
      setReporting(false)
    }
  }

  return (
    <div className={`mx-auto grid max-w-5xl gap-4 ${showReport ? 'lg:grid-cols-[1.3fr_1fr]' : 'lg:grid-cols-1'}`}>
      <TiltCard tilt={false} className="p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">Detection log</h2>
          <div className="flex items-center gap-2">
            <StaleBadge lastUpdate={det.lastUpdate} now={now} connected={!det.error} />
            <ViewToggle compact active={!showReport} onClick={() => setShowReport((v) => !v)} label={showReport ? 'Focus' : 'Report'} icon={showReport ? EYE_OFF : EYE} />
          </div>
        </div>

        {/* Overview stats — includes live-camera trash count from WebcamDetect */}
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Total" value={list.length} />
          <Stat label="Located" value={locatedCount} level="ok" />
          <Stat label="Unlocated" value={list.length - locatedCount} level="warn" />
          <Stat label="Live-cam trash" value={trashStats.peak} />
        </div>

        <div className="flex max-h-[58vh] flex-col gap-2 overflow-y-auto pr-1">
          {det.loading && list.length === 0 ? (
            <Spinner label="Loading detections" />
          ) : list.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted">
              No backend debris records yet.
              {trashStats.peak > 0 && (
                <div className="mt-1 text-xs">Live camera peaked at <span className="font-mono text-accent">{trashStats.peak}</span> trash item(s).</div>
              )}
            </div>
          ) : (
            list.map((d, i) => {
              const k = keyOf(d, i)
              return <DetectionRow key={k} d={d} i={i} expanded={expanded === k} onToggle={() => setExpanded(expanded === k ? null : k)} />
            })
          )}
        </div>
      </TiltCard>

      <AnimatePresence>
        {showReport && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
            <TiltCard className="flex h-full flex-col p-5">
              <h2 className="mb-1 text-base font-semibold text-ink">AI environmental report</h2>
              <p className="mb-3 text-xs text-muted">
                Generates a Word document with 3D graphs and analysis of the detected trash, written by Google Gemini from your detection data.
              </p>

              <label className="mb-1 text-[10px] uppercase tracking-wider text-muted">Gemini API key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your Gemini API key"
                autoComplete="off"
                spellCheck={false}
                className="inp touch mb-1 w-full px-3 text-sm"
              />
              <p className="mb-3 text-[10px] text-muted">
                Stored only in this browser. No key → a built-in report is generated instead.
              </p>

              <Btn disabled={reporting} onClick={generateReport} className="mb-2">
                {reporting ? 'Generating…' : 'Generate report (Word)'}
              </Btn>

              <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-[11px] text-muted">
                <span>
                  Live-cam peak: <span className="font-mono tnum text-ink">{trashStats.peak}</span>
                  {trashStats.updatedAt > 0 && <span className="ml-1">· {fmtClock(trashStats.updatedAt)}</span>}
                </span>
                <button
                  onClick={() => { resetTrashStats(); toast.push({ level: 'ok', title: 'Live-cam count reset' }) }}
                  className="rounded-md px-2 py-1 font-semibold text-muted transition-colors hover:text-ink"
                >
                  Reset
                </button>
              </div>
            </TiltCard>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
