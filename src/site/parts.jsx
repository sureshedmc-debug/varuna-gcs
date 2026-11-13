// Shared pieces of the website: icons, reveal-on-scroll, lazy looping video,
// the top navigation bar and the footer.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useUser, displayName, logout } from '../lib/auth'
import { navigate, linkProps, usePath } from './router'
import { M, NAV } from './content'

export const EASE = [0.16, 1, 0.3, 1]

const P = {
  arrow: <path d="M5 12h14M13 5l7 7-7 7" />,
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  app: <><rect x="3" y="4" width="18" height="13" rx="2.5" /><path d="M8 21h8M12 17v4" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  left: <path d="M15 5l-7 7 7 7" />,
  right: <path d="M9 5l7 7-7 7" />,
  star: <path d="M12 3.5l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L12 16.8l-5.3 2.9 1.2-5.9L3.4 9.7l6-.7z" fill="currentColor" stroke="none" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  download: <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" />,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
  windows: <path d="M3 5.5l7.5-1v7H3zM12 4.3 21 3v8.5h-9zM3 12.5h7.5v7l-7.5-1zM12 12.5h9V21l-9-1.3z" fill="currentColor" stroke="none" />,
  share: <><path d="M12 15V3m0 0L8 7m4-4 4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" /></>,
}

export function Icon({ name, size = 20, className, stroke = 1.8 }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  )
}

/** Fades and rises into view once, when scrolled to. */
export function Reveal({ as = 'div', delay = 0, y = 34, children, ...rest }) {
  const C = motion[as]
  return (
    <C initial={{ opacity: 0, y }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.9, ease: EASE, delay }} {...rest}>
      {children}
    </C>
  )
}

/** A muted looping clip that only downloads and plays while it is on screen. */
export function LoopVideo({ name, className, rate = 1, eager = false }) {
  const ref = useRef(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    v.playbackRate = rate
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        v.playbackRate = rate
        v.play().catch(() => {})
      } else v.pause()
    }, { rootMargin: '200px' })
    io.observe(v)
    return () => io.disconnect()
  }, [rate])
  return (
    <video ref={ref} className={className} src={M(`${name}.mp4`)} poster={M(`${name}.jpg`)} muted loop playsInline
      preload={eager ? 'auto' : 'none'} autoPlay={eager} aria-hidden="true" />
  )
}

function UserMenu({ user }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const off = (e) => !ref.current?.contains(e.target) && setOpen(false)
    window.addEventListener('pointerdown', off)
    return () => window.removeEventListener('pointerdown', off)
  }, [open])
  const name = displayName(user)
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="vs-login" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="vs-avatar">{user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : name[0]?.toUpperCase()}</span>
        <span className="vs-hide-sm">{name}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="vs-user-pop" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }} transition={{ duration: 0.22, ease: EASE }}>
            <div className="who"><b>{user.name || user.username}</b><small>{user.email || (user.username && `@${user.username}`)}</small></div>
            <button type="button" onClick={() => { setOpen(false); navigate('/app') }}>Open the app</button>
            <button type="button" onClick={() => { setOpen(false); logout() }}>Sign out</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Top bar: brand, section links, Log in / account, Open app. */
export function Nav({ active }) {
  const user = useUser()
  const path = usePath()
  const [solid, setSolid] = useState(false)
  const [drawer, setDrawer] = useState(false)
  useEffect(() => {
    const on = () => setSolid(window.scrollY > 24)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  useEffect(() => {
    document.documentElement.style.overflow = drawer ? 'hidden' : ''
    return () => { document.documentElement.style.overflow = '' }
  }, [drawer])
  const login = () => navigate(`/login?next=${encodeURIComponent(path)}`)

  return (
    <>
      <motion.header className={`vs-nav${solid || drawer ? ' solid' : ''}`} initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.9, ease: EASE, delay: 0.15 }}>
        <div className="vs-nav-in">
          <a className="vs-brand" {...linkProps('/', () => window.scrollTo({ top: 0, behavior: 'smooth' }))} aria-label="VARUNA AI home">
            <img src={M('icon-192.png')} alt="" />
            <b>VARUNA<span className="vs-grad">AI</span></b>
          </a>
          <nav className="vs-links" aria-label="Sections">
            {NAV.map(([t, to]) => (
              <a key={t} className={active === to.split('#')[1] ? 'on' : ''} {...linkProps(to)}>{t}</a>
            ))}
          </nav>
          <div className="vs-nav-right">
            {user ? <UserMenu user={user} /> : (
              <button type="button" className="vs-login" onClick={login}><Icon name="user" size={16} /> Log in</button>
            )}
            <button type="button" className="vs-btn primary small vs-hide-sm" onClick={() => navigate('/app')}>Open app <Icon name="arrow" size={16} className="arrow" /></button>
            <button type="button" className="vs-menu-btn" aria-label={drawer ? 'Close menu' : 'Open menu'} aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>
              <i style={drawer ? { transform: 'translateY(2.75px) rotate(45deg)' } : undefined} />
              <i style={drawer ? { transform: 'translateY(-2.75px) rotate(-45deg)' } : undefined} />
            </button>
          </div>
        </div>
      </motion.header>
      <AnimatePresence>
        {drawer && (
          <motion.div className="vs-drawer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
            {NAV.map(([t, to], i) => (
              <motion.a key={t} className="big" {...linkProps(to, () => setDrawer(false))}
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 + i * 0.05, duration: 0.6, ease: EASE }}>
                {t}<small>0{i + 1}</small>
              </motion.a>
            ))}
            <div className="vs-drawer-foot">
              <button type="button" className="vs-btn primary block" onClick={() => { setDrawer(false); navigate('/app') }}>Open the app <Icon name="arrow" size={16} /></button>
              {!user && <button type="button" className="vs-btn ghost block" onClick={() => { setDrawer(false); login() }}>Log in</button>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/** Which section id is in the middle of the screen (for the nav dot). */
export function useActiveSection(ids) {
  const [active, setActive] = useState('')
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean)
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => e.isIntersecting && setActive(e.target.id))
    }, { rootMargin: '-45% 0px -50% 0px' })
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [ids])
  return active
}

export function Footer() {
  return (
    <footer className="vs-foot">
      <div className="vs-wrap">
        <div className="vs-foot-grid">
          <div>
            <a className="vs-brand" {...linkProps('/')}>
              <img src={M('icon-192.png')} alt="" />
              <b>VARUNA<span className="vs-grad">AI</span></b>
            </a>
            <p style={{ color: 'var(--ink2)', fontSize: 14, lineHeight: 1.65, maxWidth: 360, marginTop: 18 }}>
              An AI drone that finds floating plastic and an autonomous solar boat that collects it. Student-built, real prototype.
            </p>
          </div>
          <div>
            <h4>Explore</h4>
            <ul>{NAV.map(([t, to]) => <li key={t}><a {...linkProps(to)}>{t}</a></li>)}</ul>
          </div>
          <div>
            <h4>The app</h4>
            <ul>
              <li><a {...linkProps('/app')}>Open the app</a></li>
              <li><a {...linkProps('/login?next=/')}>Log in or sign up</a></li>
              <li><a {...linkProps('/explore#feedback')}>Send feedback</a></li>
            </ul>
          </div>
        </div>
        <div className="vs-foot-big" aria-hidden="true">VARUNA</div>
        <div className="vs-foot-bottom">
          <span>© {new Date().getFullYear()} VARUNA AI · Nirmal Dhara Jalyan</span>
          <span>Bhai Parmanand Vidya Mandir · Environment &amp; Sustainability</span>
        </div>
      </div>
    </footer>
  )
}
