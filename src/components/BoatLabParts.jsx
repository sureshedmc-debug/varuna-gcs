// Shared pieces of the Boat Vision / Water Lab tabs in the Home page's soft
// purple/white look (screens/boatLab.css).
import '../screens/boatLab.css'

export const HOMING_LABEL = {
  idle: { label: 'Standing by', tone: 'off' },
  search: { label: 'Searching', tone: 'warn' },
  track: { label: 'Tracking', tone: 'blue' },
  capture: { label: 'Driving through', tone: 'ok' },
  confirm: { label: 'Checking the ramp', tone: 'ok' },
  resuming: { label: 'Back to mission', tone: 'off' },
}
export const WILDLIFE_LABEL = {
  clear: { label: 'Clear', tone: 'ok' },
  paused: { label: 'Paused for wildlife', tone: 'warn' },
  alert: { label: 'Waiting for you', tone: 'bad' },
}

export function Chip({ tone = '', dot, pulse, children, title }) {
  return (
    <span title={title} className={`nl-chip ${tone}`}>
      {dot && <span className={`nl-dot${pulse ? ' pulse' : ''}`} />}
      {children}
    </span>
  )
}

export function Tile({ label, value, unit, tone }) {
  const color = tone === 'ok' ? 'var(--nl-ok)' : tone === 'warn' ? 'var(--nl-warn)' : tone === 'bad' ? 'var(--nl-bad)' : tone === 'blue' ? 'var(--nl-blue)' : undefined
  return (
    <div className="nl-tile">
      <div className="nl-label">{label}</div>
      <div className="nl-value" style={color ? { color } : undefined}>
        {value}{unit && <span className="ml-0.5 text-[10px] font-semibold nl-muted">{unit}</span>}
      </div>
    </div>
  )
}

/** Boat offline / wrong address, in the panel's light style. */
export function NlBoatOffline({ boat, onNavigate }) {
  const wrong = boat.wrongTarget
  const checking = boat.reachable === undefined
  return (
    <div className={`nl-card${checking ? '' : ' alert'}`}>
      <div className="mb-1 flex items-center gap-2">
        <Chip tone={checking ? 'off' : wrong ? 'warn' : 'bad'} dot pulse={!checking}>{checking ? 'CHECKING' : 'OFFLINE'}</Chip>
        <span className="nl-title">{checking ? 'Looking for the boat…' : wrong ? 'That address is not the boat' : 'Boat not connected'}</span>
      </div>
      {!checking && (
        <>
          <div className="nl-text nl-muted">
            {wrong ? "A VARUNA backend answered, but it isn't the boat's (it may be the drone's Pi)." : boat.linkHint || 'No answer from the boat Pi.'}
          </div>
          <div className="mt-1.5 nl-text nl-muted">
            Set the boat Pi's NetBird address in <b style={{ color: 'var(--nl-ink)' }}>System → Boat connection</b>. To practise without hardware run the simulator: <span className="nl-num" style={{ color: 'var(--nl-ink)' }}>python main.py --sim --port 8001</span>
          </div>
          <div className="mt-2.5 flex gap-2">
            <button className="nl-btn" onClick={() => onNavigate?.('system')}>Open System</button>
            <button className="nl-btn soft" onClick={() => boat.refreshPing?.()}>Retry</button>
          </div>
        </>
      )}
    </div>
  )
}

export function Switch({ on, onChange, label, disabled }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!on)} role="switch" aria-checked={!!on}
      className={`nl-switch${on ? ' on' : ''}`}>
      <span className="track"><span className="knob" /></span>
      {label}
    </button>
  )
}

