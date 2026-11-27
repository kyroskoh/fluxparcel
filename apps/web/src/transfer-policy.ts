// Network policy, priorities and concurrency shared by uploads and downloads on this device.
//
// Browsers report the network type only through the Network Information API, which most desktop browsers and Safari
// do not expose. An unreported type is "unknown", never assumed to be Wi-Fi, so strict policies block until the user
// explicitly allows a transfer on the current network.

export type NetworkKind = 'wifi' | 'cellular' | 'unknown'
export type NetworkPolicy = 'any' | 'ask' | 'wifi'
export type Priority = 'high' | 'normal' | 'low'
// wifi: the policy needs Wi-Fi; confirm: a large transfer needs consent on this network.
export type NetworkBlock = 'wifi' | 'confirm'

export type TransferSettings = { policy: NetworkPolicy; uploads: number; downloads: number }

export const defaultSettings: TransferSettings = { policy: 'ask', uploads: 3, downloads: 3 }
export const minConcurrent = 1
export const maxConcurrent = 5
// The "ask" policy lets smaller transfers run on any network and asks before larger ones on cellular or unknown.
export const askThreshold = 100 * 1024 ** 2
// Each step of waiting raises a job one priority level, so low-priority work is never starved.
export const agingStep = 10 * 60 * 1000

const weights: Record<Priority, number> = { high: 0, normal: 1, low: 2 }
const changeEvent = 'fluxparcel-transfer-settings'
const settingsKey = (accountId: string) => 'fluxparcel-transfer-settings:' + accountId

type Connection = EventTarget & { type?: string }

function connection() {
  return typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: Connection }).connection
}

export function currentNetwork(): NetworkKind {
  const type = connection()?.type
  if (type === 'wifi' || type === 'ethernet') return 'wifi'
  if (type === 'cellular' || type === 'wimax' || type === 'bluetooth') return 'cellular'
  return 'unknown'
}

export const networkLabels: Record<NetworkKind, string> = {
  wifi: 'Wi-Fi or wired', cellular: 'Cellular', unknown: 'Unknown (this browser does not report it)',
}

export const policyLabels: Record<NetworkPolicy, string> = {
  any: 'Any network',
  ask: 'Ask before transfers over 100 MiB on cellular or unknown networks',
  wifi: 'Wi-Fi only',
}

export const priorityLabels: Record<Priority, string> = { high: 'High', normal: 'Normal', low: 'Low' }

function clamp(value: unknown, fallback: number) {
  const number = Math.round(Number(value))
  return Number.isFinite(number) ? Math.min(maxConcurrent, Math.max(minConcurrent, number)) : fallback
}

export function loadSettings(accountId: string): TransferSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(settingsKey(accountId)) ?? '{}') as Partial<TransferSettings>
    return {
      policy: stored.policy && stored.policy in policyLabels ? stored.policy : defaultSettings.policy,
      uploads: clamp(stored.uploads, defaultSettings.uploads),
      downloads: clamp(stored.downloads, defaultSettings.downloads),
    }
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(accountId: string, settings: TransferSettings) {
  try { localStorage.setItem(settingsKey(accountId), JSON.stringify(settings)) } catch { /* the current tab still applies it */ }
  window.dispatchEvent(new CustomEvent(changeEvent, { detail: { accountId, settings } }))
}

export function clearSettings(accountId: string) {
  try { localStorage.removeItem(settingsKey(accountId)) } catch { /* nothing stored */ }
}

// watchConditions calls back when the network type or this account's settings change, in this tab or another.
export function watchConditions(accountId: string, changed: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === settingsKey(accountId)) changed() }
  const local = (event: Event) => { if ((event as CustomEvent<{ accountId: string }>).detail?.accountId === accountId) changed() }
  const network = connection()
  window.addEventListener('storage', storage)
  window.addEventListener(changeEvent, local)
  network?.addEventListener('change', changed)
  return () => {
    window.removeEventListener('storage', storage)
    window.removeEventListener(changeEvent, local)
    network?.removeEventListener('change', changed)
  }
}

export function networkBlock(policy: NetworkPolicy, network: NetworkKind, size: number, allowed: boolean): NetworkBlock | undefined {
  if (allowed || policy === 'any' || network === 'wifi') return undefined
  if (policy === 'wifi') return 'wifi'
  return size > askThreshold ? 'confirm' : undefined
}

export function blockMessage(block: NetworkBlock, network: NetworkKind) {
  const where = network === 'cellular' ? 'a cellular network' : 'a network this browser cannot identify'
  return block === 'wifi'
    ? 'Waiting for Wi-Fi: this device is on ' + where + '.'
    : 'This large transfer is waiting for your permission to use ' + where + '.'
}

let lastQueued = 0

// queueTime is strictly increasing in this tab, so files chosen together keep the order they were selected in.
export function queueTime() {
  lastQueued = Math.max(Date.now(), lastQueued + 1)
  return lastQueued
}

// rank orders waiting jobs: lower runs first. Priority adds a fixed delay, so jobs are FIFO within a priority and a
// job that has waited long enough overtakes newer work of a higher priority.
export function rank(priority: Priority | undefined, queuedAt: number) {
  return queuedAt + weights[priority ?? 'normal'] * agingStep
}

export type Ordering = { priority: Priority; queuedAt: number }

// placeBeside moves a job just before or after its neighbour by adopting the neighbour's priority.
export function placeBeside(neighbour: Ordering, direction: 'up' | 'down'): Ordering {
  return { priority: neighbour.priority, queuedAt: neighbour.queuedAt + (direction === 'up' ? -1 : 1) }
}
