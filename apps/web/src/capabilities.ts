import { useEffect, useState } from 'react'
import { api } from './api'

export type Capabilities = {
  maxFileSize: number
  partSize: number
  minFileLifetime: number
  fileRetention: number
  snapshotRetention: number
}

let cached: Promise<Capabilities> | undefined

export function loadCapabilities() {
  cached ??= api<Capabilities>('/capabilities').catch(error => {
    cached = undefined
    throw error
  })
  return cached
}

export function useCapabilities() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  useEffect(() => {
    let active = true
    loadCapabilities().then(result => { if (active) setCapabilities(result) }).catch(() => undefined)
    return () => { active = false }
  }, [])
  return capabilities
}

export function formatDuration(seconds: number) {
  const units: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'minute']]
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size
      return count + ' ' + name + (count === 1 ? '' : 's')
    }
  }
  return seconds + ' seconds'
}
