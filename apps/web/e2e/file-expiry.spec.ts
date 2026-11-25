import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { deleteAccount, login, password, register, retryAuthentication, verifyEmail } from './chat-fixtures'

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

// Sends a single-part file through the transfer API and returns the published file ID.
async function sendFile(client: APIRequestContext, origin: string, conversationId: string, data: Buffer, expiresInSeconds?: number) {
  const headers = { Origin: origin }
  const created = await client.post('/v1/transfers', {
    headers, data: { conversationId, clientId: randomUUID(), name: 'expiring-' + randomUUID().slice(0, 6) + '.bin', size: data.length, sha256: sha256(data), expiresInSeconds },
  })
  expect(created.status()).toBe(201)
  const transfer = await created.json()
  expect((await client.put('/v1/transfers/' + transfer.id + '/parts/1', { headers: { ...headers, 'X-Content-SHA256': sha256(data) }, data })).status()).toBe(200)
  const completed = await client.post('/v1/transfers/' + transfer.id + '/complete', { headers })
  expect(completed.status()).toBe(200)
  return (await completed.json()).fileId as string
}

test('expired files disappear for every member and administrators can restore or purge snapshots', async ({ page, browser, request, baseURL }, testInfo) => {
  test.setTimeout(180000)
  const origin = baseURL!
  const headers = { Origin: origin }
  const member = await browser.newContext({ baseURL })
  const admin = await browser.newContext({ baseURL })
  try {
    // ADMIN_EMAILS lists one fixed address per browser project; a verified account with it administers storage.
    const adminEmail = 'admin-' + testInfo.project.name + '@example.test'
    const registered = await retryAuthentication(() => admin.request.post('/v1/auth/register', {
      headers, data: { email: adminEmail, username: 'admin_' + randomUUID().replaceAll('-', '').slice(0, 20), displayName: 'Storage Admin', password },
    }))
    if (registered.status() === 409) expect((await login(admin.request, origin, adminEmail)).status()).toBe(200)
    else expect(registered.status()).toBe(201)
    if (!(await (await admin.request.get('/v1/account')).json()).verified) await verifyEmail(admin.request, request, origin, adminEmail)
    expect((await (await admin.request.get('/v1/account')).json()).admin).toBe(true)

    const senderEmail = await register(page.request, origin, 'Expiry Sender')
    await register(member.request, origin, 'Expiry Recipient')
    await verifyEmail(page.request, request, origin, senderEmail)
    expect((await (await page.request.get('/v1/account')).json()).admin).toBe(false)
    const group = await (await page.request.post('/v1/conversations', { headers, data: { title: 'Expiring files' } })).json()
    const invitation = await (await page.request.post('/v1/invitations', { headers, data: { conversationId: group.id } })).json()
    expect((await member.request.post('/v1/invitations/redeem', { headers, data: { token: new URL(invitation.url).hash.slice(1) } })).status()).toBe(200)

    expect((await member.request.get('/v1/admin/storage')).status()).toBe(404)
    expect((await member.request.get('/v1/admin/snapshots')).status()).toBe(404)
    const tooShort = await page.request.post('/v1/transfers', {
      headers, data: { conversationId: group.id, clientId: randomUUID(), name: 'short.bin', size: 1, sha256: 'a'.repeat(64), expiresInSeconds: 30 },
    })
    expect(tooShort.status()).toBe(400)
    expect((await tooShort.json()).code).toBe('invalid_expiry')

    const restored = randomBytes(2048)
    const purged = randomBytes(1024)
    const [restoredId, purgedId] = await Promise.all([
      sendFile(page.request, origin, group.id, restored, 60),
      sendFile(page.request, origin, group.id, purged, 60),
    ])
    const content = (id: string) => '/v1/files/' + id + '/content'
    expect((await member.request.get(content(restoredId))).status()).toBe(200)

    const recipient = await member.newPage()
    await recipient.goto('/chats/' + group.id)
    await expect(recipient.getByText(/^.*Expires /)).toHaveCount(2)
    await expect(recipient.getByRole('link', { name: 'Download' })).toHaveCount(2)

    // The worker moves expired files to admin-only snapshots and tells open chats.
    await expect.poll(async () => {
      const messages = await (await member.request.get('/v1/conversations/' + group.id + '/messages')).json()
      return messages.filter((message: { file?: { available: boolean } }) => message.file && !message.file.available).length
    }, { timeout: 120000, intervals: [2000] }).toBe(2)
    await expect(recipient.getByText('File expired', { exact: false })).toHaveCount(2)
    await expect(recipient.getByRole('link', { name: 'Download' })).toHaveCount(0)
    for (const client of [member.request, page.request]) {
      expect((await client.get(content(restoredId))).status()).toBe(404)
      expect((await client.get(content(purgedId))).status()).toBe(404)
    }

    // Availability ends at the expiry time; the worker moves the files to snapshots on its next pass.
    await expect.poll(async () => {
      const snapshots = await (await admin.request.get('/v1/admin/snapshots')).json()
      return snapshots.map((item: { id: string }) => item.id)
    }, { timeout: 30000, intervals: [1000] }).toEqual(expect.arrayContaining([restoredId, purgedId]))
    const storage = await (await admin.request.get('/v1/admin/storage')).json()
    expect(storage.files.snapshot.count).toBeGreaterThanOrEqual(2)
    expect(storage.retention.snapshotSeconds).toBeGreaterThan(0)
    expect((await member.request.post('/v1/admin/snapshots/' + restoredId + '/restore', { headers, data: {} })).status()).toBe(404)

    const restoreResponse = await admin.request.post('/v1/admin/snapshots/' + restoredId + '/restore', { headers, data: { expiresInSeconds: 3600 } })
    expect(restoreResponse.status()).toBe(200)
    const back = await member.request.get(content(restoredId))
    expect(back.status()).toBe(200)
    expect(sha256(await back.body())).toBe(sha256(restored))
    await expect(recipient.getByRole('link', { name: 'Download' })).toHaveCount(1)

    expect((await admin.request.delete('/v1/admin/snapshots/' + purgedId, { headers })).status()).toBe(204)
    expect((await admin.request.post('/v1/admin/snapshots/' + purgedId + '/restore', { headers, data: {} })).status()).toBe(404)
    expect((await member.request.get(content(purgedId))).status()).toBe(404)
    const remaining = (await (await admin.request.get('/v1/admin/snapshots')).json()).map((item: { id: string }) => item.id)
    expect(remaining).not.toContain(purgedId)
    expect(remaining).not.toContain(restoredId)

    const adminPage = await admin.newPage()
    await adminPage.goto('/settings')
    await adminPage.getByRole('link', { name: 'Storage administration' }).click()
    await expect(adminPage.getByRole('heading', { name: 'Storage lifecycle' })).toBeVisible()
    await expect(adminPage.getByRole('table', { name: 'Storage usage' })).toBeVisible()
  } finally {
    await Promise.all([page.request, member.request, admin.request].map(client => deleteAccount(client, origin)))
    await Promise.all([member.close(), admin.close()])
  }
})
