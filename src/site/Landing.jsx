// The front door of the website: what Varuna is in one screen, and the two
// ways in — open the app, or explore the project.
import { motion } from 'framer-motion'
import { navigate } from './router'
import { EASE, Icon, LoopVideo, Nav, Footer } from './parts'
import { STACK } from './content'

const rise = (i) => ({
  initial: { opacity: 0, y: 40 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 1.1, ease: EASE, delay: 0.25 + i * 0.09 },
})

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

export default function Landing() {
  return (
    <>
      <Nav />
      <section className="vs-hero">
        <div className="vs-hero-media"><LoopVideo name="render-night" rate={0.55} eager /></div>
        <div className="vs-aurora" />
        <div className="vs-hero-body">
          <motion.div {...rise(0)}>
            <span className="vs-chip"><b>LIVE</b> Student-built · real prototype · flying and floating</span>
          </motion.div>
          <h1 className="vs-display" aria-label="Find it from the sky. Collect it on the water.">
            {['Find it from the sky.', 'Collect it on the water.'].map((l, i) => (
              <span className="line" key={l} aria-hidden="true">
                <motion.span className={i ? 'vs-grad' : ''} initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ duration: 1.25, ease: EASE, delay: 0.35 + i * 0.12 }}>{l}</motion.span>
              </span>
            ))}
          </h1>
          <motion.p className="vs-hero-sub" {...rise(3)}>
            VARUNA AI pairs an AI drone that spots floating plastic with <b style={{ color: '#fff' }}>Nirmal Dhara Jalyan</b>, a solar-powered
            autonomous boat that goes and collects it — all run from one ground-control app.
          </motion.p>

          <div className="vs-choices">
            <Choice i={4} main icon="app" small="For operators" title="Open the app"
              text="Plan missions, watch the drone's AI feed and drive the boat. Sign in first." onClick={() => navigate('/app')} />
            <Choice i={5} icon="compass" small="For everyone" title="Explore Varuna"
              text="The problem, how it works, the machines, the team, photos and the film." onClick={() => navigate('/explore')} />
          </div>

          <motion.div className="vs-hero-foot" {...rise(7)}>
            <div className="vs-stats">
              <div className="vs-stat"><b>2</b><span>machines, one mission</span></div>
              <div className="vs-stat"><b>3</b><span>steps: detect · locate · collect</span></div>
              <div className="vs-stat"><b className="vs-grad">AI</b><span>on the live drone feed</span></div>
              <div className="vs-stat"><b>☀</b><span>solar-powered boat</span></div>
            </div>
            <button type="button" className="vs-scroll" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => navigate('/explore')}>
              <i /> EXPLORE
            </button>
          </motion.div>
        </div>
      </section>

      <div className="vs-marquee" aria-label="Built with">
        <div className="vs-marquee-track">
          {[0, 1].map((k) => STACK.map((s) => <span key={`${k}-${s}`} aria-hidden={k === 1}>{s}</span>))}
        </div>
      </div>

      <Footer />
    </>
  )
}
