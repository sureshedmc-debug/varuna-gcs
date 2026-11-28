import { useState } from 'react'

// Plain-language building blocks shared by the simplified tabs (styles/simple.css).

const ICONS = {
  boat: <><path d="M3 15l2.5 4h13L21 15H3z" /><path d="M12 4v11M12 5l6 7h-6" /></>,
  mission: <><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></>,
  detections: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.3-4.3" /><path d="M9 11h4M11 9v4" /></>,
  system: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  live: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /></>,
  replay: <><path d="M3 12a9 9 0 103-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 8v4l3 2" /></>,
  data: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
}

export function TabIcon({ name, size = 22 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] || ICONS.system}
    </svg>
  )
}

/**
 * The plain header every simplified tab starts with: what this tab is for and
 * what to do first, in words a first-time user understands.
 */
export function TabHeader({ icon, title, hint, children, floating = false, className = '' }) {
  return (
    <header className={`sx-head ${floating ? 'floating' : ''} ${className}`}>
      <span className="sx-head-icon"><TabIcon name={icon} size={floating ? 19 : 22} /></span>
      <div className="sx-head-txt">
        <h1>{title}</h1>
        {hint && <p>{hint}</p>}
      </div>
      {children && <div className="sx-head-right">{children}</div>}
    </header>
  )
}

/** A status pill: tone ok | warn | bad | info | '' */
export function Pill({ tone = '', pulse = false, children, title }) {
  return <span className={`sx-pill ${tone} ${pulse ? 'pulse' : ''}`} title={title}><i />{children}</span>
}

/**
 * "More options": advanced controls folded away (nothing is removed, just out
 * of the way). Remembers open/closed per tab in this browser.
 */
export function MoreOptions({ id, title = 'More options', hint, defaultOpen = false, children, className = '' }) {
  const key = `varuna.fold.${id}`
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v == null ? defaultOpen : v === '1'
    } catch {
      return defaultOpen
    }
  })
  return (
    <details className={`sx-fold ${className}`} open={open} onToggle={(e) => {
      const o = e.currentTarget.open
      setOpen(o)
      try {
        localStorage.setItem(key, o ? '1' : '0')
      } catch {
        /* private mode */
      }
    }}>
      <summary>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
        <span>{title}{hint && <small> · {hint}</small>}</span>
        <svg className="sx-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      {open && <div className="sx-fold-body">{children}</div>}
    </details>
  )
}

/** "1 Do this · 2 Then this · 3 Done" */
export function Steps({ items }) {
  return (
    <div className="sx-steps" aria-label="Steps">
      {items.map((s, i) => <span key={s}><b>{i + 1}</b>{s}</span>)}
    </div>
  )
}

/** One width and spacing for the document-style tabs. */
export function Page({ children, className = '' }) {
  return <div className={`sx-page ${className}`}>{children}</div>
}

/** A titled card: title + optional subtitle on the left, actions on the right. */
export function Section({ title, sub, actions, children, className = '', bodyClass = '', flush = false }) {
  return (
    <section className={`sx-section ${className}`}>
      {(title || actions) && (
        <div className="sx-section-head">
          <div className="min-w-[180px] flex-1">
            {title && <h2>{title}</h2>}
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? bodyClass : `sx-section-body ${bodyClass}`}>{children}</div>
    </section>
  )
}

/** A KPI tile: label, big number with a unit, optional note. */
export function Kpi({ label, value, unit, note, color }) {
  return (
    <div className="sx-kpi">
      <div className="k">{color && <i style={{ width: 8, height: 8, borderRadius: 99, background: color, display: 'inline-block' }} />}{label}</div>
      <div className="v">{value}{unit && <small>{unit}</small>}</div>
      {note && <div className="d">{note}</div>}
    </div>
  )
}

/** Nothing here yet: what it is and what to do first. */
export function EmptyState({ icon = 'system', title, children, action }) {
  return (
    <div className="sx-empty">
      <span className="ic"><TabIcon name={icon} size={26} /></span>
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}
