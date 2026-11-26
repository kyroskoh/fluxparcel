import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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

// Uploads a file through the transfer API and returns the published file ID.
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

// Limits the page's download speed so a test can act while a download is in progress.
async function throttle(page: Page, bytesPerSecond: number) {
  const session = await page.context().newCDPSession(page)
  await session.send('Network.enable')
  await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: bytesPerSecond, uploadThroughput: -1 })
  return () => session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
}

function attachment(page: Page, name: string) {
  return page.getByRole('listitem').filter({ hasText: name }).locator('.attachment')
}

test('downloads pause, survive a reload, resume with If-Range and save the verified bytes', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(120000)
  const origin = baseURL!
  const { member, conversationId } = await setup(page, browser, request, origin, 'Resumable download')
  try {
    const data = randomBytes(20 << 20)
    const fileId = await sendFile(page.request, origin, conversationId, 'dataset.bin', data)
    const recipient = await member.newPage()
    const fetched: { range?: string; ifRange?: string }[] = []
    const statuses: number[] = []
    recipient.on('request', item => {
      if (item.url().endsWith('/v1/files/' + fileId + '/content')) fetched.push({ range: item.headers()['range'], ifRange: item.headers()['if-range'] })
    })
    recipient.on('response', item => { if (item.url().endsWith('/content')) statuses.push(item.status()) })
    await recipient.goto('/chats/' + conversationId)
    const card = attachment(recipient, 'dataset.bin')
    const unthrottle = await throttle(recipient, 2 << 20)
    await card.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(card.getByText(/Downloading · (8\.0|16) MiB of 20 MiB saved on this device/)).toBeVisible({ timeout: 30000 })
    await card.getByRole('button', { name: 'Pause download' }).click()
    await expect(card.getByText(/^Paused/)).toBeVisible()
    const requests = fetched.length
    await recipient.waitForTimeout(2000)
    expect(fetched.length).toBe(requests)

    // The committed bytes and the pause survive a reload; nothing restarts on its own.
    await recipient.reload()
    const kept = card.getByText(/Paused · [\d.]+ MiB of 20 MiB saved on this device/)
    await expect(kept).toBeVisible()
    const shown = Number(/Paused · ([\d.]+) MiB/.exec(await kept.innerText())![1])
    await recipient.waitForTimeout(1500)
    expect(fetched.length).toBe(requests)
    await unthrottle()
    await card.getByRole('button', { name: 'Resume download' }).click()
    await expect(card.getByText(/Verified · Ready to save/)).toBeVisible({ timeout: 30000 })
    const resumed = fetched.at(-1)!
    // The resume starts exactly where the kept bytes end.
    const offset = Number(/^bytes=(\d+)-$/.exec(resumed.range ?? '')?.[1])
    expect(offset).toBeGreaterThanOrEqual(8 << 20)
    expect(offset).toBeLessThan(20 << 20)
    expect(Math.abs(offset / 1048576 - shown)).toBeLessThan(0.1)
    expect(resumed.ifRange).toBe('"' + sha256(data) + '"')
    expect(statuses.at(-1)).toBe(206)

    const saving = recipient.waitForEvent('download')
    await card.getByRole('button', { name: 'Save file' }).click()
    const saved = await saving
    expect(saved.suggestedFilename()).toBe('dataset.bin')
    expect(sha256(await readFile((await saved.path())!))).toBe(sha256(data))
    await card.getByRole('button', { name: 'Remove from this device' }).click()
    await expect(card.getByRole('button', { name: 'Download', exact: true })).toBeVisible()
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})

test('a changed or corrupted file and revoked access never leave mixed or stale bytes', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(150000)
  const origin = baseURL!
  const headers = { Origin: origin }
  const { member, conversationId } = await setup(page, browser, request, origin, 'Guarded download')
  try {
    const changing = randomBytes(20 << 20)
    const corrupted = randomBytes(3 << 20)
    const revoked = randomBytes(20 << 20)
    const changingId = await sendFile(page.request, origin, conversationId, 'changing.bin', changing)
    const corruptedId = await sendFile(page.request, origin, conversationId, 'corrupted.bin', corrupted)
    await sendFile(page.request, origin, conversationId, 'revoked.bin', revoked)
    const recipient = await member.newPage()
    await recipient.goto('/chats/' + conversationId)
    const unthrottle = await throttle(recipient, 2 << 20)

    // A resumed request answered with the whole file means the server's copy changed: stop rather than append.
    const changingCard = attachment(recipient, 'changing.bin')
    await changingCard.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(changingCard.getByText(/(8\.0|16) MiB of 20 MiB saved on this device/)).toBeVisible({ timeout: 30000 })
    await changingCard.getByRole('button', { name: 'Pause download' }).click()
    await expect(changingCard.getByText(/^Paused/)).toBeVisible()
    await unthrottle()
    const route = '**/v1/files/' + changingId + '/content'
    await recipient.route(route, async item => {
      if (!item.request().headers()['range']) return item.continue()
      await item.fulfill({ status: 200, headers: { ETag: '"' + '0'.repeat(64) + '"', 'Content-Type': 'application/octet-stream' }, body: randomBytes(20 << 20) })
    })
    await changingCard.getByRole('button', { name: 'Resume download' }).click()
    await expect(changingCard.getByText('The file changed on the server', { exact: false })).toBeVisible()
    await expect(changingCard.getByRole('button', { name: 'Save file' })).toHaveCount(0)
    await recipient.unroute(route)
    await changingCard.getByRole('button', { name: 'Restart download' }).click()
    await expect(changingCard.getByText(/Verified · Ready to save/)).toBeVisible({ timeout: 30000 })
    const saving = recipient.waitForEvent('download')
    await changingCard.getByRole('button', { name: 'Save file' }).click()
    expect(sha256(await readFile((await (await saving).path())!))).toBe(sha256(changing))

    // Bytes that do not match the published SHA-256 are discarded, never offered for saving.
    await recipient.route('**/v1/files/' + corruptedId + '/content', item => item.fulfill({
      status: 200, headers: { ETag: '"' + sha256(corrupted) + '"', 'Content-Type': 'application/octet-stream' }, body: randomBytes(corrupted.length),
    }))
    const corruptedCard = attachment(recipient, 'corrupted.bin')
    await corruptedCard.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(corruptedCard.getByText('did not match its checksum', { exact: false })).toBeVisible({ timeout: 30000 })
    await expect(corruptedCard.getByRole('button', { name: 'Save file' })).toHaveCount(0)

    // Losing access stops the download and deletes this device's partial copy.
    const unthrottleAgain = await throttle(recipient, 2 << 20)
    const revokedCard = attachment(recipient, 'revoked.bin')
    await revokedCard.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(revokedCard.getByText(/(8\.0|16) MiB of 20 MiB saved on this device/)).toBeVisible({ timeout: 30000 })
    await revokedCard.getByRole('button', { name: 'Pause download' }).click()
    await unthrottleAgain()
    const messages = await (await member.request.get('/v1/conversations/' + conversationId + '/messages')).json()
    const sequence = messages.find((message: { file?: { name: string } }) => message.file?.name === 'revoked.bin').sequence
    expect((await page.request.delete('/v1/conversations/' + conversationId + '/messages/' + sequence, { headers })).status()).toBe(204)
    // The deleted message no longer shows the file in the chat; the download stays on the Transfers page.
    await expect(revokedCard).toHaveCount(0)
    await recipient.goto('/transfers')
    const revokedItem = recipient.getByRole('listitem').filter({ hasText: 'revoked.bin' })
    await expect(revokedItem.getByText(/^Paused/)).toBeVisible()
    await revokedItem.getByRole('button', { name: 'Resume download' }).click()
    await expect(revokedItem.getByText('This file is no longer available to you.', { exact: false })).toBeVisible()
    await expect(revokedItem.getByText(/0 B of 20 MiB saved on this device/)).toBeVisible()
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})

test('browsers without private file storage fall back to the browser download manager', async ({ page, browser, request, baseURL }) => {
  const origin = baseURL!
  const { member, conversationId } = await setup(page, browser, request, origin, 'Fallback download')
  try {
    await sendFile(page.request, origin, conversationId, 'fallback.bin', randomBytes(1024))
    const recipient = await member.newPage()
    await recipient.addInitScript(() => { delete (StorageManager.prototype as { getDirectory?: unknown }).getDirectory })
    await recipient.goto('/chats/' + conversationId)
    const card = attachment(recipient, 'fallback.bin')
    await expect(card.getByRole('link', { name: 'Download', exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0)
    await recipient.goto('/transfers')
    await expect(recipient.getByText('cannot be paused here', { exact: false })).toBeVisible()
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})
