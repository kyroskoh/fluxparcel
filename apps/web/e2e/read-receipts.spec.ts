import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { password, register, verifyEmail } from './chat-fixtures'

test('read receipts are opt-in, reciprocal and leave private unread counts unchanged', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(60000)
  const origin = baseURL!
  const headers = { Origin: origin }
  const reader = await browser.newContext({ baseURL })
  const anonymous = await browser.newContext({ baseURL })
  const clients = [page.request, reader.request]
  try {
    const senderEmail = await register(page.request, origin, 'Receipt Sender')
    const readerEmail = await register(reader.request, origin, 'Receipt Reader')
    await verifyEmail(page.request, request, origin, senderEmail)
    await verifyEmail(reader.request, request, origin, readerEmail)

    const sender = await (await page.request.get('/v1/account')).json()
    expect(sender.shareReadReceipts).toBe(false)
    expect((await page.request.patch('/v1/account', { headers, data: {} })).status()).toBe(400)
    expect((await page.request.patch('/v1/account', { headers, data: { shareReadReceipts: 'yes' } })).status()).toBe(400)

    const invite = await (await page.request.post('/v1/contact-invitations', { headers, data: {} })).json()
    const token = new URL(invite.url).hash.slice('#contact_'.length)
    expect((await reader.request.post('/v1/contact-invitations/redeem', { headers, data: { token } })).status()).toBe(204)
    const [pending] = await (await page.request.get('/v1/contact-requests')).json()
    const approved = await page.request.post('/v1/contact-requests/' + pending.id + '/decision', { headers, data: { decision: 'approve' } })
    expect(approved.status()).toBe(200)
    const { conversationId: id } = await approved.json()
    const base = '/v1/conversations/' + id
    const send = async (body: string) => {
      const response = await page.request.post(base + '/messages', { headers, data: { clientId: randomUUID(), body } })
      expect(response.status()).toBe(201)
      return (await response.json()).sequence as number
    }
    const markRead = async (sequence: number) => {
      expect((await reader.request.post(base + '/read', { headers, data: { sequence } })).status()).toBe(200)
    }
    const share = async (client: APIRequestContext, shareReadReceipts: boolean) => {
      const response = await client.patch('/v1/account', { headers, data: { shareReadReceipts } })
      expect(response.status()).toBe(200)
      expect((await response.json()).shareReadReceipts).toBe(shareReadReceipts)
    }
    const receipts = async (client: APIRequestContext) => (await client.get(base + '/receipts')).json()
    const unread = async () => (await (await reader.request.get('/v1/conversations')).json())[0].unread

    expect((await anonymous.request.get(base + '/receipts')).status()).toBe(401)
    const privateGroup = await (await page.request.post('/v1/conversations', { headers, data: { title: 'Sender only' } })).json()
    expect((await reader.request.get('/v1/conversations/' + privateGroup.id + '/receipts')).status()).toBe(404)
    expect((await page.request.get('/v1/conversations/' + randomUUID() + '/receipts')).status()).toBe(404)

    const first = await send('Did this arrive?')
    await markRead(first)
    expect(await receipts(page.request)).toEqual({ sharing: false, readers: [] })

    // Sharing is reciprocal: the sender sees nothing until both accounts opt in.
    await share(page.request, true)
    expect(await receipts(page.request)).toEqual({ sharing: true, readers: [] })
    await share(reader.request, true)
    const readerAccount = await (await reader.request.get('/v1/account')).json()
    expect(await receipts(page.request)).toEqual({
      sharing: true, readers: [{ userId: readerAccount.id, displayName: 'Receipt Reader', sequence: first }],
    })
    // The display name is kept when only the receipt preference changes.
    expect(readerAccount.displayName).toBe('Receipt Reader')

    await page.goto('/chats/' + id)
    const own = page.getByRole('listitem').filter({ hasText: 'Did this arrive?' })
    await expect(own.getByText('Read', { exact: true })).toBeVisible()
    const second = await send('Second message')
    const later = page.getByRole('listitem').filter({ hasText: 'Second message' })
    await expect(later.getByText('Sent', { exact: true })).toBeVisible()
    await markRead(second)
    await expect(later.getByText('Read', { exact: true })).toBeVisible()

    // Switching off hides shared receipts without touching the private read cursor or unread count.
    const third = await send('Third message')
    expect(await unread()).toBe(1)
    await share(reader.request, false)
    expect(await unread()).toBe(1)
    expect(await receipts(page.request)).toEqual({ sharing: true, readers: [] })
    expect(await receipts(reader.request)).toEqual({ sharing: false, readers: [] })
    await markRead(third)
    expect(await unread()).toBe(0)
    expect(await receipts(page.request)).toEqual({ sharing: true, readers: [] })
    await expect(later.getByText('Read', { exact: true })).toHaveCount(0, { timeout: 20000 })
    await expect(later.getByText('Sent', { exact: true })).toBeVisible()

    // Re-enabling shares the cursor that advanced privately in the meantime.
    await share(reader.request, true)
    expect((await receipts(page.request)).readers[0].sequence).toBe(third)

    // The sender's own switch in Settings hides receipts in the open chat.
    await page.goto('/settings')
    const toggle = page.getByLabel('Share read receipts')
    await expect(toggle).toBeChecked()
    // The control reflects the saved server state, so it changes once the update is confirmed.
    await toggle.click()
    await expect(page.getByText('Read receipts turned off.')).toBeVisible()
    await expect(toggle).not.toBeChecked()
    await page.goto('/chats/' + id)
    await expect(page.getByText('Third message')).toBeVisible()
    await expect(page.locator('.receipt')).toHaveCount(0)
    expect(await receipts(page.request)).toEqual({ sharing: false, readers: [] })
    expect(await unread()).toBe(0)
  } finally {
    await Promise.all(clients.map(client => client.delete('/v1/account', { headers, data: { password } })))
    await Promise.all([reader.close(), anonymous.close()])
  }
})
