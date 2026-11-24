import { useEffect, useRef, useState } from 'react'
import { enqueueMessage, listPending, outboxChannel, outboxGeneration, sendPending, updatePending, type PendingMessage } from './outbox'

export function useOutbox(accountId: string) {
  const [messages, setMessages] = useState<PendingMessage[]>([])
  const [error, setError] = useState('')
  const notify = useRef<() => void>(() => {})
  const sessionEnded = useRef(false)
  const generation = useRef<number>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(outboxChannel(accountId))
    let timer: ReturnType<typeof setTimeout>
    let running = false
    let pending = false

    function stop() {
      sessionEnded.current = true
      controller.abort()
      clearTimeout(timer)
      setMessages([])
    }

    async function update() {
      const current = await outboxGeneration(accountId)
      if (generation.current === undefined) generation.current = current
      if (generation.current !== current) stop()
      const items = await listPending(accountId)
      if (!signal.aborted) setMessages(items)
      return items
    }

    async function drain() {
      let items = await update()
      while (!signal.aborted && navigator.onLine) {
        const firstByConversation = new Map<string, PendingMessage>()
        for (const message of items) {
          if (!message.failure && !firstByConversation.has(message.conversationId)) {
            firstByConversation.set(message.conversationId, message)
          }
        }
        const next = [...firstByConversation.values()].find(message => message.retryAt <= Date.now())
        if (!next || !await sendPending(next, signal)) return
        if (!signal.aborted) channel?.postMessage('changed')
        items = await update()
      }
    }

    async function run() {
      if (signal.aborted) return
      if (running) {
        pending = true
        return
      }
      clearTimeout(timer)
      running = true
      try {
        if (navigator.locks && navigator.onLine) {
          await navigator.locks.request(outboxChannel(accountId), { ifAvailable: true }, lock =>
            lock ? drain().then(() => undefined) : update().then(() => undefined))
        } else {
          await drain()
        }
        if (!signal.aborted) setError('')
      } catch {
        if (!signal.aborted) setError('Unable to access the message queue. Check browser storage and try again.')
      } finally {
        running = false
        if (!signal.aborted) timer = setTimeout(run, pending ? 0 : 2500)
        pending = false
      }
    }

    const trigger = () => { void run() }
    notify.current = () => {
      channel?.postMessage('changed')
      trigger()
    }
    if (channel) channel.onmessage = event => {
      if (event.data === 'session-ended') {
        stop()
        return
      }
      if (event.data === 'changed') trigger()
    }
    window.addEventListener('online', trigger)
    trigger()
    return () => {
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('online', trigger)
      channel?.close()
      notify.current = () => {}
    }
  }, [accountId])

  return {
    messages,
    error,
    async enqueue(conversationId: string, body: string) {
      if (sessionEnded.current || generation.current === undefined) throw new Error('Sign in again to queue messages.')
      const createdAt = Date.now()
      await enqueueMessage({
        accountId, clientId: crypto.randomUUID(), conversationId, body,
        createdAt, attempts: 0, retryAt: 0,
      }, generation.current)
      notify.current()
    },
    async retry(message: PendingMessage) {
      if (!sessionEnded.current) {
        await updatePending(message, { attempts: 0, retryAt: 0 })
        notify.current()
      }
    },
    async discard(message: PendingMessage) {
      await updatePending(message)
      notify.current()
    },
  }
}

export type Outbox = ReturnType<typeof useOutbox>
