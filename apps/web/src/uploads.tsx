import { useEffect, useState } from 'react'
import { api } from './api'
import { ArrowDown, ArrowDownUp, ArrowUp, Download, Paperclip } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatBytes, uploadLabels, type Transfers, type UploadJob } from './transfers'
import { downloadDetail, downloadLabels, type DownloadJob, type Downloads } from './downloads'
import {
  currentNetwork, loadSettings, maxConcurrent, minConcurrent, networkLabels, policyLabels, priorityLabels, saveSettings,
  watchConditions, type NetworkPolicy, type Priority, type TransferSettings,
} from './transfer-policy'
import {
  actionLabels, clearable, compare, eligible, entries, filterLabels, matches, outcome, sortLabels,
  type BatchAction, type Entry, type Filter, type Sort,
} from './transfer-batch'

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

export function UploadItem({ job, transfers, queue = false, reorder = true }: { job: UploadJob; transfers: Transfers; queue?: boolean; reorder?: boolean }) {
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
      <QueueControls id={job.id} name={job.name} priority={job.priority} reorderable={reorder && reorderableUploads.includes(job.state)} actions={transfers} />}
  </div>
}

export function DownloadItem({ job, downloads, queue = false, reorder = true }: { job: DownloadJob; downloads: Downloads; queue?: boolean; reorder?: boolean }) {
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
      <QueueControls id={job.fileId} name={job.name} priority={job.priority} reorderable={reorder && reorderableDownloads.includes(job.state)} actions={downloads} />}
  </div>
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

// useConversationTitles maps conversation IDs to titles so transfers can be searched and opened by conversation.
function useConversationTitles() {
  const [titles, setTitles] = useState(new Map<string, string>())
  useEffect(() => {
    let active = true
    api<{ id: string; title: string }[]>('/conversations')
      .then(list => { if (active) setTitles(new Map(list.map(item => [item.id, item.title]))) })
      .catch(() => undefined)
    return () => { active = false }
  }, [])
  return titles
}

const batchActions: BatchAction[] = ['pause', 'resume', 'retry', 'cancel']

export function TransfersPage({ transfers, downloads }: { transfers: Transfers; downloads: Downloads }) {
  const { settings, network } = useTransferConditions(transfers.accountId)
  const titles = useConversationTitles()
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<Sort>('queue')
  const [selected, setSelected] = useState(new Set<string>())
  const [notice, setNotice] = useState('')
  const all = entries(transfers.jobs, downloads.jobs)
  const title = (entry: Entry) => titles.get(entry.job.conversationId) ?? ''
  const shown = all.filter(entry => matches(entry, filter, search, title(entry))).sort(compare(sort))
  const chosen = shown.filter(entry => selected.has(entry.key))
  // With nothing selected, batch actions apply to everything shown under the current filter and search.
  const targets = chosen.length ? chosen : shown
  const finished = targets.filter(clearable)
  const counts = (Object.keys(filterLabels) as Filter[]).map(value => [value, all.filter(entry => matches(entry, value, '', '')).length] as const)

  function toggle(key: string, on: boolean) {
    setSelected(current => {
      const next = new Set(current)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function run(entry: Entry, action: BatchAction) {
    if (entry.direction === 'upload') {
      if (action === 'pause') transfers.pause(entry.id)
      else if (action === 'cancel') transfers.cancel(entry.id)
      else transfers.resume(entry.id)
    } else {
      if (action === 'pause') downloads.pause(entry.id)
      else if (action === 'cancel') downloads.cancel(entry.id)
      else downloads.resume(entry.id)
    }
  }

  function apply(action: BatchAction) {
    const ready = targets.filter(entry => eligible(entry, action))
    if (action === 'cancel' && ready.length && !window.confirm('Cancel ' + ready.length + ' transfer' + (ready.length === 1 ? '' : 's') + '? '
      + 'Unfinished uploads are discarded and partial downloads are deleted from this device. Files already sent stay in their chats.')) return
    for (const entry of ready) run(entry, action)
    setNotice(outcome(action, ready.length, targets.length - ready.length))
    setSelected(new Set())
  }

  function clear() {
    const downloaded = finished.filter(entry => entry.direction === 'download' && entry.status === 'completed').length
    if (downloaded && !window.confirm('Clear ' + finished.length + ' finished transfer' + (finished.length === 1 ? '' : 's') + '? '
      + downloaded + ' verified download' + (downloaded === 1 ? ' is' : 's are') + ' also deleted from this device; save '
      + (downloaded === 1 ? 'it' : 'them') + ' first if needed. Attachments stay in their chats.')) return
    for (const entry of finished) {
      if (entry.direction === 'upload') transfers.dismiss(entry.id)
      else downloads.dismiss(entry.id)
    }
    setNotice('Cleared ' + finished.length + ' finished transfer' + (finished.length === 1 ? '' : 's') + ' from this list.')
    setSelected(new Set())
  }

  const section = (direction: Entry['direction'], heading: string) => {
    const items = shown.filter(entry => entry.direction === direction)
    if (!items.length) return null
    return <section aria-label={heading}><h2>{heading}</h2>
      <ul className="transfer-list">{items.map(entry => <li key={entry.key} className="settings-card">
        <div className="entry-bar">
          <label className="toggle-row"><input type="checkbox" checked={selected.has(entry.key)}
            aria-label={'Select ' + entry.job.name} onChange={event => toggle(entry.key, event.target.checked)} /> Select</label>
          <Link to={'/chats/' + entry.job.conversationId}>{title(entry) ? 'Open ' + title(entry) : 'Open conversation'}</Link>
        </div>
        {entry.direction === 'upload'
          ? <UploadItem job={entry.job} transfers={transfers} queue reorder={sort === 'queue'} />
          : <DownloadItem job={entry.job} downloads={downloads} queue reorder={sort === 'queue'} />}
      </li>)}</ul></section>
  }

  return <div className="settings-content">
    <header className="page-heading"><span className="section-icon"><ArrowDownUp size={23} aria-hidden /></span><h1>Transfers</h1></header>
    <p className="muted">Transfers run while this tab stays open. Closing the tab or locking the device pauses them.
      After reopening, select the same file again to resume an upload; downloads continue from the bytes already saved
      on this device and are checked before you save them.
      {!downloads.supported && ' This browser cannot keep partial downloads, so downloads use its own download manager and cannot be paused here.'}</p>
    <p className="muted">Network: {networkLabels[network]} · Policy: {policyLabels[settings.policy]} ·
      {' '}{settings.uploads} uploads and {settings.downloads} downloads at a time. <Link to="/settings">Change transfer settings</Link></p>
    {all.length === 0 ? <section className="settings-card"><h2>No transfers</h2>
      <p className="muted">Attach files in a chat to upload them, or download an attachment.</p></section> : <>
      <div className="transfer-filters" role="group" aria-label="Show transfers">
        {counts.map(([value, count]) => <button key={value} type="button" className="secondary" aria-pressed={filter === value}
          onClick={() => { setFilter(value); setSelected(new Set()) }}>{filterLabels[value]} ({count})</button>)}
      </div>
      <div className="settings-row">
        <label>Search<input type="search" value={search} placeholder="File or conversation" onChange={event => setSearch(event.target.value)} /></label>
        <label>Sort<select value={sort} onChange={event => setSort(event.target.value as Sort)}>
          {(Object.keys(sortLabels) as Sort[]).map(value => <option key={value} value={value}>{sortLabels[value]}</option>)}
        </select></label>
      </div>
      <div className="batch-bar settings-card" role="group" aria-label="Batch actions">
        <label className="toggle-row"><input type="checkbox" checked={shown.length > 0 && chosen.length === shown.length}
          disabled={!shown.length} onChange={event => setSelected(event.target.checked ? new Set(shown.map(entry => entry.key)) : new Set())} />
          Select all shown</label>
        <p className="muted">{chosen.length ? 'Applies to ' + chosen.length + ' selected' : 'Applies to all ' + shown.length + ' shown'}</p>
        <div className="chat-actions">
          {batchActions.map(action => <button key={action} type="button" className="secondary"
            disabled={!targets.some(entry => eligible(entry, action))} onClick={() => apply(action)}>{actionLabels[action].button}</button>)}
          <button type="button" className="secondary" disabled={!finished.length} onClick={clear}>Clear finished</button>
        </div>
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}
      {shown.length === 0 && <p className="muted">No transfers match.</p>}
      {section('upload', 'Uploads')}
      {section('download', 'Downloads')}
    </>}
  </div>
}
