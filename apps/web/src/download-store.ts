import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

// A download record holds the file's identity and the user's pause intent. The bytes themselves live in the
// origin private file system (OPFS), so a reload resumes from the bytes already committed there.
export type DownloadRecord = {
  accountId: string
  fileId: string
  conversationId: string
  name: string
  size: number
  sha256: string
  paused: boolean
  completed: boolean
  createdAt: number
}

interface DownloadDatabase extends DBSchema {
  downloads: {
    key: [string, string]
    value: DownloadRecord
    indexes: { 'by-account': string }
  }
}

let database: Promise<IDBPDatabase<DownloadDatabase>> | undefined

function openDownloads() {
  database ??= openDB<DownloadDatabase>('fluxparcel-downloads', 1, {
    upgrade(db) {
      const downloads = db.createObjectStore('downloads', { keyPath: ['accountId', 'fileId'] })
      downloads.createIndex('by-account', 'accountId')
    },
  }).catch(error => {
    database = undefined
    throw error
  })
  return database
}

export const downloadChannel = (accountId: string) => 'fluxparcel-downloads:' + accountId

// App-managed downloads need OPFS and workers; the download worker also confirms synchronous file handles before
// the first download. Browsers without them use their own download manager.
export function appDownloadsSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' && typeof Worker !== 'undefined'
}

export async function loadDownloads(accountId: string) {
  const records = await (await openDownloads()).getAllFromIndex('downloads', 'by-account', accountId)
  return records.sort((a, b) => a.createdAt - b.createdAt)
}

export async function saveDownload(record: DownloadRecord) {
  await (await openDownloads()).put('downloads', record)
}

export async function removeDownload(accountId: string, fileId: string) {
  await (await openDownloads()).delete('downloads', [accountId, fileId])
}

async function accountDirectory(accountId: string, create: boolean) {
  const root = await navigator.storage.getDirectory()
  const downloads = await root.getDirectoryHandle('fluxparcel-downloads', { create })
  return downloads.getDirectoryHandle(accountId, { create })
}

export async function partialFile(accountId: string, fileId: string) {
  return (await accountDirectory(accountId, true)).getFileHandle(fileId + '.part', { create: true })
}

export async function removePartial(accountId: string, fileId: string) {
  try {
    await (await accountDirectory(accountId, false)).removeEntry(fileId + '.part')
  } catch { /* nothing stored */ }
}

// Sign-out removes this account's download records and every byte kept for them on this device.
export async function purgeDownloads(accountId: string) {
  try { localStorage.removeItem('fluxparcel-paused-downloads:' + accountId) } catch { /* nothing stored */ }
  const db = await openDownloads()
  const transaction = db.transaction('downloads', 'readwrite')
  for (const key of await transaction.store.index('by-account').getAllKeys(accountId)) await transaction.store.delete(key)
  await transaction.done
  if (!appDownloadsSupported()) return
  try {
    const root = await navigator.storage.getDirectory()
    const downloads = await root.getDirectoryHandle('fluxparcel-downloads')
    await downloads.removeEntry(accountId, { recursive: true })
  } catch { /* nothing stored */ }
}
