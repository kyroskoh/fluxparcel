import { expect, type Page } from '@playwright/test'

export async function submitMessage(page: Page, body: string) {
  await page.getByLabel('Message', { exact: true }).fill(body)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

export function queuedCount(page: Page) {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('fluxparcel-outbox')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('messages', 'readonly')
      const count = tx.objectStore('messages').count()
      count.onsuccess = () => resolve(count.result)
      count.onerror = () => reject(count.error)
      tx.oncomplete = () => db.close()
    }
  }))
}

export async function checkOfflineOutbox(page: Page, endpoint: string, peerName: string) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)

  const context = page.context()
  await context.setOffline(true)
  try {
    await submitMessage(page, 'Queued first while offline')
    await submitMessage(page, 'Queued second while offline')
    await expect.poll(() => queuedCount(page)).toBe(2)
    const chat = page.url()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    expect(await queuedCount(page)).toBe(2)
    await context.setOffline(false)
    await expect(page).toHaveURL(chat)
    await expect(page.getByRole('heading', { name: peerName })).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
  await expect.poll(() => queuedCount(page)).toBe(0)
  const received = await (await page.request.get(endpoint)).json() as { body: string }[]
  expect(received.slice(-2).map(item => item.body)).toEqual(['Queued first while offline', 'Queued second while offline'])

  const acknowledgementStatuses: number[] = []
  const postRoute = '**' + endpoint
  await page.route(postRoute, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const response = await route.fetch()
    acknowledgementStatuses.push(response.status())
    if (acknowledgementStatuses.length === 1) await route.abort()
    else await route.fulfill({ response })
  })
  await submitMessage(page, 'Committed before the response was lost')
  await expect.poll(() => acknowledgementStatuses, { timeout: 10000 }).toEqual([201, 200])
  await expect(page.getByText('Committed before the response was lost')).toHaveCount(1)
  await expect.poll(() => queuedCount(page)).toBe(0)
  await page.unroute(postRoute)
}

export async function checkOutboxSignOut(page: Page, endpoint: string) {
  const postRoute = '**' + endpoint
  let rejectSend = true
  await page.route(postRoute, async route => {
    if (rejectSend && route.request().method() === 'POST') {
      await route.fulfill({ status: 403, json: { message: 'This message was declined by the test server.' } })
    } else await route.continue()
  })
  const failure = page.getByText('Failed: This message was declined by the test server.')
  await submitMessage(page, 'Retry this failed message')
  await expect(failure).toBeVisible()
  rejectSend = false
  await page.getByRole('button', { name: 'Retry send' }).click()
  await expect.poll(() => queuedCount(page)).toBe(0)
  await expect(page.getByText('Retry this failed message')).toHaveCount(1)
  rejectSend = true
  await submitMessage(page, 'Discard this failed message')
  await expect(failure).toBeVisible()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect.poll(() => queuedCount(page)).toBe(0)

  await submitMessage(page, 'Failed draft before sign-out')
  await expect(failure).toBeVisible()
  await expect.poll(() => queuedCount(page)).toBe(1)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect.poll(() => queuedCount(page)).toBe(0)
  await page.unroute(postRoute)
}
