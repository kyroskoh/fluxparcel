import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from './api'
import { loadCapabilities } from './capabilities'
import {
  blockMessage, currentNetwork, loadSettings, networkBlock, placeBeside, queueTime, rank, watchConditions,
  type NetworkBlock, type Priority, type TransferSettings,
} from './transfer-policy'
import { loadUploads, removeUpload, saveUpload, uploadChannel, type UploadRecord } from './upload-store'

export type UploadState = 'preparing' | 'queued' | 'uploading' | 'paused' | 'waiting' | 'retrying' | 'verifying'
  | 'needs-file' | 'elsewhere' | 'completed' | 'failed' | 'cancelled'

export type UploadJob = {
  id: string
  conversationId: string
  name: string
  size: number
  state: UploadState
  preparedBytes: number
  verifiedBytes: number
  sentBytes: number
  error: string
  retryAt?: number
  priority: Priority
  // Lower runs first; see rank in transfer-policy.
  rank: number
  // Why the network policy is holding this upload, if it is.
  block?: NetworkBlock
}

type TransferView = { id: string; partSize: number; partCount: number; parts: number[]; state: string; expiresAt: string }

type Upload = {
  job: UploadJob
  record: UploadRecord
  file?: File
  // Set after reselection: the chosen file must hash to the recorded SHA-256 before any part is sent.
  verifyIdentity: boolean
  transfer?: TransferView
  verified: Set<number>
  inflight: Map<number, number>
  controller?: AbortController
  attempts: number
}

const partsPerUpload = 2
const maxAttempts = 5
const defaultMaxFileSize = 64 * 1024 ** 3
const running: UploadState[] = ['preparing', 'uploading', 'retrying', 'verifying']
const terminal: UploadState[] = ['completed', 'cancelled']
// Jobs that have not started yet can be reordered; active jobs are never interrupted by a reorder.
const reorderable: UploadState[] = ['queued', 'waiting', 'paused', 'needs-file']
const lockName = (id: string) => 'fluxparcel-upload:' + id

class Offline extends Error {}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

function transient(error: unknown) {
  if (error instanceof TypeError) return true
  if (!(error instanceof ApiError)) return false
  return error.status === 0 || error.status === 401 || error.status === 429 || error.status >= 500
    || error.code === 'part_checksum_mismatch'
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unit]
}

// Uploads run in a foreground tab: three files at a time by default, two parts per file, highest rank first. Each upload's identity and
// server transfer are kept in IndexedDB, so a reload or crash resumes from the parts the server acknowledged.
// Manual pause is sticky; network loss only parks uploads until the browser reports it is online again.
export class TransferManager {
  private uploads = new Map<string, Upload>()
  private listeners = new Set<() => void>()
  private snapshot: UploadJob[] = []
  private started = false
  private channel?: BroadcastChannel
  private maxFileSize = defaultMaxFileSize
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

  start() {
    if (this.started) return
    this.started = true
    window.addEventListener('online', this.online)
    window.addEventListener('offline', this.offline)
    window.addEventListener('beforeunload', this.beforeUnload)
    this.settings = loadSettings(this.accountId)
    this.unwatch = watchConditions(this.accountId, this.conditionsChanged)
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(uploadChannel(this.accountId))
      this.channel.onmessage = () => void this.restore()
    }
    void loadCapabilities().then(capabilities => {
      if (capabilities.maxFileSize) this.maxFileSize = capabilities.maxFileSize
    }).catch(() => undefined)
    void this.restore().then(() => this.pump())
  }

  stop() {
    this.started = false
    window.removeEventListener('online', this.online)
    window.removeEventListener('offline', this.offline)
    window.removeEventListener('beforeunload', this.beforeUnload)
    this.unwatch?.()
    this.unwatch = undefined
    this.channel?.close()
    this.channel = undefined
    for (const upload of this.uploads.values()) {
      if (running.includes(upload.job.state)) this.interrupt(upload, 'queued')
    }
  }

  add(conversationId: string, files: Iterable<File>, expiresInSeconds?: number) {
    for (const file of files) {
      const id = crypto.randomUUID()
      const record: UploadRecord = {
        accountId: this.accountId, id, conversationId, name: file.name, size: file.size, type: file.type,
        lastModified: file.lastModified, expiresInSeconds, paused: false, createdAt: Date.now(), priority: 'normal', queuedAt: queueTime(),
      }
      const upload: Upload = {
        record, file, verifyIdentity: false, verified: new Set(), inflight: new Map(), attempts: 0,
        job: { id, conversationId, name: file.name, size: file.size, state: 'queued', preparedBytes: 0, verifiedBytes: 0, sentBytes: 0, error: '', priority: 'normal', rank: 0 },
      }
      this.uploads.set(id, upload)
      if (file.size > this.maxFileSize) {
        this.update(upload, { state: 'failed', error: 'Files can be up to ' + formatBytes(this.maxFileSize) + '.' })
        continue
      }
      this.persist(upload)
    }
    this.emit()
    this.pump()
  }

  // reselect attaches a file chosen again after a reload. Its SHA-256 must match the recorded upload.
  reselect(id: string, file: File) {
    const upload = this.uploads.get(id)
    if (!upload || upload.job.state !== 'needs-file') return
    if (file.size !== upload.record.size) {
      this.update(upload, { error: 'Choose the original file. It must be ' + formatBytes(upload.record.size) + '.' })
      return
    }
    upload.file = file
    upload.verifyIdentity = true
    upload.attempts = 0
    this.update(upload, { state: 'queued', error: '' })
    this.pump()
  }

  pause(id: string) {
    const upload = this.uploads.get(id)
    if (!upload || terminal.includes(upload.job.state) || ['verifying', 'elsewhere'].includes(upload.job.state)) return
    upload.record.paused = true
    this.rememberPause(id, true)
    this.persist(upload)
    this.interrupt(upload, 'paused')
    this.pump()
  }

  resume(id: string) {
    const upload = this.uploads.get(id)
    if (!upload || !['paused', 'failed', 'waiting'].includes(upload.job.state)) return
    upload.attempts = 0
    upload.record.paused = false
    this.rememberPause(id, false)
    upload.record.error = undefined
    this.persist(upload)
    this.update(upload, { state: this.ready(upload) ? 'queued' : 'needs-file', error: '' })
    this.pump()
  }

  cancel(id: string) {
    const upload = this.uploads.get(id)
    if (!upload || terminal.includes(upload.job.state) || ['verifying', 'elsewhere'].includes(upload.job.state)) return
    this.interrupt(upload, 'cancelled')
    const transferId = upload.record.transferId
    if (transferId) void api('/transfers/' + transferId, 'DELETE').catch(() => undefined)
    this.forget(upload)
    this.pump()
  }

  // allowNetwork records the user's explicit consent to send this upload on a network its policy would hold it on.
  allowNetwork(id: string) {
    const upload = this.uploads.get(id)
    if (!upload || terminal.includes(upload.job.state)) return
    upload.record.networkAllowed = true
    this.persist(upload)
    if (upload.job.block) this.update(upload, { state: 'queued', block: undefined, error: '' })
    this.pump()
  }

  setPriority(id: string, priority: Priority) {
    const upload = this.uploads.get(id)
    if (!upload || terminal.includes(upload.job.state)) return
    upload.record.priority = priority
    this.persist(upload)
    this.emit()
    this.pump()
  }

  // move swaps a waiting upload with its neighbour in the queue; active uploads keep running.
  move(id: string, direction: 'up' | 'down') {
    const order = [...this.uploads.values()].filter(upload => reorderable.includes(upload.job.state)).sort(this.byRank)
    const index = order.findIndex(upload => upload.record.id === id)
    const neighbour = order[index + (direction === 'up' ? -1 : 1)]
    if (index < 0 || !neighbour) return
    const placed = placeBeside(this.ordering(neighbour), direction)
    Object.assign(order[index].record, placed)
    this.persist(order[index])
    this.emit()
    this.pump()
  }

  dismiss(id: string) {
    const upload = this.uploads.get(id)
    if (upload && ['completed', 'cancelled', 'failed'].includes(upload.job.state)) {
      this.forget(upload)
      this.uploads.delete(id)
      this.emit()
    }
  }

  private ordering(upload: Upload) {
    return { priority: upload.record.priority ?? 'normal', queuedAt: upload.record.queuedAt ?? upload.record.createdAt }
  }

  private byRank = (a: Upload, b: Upload) => {
    const first = this.ordering(a)
    const second = this.ordering(b)
    return rank(first.priority, first.queuedAt) - rank(second.priority, second.queuedAt) || a.record.id.localeCompare(b.record.id)
  }

  private verifiedBytes(upload: Upload) {
    const partSize = upload.transfer?.partSize ?? 0
    let bytes = 0
    for (const number of upload.verified) bytes += Math.min(partSize, upload.record.size - (number - 1) * partSize)
    return bytes
  }

  // The policy weighs only the bytes still to send.
  private block(upload: Upload) {
    const remaining = upload.record.size - this.verifiedBytes(upload)
    return networkBlock(this.settings.policy, currentNetwork(), remaining, Boolean(upload.record.networkAllowed))
  }

  // conditionsChanged re-applies the policy after a network change or a settings change in any tab.
  private conditionsChanged = () => {
    this.settings = loadSettings(this.accountId)
    for (const upload of this.uploads.values()) {
      const block = this.block(upload)
      if (upload.job.state === 'waiting' && upload.job.block && !block) this.update(upload, { state: 'queued', block: undefined, error: '' })
      else if (block && running.includes(upload.job.state) && upload.job.state !== 'verifying') this.interrupt(upload, 'waiting', block)
      else if (block && upload.job.state === 'waiting' && upload.job.block !== block) this.hold(upload, block)
    }
    this.pump()
  }

  private hold(upload: Upload, block: NetworkBlock) {
    this.update(upload, { state: 'waiting', block, retryAt: undefined, error: blockMessage(block, currentNetwork()) })
  }

  // An upload can run when it has its file, or when the server already holds every part and only completion remains.
  private ready(upload: Upload) {
    const transfer = upload.transfer
    return Boolean(upload.file) || Boolean(transfer && (transfer.state === 'verifying' || transfer.parts.length === transfer.partCount))
  }

  private persist(upload: Upload) {
    void saveUpload(upload.record).then(() => this.channel?.postMessage('changed')).catch(() => undefined)
  }

  // Pause intent is also written synchronously to localStorage, because an IndexedDB write can still be in flight
  // when the page reloads; a manual pause must survive an immediate refresh.
  private pausedKey() {
    return 'fluxparcel-paused-uploads:' + this.accountId
  }

  private pausedIds() {
    try { return new Set<string>(JSON.parse(localStorage.getItem(this.pausedKey()) ?? '[]')) } catch { return new Set<string>() }
  }

  private rememberPause(id: string, paused: boolean) {
    const ids = this.pausedIds()
    if (paused) ids.add(id)
    else ids.delete(id)
    try {
      if (ids.size) localStorage.setItem(this.pausedKey(), JSON.stringify([...ids]))
      else localStorage.removeItem(this.pausedKey())
    } catch { /* IndexedDB still records the intent */ }
  }

  private forget(upload: Upload) {
    this.rememberPause(upload.record.id, false)
    void removeUpload(this.accountId, upload.record.id).then(() => this.channel?.postMessage('changed')).catch(() => undefined)
  }

  // restore loads durable records, including ones another tab changed, and reconciles them with the server.
  private async restore() {
    let records: UploadRecord[]
    try { records = await loadUploads(this.accountId) } catch { return }
    if (!this.started) return
    const held = new Set<string>()
    if (navigator.locks?.query) {
      const state = await navigator.locks.query().catch(() => ({ held: [] }))
      for (const lock of state.held ?? []) if (lock.name) held.add(lock.name)
    }
    const known = new Set(records.map(record => record.id))
    const paused = this.pausedIds()
    for (const id of paused) if (!known.has(id)) this.rememberPause(id, false)
    for (const [id, upload] of this.uploads) {
      // Another tab finished, cancelled or dismissed this upload.
      if (!known.has(id) && !upload.controller && !terminal.includes(upload.job.state) && upload.job.state !== 'failed') this.uploads.delete(id)
    }
    const pending: Upload[] = []
    for (const record of records) {
      const current = this.uploads.get(record.id)
      if (current?.controller) continue
      const upload: Upload = current ?? {
        record, verifyIdentity: false, verified: new Set(), inflight: new Map(), attempts: 0,
        job: { id: record.id, conversationId: record.conversationId, name: record.name, size: record.size, state: 'needs-file', preparedBytes: 0, verifiedBytes: 0, sentBytes: 0, error: '', priority: 'normal', rank: 0 },
      }
      upload.record = record
      this.uploads.set(record.id, upload)
      if (held.has(lockName(record.id))) this.update(upload, { state: 'elsewhere', error: '' })
      else if (record.paused || paused.has(record.id)) {
        record.paused = true
        this.update(upload, { state: 'paused', error: record.error ?? '' })
      }
      else if (!upload.file) this.update(upload, { state: 'needs-file', error: record.error ?? '' })
      else if (upload.job.state === 'elsewhere') this.update(upload, { state: 'queued', error: '' })
      if (record.transferId && !upload.file) pending.push(upload)
    }
    this.emit()
    await Promise.all(pending.map(upload => this.reconcile(upload)))
    this.pump()
  }

  private async reconcile(upload: Upload) {
    try {
      const transfer = await api<TransferView>('/transfers/' + upload.record.transferId)
      upload.transfer = transfer
      upload.verified = new Set(transfer.parts)
      if (transfer.state === 'completed') {
        this.forget(upload)
        this.update(upload, { state: 'completed', error: '' })
      } else if (transfer.state !== 'uploading' && transfer.state !== 'verifying') {
        this.closed(upload, 'This upload was ' + transfer.state + '. Start it again.')
      } else if (transfer.state === 'uploading' && Date.parse(transfer.expiresAt) <= Date.now()) {
        this.closed(upload, 'This upload expired. Start it again.')
      } else if (upload.job.state === 'needs-file' && this.ready(upload)) {
        this.update(upload, { state: 'queued', error: '' })
      } else {
        this.emit()
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) this.closed(upload, 'This upload is no longer available. Start it again.')
    }
  }

  private closed(upload: Upload, message: string) {
    upload.record.transferId = undefined
    upload.transfer = undefined
    upload.verified = new Set()
    this.forget(upload)
    this.update(upload, { state: 'failed', error: message })
  }

  private online = () => {
    for (const upload of this.uploads.values()) {
      if (upload.job.state === 'waiting' && !upload.job.block) this.update(upload, { state: 'queued', error: '' })
    }
    this.pump()
  }

  private offline = () => {
    for (const upload of this.uploads.values()) {
      if (running.includes(upload.job.state) && upload.job.state !== 'verifying') this.interrupt(upload, 'waiting')
    }
  }

  private beforeUnload = (event: BeforeUnloadEvent) => {
    if ([...this.uploads.values()].some(upload => running.includes(upload.job.state))) event.preventDefault()
  }

  private interrupt(upload: Upload, state: UploadState, block?: NetworkBlock) {
    const controller = upload.controller
    upload.controller = undefined
    upload.inflight.clear()
    const error = block ? blockMessage(block, currentNetwork()) : state === 'waiting' ? 'Waiting for a network connection.' : ''
    this.update(upload, { state, block, retryAt: undefined, error })
    controller?.abort(new DOMException('Interrupted', 'AbortError'))
  }

  private update(upload: Upload, change: Partial<UploadJob>) {
    upload.job = { ...upload.job, ...(change.state && change.state !== 'waiting' ? { block: undefined } : {}), ...change }
    this.emit()
  }

  private emit() {
    this.snapshot = [...this.uploads.values()].map(upload => {
      const verifiedBytes = this.verifiedBytes(upload)
      const inflight = [...upload.inflight.values()].reduce((total, bytes) => total + bytes, 0)
      const { priority, queuedAt } = this.ordering(upload)
      return { ...upload.job, verifiedBytes, sentBytes: Math.min(upload.record.size, verifiedBytes + inflight), priority, rank: rank(priority, queuedAt) }
    })
    for (const listener of this.listeners) listener()
  }

  // pump starts the highest-ranked queued uploads that the network policy allows. Held and paused uploads do not
  // take a slot, so one blocked job never holds up the rest of the queue.
  private pump() {
    if (!this.started) return
    let active = [...this.uploads.values()].filter(upload => running.includes(upload.job.state)).length
    for (const upload of [...this.uploads.values()].filter(upload => upload.job.state === 'queued').sort(this.byRank)) {
      const block = this.block(upload)
      if (block) {
        this.hold(upload, block)
        continue
      }
      if (active >= this.settings.uploads) continue
      active++
      void this.run(upload)
    }
  }

  // run holds a per-upload Web Lock, so only one tab sends a given upload at a time.
  private async run(upload: Upload) {
    const controller = new AbortController()
    upload.controller = controller
    this.update(upload, { state: 'preparing' })
    try {
      if (navigator.locks) {
        await navigator.locks.request(lockName(upload.record.id), { ifAvailable: true }, async lock => {
          if (!lock) {
            this.update(upload, { state: 'elsewhere', error: '' })
            return
          }
          this.channel?.postMessage('changed')
          await this.send(upload, controller.signal)
        })
      } else {
        await this.send(upload, controller.signal)
      }
    } finally {
      if (upload.controller === controller) upload.controller = undefined
      upload.inflight.clear()
      this.emit()
      this.channel?.postMessage('changed')
      this.pump()
    }
  }

  private async send(upload: Upload, signal: AbortSignal) {
    try {
      if (!navigator.onLine) throw new Offline()
      const record = upload.record
      if (upload.file && (!record.sha256 || upload.verifyIdentity)) {
        this.update(upload, { state: 'preparing', preparedBytes: 0 })
        const sha256 = await this.hash(upload.file, upload, signal)
        if (upload.verifyIdentity && sha256 !== record.sha256) {
          upload.file = undefined
          this.update(upload, { state: 'needs-file', error: 'That is a different file. Choose the original file to resume.' })
          return
        }
        upload.verifyIdentity = false
        record.sha256 = sha256
        this.persist(upload)
      }
      this.update(upload, { state: 'uploading' })
      upload.transfer = await this.withRetry(upload, signal, () => api<TransferView>('/transfers', 'POST', {
        conversationId: record.conversationId, clientId: record.id, name: record.name, size: record.size,
        mime: record.type, sha256: record.sha256, ...(record.expiresInSeconds ? { expiresInSeconds: record.expiresInSeconds } : {}),
      }, true, signal))
      if (record.transferId !== upload.transfer.id) {
        record.transferId = upload.transfer.id
        this.persist(upload)
      }
      if (upload.transfer.state !== 'completed') {
        // Server-acknowledged parts are authoritative; locally sent bytes never count until acknowledged.
        upload.verified = new Set(upload.transfer.parts)
        this.emit()
        if (upload.verified.size < upload.transfer.partCount && !upload.file) {
          this.update(upload, { state: 'needs-file', error: '' })
          return
        }
        await this.uploadParts(upload, signal)
        await this.complete(upload, signal)
      }
      upload.verified = new Set(Array.from({ length: upload.transfer.partCount }, (_, index) => index + 1))
      this.forget(upload)
      this.update(upload, { state: 'completed', retryAt: undefined, error: '' })
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof Offline) {
        this.update(upload, { state: 'waiting', error: 'Waiting for a network connection.' })
      } else if (error instanceof ApiError && ['transfer_closed', 'transfer_expired', 'integrity_failed'].includes(error.code)) {
        this.closed(upload, error.message)
      } else {
        const message = error instanceof Error && error.message ? error.message : 'The upload failed.'
        upload.record.error = message
        this.persist(upload)
        this.update(upload, { state: 'failed', retryAt: undefined, error: message })
      }
    }
  }

  private hash(file: File, upload: Upload, signal: AbortSignal) {
    return new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL('./hash-worker.ts', import.meta.url), { type: 'module' })
      const finish = () => worker.terminate()
      signal.addEventListener('abort', () => { finish(); reject(signal.reason) }, { once: true })
      worker.onmessage = (event: MessageEvent<{ type: string; bytes?: number; sha256?: string }>) => {
        if (event.data.type === 'progress') this.update(upload, { preparedBytes: event.data.bytes ?? 0 })
        else if (event.data.type === 'done') { finish(); resolve(event.data.sha256!) }
        else { finish(); reject(new Error('The file could not be read. Select it again.')) }
      }
      worker.onerror = () => { finish(); reject(new Error('The file could not be read. Select it again.')) }
      worker.postMessage(file)
    })
  }

  private async withRetry<T>(upload: Upload, signal: AbortSignal, send: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        const result = await send()
        upload.attempts = 0
        return result
      } catch (error) {
        if (signal.aborted) throw error
        const verifying = error instanceof ApiError && error.code === 'transfer_verifying'
        if (!verifying && (!transient(error) || ++upload.attempts > maxAttempts)) throw error
        if (!navigator.onLine) throw new Offline()
        if (error instanceof ApiError && error.status === 401) await api('/account').catch(() => undefined)
        const backoff = Math.min(60000, 1000 * 2 ** Math.max(0, upload.attempts - 1)) + Math.random() * 400
        const delay = error instanceof ApiError && error.retryAfter > 0 ? error.retryAfter : backoff
        const state = upload.job.state
        if (!verifying) this.update(upload, { state: 'retrying', retryAt: Date.now() + delay })
        await wait(delay, signal)
        this.update(upload, { state, retryAt: undefined })
      }
    }
  }

  private async uploadParts(upload: Upload, signal: AbortSignal) {
    const transfer = upload.transfer!
    const claimed = new Set<number>()
    const next = () => {
      for (let number = 1; number <= transfer.partCount; number++) {
        if (!upload.verified.has(number) && !claimed.has(number)) { claimed.add(number); return number }
      }
      return 0
    }
    // One failed part stops its sibling so the upload settles in a single state.
    const parts = new AbortController()
    signal.addEventListener('abort', () => parts.abort(signal.reason), { once: true })
    const worker = async () => {
      for (let number = next(); number; number = next()) {
        await this.withRetry(upload, parts.signal, () => this.sendPart(upload, number, parts.signal))
        upload.inflight.delete(number)
        upload.verified.add(number)
        this.emit()
      }
    }
    await Promise.all(Array.from({ length: Math.min(partsPerUpload, transfer.partCount) }, () => worker().catch(error => {
      parts.abort(error)
      throw error
    })))
  }

  private async sendPart(upload: Upload, number: number, signal: AbortSignal) {
    const { id, partSize } = upload.transfer!
    const slice = upload.file!.slice((number - 1) * partSize, number * partSize)
    const buffer = await slice.arrayBuffer()
    const checksum = hex(await crypto.subtle.digest('SHA-256', buffer))
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest()
      request.open('PUT', '/v1/transfers/' + id + '/parts/' + number)
      request.setRequestHeader('X-Content-SHA256', checksum)
      request.upload.onprogress = event => {
        upload.inflight.set(number, event.loaded)
        this.emit()
      }
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) return resolve()
        let body: { message?: string; code?: string } = {}
        try { body = JSON.parse(request.responseText) } catch { /* keep the generic message */ }
        const retryAfter = Number(request.getResponseHeader('Retry-After')) * 1000
        reject(new ApiError(request.status, body.message ?? 'The part could not be uploaded.', Number.isFinite(retryAfter) ? retryAfter : 0, body.code ?? ''))
      }
      request.onerror = () => reject(new ApiError(0, 'The connection was interrupted.'))
      request.onabort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', () => request.abort(), { once: true })
      request.send(buffer)
    })
  }

  private async complete(upload: Upload, signal: AbortSignal) {
    for (let reconcile = 0; ; reconcile++) {
      this.update(upload, { state: 'verifying' })
      try {
        upload.transfer = await this.withRetry(upload, signal,
          () => api<TransferView>('/transfers/' + upload.transfer!.id + '/complete', 'POST', {}, true, signal))
        return
      } catch (error) {
        // The server is authoritative: upload any part it does not hold, then complete again.
        if (!(error instanceof ApiError && error.code === 'parts_missing') || reconcile >= 2 || !upload.file) throw error
        upload.transfer = await this.withRetry(upload, signal, () => api<TransferView>('/transfers/' + upload.transfer!.id, 'GET', undefined, true, signal))
        upload.verified = new Set(upload.transfer.parts)
        this.update(upload, { state: 'uploading' })
        await this.uploadParts(upload, signal)
      }
    }
  }
}

export type Transfers = ReturnType<typeof useTransfers>

export function useTransfers(accountId: string) {
  const [manager] = useState(() => new TransferManager(accountId))
  useEffect(() => {
    manager.start()
    return () => manager.stop()
  }, [manager])
  const jobs = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  return {
    accountId,
    jobs,
    add: (conversationId: string, files: Iterable<File>, expiresInSeconds?: number) => manager.add(conversationId, files, expiresInSeconds),
    reselect: (id: string, file: File) => manager.reselect(id, file),
    pause: (id: string) => manager.pause(id),
    resume: (id: string) => manager.resume(id),
    cancel: (id: string) => manager.cancel(id),
    dismiss: (id: string) => manager.dismiss(id),
    allowNetwork: (id: string) => manager.allowNetwork(id),
    setPriority: (id: string, priority: Priority) => manager.setPriority(id, priority),
    move: (id: string, direction: 'up' | 'down') => manager.move(id, direction),
  }
}

export const uploadLabels: Record<UploadState, string> = {
  preparing: 'Preparing', queued: 'Queued', uploading: 'Uploading', paused: 'Paused', waiting: 'Waiting',
  retrying: 'Retrying', verifying: 'Verifying', 'needs-file': 'Select the file to resume', elsewhere: 'Uploading in another tab',
  completed: 'Sent', failed: 'Failed', cancelled: 'Cancelled',
}
