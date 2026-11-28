// What the app has saved: the CSV files, where they are, and the river list.
import { useEffect, useState } from 'react'
import { fetchDataStatus, fetchCatalog, exportHref, useDataSaveStatus, flushOutbox } from '../../lib/localData'
import { Kpi, Section } from '../simple/Simple'

function Notice({ tone = 'info', children }) {
  return (
    <div className="rounded-xl px-4 py-3 text-[13.5px]" role={tone === 'bad' ? 'alert' : 'status'}
      style={{ background: `var(--sx-${tone}-soft)`, color: `var(--sx-${tone})` }}>
      {children}
    </div>
  )
}

const when = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function BasicDataPage() {
  const [st, setSt] = useState(null)
  const [cat, setCat] = useState(null)
  const [error, setError] = useState('')
  const [n, setN] = useState(0)
  const save = useDataSaveStatus()

  useEffect(() => {
    let live = true
    setError('')
    Promise.all([fetchDataStatus(), fetchCatalog()])
      .then(([s, c]) => live && (setSt(s), setCat(c)))
      .catch((err) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [n, save.lastSavedAt])

  const files = st?.files || []
  const rows = files.reduce((a, f) => a + (f.missing ? 0 : Number(f.rows) || 0), 0)
  const last = files.reduce((a, f) => Math.max(a, f.updatedAt ? new Date(f.updatedAt).getTime() : 0), 0)
  const rivers = (cat?.states || []).reduce((a, s) => a + s.rivers.length, 0)

  return (
    <>
      {error && <Notice tone="bad">{error} <button type="button" className="font-bold underline" onClick={() => setN((x) => x + 1)}>Try again</button></Notice>}
      {save.pending > 0 && (
        <Notice tone="warn">
          {save.pending} save{save.pending > 1 ? 's' : ''} waiting{save.lastError ? `: ${save.lastError}` : ''}.{' '}
          <button type="button" className="font-bold underline" onClick={() => flushOutbox()}>Retry now</button>
        </Notice>
      )}
      {!save.pending && save.lastError && <Notice tone="bad">{save.lastError}</Notice>}
      {save.dropped > 0 && <Notice tone="bad">{save.dropped} older unsaved records were dropped while the store was unreachable.</Notice>}

      {st && (
        <div className="sx-kpis">
          <Kpi label="Files" value={files.filter((f) => !f.missing).length} unit={`of ${files.length}`} />
          <Kpi label="Records" value={rows.toLocaleString()} />
          <Kpi label="Last saved" value={last ? new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
            note={last ? new Date(last).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : 'nothing saved yet'} />
          <Kpi label="Rivers" value={rivers} unit={cat ? `in ${cat.states.length} states` : ''} />
        </div>
      )}

      {st && (
        <Section title="Saved files" sub="Saved automatically as you plan, fly and detect. Each one opens in Excel."
          actions={<button type="button" className="sx-btn ghost sm" onClick={() => setN((x) => x + 1)}>Refresh</button>} flush>
          <div className="overflow-x-auto">
            <table className="sx-table">
              <thead><tr><th>File</th><th className="num">Rows</th><th>Last change</th><th /></tr></thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.name}>
                    <td><span className="font-mono text-[13px] font-semibold">{f.name}</span></td>
                    <td className="num">{f.missing ? '—' : Number(f.rows).toLocaleString()}</td>
                    <td>{f.error ? <span style={{ color: 'var(--sx-bad)' }}>{f.error}</span> : f.updatedAt ? when(f.updatedAt) : <span className="text-muted">Not created yet</span>}</td>
                    <td className="text-right">
                      {!f.missing && f.name !== 'users.csv' && (
                        <a className="sx-btn ghost sm" href={exportHref(f.name.replace(/\.csv$/, ''))} download={f.name}>Download</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-[18px] py-3 text-[12.5px] text-muted" style={{ borderColor: 'var(--sx-line)' }}>
            <span>Folder: <span className="font-mono text-[12px] text-ink">{st.dataDir}</span></span>
            <span>Passwords are never stored in these files: only a salted hash, in credentials.json.</span>
          </div>
        </Section>
      )}

      {st?.warnings?.length > 0 && (
        <Section title="Recovered problems" sub="Fixed automatically; listed so nothing goes unnoticed.">
          <div className="flex flex-col gap-2">
            {st.warnings.map((w, i) => <Notice key={i}>{when(w.at)}: {w.text}</Notice>)}
          </div>
        </Section>
      )}

      {cat && (
        <Section title="States and rivers" sub={cat.source === 'csv' ? 'From states.csv and rivers.csv: add a row there to add a river.' : 'The built-in list. Add states.csv and rivers.csv to change it.'}>
          <div className="grid gap-4 md:grid-cols-2">
            {cat.states.map((s) => (
              <div key={s.id} className="sx-well p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[14px] font-bold text-ink">{s.name}</span>
                  <span className="sx-pill">{s.rivers.length} rivers</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {s.rivers.map((r) => (
                    <span key={r.id} className="rounded-lg px-2.5 py-1 text-[12.5px] font-medium"
                      style={{ background: 'var(--sx-card)', border: '1px solid var(--sx-line)', color: 'var(--sx-sub)' }}>{r.name}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {cat.notes?.map((t, i) => <div key={i} className="mt-3"><Notice>{t}</Notice></div>)}
        </Section>
      )}
    </>
  )
}
