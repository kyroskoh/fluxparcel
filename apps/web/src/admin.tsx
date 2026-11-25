import { useCallback, useEffect, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { api, errorMessage } from './api'
import { formatDuration } from './capabilities'
import { formatBytes } from './transfers'

type Usage = { count: number; bytes: number }
type Summary = {
  files: { active: Usage; snapshot: Usage; purged: Usage }
  uploads: Usage
  retention: { fileSeconds: number; snapshotSeconds: number }
}
type Snapshot = {
  id: string; name: string; size: number; sha256: string; conversation: string; owner: string
  expiredAt: string; snapshotExpiresAt: string
}

const restoreChoices = [86400, 7 * 86400, 30 * 86400]

export function StorageAdmin() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null)
  const [restoreFor, setRestoreFor] = useState<Record<string, number>>({})
  const [confirming, setConfirming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const [nextSummary, nextSnapshots] = await Promise.all([api<Summary>('/admin/storage'), api<Snapshot[]>('/admin/snapshots')])
    setSummary(nextSummary)
    setSnapshots(nextSnapshots)
  }, [])

  useEffect(() => {
    let active = true
    load().catch(error => { if (active) setError(errorMessage(error)) })
    return () => { active = false }
  }, [load])

  async function act(action: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await action()
      setConfirming('')
      await load()
      setNotice(done)
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }

  const rows: [string, Usage | undefined][] = [
    ['Available to members', summary?.files.active], ['Expired snapshots', summary?.files.snapshot],
    ['Purged', summary?.files.purged], ['Uploads in progress', summary?.uploads],
  ]
  return <div className="settings-content">
    <header className="page-heading"><span className="section-icon"><HardDrive size={23} aria-hidden /></span><h1>Storage administration</h1></header>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <section className="settings-card">
      <h2>Storage lifecycle</h2>
      {summary ? <>
        <table className="admin-table" aria-label="Storage usage">
          <thead><tr><th scope="col">State</th><th scope="col">Files</th><th scope="col">Size</th></tr></thead>
          <tbody>{rows.map(([label, usage]) => <tr key={label}><th scope="row">{label}</th><td>{usage?.count ?? 0}</td>
            <td>{formatBytes(usage?.bytes ?? 0)}</td></tr>)}</tbody>
        </table>
        <p className="muted">Files stay available for up to {formatDuration(summary.retention.fileSeconds)}. {summary.retention.snapshotSeconds > 0
          ? 'Expired files are kept as snapshots for ' + formatDuration(summary.retention.snapshotSeconds) + ', then purged.'
          : 'Snapshots are disabled; expired files are purged immediately.'} Purged sizes count files whose bytes were deleted.</p>
      </> : !error && <p role="status">Loading storage…</p>}
    </section>
    <section className="settings-card">
      <h2>Expired file snapshots</h2>
      <p className="muted">Snapshots are hidden from every member. Restoring makes the file available in its chat again; purging deletes it permanently. Both are recorded in the audit log.</p>
      {snapshots?.length === 0 && <p>No snapshots.</p>}
      <ul className="device-list" aria-label="Snapshots">{snapshots?.map(item => <li key={item.id}>
        <div>
          <strong className="upload-name">{item.name}</strong>
          <small>{formatBytes(item.size)} · {item.conversation} · sent by {item.owner}</small>
          <small>Expired {new Date(item.expiredAt).toLocaleString()} · purged after {new Date(item.snapshotExpiresAt).toLocaleString()}</small>
        </div>
        <div className="chat-actions">
          <label className="expiry-select">Available for
            <select value={restoreFor[item.id] ?? restoreChoices[1]} onChange={event => setRestoreFor(current => ({ ...current, [item.id]: Number(event.target.value) }))}>
              {restoreChoices.filter(seconds => !summary || seconds <= summary.retention.fileSeconds).map(seconds =>
                <option key={seconds} value={seconds}>{formatDuration(seconds)}</option>)}
            </select>
          </label>
          <button className="secondary" type="button" disabled={busy} onClick={() => void act(
            () => api('/admin/snapshots/' + item.id + '/restore', 'POST', { expiresInSeconds: restoreFor[item.id] ?? restoreChoices[1] }),
            item.name + ' was restored.')}>Restore</button>
          {confirming === item.id ? <>
            <button className="primary" type="button" disabled={busy} onClick={() => void act(
              () => api('/admin/snapshots/' + item.id, 'DELETE'), item.name + ' was purged.')}>Confirm purge of {item.name}</button>
            <button className="secondary" type="button" onClick={() => setConfirming('')}>Cancel</button>
          </> : <button className="secondary" type="button" disabled={busy} onClick={() => setConfirming(item.id)}>Purge</button>}
        </div>
      </li>)}</ul>
    </section>
  </div>
}
