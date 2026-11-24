import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { api, ApiError } from './api'

export type PendingMessage = {
  accountId: string
  clientId: string
  conversationId: string
  body: string
  createdAt: number
  attempts: number
  retryAt: number
  failure?: string
}

interface OutboxDatabase extends DBSchema {
  generations: { key: string; value: number }
  messages: {
    key: [string, string]
    value: PendingMessage
    indexes: { 'by-account': string }
  }
}

let database: Promise<IDBPDatabase<OutboxDatabase>> | undefined

function openOutbox() {
  database ??= openDB<OutboxDatabase>('fluxparcel-outbox', 1, {
    upgrade(db) {
      db.createObjectStore('generations')
      const messages = db.createObjectStore('messages', { keyPath: ['accountId', 'clientId'] })
      messages.createIndex('by-account', 'accountId')
    },
  }).catch(error => {
    database = undefined
    throw error
  })
  return database
}

export const outboxChannel = (accountId: string) => 'fluxparcel-outbox:' + accountId

export async function listPending(accountId: string) {
  const db = await openOutbox()
  const messages = await db.getAllFromIndex('messages', 'by-account', accountId)
  return messages.sort((a, b) => a.createdAt - b.createdAt || a.clientId.localeCompare(b.clientId))
}

export async function outboxGeneration(accountId: string) {
  return (await (await openOutbox()).get('generations', accountId)) ?? 0
}

export async function enqueueMessage(message: PendingMessage, generation: number) {
  const db = await openOutbox()
  const tx = db.transaction(['messages', 'generations'], 'readwrite')
  const current = (await tx.objectStore('generations').get(message.accountId)) ?? 0
  if (current !== generation) {
    await tx.done
    throw new Error('Sign in again to queue messages.')
  }
  const messages = tx.objectStore('messages')
  const queued = await messages.index('by-account').getAll(message.accountId)
  if (queued.length >= 100) {
    await tx.done
    throw new Error('The message queue is full. Retry or discard pending messages first.')
  }
  const createdAt = queued.reduce((latest, item) => Math.max(latest, item.createdAt + 1), message.createdAt)
  await Promise.all([messages.add({ ...message, createdAt }), tx.done])
}

export async function updatePending(message: PendingMessage, values?: Pick<PendingMessage, 'attempts' | 'retryAt' | 'failure'>) {
  const db = await openOutbox()
  const tx = db.transaction('messages', 'readwrite')
  const current = await tx.store.get([message.accountId, message.clientId])
  // A stale tab cannot recreate an acknowledged, discarded or purged entry.
  if (current && current.attempts === message.attempts && current.failure === message.failure
    && current.retryAt === message.retryAt) {
    if (values) await tx.store.put({ ...current, ...values, failure: values.failure })
    else await tx.store.delete([message.accountId, message.clientId])
  }
  await tx.done
}

export async function removePending(accountId: string, clientId: string) {
  const db = await openOutbox()
  await db.delete('messages', [accountId, clientId])
}

export async function purgeOutbox(accountId: string) {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(outboxChannel(accountId))
    channel.postMessage('session-ended')
    channel.close()
  }
  const db = await openOutbox()
  const tx = db.transaction(['messages', 'generations'], 'readwrite')
  const generations = tx.objectStore('generations')
  const previous = (await generations.get(accountId)) ?? 0
  await generations.put(previous + 1, accountId)
  const messages = tx.objectStore('messages')
  const keys = await messages.index('by-account').getAllKeys(accountId)
  await Promise.all(keys.map(key => messages.delete(key)))
  await tx.done
}

export async function sendPending(message: PendingMessage, signal: AbortSignal) {
  try {
    await api('/conversations/' + message.conversationId + '/messages', 'POST', {
      clientId: message.clientId, body: message.body, expectedSenderId: message.accountId,
    }, true, signal)
  } catch (error) {
    if (signal.aborted || !navigator.onLine) return false
    const attempts = message.attempts + 1
    const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429
    if (permanent || attempts >= 8) {
      await updatePending(message, {
        attempts, retryAt: 0, failure: permanent ? error.message : 'Delivery could not be confirmed.',
      })
    } else {
      const delay = Math.min(60000, 1000 * 2 ** attempts) + Math.random() * 500
      const retryAfter = error instanceof ApiError ? error.retryAfter : 0
      await updatePending(message, { attempts, retryAt: Date.now() + Math.max(delay, retryAfter) })
    }
    return true
  }
  // A successful reply means the server committed the message. If local deletion fails, a retry uses the same ID.
  await removePending(message.accountId, message.clientId)
  return true
}
