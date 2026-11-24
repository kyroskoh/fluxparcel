import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import QRCode from 'qrcode'
import { password, register, verifyEmail } from './chat-fixtures'
import { checkOfflineOutbox, checkOutboxSignOut } from './outbox-fixtures'

test('contact approval opens exactly one private direct conversation', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(65000)
  const origin = baseURL!
  const headers = { Origin: origin }
  const recipient = await browser.newContext({ baseURL })
  const outsider = await browser.newContext({ baseURL })
  const clients = [page.request, recipient.request, outsider.request]
  let recipientDeleted = false
  try {
    const senderEmail = await register(page.request, origin, 'Contact Issuer')
    const recipientEmail = await register(recipient.request, origin, 'Contact Recipient')
    await register(outsider.request, origin, 'Outside Account')
    await verifyEmail(page.request, request, origin, senderEmail)
    await verifyEmail(recipient.request, request, origin, recipientEmail)
    expect((await outsider.request.post('/v1/contact-invitations', { headers, data: {} })).status()).toBe(403)
    const extra = await (await page.request.post('/v1/contact-invitations', { headers, data: {} })).json()
    const revokedToken = new URL(extra.url).hash.slice('#contact_'.length)
    expect((await outsider.request.delete('/v1/contact-invitations/' + extra.id, { headers })).status()).toBe(404)
    expect((await page.request.delete('/v1/contact-invitations/' + extra.id, { headers })).status()).toBe(204)
    expect((await outsider.request.post('/v1/contact-invitations/inspect', { headers, data: { token: revokedToken } })).status()).toBe(404)

    let unavailableSocketAttempts = 0
    await page.routeWebSocket(/\/v1\/events\?/, socket => {
      unavailableSocketAttempts++
      void socket.close({ code: 1013, reason: 'Socket unavailable in test' })
    })
    await page.goto('/contacts')
    await page.getByRole('button', { name: 'Create invitation' }).click()
    await expect(page.getByAltText('QR code for this contact invitation')).toBeVisible()
    const url = await page.getByLabel('Share link').inputValue()
    const token = new URL(url).hash.slice('#contact_'.length)
    expect((await page.request.post('/v1/contact-invitations/redeem', { headers, data: { token } })).status()).toBe(404)

    const peer = await recipient.newPage()
    await peer.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied by test', 'NotAllowedError') }
    })
    await peer.goto('/chats')
    await peer.getByRole('button', { name: 'Open invite' }).click()
    await peer.getByRole('button', { name: 'Scan with camera' }).click()
    await expect(peer.getByText('Camera permission was denied.', { exact: false })).toBeVisible()
    await peer.getByLabel('Invitation link').fill('https://outside.example/i#' + 'x'.repeat(43))
    await peer.getByRole('button', { name: 'Preview invitation', exact: true }).click()
    await expect(peer.getByText('Enter a valid FluxParcel invitation link from this server.')).toBeVisible()

    const imageInput = peer.getByLabel('Choose QR image')
    const foreign = await QRCode.toBuffer('https://outside.example/i#' + 'x'.repeat(43))
    await imageInput.setInputFiles({ name: 'foreign.png', mimeType: 'image/png', buffer: foreign })
    await expect(peer.getByText('This QR code is not a FluxParcel invitation from this server.')).toBeVisible()
    await expect(peer).toHaveURL(/\/chats$/)
    await imageInput.setInputFiles({ name: 'invite.png', mimeType: 'image/png', buffer: await QRCode.toBuffer(url) })
    await expect(peer.getByText('Contact invitation found.')).toBeVisible()
    await expect(peer).toHaveURL(/\/chats$/)
    await peer.getByRole('button', { name: 'Review scanned invitation' }).click()
    await expect(peer.getByText('Contact Issuer')).toBeVisible()
    expect(await (await page.request.get('/v1/contact-requests')).json()).toEqual([])
    await peer.getByRole('button', { name: 'Send contact request' }).click()
    await expect(peer.getByText('Request sent.', { exact: false })).toBeVisible()
    const retry = await recipient.request.post('/v1/contact-invitations/redeem', { headers, data: { token } })
    expect(retry.status()).toBe(204)
    expect((await outsider.request.post('/v1/contact-invitations/redeem', { headers, data: { token } })).status()).toBe(404)
    expect(await (await recipient.request.get('/v1/conversations')).json()).toEqual([])
    const [pending] = await (await page.request.get('/v1/contact-requests')).json()
    const decision = '/v1/contact-requests/' + pending.id + '/decision'
    const data = { decision: 'approve' }
    expect((await recipient.request.post(decision, { headers, data })).status()).toBe(404)
    expect((await outsider.request.post(decision, { headers, data })).status()).toBe(404)

    const inverse = await (await recipient.request.post('/v1/contact-invitations', { headers, data: {} })).json()
    const inverseToken = new URL(inverse.url).hash.slice('#contact_'.length)
    expect((await page.request.post('/v1/contact-invitations/redeem', { headers, data: { token: inverseToken } })).status()).toBe(204)
    const [other] = (await (await recipient.request.get('/v1/contact-requests')).json()).filter((item: { incoming: boolean }) => item.incoming)

    await page.getByRole('button', { name: 'Refresh requests' }).click()
    const approved = recipient.request.post('/v1/contact-requests/' + other.id + '/decision', { headers, data })
    await page.getByRole('button', { name: 'Approve' }).click()
    expect((await approved).status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Contact Recipient' })).toBeVisible()
    const id = page.url().split('/').at(-1)
    const matches = await (await recipient.request.get('/v1/conversations')).json()
    expect(matches).toEqual([{ id, title: 'Contact Issuer', role: 'member', kind: 'direct' }])
    const messages = '/v1/conversations/' + id + '/messages'
    expect((await outsider.request.get(messages)).status()).toBe(404)
    expect((await page.request.post('/v1/invitations', { headers, data: { conversationId: id } })).status()).toBe(404)
    expect((await recipient.request.post(messages, { headers, data: { clientId: randomUUID(), body: 'Hello from the direct chat' } })).status()).toBe(201)
    await expect.poll(() => unavailableSocketAttempts).toBeGreaterThan(0)
    await expect(page.getByText('Hello from the direct chat')).toBeVisible()
    const owner = await (await page.request.get('/v1/account')).json()
    expect((await recipient.request.post(messages, {
      headers, data: { clientId: randomUUID(), body: 'Wrong account', expectedSenderId: owner.id },
    })).status()).toBe(403)
    await checkOfflineOutbox(page, messages, 'Contact Recipient')
    await checkOutboxSignOut(page, messages)
    expect((await page.request.post('/v1/auth/login', { headers, data: { email: senderEmail, password } })).status()).toBe(200)
    const declinable = await (await page.request.post('/v1/contact-invitations', { headers, data: {} })).json()
    const declineToken = new URL(declinable.url).hash.slice('#contact_'.length)
    expect((await outsider.request.post('/v1/contact-invitations/redeem', { headers, data: { token: declineToken } })).status()).toBe(204)
    const [outgoing] = await (await outsider.request.get('/v1/contact-requests')).json()
    expect((await page.request.post('/v1/contact-requests/' + outgoing.id + '/decision', { headers, data: { decision: 'decline' } })).status()).toBe(204)
    expect(await (await outsider.request.get('/v1/conversations')).json()).toEqual([])
    expect((await recipient.request.delete('/v1/account', { headers, data: { password } })).status()).toBe(204)
    recipientDeleted = true
    expect((await page.request.get(messages)).status()).toBe(404)
  } finally {
    await Promise.all(clients.filter(client => !recipientDeleted || client !== recipient.request).map(client => client.delete('/v1/account', { headers, data: { password } })))
    await Promise.all([recipient.close(), outsider.close()])
  }
})
