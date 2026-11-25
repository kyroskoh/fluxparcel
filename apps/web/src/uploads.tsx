import { ArrowDownUp, Paperclip } from 'lucide-react'
import { formatBytes, uploadLabels, type Transfers, type UploadJob } from './transfers'

export function UploadItem({ job, transfers }: { job: UploadJob; transfers: Transfers }) {
  const preparing = job.state === 'preparing'
  const done = preparing ? job.preparedBytes : job.sentBytes
  const percent = job.size ? Math.floor((done / job.size) * 100) : 0
  const detail = preparing ? 'Checking file ' + percent + '%'
    : job.state === 'completed' ? 'Verified and sent'
      : formatBytes(job.verifiedBytes) + ' of ' + formatBytes(job.size) + ' verified'
  return <div className="upload-item">
    <div className="upload-heading">
      <Paperclip size={17} aria-hidden />
      <strong className="upload-name">{job.name}</strong>
      <small>{formatBytes(job.size)}</small>
    </div>
    <progress max={100} value={percent} aria-label={'Progress for ' + job.name} />
    <small className="upload-status">{uploadLabels[job.state]} · {detail}{job.error ? ' · ' + job.error : ''}</small>
    <div className="chat-actions">
      {['preparing', 'queued', 'uploading', 'retrying', 'waiting'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.pause(job.id)}>Pause</button>}
      {['paused', 'waiting'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.resume(job.id)}>Resume</button>}
      {job.state === 'failed' && <button className="secondary" type="button" onClick={() => transfers.resume(job.id)}>Retry</button>}
      {!['completed', 'cancelled', 'verifying'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.cancel(job.id)}>Cancel upload</button>}
      {['completed', 'cancelled', 'failed'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.dismiss(job.id)}>Dismiss</button>}
    </div>
  </div>
}

export function TransfersPage({ transfers }: { transfers: Transfers }) {
  return <div className="settings-content">
    <header className="page-heading"><span className="section-icon"><ArrowDownUp size={23} aria-hidden /></span><h1>Transfers</h1></header>
    <p className="muted">Uploads run while this tab stays open. Closing the tab or locking the device stops them.
      Downloads use your browser's download manager.</p>
    {transfers.jobs.length === 0 ? <section className="settings-card"><h2>No transfers</h2>
      <p className="muted">Attach files in a chat to upload them.</p></section>
      : <ul className="transfer-list" aria-label="Uploads">{transfers.jobs.map(job => <li key={job.id} className="settings-card">
        <UploadItem job={job} transfers={transfers} />
      </li>)}</ul>}
  </div>
}
