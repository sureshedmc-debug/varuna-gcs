// The website's home page (/): the two ways in — open the app, or explore —
// then the whole project as one long story: problem, how it works, the
// machines, why it is different, photos and film, who made it, and feedback.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { navigate } from './router'
import { EASE, Icon, LoopVideo, Nav, Footer, Reveal, useActiveSection } from './parts'
import { M, STEPS, MACHINES, STACK, COMPARE, GALLERY, TEAM, FAQ, AWARD, AWARD_MEDIA, BOAT_REELS, MATCH_CLIP, CONTACT } from './content'
import Feedback from './Feedback'
import { openDownloads } from './downloads'

const SECTIONS = ['achievements', 'story', 'how', 'water', 'tech', 'gallery', 'team', 'feedback']

const toSection = (id) => (e) => {
  e.preventDefault()
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

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

// A sprig of laurel leaves along a curve, either side of the 1st-place medal.
function Laurel({ flip }) {
  const P = [[46, 112], [12, 92], [6, 46], [30, 6]] // cubic Bézier, bottom to top
  const at = (t) => {
    const u = 1 - t
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
    const d = [-3 * u * u, 3 * u * u - 6 * u * t, 6 * u * t - 3 * t * t, 3 * t * t]
    const sum = (k, i) => k.reduce((a, c, j) => a + c * P[j][i], 0)
    return { x: sum(w, 0), y: sum(w, 1), a: (Math.atan2(sum(d, 1), sum(d, 0)) * 180) / Math.PI }
  }
  return (
    <svg className={`vs-laurel${flip ? ' flip' : ''}`} viewBox="0 0 60 120" aria-hidden="true">
      <path d="M46 112C12 92 6 46 30 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      {[0.12, 0.26, 0.4, 0.54, 0.68, 0.82].map((t) => {
        const p = at(t)
        return (
          <g key={t}>
            <ellipse cx={p.x} cy={p.y} rx="10" ry="4.2" fill="currentColor" transform={`rotate(${p.a - 40} ${p.x} ${p.y}) translate(-8 0)`} />
            <ellipse cx={p.x} cy={p.y} rx="9" ry="3.8" fill="currentColor" opacity="0.75" transform={`rotate(${p.a + 40} ${p.x} ${p.y}) translate(-8 0)`} />
          </g>
        )
      })}
      <ellipse cx="31" cy="8" rx="4.5" ry="8" fill="currentColor" transform="rotate(25 31 8)" />
    </svg>
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
        <div className="vs-hero-media"><LoopVideo name="hero-1080" phone="hero-540" eager /></div>
        <div className="vs-aurora" />
        <div className="vs-hero-body">
          <motion.a href="#achievements" className="vs-award-pill" onClick={toSection('achievements')}
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.9, ease: EASE }}>
            <span className="cup"><Icon name="trophy" size={16} stroke={2} /></span>
            <b>1st place</b>
            <span className="where">DoE Science Centre No. 4</span>
            <i aria-hidden="true" />
            <span>Selected for Skill Expo</span>
            <Icon name="arrow" size={14} className="go" />
          </motion.a>
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
            <span className="t"><b>Download the VARUNA app</b><small>Android · Windows · sign in with Google to download</small></span>
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

      {/* ── achievements ── */}
      <section id="achievements" className="vs-sec vs-award-sec">
        <div className="vs-award-glow" aria-hidden="true" />
        <div className="vs-wrap">
          <div className="vs-sec-head center">
            <Reveal><span className="vs-kicker gold">Achievements</span></Reveal>
            <Reveal delay={0.05}><h2 className="vs-h2">First place. <span className="vs-gold">Selected for Skill Expo.</span></h2></Reveal>
            <Reveal delay={0.1}>
              <p className="vs-lead">VARUNA AI won <b>Position I</b> in {AWARD.category} at the {AWARD.event} of the {AWARD.org}, at {AWARD.centre}, and goes on to Skill Expo.</p>
            </Reveal>
          </div>

          <Reveal as="button" type="button" className="vs-award-hero" y={50} onClick={() => setView({ items: AWARD_MEDIA, index: 0 })}
            aria-label="1st place, on stage: open the photo">
            <img src={M('award-stage-photo.jpg')} alt="Aditya Gautam and Samar Garg on stage with their 1st-place trophies and certificates at DoE Science Centre No. 4" loading="lazy" />
            <span className="vs-award-ribbon"><Icon name="trophy" size={15} stroke={2} /> 1st place · Position I</span>
            <span className="vs-award-hero-cap"><b>On stage at Science Centre No. 4</b><span>Prize-giving · {AWARD.event}</span></span>
            <span className="vs-tile-badge"><Icon name="expand" size={13} /></span>
          </Reveal>

          <div className="vs-award-grid">
            <Reveal className="vs-award-card">
              <div className="vs-medal">
                <Laurel />
                <b>1<sup>st</sup></b>
                <Laurel flip />
              </div>
              <span className="vs-award-pos">Position I · Winner</span>
              <h3>{AWARD.headline}</h3>
              <dl className="vs-award-facts">
                <div><dt>Event</dt><dd>{AWARD.event}</dd></div>
                <div><dt>Organised by</dt><dd>{AWARD.org}</dd></div>
                <div><dt>Category</dt><dd>{AWARD.category}</dd></div>
                <div><dt>Venue</dt><dd>{AWARD.venue}</dd></div>
              </dl>
              <div className="vs-award-next">
                <span className="ic"><Icon name="star" size={18} /></span>
                <div><b>{AWARD.next}</b><span>The certificate also marks the project as selected for the state level.</span></div>
              </div>
            </Reveal>
            <div className="vs-award-tiles">
              {AWARD_MEDIA.slice(1).map((g, i) => (
                <Reveal key={g.src} delay={0.06 * i} as="button" type="button" className="vs-tile vs-award-tile"
                  onClick={() => setView({ items: AWARD_MEDIA, index: i + 1 })} aria-label={`${g.title}: ${g.sub}`}>
                  {g.type === 'img' ? <img src={M(`${g.src}.jpg`)} alt="" loading="lazy" /> : <LoopVideo name={g.src} />}
                  <span className="vs-tile-badge"><Icon name={g.type === 'img' ? 'expand' : 'play'} size={13} /></span>
                  <span className="vs-tile-cap"><b>{g.title}</b><span>{g.sub}</span></span>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

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

      {/* ── the boat on the water ── */}
      <section id="water" className="vs-sec vs-water">
        <div className="vs-wrap">
          <Head center kicker="On the water" title={<>The boat, <span className="vs-grad">in action.</span></>}
            lead="New footage of Nirmal Dhara Jalyan, the tricolour collector boat: scooping up plastic, working under the drone, and running after dark." />
          <div className="vs-reels">
            {BOAT_REELS.map((r, i) => (
              <Reveal key={r.src} delay={0.08 * i} y={60} as="button" type="button" className="vs-reel"
                onClick={() => setView({ items: BOAT_REELS, index: i })} aria-label={`${r.title}: ${r.sub}`}>
                <span className="vs-reel-in"><LoopVideo name={r.src} /></span>
                <span className="vs-reel-tag">{r.tag}</span>
                <span className="vs-reel-cap"><b>{r.title}</b><span>{r.sub}</span></span>
              </Reveal>
            ))}
          </div>

          <div className="vs-match">
            <div className="vs-match-txt">
              <Reveal><span className="vs-kicker">Waste matching</span></Reveal>
              <Reveal delay={0.05}><h3>The boat checks it found the <span className="vs-grad">same plastic.</span></h3></Reveal>
              <Reveal delay={0.1}>
                <p>As the boat closes in, its own camera compares what it sees with the picture the drone took. Above 55% it counts as a match: here it is 61% sure, with the waste 24 m ahead.</p>
              </Reveal>
              <Reveal delay={0.15} className="vs-match-stats">
                <div><b className="vs-grad">61%</b><span>same waste</span></div>
                <div><b>24 m</b><span>to the target</span></div>
                <div><b>Live</b><span>boat camera</span></div>
              </Reveal>
            </div>
            <Reveal y={60} style={{ position: 'relative' }}>
              <div className="vs-frame-glow" />
              <button type="button" className="vs-frame vs-match-frame" onClick={() => setView({ items: MATCH_CLIP, index: 0 })} aria-label="Waste matched: play the clip big">
                <span className="vs-frame-in"><LoopVideo name="app-match" /><span className="vs-frame-tag">VARUNA app · Waste matched</span></span>
              </button>
            </Reveal>
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
            lead={`VARUNA AI was created by ${TEAM.makers.map((p) => p.name).join(" and ")}, students of ${TEAM.school}, for the theme ${TEAM.theme}. The drone, the boat and the VARUNA GCS ground-control app were designed, wired, coded and tested by hand.`} />
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
              <a className="vs-team-award" href="#achievements" onClick={toSection('achievements')}>
                <span className="ic"><Icon name="trophy" size={18} stroke={2} /></span>
                <span><small>Award</small><b>1st place · DoE Science Centre No. 4 · Selected for Skill Expo</b></span>
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── contact ── */}
      <section id="contact" className="vs-sec" style={{ paddingTop: 0 }}>
        <div className="vs-wrap">
          <Reveal className="vs-contact">
            <div className="vs-contact-txt">
              <span className="vs-kicker">Contact</span>
              <h2 className="vs-h2">Let&apos;s talk about <span className="vs-grad">VARUNA AI.</span></h2>
              <p className="vs-lead">For any enquiry, funding or sponsorship, a partnership or a demo, call or WhatsApp {CONTACT.name}, the creator of VARUNA AI, directly.</p>
              <ul className="vs-contact-topics">{CONTACT.topics.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
            <div className="vs-contact-call">
              <span className="ic"><Icon name="call" size={26} /></span>
              <small>Call or WhatsApp {CONTACT.name}</small>
              <a className="num" href={`tel:${CONTACT.tel}`}>{CONTACT.phone}</a>
              <div className="acts">
                <a className="go" href={`tel:${CONTACT.tel}`}><Icon name="call" size={16} /> Call now</a>
                <a className="go wa" href={CONTACT.whatsapp} target="_blank" rel="noopener noreferrer"><Icon name="whatsapp" size={18} /> WhatsApp</a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── questions ── */}
      <section id="faq" className="vs-sec" style={{ paddingTop: 0 }}>
        <div className="vs-wrap">
          <Head kicker="Questions" title={<>VARUNA AI, <span className="vs-grad">answered.</span></>} />
          <div className="vs-faq">
            {FAQ.map((f, i) => (
              <Reveal key={f.q} className="vs-faq-item" delay={Math.min(i, 3) * 0.04}>
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </Reveal>
            ))}
          </div>
          <p className="vs-faq-more"><a href="/about">More about VARUNA AI and its creators →</a></p>
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
