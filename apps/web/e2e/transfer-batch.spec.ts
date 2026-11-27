import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { deleteAccount, register, verifyEmail } from './chat-fixtures'

const partSize = 8 << 20
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function group(owner: APIRequestContext, member: APIRequestContext, origin: string, title: string) {
  const headers = { Origin: origin }
  const created = await (await owner.post('/v1/conversations', { headers, data: { title } })).json()
  const invitation = await (await owner.post('/v1/invitations', { headers, data: { conversationId: created.id } })).json()
  expect((await member.post('/v1/invitations/redeem', { headers, data: { token: new URL(invitation.url).hash.slice(1) } })).status()).toBe(200)
  return created.id as string
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

async function throttle(page: Page, bytesPerSecond: number) {
  const session = await page.context().newCDPSession(page)
  await session.send('Network.enable')
  await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: bytesPerSecond, uploadThroughput: -1 })
  return () => session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
}

test('batch actions change only eligible selected transfers and report each outcome', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(150000)
  const origin = baseURL!
  const member = await browser.newContext({ baseURL: origin, acceptDownloads: true })
  try {
    const email = await register(page.request, origin, 'Batch sender')
    await register(member.request, origin, 'Batch recipient')
    await verifyEmail(page.request, request, origin, email)
    const alpha = await group(page.request, member.request, origin, 'Batch alpha')
    const beta = await group(page.request, member.request, origin, 'Batch beta')
    for (const name of ['alpha-1.bin', 'alpha-2.bin', 'alpha-3.bin']) await sendFile(page.request, origin, alpha, name, randomBytes(4 << 20))
    await sendFile(page.request, origin, beta, 'beta-1.bin', randomBytes(4 << 20))
    const broken = randomBytes(1 << 20)
    const brokenId = await sendFile(page.request, origin, beta, 'gamma.bin', broken)

    const recipient = await member.newPage()
    const dialogs: string[] = []
    recipient.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept() })
    const unthrottle = await throttle(recipient, 512 << 10)
    // Bytes that fail verification leave gamma.bin failed, so it can be retried later.
    const route = '**/v1/files/' + brokenId + '/content'
    await recipient.route(route, async item => item.fulfill({ response: await item.fetch(), body: randomBytes(broken.length) }))
    // In-app navigation keeps the page, and with it the throttled connection, between chats and the Transfers page.
    await recipient.goto('/chats')
    for (const [title, names] of [['Batch beta', ['gamma.bin', 'beta-1.bin']], ['Batch alpha', ['alpha-1.bin', 'alpha-2.bin', 'alpha-3.bin']]] as const) {
      await recipient.getByRole('link', { name: 'Chats' }).first().click()
      await recipient.getByRole('link', { name: new RegExp('^' + title) }).click()
      for (const name of names) {
        await recipient.getByRole('listitem').filter({ hasText: name }).locator('.attachment').getByRole('button', { name: 'Download', exact: true }).click()
      }
    }
    await recipient.getByRole('link', { name: 'Transfers' }).first().click()
    const item = (name: string) => recipient.getByRole('listitem').filter({ hasText: name })
    const notice = recipient.getByRole('status').filter({ hasText: /transfer|Skipped/ })
    const batch = recipient.getByRole('group', { name: 'Batch actions' })
    await expect(item('gamma.bin').getByText(/^Failed/)).toBeVisible({ timeout: 30000 })

    // Searching by conversation and pausing everything shown leaves the other conversation's downloads running.
    await recipient.getByLabel('Search').fill('Batch alpha')
    await expect(recipient.getByRole('region', { name: 'Downloads' }).getByRole('listitem')).toHaveCount(3)
    await batch.getByRole('checkbox', { name: 'Select all shown' }).check()
    await batch.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(notice).toHaveText('Paused 3 transfers.')
    await recipient.getByLabel('Search').fill('')
    for (const name of ['alpha-1.bin', 'alpha-2.bin', 'alpha-3.bin']) await expect(item(name).getByText(/^Paused/)).toBeVisible()
    await expect(item('beta-1.bin').getByText(/^(Downloading|Queued)/)).toBeVisible()

    // A mixed selection changes the eligible item and reports the one it skipped.
    await recipient.getByRole('button', { name: /^Paused \(3\)$/ }).click()
    await item('alpha-2.bin').getByRole('checkbox', { name: 'Select alpha-2.bin' }).check()
    await batch.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(notice).toHaveText('Resumed 1 transfer.')
    await expect(item('alpha-2.bin')).toHaveCount(0)
    await recipient.getByRole('button', { name: /^All / }).click()
    await item('alpha-2.bin').getByRole('checkbox', { name: 'Select alpha-2.bin' }).check()
    await item('alpha-3.bin').getByRole('checkbox', { name: 'Select alpha-3.bin' }).check()
    await batch.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(notice).toHaveText(/^Paused 1 transfer\. Skipped 1: /)
    for (const name of ['alpha-2.bin', 'alpha-3.bin']) await expect(item(name).getByText(/^Paused/)).toBeVisible()

    // Cancelling asks first, removes only the selected downloads and leaves the rest alone.
    await item('alpha-1.bin').getByRole('checkbox', { name: 'Select alpha-1.bin' }).check()
    await batch.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(notice).toHaveText('Cancelled 1 transfer.')
    expect(dialogs.at(-1)).toContain('Cancel 1 transfer?')
    await expect(item('alpha-1.bin')).toHaveCount(0)
    await expect(item('alpha-3.bin').getByText(/^Paused/)).toBeVisible()

    // Retry applies to failed transfers; resume with nothing selected applies to everything shown.
    for (const name of ['alpha-2.bin', 'alpha-3.bin']) await expect(item(name).getByText(/^Paused/)).toBeVisible()
    await recipient.unroute(route)
    await unthrottle()
    await recipient.getByRole('button', { name: /^Failed \(1\)$/ }).click()
    await batch.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(notice).toHaveText('Retried 1 transfer.')
    await recipient.getByRole('button', { name: 'Paused (2)' }).click()
    await batch.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(notice).toHaveText('Resumed 2 transfers.')
    await recipient.getByRole('button', { name: /^All / }).click()
    for (const name of ['alpha-2.bin', 'alpha-3.bin', 'beta-1.bin', 'gamma.bin']) {
      await expect(item(name).getByText(/Verified · Ready to save/)).toBeVisible({ timeout: 30000 })
    }

    // Clearing finished transfers asks before deleting verified copies and never touches the chat attachments.
    await batch.getByRole('button', { name: 'Clear finished' }).click()
    expect(dialogs.at(-1)).toContain('4 verified downloads are also deleted from this device')
    await expect(recipient.getByRole('heading', { name: 'No transfers' })).toBeVisible()
    // Nothing is left in this browser: no download records and no stored bytes.
    await expect.poll(() => recipient.evaluate(async () => {
      const records = await new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('fluxparcel-downloads')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const count = open.result.transaction('downloads').objectStore('downloads').count()
          count.onsuccess = () => { resolve(count.result); open.result.close() }
        }
      })
      let files = 0
      const root = await navigator.storage.getDirectory()
      const downloads = await root.getDirectoryHandle('fluxparcel-downloads') as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemDirectoryHandle> }
      for await (const account of downloads.values()) {
        for await (const name of (account as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) files += name ? 1 : 0
      }
      return records + files
    })).toBe(0)
    await recipient.goto('/chats/' + alpha)
    await expect(recipient.getByRole('listitem').filter({ hasText: 'alpha-2.bin' }).locator('.attachment').getByRole('button', { name: 'Download', exact: true })).toBeVisible()
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})

test('batch pause and resume work for uploads and pause sends nothing until resumed', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(120000)
  const origin = baseURL!
  const member = await browser.newContext({ baseURL: origin })
  try {
    const email = await register(page.request, origin, 'Batch uploader')
    await register(member.request, origin, 'Batch upload recipient')
    await verifyEmail(page.request, request, origin, email)
    const id = await group(page.request, member.request, origin, 'Batch uploads')
    await page.goto('/chats')
    await page.getByRole('link', { name: /^Batch uploads/ }).click()
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 256 << 10 })
    const files = ['one.bin', 'two.bin', 'three.bin'].map(name => ({ name, mimeType: 'application/octet-stream', buffer: randomBytes(2 << 20) }))
    await page.getByLabel('Attach files').setInputFiles(files)
    await page.getByRole('link', { name: 'Transfers' }).first().click()
    const batch = page.getByRole('group', { name: 'Batch actions' })
    await expect(page.getByRole('button', { name: 'Uploads (3)' })).toBeVisible()
    await batch.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'transfer' })).toHaveText('Paused 3 transfers.')
    for (const file of files) await expect(page.getByRole('listitem').filter({ hasText: file.name }).getByText(/^Paused/)).toBeVisible()
    let parts = 0
    page.on('request', item => { if (item.url().includes('/parts/')) parts++ })
    await page.waitForTimeout(1500)
    expect(parts).toBe(0)

    await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await batch.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'transfer' })).toHaveText('Resumed 3 transfers.')
    for (const file of files) await expect(page.getByRole('listitem').filter({ hasText: file.name }).getByText(/^Sent/)).toBeVisible({ timeout: 30000 })
    const messages = await (await member.request.get('/v1/conversations/' + id + '/messages')).json()
    for (const file of files) {
      expect(messages.find((message: { file?: { name: string; sha256: string } }) => message.file?.name === file.name).file.sha256).toBe(sha256(file.buffer))
    }
  } finally {
    await Promise.all([page.request, member.request].map(client => deleteAccount(client, origin)))
    await member.close()
  }
})
