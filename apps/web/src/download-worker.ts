import { Sha256 } from './sha256'

// Streams an attachment into the origin private file system and verifies it, off the main thread. A synchronous
// access handle writes in place, so each checkpoint flushes only new bytes instead of copying the whole file.

type Start = { type: 'start'; accountId: string; fileId: string; size: number; sha256: string }
type Message = Start | { type: 'abort' } | { type: 'probe' }

type SyncHandle = {
  getSize(): number
  write(data: Uint8Array, options: { at: number }): number
  read(data: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}

const scope = self as unknown as { onmessage: ((event: MessageEvent<Message>) => void) | null; postMessage(message: unknown): void }
const segmentSize = 8 << 20
const stallTimeout = 30000
// Progress between checkpoints is reported at most ten times a second so the page is not re-rendered per chunk.
const progressInterval = 100
let controller: AbortController | undefined

function supported() {
  return typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype
}

async function partial(accountId: string, fileId: string) {
  const root = await navigator.storage.getDirectory()
  const downloads = await root.getDirectoryHandle('fluxparcel-downloads', { create: true })
  const account = await downloads.getDirectoryHandle(accountId, { create: true })
  const handle = await account.getFileHandle(fileId + '.part', { create: true })
  return (handle as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()
}

async function download(start: Start, signal: AbortSignal) {
  const access = await partial(start.accountId, start.fileId)
  try {
    let position = access.getSize()
    scope.postMessage({ type: 'progress', committed: position, received: position })
    if (position > start.size) throw { kind: 'changed' }
    if (position < start.size) {
      const headers: HeadersInit = position > 0 ? { Range: 'bytes=' + position + '-', 'If-Range': '"' + start.sha256 + '"' } : {}
      const response = await fetch('/v1/files/' + start.fileId + '/content', { headers, signal })
      if (response.status === 404 || response.status === 403) throw { kind: 'gone' }
      if (!response.ok) throw { kind: 'http', status: response.status, retryAfter: Number(response.headers.get('Retry-After')) * 1000 }
      if (position > 0) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')
        if (response.status !== 206 || !range || Number(range[1]) !== position || Number(range[3]) !== start.size) throw { kind: 'changed' }
      } else if (response.headers.get('ETag') !== '"' + start.sha256 + '"') {
        throw { kind: 'changed' }
      }
      const reader = response.body!.getReader()
      let flushed = position
      let reported = 0
      for (;;) {
        let stalled: ReturnType<typeof setTimeout> | undefined
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { stalled = setTimeout(() => reject({ kind: 'http', status: 0 }), stallTimeout) }),
        ]).finally(() => clearTimeout(stalled))
        if (next.done) break
        if (position + next.value.length > start.size) throw { kind: 'changed' }
        access.write(next.value, { at: position })
        position += next.value.length
        if (position - flushed >= segmentSize) {
          access.flush()
          flushed = position
          scope.postMessage({ type: 'progress', committed: position, received: position })
        } else if (performance.now() - reported >= progressInterval) {
          reported = performance.now()
          scope.postMessage({ type: 'progress', committed: flushed, received: position })
        }
      }
      access.flush()
      scope.postMessage({ type: 'progress', committed: position, received: position })
    }
    if (access.getSize() !== start.size) throw { kind: 'changed' }
    scope.postMessage({ type: 'verifying' })
    const hash = new Sha256()
    const buffer = new Uint8Array(segmentSize)
    for (let offset = 0; offset < start.size; offset += segmentSize) {
      if (signal.aborted) throw signal.reason
      const read = access.read(buffer, { at: offset })
      hash.update(buffer.subarray(0, read))
    }
    return hash.hex()
  } finally {
    access.close()
  }
}

scope.onmessage = event => {
  const message = event.data
  if (message.type === 'probe') {
    scope.postMessage({ type: 'probe', supported: supported() })
  } else if (message.type === 'abort') {
    controller?.abort(new DOMException('Interrupted', 'AbortError'))
  } else {
    controller = new AbortController()
    const signal = controller.signal
    download(message, signal)
      .then(sha256 => scope.postMessage({ type: 'done', sha256 }))
      .catch(error => {
        if (signal.aborted) return scope.postMessage({ type: 'aborted' })
        if (error && typeof error === 'object' && 'kind' in error) return scope.postMessage({ type: 'error', ...error })
        const quota = error instanceof DOMException && error.name === 'QuotaExceededError'
        scope.postMessage({ type: 'error', kind: quota ? 'quota' : 'http', status: 0 })
      })
  }
}
