import { useEffect, useRef, useState } from 'react'
import { useBoat } from './BoatContext'
import { useOpsStatus, fmt8 } from '../lib/opsStatus'

// App-wide, on every tab: the moment a drone find reaches the boat, and the
// moment the boat's camera matches it, a large notice drops in at the top.
// Click it to open the Boat tab. Not shown on the Boat tab (its status line says the same).

const RED = '#FF453A'
const GREEN = '#32D74B'
const AMBER = '#FF9F0A'
const SHOW_MS = 12000

export default function OpsAlert({ onOpen, hidden = false }) {
  const boat = useBoat()
  const { ops } = useOpsStatus(boat.reachable === true)
  const [alert, setAlert] = useState(null)
  const since = useRef(Date.now() / 1000)
  const seen = useRef(new Set())

  useEffect(() => {
    if (!ops?.success) return
    const running = ops.live?.state === 'running'
    for (const e of ops.events || []) {
      if (e.t < since.current - 2) continue
      const key = `${e.t}|${e.text}`
      if (seen.current.has(key)) continue
      seen.current.add(key)
      const m = /^Drone detected plastic.*lat (-?[\d.]+), lng (-?[\d.]+)/.exec(e.text)
      if (m) {
        setAlert({
          id: key, color: running ? RED : AMBER, title: 'WASTE DETECTED',
          sub: running ? 'NIRMAL DHARA JALYAN MOVING TOWARDS IT' : 'Boat not moving — start live collect to send Nirmal Dhara Jalyan',
          detail: `Target ${fmt8(Number(m[1]))}, ${fmt8(Number(m[2]))}`, t: Date.now(),
        })
      } else if (/^Image match confirmed/.test(e.text)) {
        const pct = /— (\d+)%/.exec(e.text)
        setAlert({
          id: key, color: GREEN, title: 'WASTE DETECTED AND MATCHED', sub: 'HEADING TOWARDS IT',
          detail: pct ? `Match confidence ${pct[1]}%` : 'Seen by the boat camera', t: Date.now(),
        })
      }
    }
  }, [ops])

  useEffect(() => {
    if (!alert) return undefined
    const id = setTimeout(() => setAlert(null), SHOW_MS)
    return () => clearTimeout(id)
  }, [alert])

  if (!alert || hidden) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[64px] z-[60] flex justify-center px-3">
      <button type="button" onClick={() => { setAlert(null); onOpen?.() }}
        className="pointer-events-auto w-full max-w-xl rounded-2xl px-5 py-3 text-left shadow-2xl"
        style={{ background: `${alert.color}26`, border: `2px solid ${alert.color}`, backdropFilter: 'blur(14px)' }}>
        <div className="text-[22px] font-black leading-tight tracking-wide" style={{ color: alert.color }}>{alert.title}</div>
        <div className="text-[15px] font-extrabold leading-tight text-ink">{alert.sub}</div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11.5px] text-muted">
          <span className="font-mono">{alert.detail}</span>
          <span>Open Boat →</span>
        </div>
      </button>
    </div>
  )
}
