import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { deleteAccount, register, verifyEmail } from './chat-fixtures'

const partSize = 8 << 20
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function setup(page: Page, browser: Browser, request: APIRequestContext, origin: string, title: string) {
  const headers = { Origin: origin }
  const member = await browser.newContext({ baseURL: origin, acceptDownloads: true })
  const email = await register(page.request, origin, title + ' sender')
  await register(member.request, origin, title + ' recipient')
  await verifyEmail(page.request, request, origin, email)
  const group = await (await page.request.post('/v1/conversations', { headers, data: { title } })).json()
  const invitation = await (await page.request.post('/v1/invitations', { headers, data: { conversationId: group.id } })).json()
  expect((await member.request.post('/v1/invitations/redeem', { headers, data: { token: new URL(invitation.url).hash.slice(1) } })).status()).toBe(200)
  return { member, conversationId: group.id as string }
}

async function sendFile(client: APIRequestContext, origin: string, conversationId: string, name: string, data: Buffer) {
  const headers = { Origin: origin }
  const transfer = await (await client.post('/v1/transfers', {
    headers, data: { conversationId, clientId: randomUUID(), name, size: data.length, sha256: sha256(data) },
  })).json()
  for (let number = 1; number <= transfer.partCount; number++) {
    const part = data.subarray((number - 1) * partSize, number * partSize)
    expect((await client.put('/v1/transfers/' + transfer.id + '/parts/' + number, { headers: { ...headers, 'X-Content-SHA256': sha256(part) }, data: part })).status()).toBe(200)
  }
  const completed = await client.post('/v1/transfers/' + transfer.id + '/complete', { headers })
  expect(completed.status()).toBe(200)
  return (await completed.json()).fileId as string
}

// Stands in for the Network Information API, which reports the connection type only on some devices.
// A missing type reads as an unknown network. setNetwork changes it and fires the API's change event.
async function emulateNetwork(page: Page, type: string | undefined) {
  await page.addInitScript(initial => {
    const connection = new EventTarget() as EventTarget & { type?: string }
    const stored = sessionStorage.getItem('test-network')
    connection.type = stored === null ? initial ?? undefined : stored || undefined
    Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => connection })
    Object.assign(window, {
      setNetwork(next: string) {
        sessionStorage.setItem('test-network', next)
        connection.type = next || undefined
        connection.dispatchEvent(new Event('change'))
      },
    })
  }, type ?? null)
}

const setNetwork = (page: Page, type: string) => page.evaluate(next => (window as unknown as { setNetwork(type: string): void }).setNetwork(next), type)

async function throttle(page: Page, bytesPerSecond: number) {
  const session = await page.context().newCDPSession(page)
  await session.send('Network.enable')
  await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: bytesPerSecond, uploadThroughput: bytesPerSecond })
  return () => session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
}

function attachment(page: Page, name: string) {
  return page.getByRole('listitem').filter({ hasText: name }).locator('.attachment')
}

test('Wi-Fi only holds transfers on cellular, follows network changes and honors a confirmed override', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(120000)
  const origin = baseURL!
  const { member, conversationId } = await setup(page, browser, request, origin, 'Wi-Fi only')
  try {
    const data = randomBytes(20 << 20)
    const fileId = await sendFile(page.request, origin, conversationId, 'footage.bin', data)
    const recipient = await member.newPage()
    await emulateNetwork(recipient, 'cellular')
    const ranges: (string | undefined)[] = []
    recipient.on('request', item => { if (item.url().endsWith('/v1/files/' + fileId + '/content')) ranges.push(item.headers()['range']) })

    await recipient.goto('/settings')
    const card = recipient.locator('section').filter({ has: recipient.getByRole('heading', { name: 'Transfers on this device' }) })
    await expect(card.getByText('Network reported by this browser: Cellular')).toBeVisible()
    await card.getByRole('radio', { name: 'Wi-Fi only' }).check()

    // Nothing is fetched while the policy holds the download.
    await recipient.goto('/chats/' + conversationId)
    const file = attachment(recipient, 'footage.bin')
    await file.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(file.getByText('Waiting for Wi-Fi: this device is on a cellular network.', { exact: false })).toBeVisible()
    await recipient.waitForTimeout(1000)
    expect(ranges).toHaveLength(0)

    // Joining Wi-Fi starts it; dropping back to cellular mid-download holds it and keeps the saved bytes.
    const unthrottle = await throttle(recipient, 2 << 20)
    await setNetwork(recipient, 'wifi')
    await expect(file.getByText(/Downloading · (8\.0|16) MiB of 20 MiB saved on this device/)).toBeVisible({ timeout: 30000 })
    await setNetwork(recipient, 'cellular')
    await expect(file.getByText(/^Waiting · [\d.]+ MiB of 20 MiB saved on this device · Waiting for Wi-Fi/)).toBeVisible()
    const requests = ranges.length
    await recipient.waitForTimeout(1500)
    expect(ranges).toHaveLength(requests)
    await unthrottle()
    await setNetwork(recipient, 'wifi')
    await expect(file.getByText(/Verified · Ready to save/)).toBeVisible({ timeout: 30000 })
    expect(ranges.at(-1)).toMatch(/^bytes=\d+-$/)

    // An upload on cellular waits too, until the sender explicitly allows this one transfer.
    await setNetwork(recipient, 'cellular')
    const upload = randomBytes(1 << 20)
    await recipient.getByLabel('Attach files').setInputFiles({ name: 'clip.bin', mimeType: 'application/octet-stream', buffer: upload })
    const pending = recipient.locator('.upload-item').filter({ hasText: 'clip.bin' })
    await expect(pending.getByText('Waiting for Wi-Fi', { exact: false })).toBeVisible()
    recipient.once('dialog', dialog => dialog.dismiss())
    await pending.getByRole('button', { name: 'Upload on this network' }).click()
    await expect(pending.getByText('Waiting for Wi-Fi', { exact: false })).toBeVisible()
    recipient.once('dialog', dialog => {
      expect(dialog.message()).toContain('clip.bin')
      void dialog.accept()
    })
    await pending.getByRole('button', { name: 'Upload on this network' }).click()
    await expect(attachment(recipient, 'clip.bin')).toBeVisible({ timeout: 30000 })
    const messages = await (await page.request.get('/v1/conversations/' + conversationId + '/messages')).json()
    expect(messages.find((message: { file?: { name: string; sha256: string } }) => message.file?.name === 'clip.bin').file.sha256).toBe(sha256(upload))
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})

test('on an unknown network only large transfers ask first, and the answer applies to one transfer', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(120000)
  const origin = baseURL!
  const { member, conversationId } = await setup(page, browser, request, origin, 'Unknown network')
  try {
    const small = randomBytes(1 << 20)
    const large = randomBytes(101 << 20)
    await sendFile(page.request, origin, conversationId, 'notes.bin', small)
    await sendFile(page.request, origin, conversationId, 'archive.bin', large)
    const recipient = await member.newPage()
    await emulateNetwork(recipient, undefined)
    await recipient.goto('/transfers')
    await expect(recipient.getByText('Network: Unknown (this browser does not report it)', { exact: false })).toBeVisible()
    await expect(recipient.getByText('Ask before transfers over 100 MiB on cellular or unknown networks', { exact: false })).toBeVisible()

    await recipient.goto('/chats/' + conversationId)
    const notes = attachment(recipient, 'notes.bin')
    await notes.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(notes.getByText(/Verified · Ready to save/)).toBeVisible({ timeout: 30000 })

    const archive = attachment(recipient, 'archive.bin')
    await archive.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(archive.getByText('waiting for your permission to use a network this browser cannot identify', { exact: false })).toBeVisible()
    // The status never claims a network type the browser did not report.
    await expect(archive.getByText(/cellular network\./)).toHaveCount(0)
    recipient.once('dialog', dialog => dialog.dismiss())
    await archive.getByRole('button', { name: 'Download on this network' }).click()
    await expect(archive.getByText(/^Waiting/)).toBeVisible()
    recipient.once('dialog', dialog => {
      expect(dialog.message()).toContain('archive.bin (101 MiB remaining)')
      void dialog.accept()
    })
    await archive.getByRole('button', { name: 'Download on this network' }).click()
    await expect(archive.getByText(/Verified · Ready to save/)).toBeVisible({ timeout: 60000 })
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})

test('queued downloads follow priority, manual order and aging within the concurrency limit', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(150000)
  const origin = baseURL!
  const { member, conversationId } = await setup(page, browser, request, origin, 'Download queue')
  try {
    const names = ['first.bin', 'bravo.bin', 'charlie.bin', 'delta.bin', 'echo.bin']
    const ids = new Map<string, string>()
    for (const name of names) ids.set(await sendFile(page.request, origin, conversationId, name, randomBytes(name === 'first.bin' ? 16 << 20 : 1 << 20)), name)
    const recipient = await member.newPage()
    await emulateNetwork(recipient, 'wifi')
    await recipient.clock.install()
    const started: string[] = []
    recipient.on('request', item => {
      const name = ids.get(/\/v1\/files\/([^/]+)\/content$/.exec(item.url())?.[1] ?? '')
      if (name && !started.includes(name)) started.push(name)
    })

    await recipient.goto('/settings')
    await recipient.getByLabel('Downloads at a time').selectOption('1')
    await recipient.goto('/chats/' + conversationId)
    const unthrottle = await throttle(recipient, 1 << 20)
    await attachment(recipient, 'first.bin').getByRole('button', { name: 'Download', exact: true }).click()
    await expect(attachment(recipient, 'first.bin').getByText(/^Downloading/)).toBeVisible()
    for (const name of ['bravo.bin', 'charlie.bin', 'delta.bin']) {
      await attachment(recipient, name).getByRole('button', { name: 'Download', exact: true }).click()
      await expect(attachment(recipient, name).getByText(/^Queued/)).toBeVisible()
    }

    // High priority jumps the queue, a manual move reorders within it, and long-waiting low work is not starved.
    await recipient.getByRole('link', { name: 'Transfers' }).first().click()
    const item = (name: string) => recipient.getByRole('listitem').filter({ hasText: name })
    await item('delta.bin').getByLabel('Priority for delta.bin').selectOption('high')
    await item('charlie.bin').getByRole('button', { name: 'Move charlie.bin up' }).click()
    await item('bravo.bin').getByLabel('Priority for bravo.bin').selectOption('low')
    await recipient.clock.fastForward('25:00')
    await recipient.getByRole('link', { name: 'Chats' }).first().click()
    await recipient.getByRole('link', { name: /^Download queue/ }).click()
    await attachment(recipient, 'echo.bin').getByRole('button', { name: 'Download', exact: true }).click()
    await recipient.getByRole('link', { name: 'Transfers' }).first().click()
    await item('echo.bin').getByLabel('Priority for echo.bin').selectOption('high')
    const queued = recipient.getByRole('region', { name: 'Downloads' }).getByRole('listitem')
    await expect(queued.locator('.upload-name')).toHaveText(['first.bin', 'delta.bin', 'charlie.bin', 'bravo.bin', 'echo.bin'])
    expect(started).toEqual(['first.bin'])

    await unthrottle()
    for (const name of names) await expect(item(name).getByText(/Verified · Ready to save/)).toBeVisible({ timeout: 60000 })
    expect(started).toEqual(['first.bin', 'delta.bin', 'charlie.bin', 'bravo.bin', 'echo.bin'])
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})

test('queued uploads respect the concurrency setting and all eventually send', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(120000)
  const origin = baseURL!
  const { member, conversationId } = await setup(page, browser, request, origin, 'Upload queue')
  try {
    await emulateNetwork(page, 'wifi')
    await page.goto('/settings')
    await page.getByLabel('Uploads at a time').selectOption('2')
    await page.goto('/chats/' + conversationId)
    const active = new Set<string>()
    let peak = 0
    page.on('request', item => {
      const id = /\/v1\/transfers\/([^/]+)\/parts\//.exec(item.url())?.[1]
      if (id) { active.add(id); peak = Math.max(peak, active.size) }
    })
    const settle = (item: { url(): string }) => {
      const id = /\/v1\/transfers\/([^/]+)\/parts\//.exec(item.url())?.[1]
      if (id) active.delete(id)
    }
    page.on('requestfinished', settle)
    page.on('requestfailed', settle)
    const unthrottle = await throttle(page, 1 << 20)
    const files = Array.from({ length: 8 }, (_, index) => ({ name: 'batch-' + index + '.bin', mimeType: 'application/octet-stream', buffer: randomBytes(512 << 10) }))
    await page.getByLabel('Attach files').setInputFiles(files)
    await expect(page.getByRole('listitem').filter({ hasText: 'batch-0.bin' }).locator('.attachment')).toBeVisible({ timeout: 30000 })
    await unthrottle()
    for (const file of files) await expect(page.getByRole('listitem').filter({ hasText: file.name }).locator('.attachment')).toBeVisible({ timeout: 30000 })
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(2)
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})
