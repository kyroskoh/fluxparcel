import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from './api'

export type UploadState = 'preparing' | 'queued' | 'uploading' | 'paused' | 'waiting' | 'retrying' | 'verifying'
  | 'completed' | 'failed' | 'cancelled'

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
}

type TransferView = { id: string; partSize: number; partCount: number; parts: number[]; state: string }

type Upload = {
  job: UploadJob
  file: File
  sha256?: string
  transfer?: TransferView
  verified: Set<number>
  inflight: Map<number, number>
  controller?: AbortController
  attempts: number
}

const maxActiveUploads = 3
const partsPerUpload = 2
const maxAttempts = 5
const running: UploadState[] = ['preparing', 'uploading', 'retrying', 'verifying']
const terminal: UploadState[] = ['completed', 'cancelled']

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

// Uploads run in the foreground tab: three files at a time, two parts per file. Manual pause is sticky;
// network loss only parks uploads until the browser reports it is online again.
export class TransferManager {
  private uploads = new Map<string, Upload>()
  private listeners = new Set<() => void>()
  private snapshot: UploadJob[] = []
  private started = false

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
    this.pump()
  }

  stop() {
    this.started = false
    window.removeEventListener('online', this.online)
    window.removeEventListener('offline', this.offline)
    window.removeEventListener('beforeunload', this.beforeUnload)
    for (const upload of this.uploads.values()) {
      if (running.includes(upload.job.state)) this.interrupt(upload, 'queued')
    }
  }

  add(conversationId: string, files: Iterable<File>) {
    for (const file of files) {
      const id = crypto.randomUUID()
      this.uploads.set(id, {
        file, verified: new Set(), inflight: new Map(), attempts: 0,
        job: { id, conversationId, name: file.name, size: file.size, state: 'queued', preparedBytes: 0, verifiedBytes: 0, sentBytes: 0, error: '' },
      })
    }
    this.emit()
    this.pump()
  }

  pause(id: string) {
    const upload = this.uploads.get(id)
    if (!upload || terminal.includes(upload.job.state) || upload.job.state === 'verifying') return
    this.interrupt(upload, 'paused')
    this.pump()
  }

  resume(id: string) {
    const upload = this.uploads.get(id)
    if (!upload || !['paused', 'failed', 'waiting'].includes(upload.job.state)) return
    upload.attempts = 0
    this.update(upload, { state: 'queued', error: '' })
    this.pump()
  }

  cancel(id: string) {
    const upload = this.uploads.get(id)
    if (!upload || terminal.includes(upload.job.state) || upload.job.state === 'verifying') return
    this.interrupt(upload, 'cancelled')
    if (upload.transfer) void api('/transfers/' + upload.transfer.id, 'DELETE').catch(() => undefined)
    this.pump()
  }

  dismiss(id: string) {
    const upload = this.uploads.get(id)
    if (upload && ['completed', 'cancelled', 'failed'].includes(upload.job.state)) {
      this.uploads.delete(id)
      this.emit()
    }
  }

  private online = () => {
    for (const upload of this.uploads.values()) {
      if (upload.job.state === 'waiting') this.update(upload, { state: 'queued', error: '' })
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

  private interrupt(upload: Upload, state: UploadState) {
    const controller = upload.controller
    upload.controller = undefined
    upload.inflight.clear()
    this.update(upload, { state, retryAt: undefined, error: state === 'waiting' ? 'Waiting for a network connection.' : '' })
    controller?.abort(new DOMException('Interrupted', 'AbortError'))
  }

  private update(upload: Upload, change: Partial<UploadJob>) {
    upload.job = { ...upload.job, ...change }
    this.emit()
  }

  private emit() {
    this.snapshot = [...this.uploads.values()].map(upload => {
      const partSize = upload.transfer?.partSize ?? 0
      let verifiedBytes = 0
      for (const number of upload.verified) verifiedBytes += Math.min(partSize, upload.file.size - (number - 1) * partSize)
      const inflight = [...upload.inflight.values()].reduce((total, bytes) => total + bytes, 0)
      return { ...upload.job, verifiedBytes, sentBytes: Math.min(upload.file.size, verifiedBytes + inflight) }
    })
    for (const listener of this.listeners) listener()
  }

  private pump() {
    if (!this.started) return
    let active = [...this.uploads.values()].filter(upload => running.includes(upload.job.state)).length
    for (const upload of this.uploads.values()) {
      if (active >= maxActiveUploads) break
      if (upload.job.state !== 'queued') continue
      active++
      void this.run(upload)
    }
  }

  private async run(upload: Upload) {
    const controller = new AbortController()
    upload.controller = controller
    const signal = controller.signal
    try {
      if (!navigator.onLine) throw new Offline()
      if (!upload.sha256) {
        this.update(upload, { state: 'preparing' })
        upload.sha256 = await this.hash(upload, signal)
      }
      this.update(upload, { state: 'uploading' })
      const job = upload.job
      upload.transfer = await this.withRetry(upload, signal, () => api<TransferView>('/transfers', 'POST', {
        conversationId: job.conversationId, clientId: job.id, name: job.name, size: job.size,
        mime: upload.file.type, sha256: upload.sha256,
      }, true, signal))
      if (upload.transfer.state !== 'completed') {
        // Server-acknowledged parts are authoritative; locally sent bytes never count until acknowledged.
        upload.verified = new Set(upload.transfer.parts)
        this.emit()
        await this.uploadParts(upload, signal)
        await this.complete(upload, signal)
      }
      upload.verified = new Set(Array.from({ length: upload.transfer.partCount }, (_, index) => index + 1))
      this.update(upload, { state: 'completed', retryAt: undefined })
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof Offline) {
        this.update(upload, { state: 'waiting', error: 'Waiting for a network connection.' })
      } else {
        this.update(upload, { state: 'failed', retryAt: undefined, error: error instanceof Error && error.message ? error.message : 'The upload failed.' })
      }
    } finally {
      if (upload.controller === controller) upload.controller = undefined
      upload.inflight.clear()
      this.emit()
      this.pump()
    }
  }

  private hash(upload: Upload, signal: AbortSignal) {
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
      worker.postMessage(upload.file)
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
    const slice = upload.file.slice((number - 1) * partSize, number * partSize)
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
        if (!(error instanceof ApiError && error.code === 'parts_missing') || reconcile >= 2) throw error
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
  const [manager] = useState(() => new TransferManager())
  useEffect(() => {
    manager.start()
    return () => manager.stop()
  }, [manager])
  const jobs = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  return {
    accountId,
    jobs,
    add: (conversationId: string, files: Iterable<File>) => manager.add(conversationId, files),
    pause: (id: string) => manager.pause(id),
    resume: (id: string) => manager.resume(id),
    cancel: (id: string) => manager.cancel(id),
    dismiss: (id: string) => manager.dismiss(id),
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unit]
}

export const uploadLabels: Record<UploadState, string> = {
  preparing: 'Preparing', queued: 'Queued', uploading: 'Uploading', paused: 'Paused', waiting: 'Waiting',
  retrying: 'Retrying', verifying: 'Verifying', completed: 'Sent', failed: 'Failed', cancelled: 'Cancelled',
}
