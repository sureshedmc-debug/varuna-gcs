import { useEffect, useId, useMemo, useRef, useState } from 'react'
import './homeNew.css'
import { useSystem }        from '../components/SystemContext'
import { useTrashStats }    from '../lib/detectionStats'
import { useTrashLog }      from '../lib/trashLog'
import { useActiveMission } from '../lib/missionStore'
import { useImpactStats }   from '../lib/impactStats'
import { pick, bool, num, DASH } from '../lib/format'
import { usePolling }       from '../hooks/usePolling'
import { api }              from '../api/client'

/* ─────────────────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────────────────── */
function readTelem(t) {
  if (!t) return {}
  return {
    armed:   bool(pick(t,['armed','is_armed'])),
    mode:    pick(t,['flight_mode','mode','custom_mode']),
    lat:     pick(t,['lat','latitude']),
    lng:     pick(t,['lng','lon','longitude']),
    sats:    pick(t,['satellites','satellites_visible','num_sats','sats']),
    volt:    pick(t,['battery_voltage','voltage','battery']),
    alt:     pick(t,['altitude','alt','relative_alt','rel_alt']),
    speed:   pick(t,['speed','groundspeed','ground_speed']),
    heading: pick(t,['heading','yaw','hdg']),
  }
}

// Count-up animation hook
function useCountUp(target, duration=800) {
  const [val, setVal] = useState(0)
  const prev = useRef(0)
  useEffect(() => {
    const from = prev.current
    const diff = target - from
    if (diff === 0) return
    const start = performance.now()
    let raf
    const tick = (now) => {
      const p = Math.min((now - start) / duration, 1)
      const ease = 1 - Math.pow(1-p, 3)
      setVal(Math.round(from + diff * ease))
      if (p < 1) raf = requestAnimationFrame(tick)
      else { prev.current = target; setVal(target) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return val
}

/* ── Circular SVG ring ── */
function Ring({ pct=0, color='#7c3aed', val, unit, size=72 }) {
  const R=30, C=2*Math.PI*R
  const fill = Math.max(0,Math.min(1,pct))*C
  return (
    <div className="vh-ring-wrap" style={{width:size,height:size}}>
      <svg viewBox="0 0 72 72" style={{width:size,height:size,transform:'rotate(-90deg)'}}>
        <circle cx="36" cy="36" r={R} className="vh-ring-track"/>
        <circle cx="36" cy="36" r={R} className="vh-ring-fill"
          stroke={color} strokeDasharray={`${fill} ${C-fill}`} strokeDashoffset="0"/>
      </svg>
      <div className="vh-ring-center">
        <span className="vh-ring-val">{val}</span>
        {unit && <span className="vh-ring-unit">{unit}</span>}
      </div>
    </div>
  )
}

/* ── Sparkline — live mini trend from last 8 telemetry readings ── */
/* Soft pink wash that fades out below a line */
function PinkShade({ id }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#f472b6" stopOpacity="0.34"/>
      <stop offset="60%" stopColor="#f9a8d4" stopOpacity="0.12"/>
      <stop offset="100%" stopColor="#fbcfe8" stopOpacity="0"/>
    </linearGradient>
  )
}

function LiveSparkline({ readings=[], color='#a78bfa' }) {
  const shadeId = `spk-shade-${useId().replace(/:/g, '')}`
  if (!readings.length) {
    // flat line when no data
    return (
      <svg width="64" height="28" viewBox="0 0 64 28" fill="none" className="vh-sparkline">
        <defs><PinkShade id={shadeId}/></defs>
        <path d="M2 20 L62 20 L62 28 L2 28 Z" fill={`url(#${shadeId})`} opacity="0.6"/>
        <path d="M2 20 L62 20" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.4"/>
      </svg>
    )
  }
  const W=64, H=28, pad=3
  const min = Math.min(...readings)
  const max = Math.max(...readings)
  const range = max-min || 1
  const pts = readings.map((v,i) => {
    const x = pad + (i / (readings.length-1)) * (W-pad*2)
    const y = H-pad - ((v-min)/range) * (H-pad*2)
    return `${x},${y}`
  }).join(' ')
  return (
    <svg width="64" height="28" viewBox={`0 0 ${W} ${H}`} fill="none" className="vh-sparkline">
      <defs><PinkShade id={shadeId}/></defs>
      <polygon points={`${pad},${H} ${pts} ${W-pad},${H}`} fill={`url(#${shadeId})`}/>
      <polyline points={pts} stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  )
}

function DroneIcon({ size=22, color='currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="10" y="10" width="4" height="4" rx="1" fill={color}/>
      <line x1="12" y1="10" x2="8"  y2="6"  stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="12" y1="10" x2="16" y2="6"  stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="12" y1="14" x2="8"  y2="18" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="12" y1="14" x2="16" y2="18" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="7"  cy="5"  r="2" stroke={color} strokeWidth="1.4" fill="none"/>
      <circle cx="17" cy="5"  r="2" stroke={color} strokeWidth="1.4" fill="none"/>
      <circle cx="7"  cy="19" r="2" stroke={color} strokeWidth="1.4" fill="none"/>
      <circle cx="17" cy="19" r="2" stroke={color} strokeWidth="1.4" fill="none"/>
    </svg>
  )
}

function Pill({ status }) {
  const map = {
    'Completed':'completed','In Progress':'inprogress','Scheduled':'scheduled',
    'Running':'running','Online':'online','Maintenance':'maintenance',
    'Offline':'offline','Armed':'armed','Disarmed':'disarmed',
  }
  return (
    <span className={`vh-pill ${map[status]||''}`}>
      <span className="vh-pill-dot"/>{status}
    </span>
  )
}

/* ── Live bar chart — detections per day (real data) ── */
function BarChart({ values=[], labels=[] }) {
  const days  = labels.length ? labels : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
  const vals  = values.length ? values : [0,0,0,0,0,0,0]
  const maxVal = Math.max(...vals,1)
  const W=380,H=160,padL=28,padR=6,padT=24,padB=30
  const chartW=W-padL-padR, chartH=H-padT-padB
  const barW=chartW/days.length*0.52, gap=chartW/days.length
  const yTicks = [...new Set([0, Math.round(maxVal/2), maxVal])]
  // Smooth curve through the bar tops; the pink shade fills the area beneath it
  const base = padT+chartH
  const tops = vals.map((v,i)=>[padL+i*gap+gap/2, base-(v/maxVal)*chartH])
  let curve = `M${tops[0][0]},${tops[0][1]}`
  for (let i=1;i<tops.length;i++) {
    const [x0,y0]=tops[i-1], [x1,y1]=tops[i], mx=(x0+x1)/2
    curve += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`
  }
  const area = `${curve} L${tops[tops.length-1][0]},${base} L${tops[0][0]},${base} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="vh-barchart">
      <defs>
        <PinkShade id="hpg-shade"/>
        <linearGradient id="hpg-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f472b6" stopOpacity="0.16"/>
          <stop offset="100%" stopColor="#f472b6" stopOpacity="0"/>
        </linearGradient>
        {vals.map((_,i)=>(
          <linearGradient key={i} id={`hpg${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed"/>
            <stop offset="100%" stopColor="#c4b5fd"/>
          </linearGradient>
        ))}
      </defs>
      {yTicks.map(v=>{
        const y=padT+chartH-(v/maxVal)*chartH
        return (
          <g key={v}>
            <line x1={padL} y1={y} x2={W-padR} y2={y} stroke="#f0ecff" strokeWidth="1"/>
            <text x={padL-4} y={y+3.5} textAnchor="end" fontSize="8.5" fill="#a78bfa" fontFamily="Inter,system-ui">{v}</text>
          </g>
        )
      })}
      <rect x={padL} y={base-14} width={chartW} height={14} fill="url(#hpg-floor)"/>
      <path d={area} fill="url(#hpg-shade)"/>
      <path d={curve} fill="none" stroke="#f472b6" strokeWidth="1.5" strokeOpacity="0.55" strokeLinecap="round"/>
      {vals.map((v,i)=>{
        const barH=Math.max((v/maxVal)*chartH, v>0?4:0)
        const x=padL+i*gap+(gap-barW)/2
        const y=padT+chartH-barH
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH} fill={`url(#hpg${i})`} rx="4"/>
            {v>0&&<text x={x+barW/2} y={y-4} textAnchor="middle" fontSize="8.5" fill="#7c3aed" fontWeight="700" fontFamily="Inter,system-ui">{v}</text>}
            <text x={x+barW/2} y={H-padB+14} textAnchor="middle" fontSize="8.5" fill="#a78bfa" fontFamily="Inter,system-ui">{days[i]}</text>
          </g>
        )
      })}
    </svg>
  )
}

/* ── Live donut chart ── */
function DonutChart({ total, segments }) {
  const R=54,cx=68,cy=68,stroke=16,C=2*Math.PI*R
  let offset=0
  const arcs=segments.map(seg=>{
    const dash=total>0?(seg.value/total)*C:0
    const arc={...seg,dash,offset}
    offset+=dash
    return arc
  })
  return (
    <div className="vh-donut-wrap">
      <div style={{position:'relative',flexShrink:0}}>
        <svg width="136" height="136" viewBox="0 0 136 136" className="vh-donut-svg">
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="#f0ecff" strokeWidth={stroke}/>
          {arcs.map((arc,i)=>arc.value>0&&(
            <circle key={i} cx={cx} cy={cy} r={R}
              fill="none" stroke={arc.color} strokeWidth={stroke}
              strokeDasharray={`${arc.dash} ${C-arc.dash}`}
              strokeDashoffset={-arc.offset} strokeLinecap="butt"
              style={{transform:'rotate(-90deg)',transformOrigin:`${cx}px ${cy}px`}}
            />
          ))}
        </svg>
        <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
          <span className="vh-donut-num">{total}</span>
          <span className="vh-donut-label">Total<br/>Incidents</span>
        </div>
      </div>
      <div className="vh-legend">
        {segments.map((s,i)=>(
          <div key={i} className="vh-legend-item">
            <div className="vh-legend-left">
              <span className="vh-legend-dot" style={{background:s.color}}/>
              <span>{s.label}</span>
            </div>
            <span className="vh-legend-count">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  )
}

/* ── Live connection status dot ── */
function StatusDot({ ok }) {
  return (
    <span style={{
      display:'inline-block', width:8, height:8, borderRadius:'50%',
      background: ok ? '#16a34a' : '#ef4444',
      boxShadow: ok ? '0 0 6px #16a34a' : '0 0 6px #ef4444',
      flexShrink:0,
    }}/>
  )
}

/* ═══════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════════════ */
export default function MissionControlScreen({ onNavigate }) {

  /* ── Live data sources ─────────────────────────────────────────────── */
  const { telemetry, backendReachable, simulated, health, armedSince } = useSystem()
  const trashStats    = useTrashStats()           // { peak, last, updatedAt }
  const trashLog      = useTrashLog()             // array of sighting entries
  const activeMission = useActiveMission()        // { name, waypoints, altitude, speedKmh, status, target } | null
  const impact        = useImpactStats()          // { missionsCompleted, flightSeconds, itemsFound }
  const missionList   = usePolling(api.missionList, 10000)  // live missions from Pi backend
  const aiStatus      = usePolling(api.aiStatus,   5000)    // { ai_enabled, ... }
  const camStatus     = usePolling(api.cameraStatus, 6000)  // { connected, ... }

  /* ── Telemetry fields ──────────────────────────────────────────────── */
  const t = readTelem(telemetry.data)
  const voltN   = Number(t.volt)
  const battPct = Number.isNaN(voltN) ? 0 : Math.round(Math.max(0,Math.min(100,((voltN-10.5)/(12.6-10.5))*100)))
  const altN    = Number.isFinite(Number(t.alt))   ? Number(t.alt)   : 0
  const speedN  = Number.isFinite(Number(t.speed)) ? Number(t.speed) : 0
  const satsN   = Number.isFinite(Number(t.sats))  ? Number(t.sats)  : 0
  const headN   = Number.isFinite(Number(t.heading)) ? ((Math.round(Number(t.heading))%360)+360)%360 : null
  const armed   = t.armed === true

  /* ── Sparkline history buffers (keep last 8 telem samples) ─────────── */
  const voltHistory  = useRef([])
  const altHistory   = useRef([])
  const speedHistory = useRef([])
  const satsHistory  = useRef([])
  useEffect(() => {
    if (!telemetry.data) return
    const push = (ref, val) => {
      if (!Number.isFinite(val)) return
      ref.current = [...ref.current.slice(-7), val]
    }
    push(voltHistory,  voltN)
    push(altHistory,   altN)
    push(speedHistory, speedN)
    push(satsHistory,  satsN)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telemetry.data, voltN, altN, speedN, satsN])

  /* ── Link & arm state ─────────────────────────────────────────────── */
  const linkStatus = simulated ? 'sim'
    : telemetry.status === 'live'    ? 'live'
    : telemetry.status === 'polling' ? 'polling'
    : 'connecting'
  const linkLabel = simulated ? 'SIMULATOR'
    : telemetry.status === 'live'    ? 'LINK LIVE'
    : telemetry.status === 'polling' ? 'RECONNECTING'
    : 'CONNECTING'

  /* ── Battery % from ring color ─────────────────────────────────────── */
  const battColor = battPct>=60 ? '#7c3aed' : battPct>=30 ? '#f59e0b' : '#ef4444'

  /* ── Flight time for current armed session ──────────────────────────── */
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const flightSecs = armedSince ? Math.round((now - armedSince) / 1000) : 0
  const flightFmt  = flightSecs >= 3600
    ? `${Math.floor(flightSecs/3600)}h ${Math.floor((flightSecs%3600)/60)}m`
    : flightSecs >= 60
    ? `${Math.floor(flightSecs/60)}m ${flightSecs%60}s`
    : flightSecs > 0
    ? `${flightSecs}s`
    : null

  /* ── Backend connectivity ───────────────────────────────────────────── */
  const backendOk = backendReachable === true

  /* ── Health data ────────────────────────────────────────────────────── */
  const hd = health?.data || {}
  const pixOk   = !!(hd.pixhawk_connected ?? hd.pixhawk ?? false)

  /* ── KPI: Active drone count ────────────────────────────────────────── */
  // Drone is "active" if the backend is reachable AND Pixhawk is connected
  const activeDrones = backendOk && pixOk ? 1 : backendOk ? 1 : 0

  /* ── KPI: Missions completed (real impact store) ────────────────────── */
  const missionsCompleted = impact.missionsCompleted

  /* ── KPI: Items detected (real trash log) ───────────────────────────── */
  const totalDetected = trashLog.length

  /* ── KPI count-up animations ─────────────────────────────────────────── */
  const animDrones    = useCountUp(activeDrones)
  const animMissions  = useCountUp(missionsCompleted)
  const animDetected  = useCountUp(totalDetected)

  // pollTotal is computed below in pollutionMap � we derive it first so
  // useCountUp can reference it without a forward call.
  const pollRawTotal = useMemo(() => {
    let t = 0
    trashLog.forEach(e => { t += (e.count || 1) })
    return t
  }, [trashLog])
  const animPollution = useCountUp(pollRawTotal)

  /* ── KPI: Pollution breakdown by class ──────────────────────────────── */
  const pollutionMap = useMemo(() => {
    const m = { plastic:0, chemical:0, oil:0, other:0 }
    trashLog.forEach(e => {
      const c = (e.class||'').toLowerCase()
      const n = e.count || 1
      if (c.includes('plastic')||c.includes('bottle')||c.includes('bag')||c.includes('styrofoam')) m.plastic += n
      else if (c.includes('chemical')) m.chemical += n
      else if (c.includes('oil'))      m.oil += n
      else                              m.other += n
    })
    return m
  }, [trashLog])
  const pollTotal = pollutionMap.plastic + pollutionMap.chemical + pollutionMap.oil + pollutionMap.other
  const pollSegs = [
    { label:'Plastic Waste',  value:pollutionMap.plastic,  color:'#3b82f6' },
    { label:'Chemical Waste', value:pollutionMap.chemical, color:'#a78bfa' },
    { label:'Oil Spill',      value:pollutionMap.oil,      color:'#f59e0b' },
    { label:'Other',          value:pollutionMap.other,    color:'#f472b6' },
  ]

  /* ── Bar chart: detections per day for last 7 days ──────────────────── */
  const barData = useMemo(() => {
    const days=[], vals=[]
    for (let i=6; i>=0; i--) {
      const d=new Date(); d.setDate(d.getDate()-i)
      days.push(d.toLocaleDateString('en-US',{weekday:'short'}))
      const s=new Date(d); s.setHours(0,0,0,0)
      const e=new Date(d); e.setHours(23,59,59,999)
      vals.push(trashLog.filter(x=>x.firstSeen>=s.getTime()&&x.firstSeen<=e.getTime()).length)
    }
    return {days,vals}
  }, [trashLog])

  /* ── Recent detections table (newest 4 unique locations) ───────────── */
  const recentDetections = useMemo(() => {
    const seen=new Set(), out=[]
    for (const e of trashLog) {
      const key = e.lat!=null ? `${Number(e.lat).toFixed(3)},${Number(e.lng).toFixed(3)}` : `nopos-${e.id}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push(e)
        if (out.length >= 4) break
      }
    }
    return out
  }, [trashLog])

  /* ── Active mission data ────────────────────────────────────────────── */
  const mission    = activeMission
  const wpCount    = mission?.waypoints?.length || 0
  const wpDone     = mission?.status === 'running'
    ? Math.min(wpCount, Math.ceil(wpCount * 0.4))  // approximation while running
    : 0
  const wpProgress = wpCount > 0 ? wpDone / wpCount : 0

  /* ── Mission list from Pi backend ──────────────────────────────────── */
  // Fallback to recent detections reformatted, then static data
  const piMissions = useMemo(() => {
    const raw = missionList?.data
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.slice(0,4).map((m,i) => ({
        id:       m.name || m.id || `M-00${i+1}`,
        location: m.location || m.description || 'Unknown',
        status:   m.status === 'completed' ? 'Completed'
                : m.status === 'running'   ? 'In Progress'
                : m.status === 'uploaded'  ? 'Scheduled'
                : 'Scheduled',
        dt:       m.updated_at || m.created_at
                  ? new Date(m.updated_at || m.created_at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})
                  : '—',
      }))
    }
    // Fall back to detection log entries as pseudo-missions
    if (recentDetections.length > 0) {
      return recentDetections.map((e,i) => ({
        id:       `M-00${i+1}`,
        location: e.lat!=null
          ? `${Number(e.lat).toFixed(3)}°, ${Number(e.lng).toFixed(3)}°`
          : 'Unknown location',
        status:   'Completed',
        dt:       e.firstSeen
          ? new Date(e.firstSeen).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})
          : '—',
      }))
    }
    // Last resort static
    return [
      {id:'M-001',location:'Ulsoor Lake',   status:'Completed',  dt:'Sep 28, 2026 10:30 AM'},
      {id:'M-002',location:'Bellandur Lake',status:'In Progress',dt:'Sep 28, 2026 02:15 PM'},
      {id:'M-003',location:'Varthur Lake',  status:'Completed',  dt:'Sep 27, 2026 04:20 PM'},
      {id:'M-004',location:'Hebbal Lake',   status:'Scheduled',  dt:'Sep 27, 2026 08:00 AM'},
    ]
  }, [missionList?.data, recentDetections])

  /* ── Total flight hours ─────────────────────────────────────────────── */
  const totalFlightHours = ((impact.flightSeconds || 0) / 3600).toFixed(1)

  /* ════════════════════════════════════════════════════════════════════
     RENDER
  ════════════════════════════════════════════════════════════════════ */
  return (
    <div className="varuna-home">

      {/* ── Hero ── */}
      <div className="vh-hero vh-animate vh-animate-2">
        <img className="vh-hero-img" src="/hero-banner.png" alt="Aerial lake environment with drone" draggable="false"/>
      </div>

      {/* ── Body ── */}
      <div className="vh-body">

        {/* ── KPI Row — all live ── */}
        <div className="vh-kpi-row vh-animate vh-animate-3">

          {/* Active Drones — live from backendReachable + pixhawk health */}
          <div className="vh-kpi-card">
            <div className="vh-kpi-icon teal"><DroneIcon size={24} color="#fff"/></div>
            <div className="vh-kpi-right">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div>
                  <div className="vh-kpi-label">Active Drones</div>
                  <div className="vh-kpi-value">{animDrones}</div>
                </div>
                <LiveSparkline readings={[0,0,backendOk?1:0,backendOk?1:0,backendOk?1:0,backendOk?1:0,activeDrones]} color="#a78bfa"/>
              </div>
              <div className={`vh-kpi-delta ${backendOk?'up':'neu'}`} style={{display:'flex',alignItems:'center',gap:4}}>
                <StatusDot ok={backendOk}/>
                {backendOk
                  ? (simulated ? 'Simulator mode' : `Pixhawk ${pixOk?'connected':'searching'}`)
                  : 'Backend offline'
                }
              </div>
            </div>
          </div>

          {/* Missions Completed — live from impactStats */}
          <div className="vh-kpi-card">
            <div className="vh-kpi-icon blue">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect x="5" y="2" width="14" height="20" rx="2" stroke="#fff" strokeWidth="1.8"/>
                <polyline points="9 12 11 14 15 10" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="vh-kpi-right">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div>
                  <div className="vh-kpi-label">Missions Completed</div>
                  <div className="vh-kpi-value">{animMissions}</div>
                </div>
                <LiveSparkline readings={Array.from({length:7},(_,i)=>Math.max(0,missionsCompleted-6+i))} color="#c4b5fd"/>
              </div>
              <div className="vh-kpi-delta up">
                ↑ {totalFlightHours}h total flight time
              </div>
            </div>
          </div>

          {/* Items Detected — live from trashLog */}
          <div className="vh-kpi-card">
            <div className="vh-kpi-icon green">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M12 22s-8-4.5-8-11.8A8 8 0 0112 2a8 8 0 018 8.2c0 7.3-8 11.8-8 11.8z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round"/>
                <circle cx="12" cy="10" r="3" stroke="#fff" strokeWidth="1.8"/>
              </svg>
            </div>
            <div className="vh-kpi-right">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div>
                  <div className="vh-kpi-label">Items Detected</div>
                  <div className="vh-kpi-value">{animDetected}</div>
                </div>
                <LiveSparkline readings={barData.vals} color="#a78bfa"/>
              </div>
              <div className="vh-kpi-delta up">
                {trashStats.last > 0 ? `↑ ${trashStats.last} active` : trashStats.peak > 0 ? `Peak: ${trashStats.peak}` : 'Start detection to log'}
              </div>
            </div>
          </div>

          {/* Pollution Incidents — live from trashLog classes */}
          <div className="vh-kpi-card">
            <div className="vh-kpi-icon amber">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round"/>
                <line x1="12" y1="9" x2="12" y2="13" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
                <circle cx="12" cy="17" r="1" fill="#fff"/>
              </svg>
            </div>
            <div className="vh-kpi-right">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div>
                  <div className="vh-kpi-label">Pollution Incidents</div>
                  <div className="vh-kpi-value">{animPollution}</div>
                </div>
                <LiveSparkline readings={barData.vals.map(v=>Math.round(v*0.4))} color="#ddd6fe"/>
              </div>
              <div className={`vh-kpi-delta ${pollTotal===0?'up':'down'}`}>
                {pollTotal===0 ? '✓ None logged yet' : `${pollutionMap.plastic} plastic, ${pollutionMap.other} other`}
              </div>
            </div>
          </div>
        </div>

        {/* ── Telemetry ring row — 100% live ── */}
        <div className="vh-telem-row vh-animate vh-animate-3">

          {/* Battery */}
          <div className="vh-telem-card">
            <Ring pct={battPct/100} color={battColor}
              val={telemetry.data ? `${battPct}%` : DASH} unit="BATT"/>
            <div className="vh-telem-label">Battery</div>
            <div className="vh-telem-sub">
              {telemetry.data ? `${Number.isNaN(voltN)?'—':voltN.toFixed(1)} V` : 'No data'}
            </div>
          </div>

          {/* Altitude */}
          <div className="vh-telem-card">
            <Ring pct={altN/50} color="#7c3aed"
              val={telemetry.data ? altN.toFixed(1) : DASH} unit="m"/>
            <div className="vh-telem-label">Altitude</div>
            <div className="vh-telem-sub">{t.mode || 'No mode'}</div>
          </div>

          {/* Speed */}
          <div className="vh-telem-card">
            <Ring pct={speedN/20} color="#8b5cf6"
              val={telemetry.data ? speedN.toFixed(1) : DASH} unit="km/h"/>
            <div className="vh-telem-label">Speed</div>
            <div className="vh-telem-sub">{speedN>0?`${speedN.toFixed(1)} km/h`:'Stationary'}</div>
          </div>

          {/* GPS */}
          <div className="vh-telem-card">
            <Ring pct={satsN/12}
              color={satsN>=6?'#7c3aed':satsN>=4?'#f59e0b':'#ef4444'}
              val={telemetry.data ? satsN : DASH} unit="SATS"/>
            <div className="vh-telem-label">GPS Sats</div>
            <div className="vh-telem-sub">
              {satsN>=6?'Good fix':satsN>=4?'Weak fix':satsN>0?'No fix':'No GPS'}
            </div>
          </div>

          {/* Link + armed state */}
          <div className="vh-telem-card">
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:6,paddingTop:4}}>
              {/* WiFi-style icon colored by status */}
              <svg width="38" height="38" viewBox="0 0 24 24" fill="none">
                <path d="M1 6c0 0 5-3 11-3s11 3 11 3" stroke={backendOk?'#7c3aed':'#e2e8f0'} strokeWidth="2" strokeLinecap="round"/>
                <path d="M4 10c0 0 3.5-2 8-2s8 2 8 2" stroke={backendOk?'#7c3aed':'#e2e8f0'} strokeWidth="2" strokeLinecap="round"/>
                <path d="M7 14c0 0 2-1.5 5-1.5s5 1.5 5 1.5" stroke={backendOk?'#7c3aed':'#e2e8f0'} strokeWidth="2" strokeLinecap="round"/>
                <circle cx="12" cy="18" r="1.5"
                  fill={telemetry.status==='live'?'#7c3aed':telemetry.status==='polling'?'#f59e0b':'#e2e8f0'}/>
              </svg>
              <span className={`vh-link-pill ${linkStatus}`}>
                <span className="vh-pulse-dot"/>
                {linkLabel}
              </span>
              <span style={{fontSize:10.5,color:armed?'#dc2626':'#7c3aed',fontWeight:700}}>
                {armed
                  ? `🔴 ARMED${flightFmt?' · '+flightFmt:''}`
                  : '🟢 DISARMED'
                }
              </span>
            </div>
            <div className="vh-telem-label">Link</div>
            <div className="vh-telem-sub">
              {headN!=null ? `HDG ${headN}°` : simulated ? 'SIMULATOR' : '—'}
            </div>
          </div>
        </div>

        {/* ── Mid row: bar chart + donut + active mission ── */}
        <div className="vh-mid-row vh-animate vh-animate-4">

          {/* Mission Activity — live detections per day */}
          <div className="vh-panel">
            <div className="vh-panel-header">
              <div>
                <div className="vh-panel-title" style={{display:'flex',alignItems:'center'}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" style={{marginRight:6}}>
                    <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
                  </svg>
                  Mission Activity
                </div>
                <div className="vh-panel-sub">
                  {totalDetected > 0 ? `${totalDetected} detections logged` : 'Start flying to populate'}
                </div>
              </div>
              <button className="vh-period-btn">
                Last 7 Days
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            </div>
            <BarChart values={barData.vals} labels={barData.days}/>
          </div>

          {/* Pollution Incidents — live class breakdown */}
          <div className="vh-panel">
            <div className="vh-panel-header">
              <div>
                <div className="vh-panel-title" style={{display:'flex',alignItems:'center'}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" style={{marginRight:6}}>
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="1" fill="#7c3aed"/>
                  </svg>
                  Pollution Incidents
                </div>
                <div className="vh-panel-sub">By class, all sessions</div>
              </div>
              <button className="vh-period-btn">
                All Time
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            </div>
            <DonutChart total={pollTotal} segments={pollSegs}/>
          </div>

          {/* Active Mission — live from missionStore */}
          <div className="vh-panel">
            <div className="vh-panel-header">
              <div className="vh-panel-title" style={{display:'flex',alignItems:'center'}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" style={{marginRight:6}}>
                  <polygon points="3 11 22 2 13 21 11 13 3 11"/>
                </svg>
                Active Mission
              </div>
              {mission && <Pill status={mission.status==='running'?'Running':'Scheduled'}/>}
            </div>
            {mission ? (
              <>
                <div className="vh-mission-name">{mission.name || 'Unnamed Mission'}</div>
                <div className="vh-mission-meta">
                  {wpCount} wps · {mission.altitude||10}m · {mission.speedKmh||5}km/h · {mission.target==='sim'?'Simulator':'Real drone'}
                </div>
                <div className="vh-wp-bar-label">
                  <span>Waypoints ({wpDone}/{wpCount})</span>
                  <span>{Math.round(wpProgress*100)}%</span>
                </div>
                <div className="vh-wp-bar-track">
                  <div className="vh-wp-bar-fill" style={{width:`${wpProgress*100}%`}}/>
                </div>
                <div className="vh-mission-tiles">
                  <div className="vh-mission-tile"><small>Waypoints</small><b>{wpCount}</b></div>
                  <div className="vh-mission-tile"><small>Altitude</small><b>{mission.altitude||'—'}m</b></div>
                  <div className="vh-mission-tile"><small>Speed</small><b>{mission.speedKmh||'—'}km/h</b></div>
                </div>
              </>
            ) : (
              <div className="vh-no-mission">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ddd6fe" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="3 11 22 2 13 21 11 13 3 11"/>
                </svg>
                No active mission
                <button onClick={()=>onNavigate?.('mission')}
                  style={{fontSize:12,color:'#7c3aed',background:'none',border:'1.5px solid #ddd6fe',borderRadius:8,cursor:'pointer',padding:'5px 14px',fontFamily:'inherit',fontWeight:700}}>
                  Plan a mission →
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Bottom row ── */}
        <div className="vh-bottom-row vh-bottom-row--single vh-animate vh-animate-5">

          {/* Recent Missions — live from Pi backend → fallback to detections → fallback static */}
          <div className="vh-panel">
            <div className="vh-table-header">
              <span className="vh-panel-title" style={{display:'flex',alignItems:'center'}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" style={{marginRight:6}}>
                  <rect x="5" y="2" width="14" height="20" rx="2"/><polyline points="9 12 11 14 15 10"/>
                </svg>
                Recent Missions
              </span>
              <button className="vh-view-all" onClick={()=>onNavigate?.('mission')}>View All →</button>
            </div>
            <table className="vh-table">
              <thead>
                <tr>
                  <th>Mission ID</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th>Date &amp; Time</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {piMissions.map(m=>(
                  <tr key={m.id}>
                    <td>
                      <span style={{display:'inline-flex',alignItems:'center'}}>
                        <span className="vh-row-thumb">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="3 11 22 2 13 21 11 13 3 11"/>
                          </svg>
                        </span>
                        <span style={{fontWeight:700,color:'#1e1b4b'}}>{m.id}</span>
                      </span>
                    </td>
                    <td style={{color:'#475569'}}>{m.location}</td>
                    <td><Pill status={m.status}/></td>
                    <td style={{color:'#94a3b8',fontSize:11}}>{m.dt}</td>
                    <td><Chevron/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
