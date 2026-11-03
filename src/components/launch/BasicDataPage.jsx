// What the app has saved: the CSV files, where they are, and the river list.
import { useEffect, useState } from 'react'
import { fetchDataStatus, fetchCatalog, exportHref, useDataSaveStatus, flushOutbox } from '../../lib/localData'

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

  return (
    <>
      <h2 className="vl-h1">Basic / Elementary Data</h2>
      <p className="vl-sub">Everything below is saved automatically as you sign in, plan, fly and detect.</p>

      {error && <div className="vl-msg bad">{error} <button type="button" className="vl-link" onClick={() => setN((x) => x + 1)}>Try again</button></div>}
      {save.pending > 0 && (
        <div className="vl-msg info">
          {save.pending} save{save.pending > 1 ? 's' : ''} waiting{save.lastError ? `: ${save.lastError}` : ''}.{' '}
          <button type="button" className="vl-link" onClick={() => flushOutbox()}>Retry now</button>
        </div>
      )}
      {!save.pending && save.lastError && <div className="vl-msg bad">{save.lastError}</div>}
      {save.dropped > 0 && <div className="vl-msg bad">{save.dropped} older unsaved records were dropped while the store was unreachable.</div>}

      {st && (
        <>
          <div className="vl-section-title">Data folder</div>
          <div className="vl-mono">{st.dataDir}</div>
          <div className="vl-section-title">Files</div>
          <div className="vl-scroll-x">
            <table className="vl-table">
              <thead><tr><th>File</th><th>Rows</th><th>Last change</th><th /></tr></thead>
              <tbody>
                {st.files.map((f) => (
                  <tr key={f.name}>
                    <td className="vl-mono">{f.name}</td>
                    <td>{f.missing ? '—' : f.rows}</td>
                    <td>{f.error ? <span style={{ color: '#b91c1c' }}>{f.error}</span> : f.updatedAt ? new Date(f.updatedAt).toLocaleString() : 'not created yet'}</td>
                    <td>{!f.missing && f.name !== 'users.csv' && <a className="vl-link" href={exportHref(f.name.replace(/\.csv$/, ''))} download={f.name}>Download</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {st.warnings?.length > 0 && (
            <>
              <div className="vl-section-title">Recovered problems</div>
              {st.warnings.map((w, i) => <div key={i} className="vl-msg info">{new Date(w.at).toLocaleString()}: {w.text}</div>)}
            </>
          )}
          <p style={{ fontSize: 12, marginTop: 10 }}>
            Passwords are never written to these files: only a salted hash is kept, in credentials.json, and Google sign-in keeps no token.
          </p>
        </>
      )}

      {cat && (
        <>
          <div className="vl-section-title">States and rivers ({cat.source === 'csv' ? 'states.csv + rivers.csv' : 'built-in list'})</div>
          {cat.states.map((s) => (
            <div key={s.id} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4 }}>{s.name} <span className="vl-mono" style={{ color: '#8b5cf6' }}>{s.id}</span></div>
              <div className="vl-chips">{s.rivers.map((r) => <span key={r.id} className="vl-chip">{r.name}</span>)}</div>
            </div>
          ))}
          {cat.notes?.map((t, i) => <div key={i} className="vl-msg info">{t}</div>)}
          <p style={{ fontSize: 12 }}>Add a state or river by adding a row to those files (Excel is fine); the list updates the next time it opens.</p>
        </>
      )}
    </>
  )
}
