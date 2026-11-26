import { ArrowDownUp, Download, Paperclip } from 'lucide-react'
import { formatBytes, uploadLabels, type Transfers, type UploadJob } from './transfers'
import { downloadDetail, downloadLabels, type DownloadJob, type Downloads } from './downloads'

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
      {job.state === 'needs-file' && <label className="secondary attach-button">
        Select file to resume
        <input type="file" className="visually-hidden" aria-label={'Select ' + job.name + ' to resume'} onChange={event => {
          const file = event.target.files?.[0]
          if (file) transfers.reselect(job.id, file)
          event.target.value = ''
        }} />
      </label>}
      {['preparing', 'queued', 'uploading', 'retrying', 'waiting'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.pause(job.id)}>Pause</button>}
      {['paused', 'waiting'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.resume(job.id)}>Resume</button>}
      {job.state === 'failed' && <button className="secondary" type="button" onClick={() => transfers.resume(job.id)}>Retry</button>}
      {!['completed', 'cancelled', 'verifying', 'elsewhere'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.cancel(job.id)}>Cancel upload</button>}
      {['completed', 'cancelled', 'failed'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.dismiss(job.id)}>Dismiss</button>}
    </div>
  </div>
}

export function DownloadItem({ job, downloads }: { job: DownloadJob; downloads: Downloads }) {
  const percent = job.size ? Math.floor((job.receivedBytes / job.size) * 100) : 0
  return <div className="upload-item">
    <div className="upload-heading">
      <Download size={17} aria-hidden />
      <strong className="upload-name">{job.name}</strong>
      <small>{formatBytes(job.size)}</small>
    </div>
    {job.state !== 'completed' && <progress max={100} value={percent} aria-label={'Download progress for ' + job.name} />}
    <small className="upload-status">{downloadLabels[job.state]} · {downloadDetail(job)}{job.error ? ' · ' + job.error : ''}</small>
    <div className="chat-actions">
      {job.state === 'completed' && <button className="primary" type="button" onClick={() => downloads.save(job.fileId)}>Save file</button>}
      {['queued', 'downloading', 'retrying', 'waiting'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => downloads.pause(job.fileId)}>Pause download</button>}
      {(job.state === 'paused' || job.state === 'waiting' || (job.state === 'failed' && !job.restartRequired)) &&
        <button className="secondary" type="button" onClick={() => downloads.resume(job.fileId)}>Resume download</button>}
      {job.state === 'failed' && job.restartRequired &&
        <button className="secondary" type="button" onClick={() => downloads.restart(job.fileId)}>Restart download</button>}
      {!['completed', 'verifying', 'elsewhere', 'failed'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => downloads.cancel(job.fileId)}>Cancel download</button>}
      {['completed', 'failed'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => downloads.dismiss(job.fileId)}>Remove from this device</button>}
    </div>
  </div>
}

export function TransfersPage({ transfers, downloads }: { transfers: Transfers; downloads: Downloads }) {
  return <div className="settings-content">
    <header className="page-heading"><span className="section-icon"><ArrowDownUp size={23} aria-hidden /></span><h1>Transfers</h1></header>
    <p className="muted">Transfers run while this tab stays open. Closing the tab or locking the device pauses them.
      After reopening, select the same file again to resume an upload; downloads continue from the bytes already saved
      on this device and are checked before you save them.
      {!downloads.supported && ' This browser cannot keep partial downloads, so downloads use its own download manager and cannot be paused here.'}</p>
    {transfers.jobs.length === 0 && downloads.jobs.length === 0 && <section className="settings-card"><h2>No transfers</h2>
      <p className="muted">Attach files in a chat to upload them, or download an attachment.</p></section>}
    {transfers.jobs.length > 0 && <section aria-label="Uploads"><h2>Uploads</h2>
      <ul className="transfer-list">{transfers.jobs.map(job => <li key={job.id} className="settings-card">
        <UploadItem job={job} transfers={transfers} />
      </li>)}</ul></section>}
    {downloads.jobs.length > 0 && <section aria-label="Downloads"><h2>Downloads</h2>
      <ul className="transfer-list">{downloads.jobs.map(job => <li key={job.fileId} className="settings-card">
        <DownloadItem job={job} downloads={downloads} />
      </li>)}</ul></section>}
  </div>
}
