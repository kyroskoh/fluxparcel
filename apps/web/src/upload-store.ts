import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

// A durable upload record holds the file's identity and server transfer, never the file bytes. Browsers would
// copy a stored File into origin storage, which multi-gigabyte files would exhaust, so a reload asks the user
// to select the same file again and verifies it by SHA-256 before resuming.
export type UploadRecord = {
  accountId: string
  id: string
  conversationId: string
  name: string
  size: number
  type: string
  lastModified: number
  sha256?: string
  transferId?: string
  // The sender's chosen file lifetime in seconds; the server default applies when absent.
  expiresInSeconds?: number
  paused: boolean
  error?: string
  createdAt: number
}

interface UploadDatabase extends DBSchema {
  uploads: {
    key: [string, string]
    value: UploadRecord
    indexes: { 'by-account': string }
  }
}

let database: Promise<IDBPDatabase<UploadDatabase>> | undefined

function openUploads() {
  database ??= openDB<UploadDatabase>('fluxparcel-uploads', 1, {
    upgrade(db) {
      const uploads = db.createObjectStore('uploads', { keyPath: ['accountId', 'id'] })
      uploads.createIndex('by-account', 'accountId')
    },
  }).catch(error => {
    database = undefined
    throw error
  })
  return database
}

export const uploadChannel = (accountId: string) => 'fluxparcel-uploads:' + accountId

export async function loadUploads(accountId: string) {
  const records = await (await openUploads()).getAllFromIndex('uploads', 'by-account', accountId)
  return records.sort((a, b) => a.createdAt - b.createdAt)
}

export async function saveUpload(record: UploadRecord) {
  await (await openUploads()).put('uploads', record)
}

export async function removeUpload(accountId: string, id: string) {
  await (await openUploads()).delete('uploads', [accountId, id])
}

export async function purgeUploads(accountId: string) {
  const db = await openUploads()
  const transaction = db.transaction('uploads', 'readwrite')
  for (const key of await transaction.store.index('by-account').getAllKeys(accountId)) await transaction.store.delete(key)
  await transaction.done
}
