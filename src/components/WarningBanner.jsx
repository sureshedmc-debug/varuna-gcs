import { AnimatePresence, motion } from 'framer-motion'
import { StatusOrb } from './ui'

/**
 * Impossible-to-miss banner for real hardware faults. Undervoltage on this
 * project has previously caused stream failures, so it must never be buried.
 */
export function WarningBanner({ warnings = [] }) {
  return (
    <div className="fixed inset-x-0 top-[54px] z-50 flex flex-col items-center gap-1 px-2 pt-2 md:pl-[86px]">
      <AnimatePresence>
        {warnings.map((w) => (
          <motion.div
            key={w.key}
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
            className="flex w-full max-w-3xl items-center gap-3 rounded-xl px-4 py-2.5 shadow-elev"
            style={{
              background: w.level === 'bad' ? 'rgba(239,68,68,0.18)' : 'rgba(245,158,11,0.16)',
              border: `1px solid ${w.level === 'bad' ? '#EF4444' : '#F59E0B'}66`,
              backdropFilter: 'blur(16px)',
            }}
          >
            <StatusOrb level={w.level} size={12} pulse />
            <div className="flex-1">
              <div className="text-sm font-bold" style={{ color: w.level === 'bad' ? '#FCA5A5' : '#FCD34D' }}>
                {w.title}
              </div>
              {w.msg && <div className="text-xs text-ink/80">{w.msg}</div>}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

/** Derive warning banners from pi metrics + backend reachability. */
export function deriveWarnings({ pi, backendReachable }) {
  const out = []
  if (backendReachable === false) {
    out.push({
      key: 'backend',
      level: 'bad',
      title: 'Backend unreachable',
      msg: 'No response from the drone. Retrying…',
    })
  }
  const th = pi?.throttledState || pi?.throttled_state || pi?.throttled
  if (th && typeof th === 'object') {
    if (th.under_voltage || th.undervoltage || th.under_voltage_now) {
      out.push({
        key: 'uv',
        level: 'bad',
        title: 'UNDERVOLTAGE DETECTED',
        msg: 'Pi power supply is low — this can crash the camera/stream. Check power now.',
      })
    } else if (th.throttled || th.frequency_capped || th.soft_temp_limit) {
      out.push({
        key: 'throttle',
        level: 'warn',
        title: 'Pi throttled',
        msg: 'CPU is being throttled (heat/power). Performance may degrade.',
      })
    }
  } else if (typeof th === 'string' && /under|0x[0-9a-f]*[13579bdf]/i.test(th)) {
    out.push({ key: 'uv', level: 'bad', title: 'UNDERVOLTAGE / THROTTLE', msg: `throttled state: ${th}` })
  }
  const temp = pi?.temperature ?? pi?.temp ?? pi?.cpu_temp
  if (typeof temp === 'number' && temp >= 80) {
    out.push({ key: 'temp', level: 'warn', title: `High temperature · ${temp.toFixed(0)}°C`, msg: 'Pi is running hot.' })
  }
  return out
}
