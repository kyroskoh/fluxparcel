import { useEffect, useState } from 'react'
import { ArrowDown, ArrowDownUp, ArrowUp, Download, Paperclip } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatBytes, uploadLabels, type Transfers, type UploadJob } from './transfers'
import { downloadDetail, downloadLabels, type DownloadJob, type Downloads } from './downloads'
import {
  currentNetwork, loadSettings, maxConcurrent, minConcurrent, networkLabels, policyLabels, priorityLabels, saveSettings,
  watchConditions, type NetworkPolicy, type Priority, type TransferSettings,
} from './transfer-policy'

// useTransferConditions follows this device's network type and the account's transfer settings.
export function useTransferConditions(accountId: string) {
  const read = () => ({ settings: loadSettings(accountId), network: currentNetwork() })
  const [conditions, setConditions] = useState(read)
  useEffect(() => {
    setConditions({ settings: loadSettings(accountId), network: currentNetwork() })
    return watchConditions(accountId, () => setConditions({ settings: loadSettings(accountId), network: currentNetwork() }))
  }, [accountId])
  return { ...conditions, save: (settings: TransferSettings) => saveSettings(accountId, settings) }
}

// Asking before every overridden transfer keeps the consent explicit; it never applies to other transfers.
function confirmNetwork(name: string, bytes: number, verb: string) {
  return window.confirm(verb + ' ' + name + ' (' + formatBytes(bytes) + ' remaining) on this network? '
    + 'It may be cellular or metered, and your provider may charge for the data.')
}

type QueueActions = { setPriority: (id: string, priority: Priority) => void; move: (id: string, direction: 'up' | 'down') => void }

function QueueControls({ id, name, priority, reorderable, actions }: {
  id: string
  name: string
  priority: Priority
  reorderable: boolean
  actions: QueueActions
}) {
  return <div className="queue-controls">
    <label>Priority
      <select value={priority} aria-label={'Priority for ' + name} onChange={event => actions.setPriority(id, event.target.value as Priority)}>
        {(Object.keys(priorityLabels) as Priority[]).map(value => <option key={value} value={value}>{priorityLabels[value]}</option>)}
      </select>
    </label>
    {reorderable && <>
      <button className="icon-button" type="button" aria-label={'Move ' + name + ' up'} title="Move up" onClick={() => actions.move(id, 'up')}><ArrowUp size={17} aria-hidden /></button>
      <button className="icon-button" type="button" aria-label={'Move ' + name + ' down'} title="Move down" onClick={() => actions.move(id, 'down')}><ArrowDown size={17} aria-hidden /></button>
    </>}
  </div>
}

const reorderableUploads = ['queued', 'waiting', 'paused', 'needs-file']
const reorderableDownloads = ['queued', 'waiting', 'paused']

export function UploadItem({ job, transfers, queue = false }: { job: UploadJob; transfers: Transfers; queue?: boolean }) {
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
      {job.block && <button className="primary" type="button" onClick={() => {
        if (confirmNetwork(job.name, job.size - job.verifiedBytes, 'Upload')) transfers.allowNetwork(job.id)
      }}>Upload on this network</button>}
      {(job.state === 'paused' || (job.state === 'waiting' && !job.block)) &&
        <button className="secondary" type="button" onClick={() => transfers.resume(job.id)}>Resume</button>}
      {job.state === 'failed' && <button className="secondary" type="button" onClick={() => transfers.resume(job.id)}>Retry</button>}
      {!['completed', 'cancelled', 'verifying', 'elsewhere'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.cancel(job.id)}>Cancel upload</button>}
      {['completed', 'cancelled', 'failed'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => transfers.dismiss(job.id)}>Dismiss</button>}
    </div>
    {queue && !['completed', 'cancelled', 'failed'].includes(job.state) &&
      <QueueControls id={job.id} name={job.name} priority={job.priority} reorderable={reorderableUploads.includes(job.state)} actions={transfers} />}
  </div>
}

export function DownloadItem({ job, downloads, queue = false }: { job: DownloadJob; downloads: Downloads; queue?: boolean }) {
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
      {job.block && <button className="primary" type="button" onClick={() => {
        if (confirmNetwork(job.name, job.size - job.committedBytes, 'Download')) downloads.allowNetwork(job.fileId)
      }}>Download on this network</button>}
      {(job.state === 'paused' || (job.state === 'waiting' && !job.block) || (job.state === 'failed' && !job.restartRequired)) &&
        <button className="secondary" type="button" onClick={() => downloads.resume(job.fileId)}>Resume download</button>}
      {job.state === 'failed' && job.restartRequired &&
        <button className="secondary" type="button" onClick={() => downloads.restart(job.fileId)}>Restart download</button>}
      {!['completed', 'verifying', 'elsewhere', 'failed'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => downloads.cancel(job.fileId)}>Cancel download</button>}
      {['completed', 'failed'].includes(job.state) &&
        <button className="secondary" type="button" onClick={() => downloads.dismiss(job.fileId)}>Remove from this device</button>}
    </div>
    {queue && !['completed', 'cancelled', 'failed', 'verifying'].includes(job.state) &&
      <QueueControls id={job.fileId} name={job.name} priority={job.priority} reorderable={reorderableDownloads.includes(job.state)} actions={downloads} />}
  </div>
}

// The Transfers page lists active jobs first, then waiting jobs in the order they will start, then finished ones.
function queueOrder<T extends { state: string; rank: number }>(jobs: T[], waiting: string[]) {
  const group = (job: T) => waiting.includes(job.state) ? 1 : ['completed', 'failed', 'cancelled'].includes(job.state) ? 2 : 0
  return [...jobs].sort((a, b) => group(a) - group(b) || a.rank - b.rank)
}

export function TransferSettingsCard({ accountId }: { accountId: string }) {
  const { settings, network, save } = useTransferConditions(accountId)
  const counts = Array.from({ length: maxConcurrent - minConcurrent + 1 }, (_, index) => minConcurrent + index)
  return <section className="settings-card">
    <h2>Transfers on this device</h2>
    <p className="muted">Network reported by this browser: {networkLabels[network]}. Many browsers do not report the
      network type, so an unknown network is treated as possibly cellular or metered. Your provider's billing may differ.</p>
    <fieldset className="choice-group">
      <legend>Network policy</legend>
      {(Object.keys(policyLabels) as NetworkPolicy[]).map(policy => <label key={policy} className="toggle-row">
        <input type="radio" name="network-policy" value={policy} checked={settings.policy === policy}
          onChange={() => save({ ...settings, policy })} />
        <span>{policyLabels[policy]}</span>
      </label>)}
    </fieldset>
    <div className="settings-row">
      <label>Uploads at a time
        <select value={settings.uploads} onChange={event => save({ ...settings, uploads: Number(event.target.value) })}>
          {counts.map(count => <option key={count} value={count}>{count}</option>)}
        </select>
      </label>
      <label>Downloads at a time
        <select value={settings.downloads} onChange={event => save({ ...settings, downloads: Number(event.target.value) })}>
          {counts.map(count => <option key={count} value={count}>{count}</option>)}
        </select>
      </label>
    </div>
  </section>
}

export function TransfersPage({ transfers, downloads }: { transfers: Transfers; downloads: Downloads }) {
  const { settings, network } = useTransferConditions(transfers.accountId)
  return <div className="settings-content">
    <header className="page-heading"><span className="section-icon"><ArrowDownUp size={23} aria-hidden /></span><h1>Transfers</h1></header>
    <p className="muted">Transfers run while this tab stays open. Closing the tab or locking the device pauses them.
      After reopening, select the same file again to resume an upload; downloads continue from the bytes already saved
      on this device and are checked before you save them.
      {!downloads.supported && ' This browser cannot keep partial downloads, so downloads use its own download manager and cannot be paused here.'}</p>
    <p className="muted" role="status">Network: {networkLabels[network]} · Policy: {policyLabels[settings.policy]} ·
      {' '}{settings.uploads} uploads and {settings.downloads} downloads at a time. <Link to="/settings">Change transfer settings</Link></p>
    {transfers.jobs.length === 0 && downloads.jobs.length === 0 && <section className="settings-card"><h2>No transfers</h2>
      <p className="muted">Attach files in a chat to upload them, or download an attachment.</p></section>}
    {transfers.jobs.length > 0 && <section aria-label="Uploads"><h2>Uploads</h2>
      <ul className="transfer-list">{queueOrder(transfers.jobs, reorderableUploads).map(job => <li key={job.id} className="settings-card">
        <UploadItem job={job} transfers={transfers} queue />
      </li>)}</ul></section>}
    {downloads.jobs.length > 0 && <section aria-label="Downloads"><h2>Downloads</h2>
      <ul className="transfer-list">{queueOrder(downloads.jobs, reorderableDownloads).map(job => <li key={job.fileId} className="settings-card">
        <DownloadItem job={job} downloads={downloads} queue />
      </li>)}</ul></section>}
  </div>
}
