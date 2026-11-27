import type { DownloadJob, DownloadState } from './downloads'
import type { UploadJob, UploadState } from './transfers'

// Batch actions on the Transfers page apply each action to every eligible item on its own, so one item that cannot
// change never stops or rolls back the others. The eligibility rules match the buttons each item shows.

export type Direction = 'upload' | 'download'
export type Status = 'active' | 'queued' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type Filter = 'all' | 'uploads' | 'downloads' | 'active' | 'queued' | 'paused' | 'completed' | 'failed'
export type Sort = 'queue' | 'newest' | 'largest' | 'status'
export type BatchAction = 'pause' | 'resume' | 'retry' | 'cancel'

export type Entry =
  | { key: string; direction: 'upload'; id: string; job: UploadJob; status: Status }
  | { key: string; direction: 'download'; id: string; job: DownloadJob; status: Status }

export const filterLabels: Record<Filter, string> = {
  all: 'All', uploads: 'Uploads', downloads: 'Downloads', active: 'Active', queued: 'Queued', paused: 'Paused',
  completed: 'Completed', failed: 'Failed',
}

export const sortLabels: Record<Sort, string> = {
  queue: 'Queue order', newest: 'Newest first', largest: 'Largest first', status: 'Status',
}

export const actionLabels: Record<BatchAction, { button: string; done: string; skipped: string }> = {
  pause: { button: 'Pause', done: 'Paused', skipped: 'already finished, verifying or running in another tab' },
  resume: { button: 'Resume', done: 'Resumed', skipped: 'not paused or waiting' },
  retry: { button: 'Retry', done: 'Retried', skipped: 'not failed, or a restart is needed' },
  cancel: { button: 'Cancel', done: 'Cancelled', skipped: 'already finished, verifying or running in another tab' },
}

const uploadStatus: Record<UploadState, Status> = {
  preparing: 'active', uploading: 'active', retrying: 'active', verifying: 'active', elsewhere: 'active',
  queued: 'queued', waiting: 'queued', 'needs-file': 'queued', paused: 'paused', completed: 'completed',
  failed: 'failed', cancelled: 'cancelled',
}

const downloadStatus: Record<DownloadState, Status> = {
  downloading: 'active', retrying: 'active', verifying: 'active', elsewhere: 'active', queued: 'queued',
  waiting: 'queued', paused: 'paused', completed: 'completed', failed: 'failed', cancelled: 'cancelled',
}

const statusOrder: Status[] = ['active', 'queued', 'paused', 'failed', 'completed', 'cancelled']

export function entries(uploads: UploadJob[], downloads: DownloadJob[]): Entry[] {
  return [
    ...uploads.map(job => ({ key: 'upload:' + job.id, direction: 'upload' as const, id: job.id, job, status: uploadStatus[job.state] })),
    ...downloads.map(job => ({ key: 'download:' + job.fileId, direction: 'download' as const, id: job.fileId, job, status: downloadStatus[job.state] })),
  ]
}

export function matches(entry: Entry, filter: Filter, search: string, conversation: string) {
  if (filter === 'uploads' && entry.direction !== 'upload') return false
  if (filter === 'downloads' && entry.direction !== 'download') return false
  if (!['all', 'uploads', 'downloads'].includes(filter) && entry.status !== filter) return false
  const query = search.trim().toLowerCase()
  return !query || entry.job.name.toLowerCase().includes(query) || conversation.toLowerCase().includes(query)
}

// Queue order lists active work first, then waiting work in the order it will start, then finished work.
export function compare(sort: Sort) {
  return (a: Entry, b: Entry) => {
    if (sort === 'newest') return b.job.createdAt - a.job.createdAt
    if (sort === 'largest') return b.job.size - a.job.size
    const status = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
    if (sort === 'status') return status || a.job.name.localeCompare(b.job.name)
    const group = (entry: Entry) => entry.status === 'active' ? 0 : ['queued', 'paused'].includes(entry.status) ? 1 : 2
    return group(a) - group(b) || a.job.rank - b.job.rank
  }
}

export function eligible(entry: Entry, action: BatchAction) {
  const state = entry.job.state
  const held = Boolean(entry.job.block)
  if (entry.direction === 'upload') {
    if (action === 'pause') return ['preparing', 'queued', 'uploading', 'retrying', 'waiting', 'needs-file'].includes(state)
    if (action === 'resume') return state === 'paused' || (state === 'waiting' && !held)
    if (action === 'retry') return state === 'failed'
    return !['completed', 'cancelled', 'verifying', 'elsewhere'].includes(state)
  }
  if (action === 'pause') return ['queued', 'downloading', 'retrying', 'waiting'].includes(state)
  if (action === 'resume') return state === 'paused' || (state === 'waiting' && !held)
  if (action === 'retry') return state === 'failed' && !entry.job.restartRequired
  return !['completed', 'verifying', 'elsewhere', 'failed', 'cancelled'].includes(state)
}

// Clearing history removes finished items from this list. A cleared download also removes its verified copy from this
// device; attachments in chats are never affected.
export function clearable(entry: Entry) {
  return entry.status === 'completed' || entry.status === 'cancelled'
}

export function outcome(action: BatchAction, done: number, skipped: number) {
  const label = actionLabels[action]
  const changed = done ? label.done + ' ' + done + ' transfer' + (done === 1 ? '' : 's') + '.' : 'No transfers changed.'
  return skipped ? changed + ' Skipped ' + skipped + ': ' + label.skipped + '.' : changed
}
