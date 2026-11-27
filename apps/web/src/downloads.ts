import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from './api'
import {
  appDownloadsSupported, downloadChannel, loadDownloads, partialFile, removeDownload, removePartial, saveDownload,
  type DownloadRecord,
} from './download-store'
import {
  blockMessage, currentNetwork, loadSettings, networkBlock, placeBeside, queueTime, rank, watchConditions,
  type NetworkBlock, type Priority, type TransferSettings,
} from './transfer-policy'
import { formatBytes } from './transfers'

export type DownloadState = 'queued' | 'downloading' | 'paused' | 'waiting' | 'retrying' | 'verifying' | 'elsewhere'
  | 'completed' | 'failed' | 'cancelled'

export type DownloadJob = {
  fileId: string
  conversationId: string
  name: string
  size: number
  state: DownloadState
  committedBytes: number
  receivedBytes: number
  error: string
  // Set when the server's copy no longer matches the partial bytes; resuming would mix two versions.
  restartRequired: boolean
  priority: Priority
  // Lower runs first; see rank in transfer-policy.
  rank: number
  // Why the network policy is holding this download, if it is.
  block?: NetworkBlock
}

export type DownloadSource = { id: string; name: string; size: number; sha256: string }

// settled resolves when a running attempt has closed its file handle, so the partial copy can be removed safely.
type Download = { job: DownloadJob; record: DownloadRecord; controller?: AbortController; attempts: number; settled?: Promise<void> }

const maxAttempts = 5
const running: DownloadState[] = ['downloading', 'retrying', 'verifying']
// Downloads that have not started yet can be reordered; active downloads are never interrupted by a reorder.
const reorderable: DownloadState[] = ['queued', 'waiting', 'paused']
const finished: DownloadState[] = ['completed', 'failed', 'cancelled']
const lockName = (fileId: string) => 'fluxparcel-download:' + fileId

class Offline extends Error {}
// The server's copy changed (If-Range answered with the whole file or a different range).
class Changed extends Error {}
// Access was revoked or the file expired.
class Gone extends Error {}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

function transient(error: unknown) {
  if (error instanceof TypeError) return true
  return error instanceof ApiError && (error.status === 0 || error.status === 401 || error.status === 429 || error.status >= 500)
}

// Downloads run in a foreground tab and stream into the origin private file system with bounded memory. Each resume
// asks only for missing bytes with If-Range keyed by the file's SHA-256, and the whole file is verified before the
// user can save it. Manual pause is sticky across reloads.
export class DownloadManager {
  private downloads = new Map<string, Download>()
  private listeners = new Set<() => void>()
  private snapshot: { supported: boolean; jobs: DownloadJob[] } = { supported: false, jobs: [] }
  private started = false
  private channel?: BroadcastChannel
  supported = appDownloadsSupported()
  private settings: TransferSettings
  private unwatch?: () => void

  constructor(private accountId: string) {
    this.settings = loadSettings(accountId)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = () => this.snapshot

  // The worker reports whether synchronous file handles exist; without them downloads use the browser.
  private probe() {
    return new Promise<boolean>(resolve => {
      const worker = new Worker(new URL('./download-worker.ts', import.meta.url), { type: 'module' })
      const done = (supported: boolean) => { worker.terminate(); resolve(supported) }
      worker.onmessage = (event: MessageEvent<{ type: string; supported?: boolean }>) => done(Boolean(event.data.supported))
      worker.onerror = () => done(false)
      worker.postMessage({ type: 'probe' })
    })
  }

  start() {
    if (this.started || !this.supported) return
    this.started = true
    window.addEventListener('online', this.online)
    window.addEventListener('offline', this.offline)
    this.settings = loadSettings(this.accountId)
    this.unwatch = watchConditions(this.accountId, this.conditionsChanged)
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(downloadChannel(this.accountId))
      this.channel.onmessage = () => void this.restore()
    }
    void navigator.storage.persist?.().catch(() => false)
    void this.probe().then(supported => {
      this.supported = supported
      this.emit()
      if (supported) return this.restore().then(() => this.pump())
    })
  }

  stop() {
    this.started = false
    window.removeEventListener('online', this.online)
    window.removeEventListener('offline', this.offline)
    this.unwatch?.()
    this.unwatch = undefined
    this.channel?.close()
    this.channel = undefined
    for (const download of this.downloads.values()) {
      if (running.includes(download.job.state)) this.interrupt(download, 'queued')
    }
  }

  add(conversationId: string, file: DownloadSource) {
    if (!this.supported) return
    const existing = this.downloads.get(file.id)
    if (existing && !['cancelled'].includes(existing.job.state)) {
      if (['paused', 'failed', 'waiting'].includes(existing.job.state)) this.resume(file.id)
      return
    }
    const record: DownloadRecord = {
      accountId: this.accountId, fileId: file.id, conversationId, name: file.name, size: file.size, sha256: file.sha256,
      paused: false, completed: false, createdAt: Date.now(), priority: 'normal', queuedAt: queueTime(),
    }
    const download: Download = { record, attempts: 0, job: this.blankJob(record) }
    this.downloads.set(file.id, download)
    this.persist(download)
    this.emit()
    this.pump()
  }

  pause(fileId: string) {
    const download = this.downloads.get(fileId)
    if (!download || !['queued', 'downloading', 'retrying', 'waiting'].includes(download.job.state)) return
    download.record.paused = true
    this.rememberPause(fileId, true)
    this.persist(download)
    this.interrupt(download, 'paused')
    this.pump()
  }

  resume(fileId: string) {
    const download = this.downloads.get(fileId)
    if (!download || !['paused', 'failed', 'waiting'].includes(download.job.state) || download.job.restartRequired) return
    download.attempts = 0
    download.record.paused = false
    this.rememberPause(fileId, false)
    this.persist(download)
    this.update(download, { state: 'queued', error: '' })
    this.pump()
  }

  // allowNetwork records the user's explicit consent to download this file on a network its policy would hold it on.
  allowNetwork(fileId: string) {
    const download = this.downloads.get(fileId)
    if (!download || finished.includes(download.job.state)) return
    download.record.networkAllowed = true
    this.persist(download)
    if (download.job.block) this.update(download, { state: 'queued', block: undefined, error: '' })
    this.pump()
  }

  setPriority(fileId: string, priority: Priority) {
    const download = this.downloads.get(fileId)
    if (!download || finished.includes(download.job.state)) return
    download.record.priority = priority
    this.persist(download)
    this.emit()
    this.pump()
  }

  // move swaps a waiting download with its neighbour in the queue; active downloads keep running.
  move(fileId: string, direction: 'up' | 'down') {
    const order = [...this.downloads.values()].filter(download => reorderable.includes(download.job.state)).sort(this.byRank)
    const index = order.findIndex(download => download.record.fileId === fileId)
    const neighbour = order[index + (direction === 'up' ? -1 : 1)]
    if (index < 0 || !neighbour) return
    Object.assign(order[index].record, placeBeside(this.ordering(neighbour), direction))
    this.persist(order[index])
    this.emit()
    this.pump()
  }

  // restart discards the partial bytes, for example after the server's copy changed.
  async restart(fileId: string) {
    const download = this.downloads.get(fileId)
    if (!download || download.job.state !== 'failed') return
    await removePartial(this.accountId, fileId)
    download.attempts = 0
    download.record.paused = false
    this.rememberPause(fileId, false)
    this.persist(download)
    this.update(download, { state: 'queued', error: '', committedBytes: 0, receivedBytes: 0, restartRequired: false })
    this.pump()
  }

  // cancel stops the download and deletes this device's partial copy. It never affects the file for anyone else.
  async cancel(fileId: string) {
    const download = this.downloads.get(fileId)
    if (!download || ['verifying', 'elsewhere'].includes(download.job.state)) return
    this.interrupt(download, 'cancelled')
    await download.settled
    await this.forget(download)
  }

  // save hands the verified file to the browser. The object URL reads from OPFS on disk, not from memory.
  async save(fileId: string) {
    const download = this.downloads.get(fileId)
    if (!download || download.job.state !== 'completed') return
    const file = await (await partialFile(this.accountId, fileId)).getFile()
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = download.record.name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  // dismiss removes the local copy of a completed, failed or cancelled download.
  async dismiss(fileId: string) {
    const download = this.downloads.get(fileId)
    if (!download || !['completed', 'failed', 'cancelled'].includes(download.job.state)) return
    await this.forget(download)
  }

  private blankJob(record: DownloadRecord): DownloadJob {
    return {
      fileId: record.fileId, conversationId: record.conversationId, name: record.name, size: record.size, state: 'queued',
      committedBytes: 0, receivedBytes: 0, error: '', restartRequired: false, priority: 'normal', rank: 0,
    }
  }

  private ordering(download: Download) {
    return { priority: download.record.priority ?? 'normal', queuedAt: download.record.queuedAt ?? download.record.createdAt }
  }

  private byRank = (a: Download, b: Download) => {
    const first = this.ordering(a)
    const second = this.ordering(b)
    return rank(first.priority, first.queuedAt) - rank(second.priority, second.queuedAt) || a.record.fileId.localeCompare(b.record.fileId)
  }

  private block(download: Download) {
    return networkBlock(this.settings.policy, currentNetwork(), download.record.size - download.job.committedBytes, Boolean(download.record.networkAllowed))
  }

  // conditionsChanged re-applies the policy after a network change or a settings change in any tab.
  private conditionsChanged = () => {
    this.settings = loadSettings(this.accountId)
    for (const download of this.downloads.values()) {
      const block = this.block(download)
      if (download.job.state === 'waiting' && download.job.block && !block) this.update(download, { state: 'queued', block: undefined, error: '' })
      else if (block && running.includes(download.job.state) && download.job.state !== 'verifying') this.interrupt(download, 'waiting', block)
      else if (block && download.job.state === 'waiting' && download.job.block !== block) this.hold(download, block)
    }
    this.pump()
  }

  private hold(download: Download, block: NetworkBlock) {
    this.update(download, { state: 'waiting', block, receivedBytes: download.job.committedBytes, error: blockMessage(block, currentNetwork()) })
  }

  private async forget(download: Download) {
    this.downloads.delete(download.record.fileId)
    this.rememberPause(download.record.fileId, false)
    this.emit()
    await removePartial(this.accountId, download.record.fileId)
    await removeDownload(this.accountId, download.record.fileId).catch(() => undefined)
    this.channel?.postMessage('changed')
    this.pump()
  }

  private persist(download: Download) {
    void saveDownload(download.record).then(() => this.channel?.postMessage('changed')).catch(() => undefined)
  }

  // Pause intent is also written synchronously, because an IndexedDB write can still be in flight when the page reloads.
  private pausedKey() {
    return 'fluxparcel-paused-downloads:' + this.accountId
  }

  private pausedIds() {
    try { return new Set<string>(JSON.parse(localStorage.getItem(this.pausedKey()) ?? '[]')) } catch { return new Set<string>() }
  }

  private rememberPause(fileId: string, paused: boolean) {
    const ids = this.pausedIds()
    if (paused) ids.add(fileId)
    else ids.delete(fileId)
    try {
      if (ids.size) localStorage.setItem(this.pausedKey(), JSON.stringify([...ids]))
      else localStorage.removeItem(this.pausedKey())
    } catch { /* IndexedDB still records the intent */ }
  }

  private async restore() {
    let records: DownloadRecord[]
    try { records = await loadDownloads(this.accountId) } catch { return }
    if (!this.started) return
    const held = new Set<string>()
    if (navigator.locks?.query) {
      const state = await navigator.locks.query().catch(() => ({ held: [] }))
      for (const lock of state.held ?? []) if (lock.name) held.add(lock.name)
    }
    const paused = this.pausedIds()
    const known = new Set(records.map(record => record.fileId))
    for (const [fileId, download] of this.downloads) {
      if (!known.has(fileId) && !download.controller) this.downloads.delete(fileId)
    }
    for (const record of records) {
      const current = this.downloads.get(record.fileId)
      if (current?.controller) continue
      const download: Download = current ?? { record, attempts: 0, job: this.blankJob(record) }
      download.record = record
      this.downloads.set(record.fileId, download)
      let committed = 0
      try { committed = (await (await partialFile(this.accountId, record.fileId)).getFile()).size } catch { /* nothing stored */ }
      const change: Partial<DownloadJob> = { committedBytes: committed, receivedBytes: committed }
      if (held.has(lockName(record.fileId))) change.state = 'elsewhere'
      else if (record.completed && committed === record.size) change.state = 'completed'
      else if (record.paused || paused.has(record.fileId)) { record.paused = true; change.state = 'paused' }
      else if (!current || ['elsewhere', 'queued'].includes(current.job.state)) change.state = 'queued'
      this.update(download, change)
    }
    this.pump()
  }

  private online = () => {
    for (const download of this.downloads.values()) {
      if (download.job.state === 'waiting' && !download.job.block) this.update(download, { state: 'queued', error: '' })
    }
    this.pump()
  }

  private offline = () => {
    for (const download of this.downloads.values()) {
      if (running.includes(download.job.state) && download.job.state !== 'verifying') this.interrupt(download, 'waiting')
    }
  }

  private interrupt(download: Download, state: DownloadState, block?: NetworkBlock) {
    const controller = download.controller
    download.controller = undefined
    this.update(download, {
      state, block, receivedBytes: download.job.committedBytes,
      error: block ? blockMessage(block, currentNetwork()) : state === 'waiting' ? 'Waiting for a network connection.' : '',
    })
    controller?.abort(new DOMException('Interrupted', 'AbortError'))
  }

  private update(download: Download, change: Partial<DownloadJob>) {
    download.job = { ...download.job, ...(change.state && change.state !== 'waiting' ? { block: undefined } : {}), ...change }
    this.emit()
  }

  private emit() {
    this.snapshot = {
      supported: this.supported,
      jobs: [...this.downloads.values()].map(download => {
        const { priority, queuedAt } = this.ordering(download)
        return { ...download.job, priority, rank: rank(priority, queuedAt) }
      }),
    }
    for (const listener of this.listeners) listener()
  }

  // pump starts the highest-ranked queued downloads that the network policy allows. Held and paused downloads do
  // not take a slot, so one blocked job never holds up the rest of the queue.
  private pump() {
    if (!this.started) return
    let active = [...this.downloads.values()].filter(download => running.includes(download.job.state)).length
    for (const download of [...this.downloads.values()].filter(download => download.job.state === 'queued').sort(this.byRank)) {
      const block = this.block(download)
      if (block) {
        this.hold(download, block)
        continue
      }
      if (active >= this.settings.downloads) continue
      active++
      void this.run(download)
    }
  }

  private run(download: Download) {
    download.settled = this.runLocked(download)
    return download.settled
  }

  private async runLocked(download: Download) {
    const controller = new AbortController()
    download.controller = controller
    this.update(download, { state: 'downloading' })
    try {
      if (navigator.locks) {
        await navigator.locks.request(lockName(download.record.fileId), { ifAvailable: true }, async lock => {
          if (!lock) {
            this.update(download, { state: 'elsewhere' })
            return
          }
          this.channel?.postMessage('changed')
          await this.fetchAndVerify(download, controller.signal)
        })
      } else {
        await this.fetchAndVerify(download, controller.signal)
      }
    } finally {
      if (download.controller === controller) download.controller = undefined
      this.emit()
      this.channel?.postMessage('changed')
      this.pump()
    }
  }

  private async fetchAndVerify(download: Download, signal: AbortSignal) {
    const record = download.record
    try {
      let sha256: string
      for (;;) {
        const estimate = await navigator.storage.estimate?.().catch(() => undefined)
        if (estimate?.quota !== undefined && estimate.usage !== undefined
          && estimate.quota - estimate.usage < record.size - download.job.committedBytes) {
          throw new DOMException('Not enough storage', 'QuotaExceededError')
        }
        try {
          sha256 = await this.attempt(download, signal)
          download.attempts = 0
          break
        } catch (error) {
          if (signal.aborted || !transient(error) || ++download.attempts > maxAttempts) throw error
          if (!navigator.onLine) throw new Offline()
          if (error instanceof ApiError && error.status === 401) await api('/account').catch(() => undefined)
          const backoff = Math.min(60000, 1000 * 2 ** Math.max(0, download.attempts - 1)) + Math.random() * 400
          const delay = error instanceof ApiError && error.retryAfter > 0 ? error.retryAfter : backoff
          this.update(download, { state: 'retrying', receivedBytes: download.job.committedBytes })
          await wait(delay, signal)
          this.update(download, { state: 'downloading' })
        }
      }
      if (sha256 !== record.sha256) {
        await removePartial(this.accountId, record.fileId)
        this.update(download, { state: 'failed', committedBytes: 0, receivedBytes: 0, error: 'The downloaded file did not match its checksum and was discarded. Download it again.' })
        return
      }
      record.completed = true
      this.persist(download)
      this.update(download, { state: 'completed', receivedBytes: record.size, committedBytes: record.size, error: '' })
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof Offline) {
        this.update(download, { state: 'waiting', receivedBytes: download.job.committedBytes, error: 'Waiting for a network connection.' })
      } else if (error instanceof Changed) {
        this.update(download, { state: 'failed', receivedBytes: download.job.committedBytes, restartRequired: true,
          error: 'The file changed on the server, so the partial copy cannot be continued. Restart the download.' })
      } else if (error instanceof Gone) {
        // Revoked access or an expired file also removes this device's partial copy.
        await removePartial(this.accountId, record.fileId)
        this.update(download, { state: 'failed', committedBytes: 0, receivedBytes: 0, error: 'This file is no longer available to you.' })
      } else if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        this.update(download, { state: 'failed', receivedBytes: download.job.committedBytes, error: 'This browser ran out of storage. Free some space, then resume.' })
      } else {
        this.update(download, { state: 'failed', receivedBytes: download.job.committedBytes, error: error instanceof Error && error.message ? error.message : 'The download failed.' })
      }
    }
  }

  // attempt runs one download attempt in a worker and resolves with the SHA-256 of the complete local file.
  private attempt(download: Download, signal: AbortSignal) {
    const record = download.record
    return new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL('./download-worker.ts', import.meta.url), { type: 'module' })
      let settled = false
      const finish = (outcome: () => void) => {
        if (settled) return
        settled = true
        worker.terminate()
        outcome()
      }
      // Ask the worker to stop and wait until it has closed its file handle before reporting the abort.
      const abort = () => {
        worker.postMessage({ type: 'abort' })
        setTimeout(() => finish(() => reject(signal.reason)), 5000)
      }
      signal.addEventListener('abort', abort, { once: true })
      worker.onmessage = (event: MessageEvent<{ type: string; committed?: number; received?: number; sha256?: string; kind?: string; status?: number; retryAfter?: number }>) => {
        const message = event.data
        if (message.type === 'progress') {
          this.update(download, { committedBytes: message.committed ?? 0, receivedBytes: message.received ?? 0 })
        } else if (message.type === 'verifying') {
          this.update(download, { state: 'verifying' })
        } else if (message.type === 'done') {
          finish(() => resolve(message.sha256!))
        } else if (message.type === 'aborted') {
          finish(() => reject(signal.reason))
        } else if (message.type === 'error') {
          finish(() => reject(message.kind === 'changed' ? new Changed()
            : message.kind === 'gone' ? new Gone()
              : message.kind === 'quota' ? new DOMException('Not enough storage', 'QuotaExceededError')
                : new ApiError(message.status ?? 0, 'The download was interrupted.', Number.isFinite(message.retryAfter) ? message.retryAfter! : 0)))
        }
      }
      worker.onerror = () => finish(() => reject(new Error('The download could not be written to this device.')))
      worker.postMessage({ type: 'start', accountId: this.accountId, fileId: record.fileId, size: record.size, sha256: record.sha256 })
    })
  }
}

export type Downloads = ReturnType<typeof useDownloads>

export function useDownloads(accountId: string) {
  const [manager] = useState(() => new DownloadManager(accountId))
  useEffect(() => {
    manager.start()
    return () => manager.stop()
  }, [manager])
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  return {
    supported: snapshot.supported,
    jobs: snapshot.jobs,
    add: (conversationId: string, file: DownloadSource) => manager.add(conversationId, file),
    pause: (fileId: string) => manager.pause(fileId),
    resume: (fileId: string) => manager.resume(fileId),
    restart: (fileId: string) => void manager.restart(fileId),
    cancel: (fileId: string) => void manager.cancel(fileId),
    save: (fileId: string) => void manager.save(fileId),
    dismiss: (fileId: string) => void manager.dismiss(fileId),
    allowNetwork: (fileId: string) => manager.allowNetwork(fileId),
    setPriority: (fileId: string, priority: Priority) => manager.setPriority(fileId, priority),
    move: (fileId: string, direction: 'up' | 'down') => manager.move(fileId, direction),
  }
}

export const downloadLabels: Record<DownloadState, string> = {
  queued: 'Queued', downloading: 'Downloading', paused: 'Paused', waiting: 'Waiting', retrying: 'Retrying',
  verifying: 'Verifying', elsewhere: 'Downloading in another tab', completed: 'Verified', failed: 'Failed', cancelled: 'Cancelled',
}

export function downloadDetail(job: DownloadJob) {
  if (job.state === 'completed') return 'Ready to save'
  return formatBytes(job.committedBytes) + ' of ' + formatBytes(job.size) + ' saved on this device'
}
