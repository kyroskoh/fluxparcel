export type Account = {
  id: string
  email: string
  username: string
  displayName: string
  verified: boolean
  shareReadReceipts: boolean
}

export type Device = {
  id: string
  createdAt: string
  lastSeenAt: string
  current: boolean
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter = 0) {
    super(message)
  }
}

let refreshing: Promise<boolean> | undefined

function refreshSession() {
  if (!refreshing) {
    const rotate = async () => {
      const current = await fetch('/v1/account')
      if (current.ok) return true
      return (await fetch('/v1/auth/refresh', { method: 'POST' })).ok
    }
    refreshing = Promise.resolve(navigator.locks
      ? navigator.locks.request('fluxparcel-session-refresh', rotate)
      : rotate()
    ).finally(() => { refreshing = undefined })
  }
  return refreshing
}

export async function api<T>(path: string, method = 'GET', data?: unknown, retry = true, signal?: AbortSignal): Promise<T> {
  const request: RequestInit = { method, signal }
  if (data !== undefined) {
    request.headers = { 'Content-Type': 'application/json' }
    request.body = JSON.stringify(data)
  }
  let response = await fetch('/v1' + path, request)
  if (response.status === 401 && retry && await refreshSession()) {
    response = await fetch('/v1' + path, request)
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    const retryAfter = Number(response.headers.get('Retry-After')) * 1000
    throw new ApiError(response.status, error?.message ?? 'The request could not be completed.', Number.isFinite(retryAfter) ? retryAfter : 0)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : 'Could not reach FluxParcel. Check your connection and try again.'
}
