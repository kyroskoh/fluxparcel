import { useEffect, useRef, useState } from 'react'
import { invitePath } from './invite-link'

const maxImageBytes = 8 * 1024 * 1024
const maxFrameEdge = 1024

async function createDecoder() {
  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Image decoding unavailable')
  return (source: CanvasImageSource, width: number, height: number) => {
    if (!width || !height) return undefined
    const scale = Math.min(1, maxFrameEdge / Math.max(width, height))
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    return jsQR(pixels.data, pixels.width, pixels.height)?.data
  }
}

export function InviteScanner({ onPreview }: { onPreview: (path: string) => void }) {
  const [camera, setCamera] = useState(false)
  const [imagePending, setImagePending] = useState(false)
  const [candidate, setCandidate] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const active = useRef(false)
  const cameraAvailable = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  useEffect(() => {
    if (!camera) return
    const preview = video.current
    if (!preview) return
    let cancelled = false
    let stream: MediaStream | undefined
    let frameTimer: ReturnType<typeof setTimeout>
    let deadline: ReturnType<typeof setTimeout>
    function stop(message: string) {
      if (cancelled) return
      setStatus('')
      setError(message)
      setCamera(false)
    }
    const onHidden = () => {
      if (document.hidden) stop('Camera stopped while this tab was hidden.')
    }
    document.addEventListener('visibilitychange', onHidden)

    async function start(element: HTMLVideoElement) {
      try {
        const decode = await createDecoder()
        if (cancelled) return
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        stream.getVideoTracks().forEach(track => track.addEventListener('ended', onEnded))
        element.srcObject = stream
        await element.play()
        if (cancelled) return
        setStatus('Point the camera at an invitation QR code.')
        deadline = setTimeout(() => stop('No invitation found. Try a photo or paste the invitation link.'), 45000)
        function scan() {
          if (cancelled) return
          try {
            const value = decode(element, element.videoWidth, element.videoHeight)
            if (value) {
              const path = invitePath(value, window.location.origin)
              setCandidate(path)
              stop(path ? '' : 'This QR code is not a FluxParcel invitation from this server.')
              return
            }
            frameTimer = setTimeout(scan, 350)
          } catch {
            stop('The camera image could not be read. Try a photo or paste the link.')
          }
        }
        scan()
      } catch (error) {
        const denied = error instanceof DOMException && error.name === 'NotAllowedError'
        stop(denied
          ? 'Camera permission was denied. Choose a QR image or paste the invitation link.'
          : 'The camera is unavailable. Choose a QR image or paste the invitation link.')
      }
    }
    function onEnded() {
      stop('The camera disconnected. Choose a QR image or paste the invitation link.')
    }
    void start(preview)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onHidden)
      clearTimeout(frameTimer)
      clearTimeout(deadline)
      stream?.getTracks().forEach(track => {
        track.removeEventListener('ended', onEnded)
        track.stop()
      })
      preview.srcObject = null
    }
  }, [camera])

  async function scanImage(file: File) {
    setCandidate(null)
    setError('')
    if (file.size > maxImageBytes || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError('Choose a PNG, JPEG or WebP image up to 8 MiB.')
      return
    }
    setImagePending(true)
    try {
      const decode = await createDecoder()
      const bitmap = await createImageBitmap(file)
      try {
        if (active.current) {
          const value = decode(bitmap, bitmap.width, bitmap.height)
          const path = value ? invitePath(value, window.location.origin) : null
          setCandidate(path)
          if (!path) setError(value ? 'This QR code is not a FluxParcel invitation from this server.' : 'No QR code was found in that image.')
        }
      } finally { bitmap.close() }
    } catch {
      if (active.current) setError('The image could not be read. Paste the invitation link to continue.')
    } finally {
      if (active.current) setImagePending(false)
    }
  }

  return <section className="invite-scanner" aria-label="Scan invitation QR code">
    <div className="chat-actions">
      {cameraAvailable ? <button className="secondary" type="button" disabled={imagePending} onClick={() => {
        setError('')
        setCandidate(null)
        setStatus(camera ? '' : 'Waiting for camera access…')
        setCamera(!camera)
      }}>{camera ? 'Stop camera' : 'Scan with camera'}</button> : <p>Camera scanning requires a supported browser and a secure connection.</p>}
    </div>
    {camera && <video ref={video} muted playsInline aria-label="Camera preview" />}
    <label className="qr-image-label">Choose QR image
      <input type="file" accept="image/png,image/jpeg,image/webp" disabled={camera || imagePending} onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) void scanImage(file)
      }} />
    </label>
    {status && <p role="status">{status}</p>}
    {imagePending && <p role="status">Reading QR image…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {candidate && <div className="qr-result">
      <p role="status">{candidate.startsWith('/i#contact_') ? 'Contact invitation found.' : 'Group invitation found.'}</p>
      <button className="primary" type="button" onClick={() => onPreview(candidate)}>Review scanned invitation</button>
    </div>}
  </section>
}
