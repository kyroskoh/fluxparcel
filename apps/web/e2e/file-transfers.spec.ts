import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { deleteAccount, register, verifyEmail } from './chat-fixtures'

const partSize = 8 << 20
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function sharedGroup(page: { request: APIRequestContext }, member: APIRequestContext, origin: string, title: string) {
  const headers = { Origin: origin }
  const group = await (await page.request.post('/v1/conversations', { headers, data: { title } })).json()
  const invitation = await (await page.request.post('/v1/invitations', { headers, data: { conversationId: group.id } })).json()
  const token = new URL(invitation.url).hash.slice(1)
  expect((await member.post('/v1/invitations/redeem', { headers, data: { token } })).status()).toBe(200)
  return group.id as string
}

test('uploads verify every part and the whole file before members can download it', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(90000)
  const origin = baseURL!
  const headers = { Origin: origin }
  const member = await browser.newContext({ baseURL })
  const outsider = await browser.newContext({ baseURL })
  const clients = [page.request, member.request, outsider.request]
  try {
    const ownerEmail = await register(page.request, origin, 'File Sender')
    await register(member.request, origin, 'File Recipient')
    await register(outsider.request, origin, 'File Outsider')
    await verifyEmail(page.request, request, origin, ownerEmail)
    const conversationId = await sharedGroup(page, member.request, origin, 'File group')
    const data = randomBytes(partSize + 123_456)
    const checksum = sha256(data)
    const create = (client: APIRequestContext, overrides: object = {}) => client.post('/v1/transfers', {
      headers, data: { conversationId, clientId: randomUUID(), name: 'report final.bin', size: data.length, mime: 'application/pdf', sha256: checksum, ...overrides },
    })
    const putPart = (client: APIRequestContext, id: string, number: number, body: Buffer, digest = sha256(body)) =>
      client.put('/v1/transfers/' + id + '/parts/' + number, { headers: { ...headers, 'X-Content-SHA256': digest }, data: body })
    const parts = [data.subarray(0, partSize), data.subarray(partSize)]

    expect((await create(outsider.request)).status()).toBe(404)
    expect((await create(page.request, { size: 2 ** 31 + 1 })).status()).toBe(400)
    expect((await create(page.request, { name: '../escape.bin' })).status()).toBe(400)
    const clientId = randomUUID()
    const created = await create(page.request, { clientId })
    expect(created.status()).toBe(201)
    const transfer = await created.json()
    expect(transfer).toMatchObject({ partCount: 2, partSize, parts: [], state: 'uploading', mime: 'application/pdf' })
    const retried = await create(page.request, { clientId })
    expect(retried.status()).toBe(200)
    expect((await retried.json()).id).toBe(transfer.id)
    expect((await create(page.request, { clientId, size: data.length - 1 })).status()).toBe(409)

    expect((await putPart(page.request, transfer.id, 1, parts[0], sha256(parts[1]))).status()).toBe(422)
    expect((await putPart(page.request, transfer.id, 1, parts[1])).status()).toBe(400)
    expect((await putPart(page.request, transfer.id, 3, parts[1])).status()).toBe(400)
    expect((await putPart(member.request, transfer.id, 1, parts[0])).status()).toBe(404)
    const complete = (id: string, client = page.request) => client.post('/v1/transfers/' + id + '/complete', { headers })
    expect((await complete(transfer.id)).status()).toBe(409)
    expect((await putPart(page.request, transfer.id, 2, parts[1])).status()).toBe(200)
    expect((await putPart(page.request, transfer.id, 1, parts[0])).status()).toBe(200)
    expect(await (await page.request.get('/v1/transfers/' + transfer.id)).json()).toMatchObject({ parts: [1, 2], verifiedBytes: data.length })
    expect((await member.request.get('/v1/transfers/' + transfer.id)).status()).toBe(404)

    const completed = await complete(transfer.id)
    expect(completed.status()).toBe(200)
    const published = await completed.json()
    expect(published).toMatchObject({ state: 'completed', messageSequence: 1 })
    expect(await (await complete(transfer.id)).json()).toMatchObject({ fileId: published.fileId })

    const [message] = await (await member.request.get('/v1/conversations/' + conversationId + '/messages')).json()
    expect(message).toMatchObject({ clientId, body: '', file: { id: published.fileId, name: 'report final.bin', size: data.length, sha256: checksum, scanStatus: 'not_scanned' } })
    const content = '/v1/files/' + published.fileId + '/content'
    const download = await member.request.get(content)
    expect(download.status()).toBe(200)
    expect(sha256(await download.body())).toBe(checksum)
    expect(download.headers()['x-content-sha256']).toBe(checksum)
    expect(download.headers()['content-type']).toBe('application/octet-stream')
    expect(download.headers()['content-disposition']).toContain('attachment')
    const etag = download.headers()['etag']
    expect(etag).toBe('"' + checksum + '"')
    const range = await member.request.get(content, { headers: { Range: 'bytes=100-199', 'If-Range': etag } })
    expect(range.status()).toBe(206)
    expect(range.headers()['content-range']).toBe('bytes 100-199/' + data.length)
    expect(Buffer.compare(await range.body(), data.subarray(100, 200))).toBe(0)
    const changed = await member.request.get(content, { headers: { Range: 'bytes=100-199', 'If-Range': '"' + '0'.repeat(64) + '"' } })
    expect(changed.status()).toBe(200)
    expect((await outsider.request.get(content)).status()).toBe(404)

    // Correct parts with a wrong whole-file checksum fail after assembly and publish nothing.
    const wrong = await (await create(page.request, { sha256: sha256(Buffer.from('different')) })).json()
    expect((await putPart(page.request, wrong.id, 1, parts[0])).status()).toBe(200)
    expect((await putPart(page.request, wrong.id, 2, parts[1])).status()).toBe(200)
    const rejected = await complete(wrong.id)
    expect(rejected.status()).toBe(422)
    expect((await rejected.json()).code).toBe('integrity_failed')
    expect((await (await page.request.get('/v1/transfers/' + wrong.id)).json()).state).toBe('failed')

    // Cancellation closes the upload for further parts and completion.
    const cancelled = await (await create(page.request)).json()
    expect((await putPart(page.request, cancelled.id, 1, parts[0])).status()).toBe(200)
    expect((await page.request.delete('/v1/transfers/' + cancelled.id, { headers })).status()).toBe(204)
    expect((await putPart(page.request, cancelled.id, 2, parts[1])).status()).toBe(409)
    expect((await complete(cancelled.id)).status()).toBe(409)
    expect((await page.request.delete('/v1/transfers/' + transfer.id, { headers })).status()).toBe(409)

    const messages = await (await member.request.get('/v1/conversations/' + conversationId + '/messages')).json()
    expect(messages).toHaveLength(1)
    expect((await page.request.delete('/v1/conversations/' + conversationId + '/messages/1', { headers })).status()).toBe(204)
    expect((await member.request.get(content)).status()).toBe(404)
  } finally {
    await Promise.all(clients.map(client => deleteAccount(client, origin)))
    await Promise.all([member.close(), outsider.close()])
  }
})

test('a paused upload resends only unacknowledged parts and the recipient gets the exact bytes', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(90000)
  const origin = baseURL!
  const member = await browser.newContext({ baseURL })
  try {
    const ownerEmail = await register(page.request, origin, 'Paused Sender')
    await register(member.request, origin, 'Paused Recipient')
    await verifyEmail(page.request, request, origin, ownerEmail)
    const conversationId = await sharedGroup(page, member.request, origin, 'Paused uploads')
    const data = randomBytes(2 * partSize + 4096)

    const requested: number[] = []
    const acknowledged = new Set<number>()
    let slow = true
    await page.route(/\/v1\/transfers\/[^/]+\/parts\/\d+$/, async route => {
      const number = Number(route.request().url().split('/').at(-1))
      requested.push(number)
      // Slow the first parts down so the test can pause while an upload is in flight.
      if (slow) await new Promise(resolve => setTimeout(resolve, 1500))
      try {
        const response = await route.fetch()
        if (response.status() === 200) acknowledged.add(number)
        await route.fulfill({ response })
      } catch { /* the browser aborted this part when the upload paused */ }
    })

    await page.goto('/chats/' + conversationId)
    await page.getByLabel('Attach files').setInputFiles({ name: 'archive.bin', mimeType: 'application/octet-stream', buffer: data })
    // The sender-only placeholder is the list item with a progress bar; the published message has none.
    const item = page.getByRole('listitem').filter({ hasText: 'archive.bin', has: page.getByRole('progressbar') })
    await expect(item.getByText(/Uploading/)).toBeVisible()
    await expect.poll(() => acknowledged.size).toBeGreaterThan(0)
    await item.getByRole('button', { name: 'Pause' }).click()
    await expect(item.getByText(/Paused/)).toBeVisible()
    const beforePause = new Set(acknowledged)
    const sentWhilePaused = requested.length
    await page.waitForTimeout(2000)
    expect(requested.length).toBe(sentWhilePaused)

    slow = false
    await item.getByRole('button', { name: 'Resume' }).click()
    const recipient = await member.newPage()
    await recipient.goto('/chats/' + conversationId)
    await expect(recipient.getByText('archive.bin')).toBeVisible({ timeout: 30000 })
    await expect(recipient.getByRole('link', { name: 'Download' })).toBeVisible()
    const resent = requested.slice(sentWhilePaused)
    for (const number of beforePause) expect(resent).not.toContain(number)
    expect([...acknowledged].sort()).toEqual([1, 2, 3])

    const [message] = await (await member.request.get('/v1/conversations/' + conversationId + '/messages')).json()
    expect(message.file.sha256).toBe(sha256(data))
    expect(sha256(await (await member.request.get('/v1/files/' + message.file.id + '/content')).body())).toBe(sha256(data))
    await expect(page.getByRole('link', { name: 'Download' })).toBeVisible()
    await expect(item).toHaveCount(0)
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})
