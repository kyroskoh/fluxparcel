import { Sha256 } from './sha256'

// The app compiles against DOM types, so describe the small worker surface used here.
const scope = self as unknown as { onmessage: ((event: MessageEvent<File>) => void) | null; postMessage(message: unknown): void }

const sliceSize = 8 << 20

// Hash a file in bounded slices off the main thread and report progress after each slice.
scope.onmessage = async event => {
  const file = event.data
  const hash = new Sha256()
  try {
    for (let offset = 0; offset < file.size; offset += sliceSize) {
      hash.update(new Uint8Array(await file.slice(offset, offset + sliceSize).arrayBuffer()))
      scope.postMessage({ type: 'progress', bytes: Math.min(file.size, offset + sliceSize) })
    }
    scope.postMessage({ type: 'done', sha256: hash.hex() })
  } catch {
    scope.postMessage({ type: 'error' })
  }
}
