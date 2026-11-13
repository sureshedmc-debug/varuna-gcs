// The website's home page (/): the two ways in — open the app, or explore —
// then the whole project as one long story: problem, how it works, the
// machines, why it is different, photos and film, who made it, and feedback.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { navigate } from './router'
import { EASE, Icon, LoopVideo, Nav, Footer, Reveal, useActiveSection } from './parts'
import { M, STEPS, MACHINES, STACK, COMPARE, GALLERY, TEAM } from './content'
import Feedback from './Feedback'
import { openDownloads } from './downloads'

const SECTIONS = ['story', 'how', 'tech', 'gallery', 'team', 'feedback']

const rise = (i) => ({
  initial: { opacity: 0, y: 30 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 1, ease: EASE, delay: 0.55 + i * 0.09 },
})

// The card follows the pointer with a soft glow.
function spotlight(e) {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
}

function Choice({ main, icon, small, title, text, onClick, i }) {
  return (
    <motion.button type="button" className={`vs-choice${main ? ' main' : ''}`} onClick={onClick} onPointerMove={spotlight} {...rise(i)}>
      <span className="vs-choice-icon"><Icon name={icon} size={24} /></span>
      <span className="vs-choice-txt"><small>{small}</small><b>{title}</b><span>{text}</span></span>
      <span className="vs-choice-go"><Icon name="arrow" size={18} /></span>
    </motion.button>
  )
}

function Head({ kicker, title, lead, center }) {
  return (
    <div className={`vs-sec-head${center ? ' center' : ''}`}>
      <Reveal><span className="vs-kicker">{kicker}</span></Reveal>
      <Reveal delay={0.05}><h2 className="vs-h2">{title}</h2></Reveal>
      {lead && <Reveal delay={0.1}><p className="vs-lead">{lead}</p></Reveal>}
    </div>
  )
}

/** Full-screen viewer for the gallery (arrows / swipe-free) and the film. */
function Viewer({ items, index, onIndex, onClose }) {
  const it = items[index]
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onClose()
      if (items.length > 1 && e.key === 'ArrowRight') onIndex((index + 1) % items.length)
      if (items.length > 1 && e.key === 'ArrowLeft') onIndex((index - 1 + items.length) % items.length)
    }
    window.addEventListener('keydown', key)
    document.documentElement.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', key)
      document.documentElement.style.overflow = ''
    }
  }, [index, items.length, onIndex, onClose])
  return (
    <motion.div className="vs-modal" role="dialog" aria-modal="true" aria-label={it.title} onClick={(e) => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
      <button type="button" className="vs-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      {items.length > 1 && (
        <>
          <button type="button" className="vs-arrow l" aria-label="Previous" onClick={() => onIndex((index - 1 + items.length) % items.length)}><Icon name="left" /></button>
          <button type="button" className="vs-arrow r" aria-label="Next" onClick={() => onIndex((index + 1) % items.length)}><Icon name="right" /></button>
        </>
      )}
      <motion.div key={index} className="vs-modal-in" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.45, ease: EASE }}>
        {it.type === 'img'
          ? <img src={M(`${it.src}.jpg`)} alt={it.title} />
          : <video src={M(`${it.src}.mp4`)} poster={M(`${it.poster}.jpg`)} controls autoPlay playsInline muted={!it.sound} loop={!it.sound} />}
        <div className="vs-modal-cap"><b>{it.title}</b>{it.sub}</div>
      </motion.div>
    </motion.div>
  )
}

const FILM = [{ type: 'video', src: 'film', poster: 'p-poster', title: 'VARUNA AI — the film', sub: 'The drone and the boat, start to finish', sound: true }]

export default function Explore() {
  const active = useActiveSection(SECTIONS)
  const [view, setView] = useState(null) // { items, index }

  return (
    <>
      <Nav active={active} />

      {/* ── opening ── */}
      <section className="vs-xhero">
        <div className="vs-hero-media"><LoopVideo name="hero-1080" eager /></div>
        <div className="vs-aurora" />
        <div className="vs-hero-body">
          <motion.span className="vs-eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3, duration: 1 }}>
            <span className="dot" /> Explore Varuna · {TEAM.theme}
          </motion.span>
          <h1 className="vs-display" aria-label="Rivers deserve better.">
            {['Rivers', 'deserve better.'].map((l, i) => (
              <span className="line" key={l} aria-hidden="true">
                <motion.span className={i ? 'vs-grad' : ''} initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ duration: 1.2, ease: EASE, delay: 0.3 + i * 0.12 }}>{l}</motion.span>
              </span>
            ))}
          </h1>
          <motion.p className="vs-hero-sub" {...rise(0)}>
            This is the story of VARUNA AI: why we built a drone and a boat to clean rivers, how they work together, and the people behind them.
          </motion.p>

          <div className="vs-choices">
            <Choice i={1} main icon="app" small="For operators" title="Open the app"
              text="Plan missions, watch the drone's AI feed and drive the boat. Sign in first." onClick={() => navigate('/app')} />
            <Choice i={2} icon="compass" small="For everyone" title="Explore Varuna"
              text="The problem, how it works, the machines, the team, photos and the film."
              onClick={() => document.getElementById('story')?.scrollIntoView({ behavior: 'smooth' })} />
          </div>

          <motion.button type="button" className="vs-dlbtn" onClick={openDownloads} {...rise(3)}>
            <span className="ic"><Icon name="download" size={24} stroke={2.2} /></span>
            <span className="t"><b>Download the VARUNA app</b><small>Android · Windows · install on any device</small></span>
            <span className="go">Free download <Icon name="arrow" size={16} /></span>
          </motion.button>

          <motion.div className="vs-hero-foot" {...rise(4)}>
            <button type="button" className="vs-play" onClick={() => setView({ items: FILM, index: 0 })}>
              <i><Icon name="play" size={22} /></i>
              <span><b>Watch the film</b><small>56 seconds · sound on</small></span>
            </button>
            <button type="button" className="vs-play vs-try-pill" onClick={() => navigate('/try')}>
              <i><Icon name="compass" size={22} /></i>
              <span><b>Try the AI on your webcam</b><small>Live demo · no sign-in</small></span>
            </button>
            <div className="vs-stats">
              <div className="vs-stat"><b>2</b><span>machines, one mission</span></div>
              <div className="vs-stat"><b>3</b><span>steps: detect · locate · collect</span></div>
              <div className="vs-stat"><b className="vs-grad">AI</b><span>on the live drone feed</span></div>
            </div>
          </motion.div>
        </div>
      </section>

      <div className="vs-marquee" aria-label="Built with">
        <div className="vs-marquee-track">
          {[0, 1].map((k) => STACK.map((s) => <span key={`${k}-${s}`} aria-hidden={k === 1}>{s}</span>))}
        </div>
      </div>

      {/* ── the problem ── */}
      <section id="story" className="vs-sec">
        <div className="vs-wrap vs-problem">
          <Reveal className="vs-problem-media">
            <img src={M('p-detect.jpg')} alt="The drone's camera marking a plastic bag floating in water" loading="lazy" />
            <div className="vs-problem-cap"><b>Plastic on the water</b>Seen through the drone's own camera</div>
          </Reveal>
          <div>
            <Head kicker="The problem" title={<>Plastic is choking <span className="vs-grad">our rivers.</span></>}
              lead="Bottles and bags drift down rivers every day. Floating plastic is hard to find and harder to collect: today it is done by people in boats, with nets, by eye — slow, tiring and often risky." />
            <div className="vs-pains">
              {[
                ['Hard to find', 'Waste spreads across wide water; spotting it from a bank or a boat misses most of it.'],
                ['Slow to collect', 'Nets and manual labour clean a little at a time, and the river keeps bringing more.'],
                ['People at risk', 'Cleanup crews work on and in polluted water, for hours.'],
              ].map(([t, d], i) => (
                <Reveal key={t} delay={0.08 * i} className="vs-pain"><i>0{i + 1}</i><div><b>{t}</b><span>{d}</span></div></Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── how it works ── */}
      <section id="how" className="vs-sec" style={{ paddingTop: 0 }}>
        <div className="vs-wrap">
          <Head center kicker="How it works" title={<>Three steps. <span className="vs-grad">Zero hands</span> in the water.</>}
            lead="A drone that sees, an app that thinks and a boat that collects — each one hands the job to the next." />
          <div className="vs-steps">
            {STEPS.map((s) => (
              <div className="vs-step" key={s.n}>
                <div className="vs-step-txt">
                  <Reveal><div className="vs-step-n">{s.n}</div></Reveal>
                  <Reveal delay={0.05}><span className="vs-kicker vs-step-k">{s.kicker}</span></Reveal>
                  <Reveal delay={0.1}><h3>{s.title}</h3></Reveal>
                  <Reveal delay={0.15}><p>{s.body}</p></Reveal>
                </div>
                <Reveal y={60} style={{ position: 'relative' }}>
                  <div className="vs-frame-glow" />
                  <div className="vs-frame">
                    <div className="vs-frame-in">
                      <LoopVideo name={s.video} />
                      <span className="vs-frame-tag">{s.tag}</span>
                    </div>
                  </div>
                </Reveal>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── machines + tech ── */}
      <section id="tech" className="vs-sec" style={{ background: 'linear-gradient(180deg, transparent, var(--bg2) 20%, var(--bg2) 80%, transparent)' }}>
        <div className="vs-wrap">
          <Head center kicker="The technology" title={<>Engineered <span className="vs-grad">end to end.</span></>}
            lead="Two vehicles built by hand and one app written from scratch: flight controllers, on-board computers, computer vision and a full ground station." />
          <div className="vs-machines">
            {MACHINES.map((m, i) => (
              <Reveal key={m.name} delay={0.08 * i} className="vs-machine">
                <div className="vs-machine-img"><img src={M(`${m.img}.jpg`)} alt={m.name} loading="lazy" /></div>
                <div className="vs-machine-body">
                  <small>{m.role}</small>
                  <h3>{m.name}</h3>
                  <ul>{m.specs.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal className="vs-stack">{STACK.map((s) => <span key={s}>{s}</span>)}</Reveal>

          <div style={{ marginTop: 'clamp(90px, 12vw, 150px)' }}>
            <Head kicker="Why Varuna stands out" title={<>Not a net. <span className="vs-grad">A system.</span></>} />
            <Reveal className="vs-compare">
              <div className="vs-compare-row head"><span>&nbsp;</span><span>Traditional clean-up</span><span>VARUNA AI</span></div>
              {COMPARE.map(([a, b, c]) => (
                <div className="vs-compare-row" key={a}><b>{a}</b><span className="old">{b}</span><span className="new">{c}</span></div>
              ))}
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── gallery + film ── */}
      <section id="gallery" className="vs-sec">
        <div className="vs-wrap">
          <Head kicker="Gallery" title={<>Built, flown and <span className="vs-grad">floated.</span></>}
            lead="Real photos and clips from building and testing the prototype. Tap any one to see it big." />
          <div className="vs-gallery">
            {GALLERY.map((g, i) => (
              <Reveal key={g.src} delay={(i % 4) * 0.06} as="button" type="button" className={`vs-tile${g.wide ? ' wide' : ''}`}
                onClick={() => setView({ items: GALLERY, index: i })} aria-label={`${g.title}: ${g.sub}`}>
                {g.type === 'img' ? <img src={M(`${g.src}.jpg`)} alt="" loading="lazy" /> : <LoopVideo name={g.src} />}
                <span className="vs-tile-badge"><Icon name={g.type === 'img' ? 'expand' : 'play'} size={13} /></span>
                <span className="vs-tile-cap"><b>{g.title}</b><span>{g.sub}</span></span>
              </Reveal>
            ))}
          </div>

          <Reveal as="button" type="button" className="vs-film" style={{ display: 'block', width: '100%', padding: 0 }}
            onClick={() => setView({ items: FILM, index: 0 })} aria-label="Play the VARUNA AI film">
            <img src={M('p-poster.jpg')} alt="" loading="lazy" />
            <span className="vs-film-play"><i><Icon name="play" size={34} /></i></span>
            <span className="vs-film-cap" style={{ textAlign: 'left' }}><b>Watch the film</b><span>VARUNA AI · AI drone + robot boat cleaning our rivers</span></span>
          </Reveal>
        </div>
      </section>

      {/* ── team ── */}
      <section id="team" className="vs-sec" style={{ paddingTop: 0 }}>
        <div className="vs-wrap vs-team">
          <Head kicker="Who made it" title={<>Made by students, <span className="vs-grad">for every river.</span></>}
            lead={`VARUNA AI was created by ${TEAM.makers[0].name}, a student of ${TEAM.school}, for the theme ${TEAM.theme}. The drone, the boat and the VARUNA GCS ground-control app were designed, wired, coded and tested by hand.`} />
          <Reveal className="vs-team-card">
            {TEAM.makers.map((p) => (
              <div className="vs-maker" key={p.name}>
                <span className="vs-maker-av">{p.initials}</span>
                <div><b>{p.name}</b><span>{p.role}</span></div>
              </div>
            ))}
            <div className="vs-team-facts">
              <div><small>School</small><b>{TEAM.school}</b></div>
              <div><small>Theme</small><b>{TEAM.theme}</b></div>
              <div><small>Drone</small><b>Varuna · AI aerial scout</b></div>
              <div><small>Boat</small><b>Nirmal Dhara Jalyan</b></div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── call to action ── */}
      <section className="vs-sec" style={{ paddingTop: 0 }}>
        <div className="vs-wrap">
          <Reveal className="vs-cta">
            <LoopVideo name="render-day" />
            <span className="vs-kicker">Try it yourself</span>
            <h2 className="vs-h2" style={{ maxWidth: 820, marginInline: 'auto' }}>Fly the mission from <span className="vs-grad">your screen.</span></h2>
            <p className="vs-lead" style={{ marginInline: 'auto' }}>Sign in and open the same ground-control app the team uses — plan a river mission, watch the drone feed and drive the boat in the simulator.</p>
            <div className="row">
              <button type="button" className="vs-btn primary" onClick={() => navigate('/app')}>Open the app <Icon name="arrow" size={16} className="arrow" /></button>
              <button type="button" className="vs-btn ghost" onClick={openDownloads}><Icon name="download" size={16} /> Download the app</button>
              <button type="button" className="vs-btn ghost" onClick={() => document.getElementById('feedback')?.scrollIntoView({ behavior: 'smooth' })}>Leave feedback</button>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── feedback ── */}
      <section id="feedback" className="vs-sec" style={{ paddingTop: 0 }}>
        <div className="vs-wrap vs-fb">
          <div>
            <Head kicker="Feedback" title={<>Tell us what <span className="vs-grad">you think.</span></>}
              lead="Judges, teachers, engineers, students — every note helps us make Varuna better. It takes less than a minute." />
            <Reveal delay={0.15} style={{ marginTop: 30, display: 'grid', gap: 12, color: 'var(--ink2)', fontSize: 14 }}>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Icon name="shield" size={18} /> Name and email are optional.</span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Icon name="check" size={18} /> Read by the Varuna team.</span>
            </Reveal>
          </div>
          <Reveal delay={0.1}><Feedback /></Reveal>
        </div>
      </section>

      <Footer />

      <AnimatePresence>
        {view && <Viewer items={view.items} index={view.index} onIndex={(index) => setView((v) => ({ ...v, index }))} onClose={() => setView(null)} />}
      </AnimatePresence>
    </>
  )
}
