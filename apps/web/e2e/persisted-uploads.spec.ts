import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { deleteAccount, register, verifyEmail } from './chat-fixtures'

const partSize = 8 << 20
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function setup(page: Page, browser: import('@playwright/test').Browser, request: import('@playwright/test').APIRequestContext, baseURL: string, title: string) {
  const headers = { Origin: baseURL }
  const member = await browser.newContext({ baseURL })
  const email = await register(page.request, baseURL, title + ' sender')
  await register(member.request, baseURL, title + ' recipient')
  await verifyEmail(page.request, request, baseURL, email)
  const group = await (await page.request.post('/v1/conversations', { headers, data: { title } })).json()
  const invitation = await (await page.request.post('/v1/invitations', { headers, data: { conversationId: group.id } })).json()
  const token = new URL(invitation.url).hash.slice(1)
  expect((await member.request.post('/v1/invitations/redeem', { headers, data: { token } })).status()).toBe(200)
  return { member, conversationId: group.id as string }
}

// Records part requests and server acknowledgments, and can slow parts so a test can act mid-upload.
async function watchParts(page: Page) {
  const watch = { requested: [] as number[], acknowledged: new Set<number>(), slow: true }
  await page.route(/\/v1\/transfers\/[^/]+\/parts\/\d+$/, async route => {
    const number = Number(route.request().url().split('/').at(-1))
    watch.requested.push(number)
    if (watch.slow) await new Promise(resolve => setTimeout(resolve, 1500))
    try {
      const response = await route.fetch()
      if (response.status() === 200) watch.acknowledged.add(number)
      await route.fulfill({ response })
    } catch { /* the page aborted this part */ }
  })
  return watch
}

test('an upload interrupted by a reload resumes from acknowledged parts after the same file is selected', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(90000)
  const { member, conversationId } = await setup(page, browser, request, baseURL!, 'Reloaded upload')
  try {
    const data = randomBytes(2 * partSize + 777)
    const watch = await watchParts(page)
    await page.goto('/chats/' + conversationId)
    await page.getByLabel('Attach files').setInputFiles({ name: 'survey.bin', mimeType: 'application/octet-stream', buffer: data })
    await expect.poll(() => watch.acknowledged.size).toBeGreaterThan(0)
    await page.reload()
    const acknowledgedBeforeReload = new Set(watch.acknowledged)
    const requestedBeforeReload = watch.requested.length

    const item = page.getByRole('listitem').filter({ hasText: 'survey.bin', has: page.getByRole('progressbar') })
    await expect(item.getByText(/Select the file to resume/)).toBeVisible()
    const picker = item.getByLabel('Select survey.bin to resume')
    await picker.setInputFiles({ name: 'survey.bin', mimeType: 'application/octet-stream', buffer: data.subarray(0, 100) })
    await expect(item.getByText(/It must be/)).toBeVisible()
    const impostor = Buffer.from(data)
    impostor[impostor.length - 1] ^= 0xff
    await picker.setInputFiles({ name: 'survey.bin', mimeType: 'application/octet-stream', buffer: impostor })
    await expect(item.getByText('That is a different file. Choose the original file to resume.', { exact: false })).toBeVisible()
    expect(watch.requested.length).toBe(requestedBeforeReload)

    watch.slow = false
    await picker.setInputFiles({ name: 'survey.bin', mimeType: 'application/octet-stream', buffer: data })
    await expect(item).toHaveCount(0, { timeout: 30000 })
    const resent = watch.requested.slice(requestedBeforeReload)
    for (const number of acknowledgedBeforeReload) expect(resent).not.toContain(number)

    const [message] = await (await member.request.get('/v1/conversations/' + conversationId + '/messages')).json()
    expect(message.file).toMatchObject({ name: 'survey.bin', size: data.length, sha256: sha256(data), available: true })
    expect(sha256(await (await member.request.get('/v1/files/' + message.file.id + '/content')).body())).toBe(sha256(data))
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, baseURL!)))
    await member.close()
  }
})

test('a paused upload stays paused across reloads and cancelling it lets cleanup remove the transfer', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(90000)
  const { member, conversationId } = await setup(page, browser, request, baseURL!, 'Paused reload')
  try {
    const watch = await watchParts(page)
    const created: string[] = []
    page.on('response', async response => {
      if (response.request().method() === 'POST' && response.url().endsWith('/v1/transfers') && response.ok()) created.push((await response.json()).id)
    })
    await page.goto('/chats/' + conversationId)
    await page.getByLabel('Attach files').setInputFiles({ name: 'paused.bin', mimeType: 'application/octet-stream', buffer: randomBytes(2 * partSize + 1) })
    const item = page.getByRole('listitem').filter({ hasText: 'paused.bin', has: page.getByRole('progressbar') })
    await expect.poll(() => watch.acknowledged.size).toBeGreaterThan(0)
    await item.getByRole('button', { name: 'Pause' }).click()
    await expect(item.getByText(/Paused/)).toBeVisible()
    await page.reload()
    await expect(item.getByText(/Paused/)).toBeVisible()
    const requested = watch.requested.length
    await page.waitForTimeout(2000)
    expect(watch.requested.length).toBe(requested)

    await item.getByRole('button', { name: 'Cancel upload' }).click()
    await expect(item).toHaveCount(0)
    await page.reload()
    await expect(page.getByText('paused.bin')).toHaveCount(0)
    expect(created).toHaveLength(1)
    // The cleanup worker aborts the cancelled upload and deletes its transfer record.
    await expect.poll(async () => (await page.request.get('/v1/transfers/' + created[0])).status(), { timeout: 30000 }).toBe(404)
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, baseURL!)))
    await member.close()
  }
})

test('large files up to the configured limit are accepted and split into parts', async ({ page, browser, request, baseURL }) => {
  const origin = baseURL!
  const headers = { Origin: origin }
  const { member, conversationId } = await setup(page, browser, request, origin, 'Large limits')
  try {
    const capabilities = await (await page.request.get('/v1/capabilities')).json()
    expect(capabilities).toMatchObject({ transfers: true, maxFileSize: 8 * 1024 ** 3, partSize })
    const create = (size: number) => page.request.post('/v1/transfers', {
      headers, data: { conversationId, clientId: randomUUID(), name: 'video.mkv', size, sha256: 'a'.repeat(64) },
    })
    const sixGiB = await create(6 * 1024 ** 3)
    expect(sixGiB.status()).toBe(201)
    const transfer = await sixGiB.json()
    expect(transfer).toMatchObject({ partCount: 768, partSize, size: 6 * 1024 ** 3 })
    const atLimit = await create(8 * 1024 ** 3)
    expect(atLimit.status()).toBe(201)
    const tooLarge = await create(8 * 1024 ** 3 + 1)
    expect(tooLarge.status()).toBe(400)
    expect((await tooLarge.json()).message).toContain('8 GiB')
    for (const id of [transfer.id, (await atLimit.json()).id]) {
      expect((await page.request.delete('/v1/transfers/' + id, { headers })).status()).toBe(204)
    }
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})

test('the browser rejects files above the server limit before hashing them', async ({ page, browser, request, baseURL }) => {
  const { member, conversationId } = await setup(page, browser, request, baseURL!, 'Client limit')
  try {
    await page.route('**/v1/capabilities', route => route.fulfill({ json: { transfers: true, maxFileSize: 1 << 20, partSize } }))
    let created = 0
    page.on('request', item => { if (item.method() === 'POST' && item.url().endsWith('/v1/transfers')) created++ })
    await page.goto('/chats/' + conversationId)
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
    await page.getByLabel('Attach files').setInputFiles({ name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: randomBytes(2 << 20) })
    await expect(page.getByText('Files can be up to 1.0 MiB.', { exact: false })).toBeVisible()
    expect(created).toBe(0)
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, baseURL!)))
    await member.close()
  }
})
