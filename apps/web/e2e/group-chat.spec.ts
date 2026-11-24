import { randomUUID } from 'node:crypto'
import { expect, test, type WebSocket } from '@playwright/test'
import QRCode from 'qrcode'
import { password, register, verifyEmail } from './chat-fixtures'

test('private group invitations, atomic redemption and durable message synchronization', async ({ browser, page, request, baseURL }) => {
  const origin = baseURL!
  const headers = { Origin: origin }
  const member = await browser.newContext({ baseURL })
  const outsider = await browser.newContext({ baseURL })
  try {
    const email = await register(page.request, origin, 'Group Owner')
    const memberEmail = await register(member.request, origin, 'Recipient')
    await register(outsider.request, origin, 'Outsider')
    await verifyEmail(page.request, request, origin, email)

    await page.goto('/chats')
    await page.getByRole('button', { name: 'New group' }).click()
    await page.getByLabel('Group name').fill('Private test group')
    await page.getByRole('button', { name: 'Create group' }).click()
    await expect(page.getByRole('heading', { name: 'Private test group' })).toBeVisible()
    const group = page.url().split('/').at(-1)!
    const endpoint = '/v1/conversations/' + group + '/messages'
    expect((await member.request.get(endpoint)).status()).toBe(404)

    await page.getByRole('button', { name: 'Group invitations' }).click()
    await page.getByRole('button', { name: 'Create invitation' }).click()
    await expect(page.getByAltText('QR code for this group invitation')).toBeVisible()
    const link = await page.getByLabel('Share link').inputValue()
    const inviteToken = new URL(link).hash.slice(1)
    expect(inviteToken).toHaveLength(43)

    const scanner = await member.newPage()
    await scanner.addInitScript(uri => {
      navigator.mediaDevices.getUserMedia = async () => {
        const image = new Image()
        image.src = uri
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')!
        const stream = canvas.captureStream(15)
        const track = stream.getVideoTracks()[0]
        const draw = () => context.drawImage(image, 0, 0)
        const interval = setInterval(draw, 70)
        const stop = track.stop.bind(track)
        track.stop = () => {
          clearInterval(interval)
          stop()
          document.documentElement.dataset.testCameraStopped = String(track.readyState === 'ended')
        }
        draw()
        return stream
      }
    }, await QRCode.toDataURL(link, { width: 400 }))
    await scanner.goto('/chats')
    await scanner.getByRole('button', { name: 'Open invite' }).click()
    await scanner.getByRole('button', { name: 'Scan with camera' }).click()
    await expect(scanner.getByText('Group invitation found.')).toBeVisible()
    await expect(scanner.locator('html')).toHaveAttribute('data-test-camera-stopped', 'true')
    await expect(scanner).toHaveURL(/\/chats$/)
    await scanner.getByRole('button', { name: 'Review scanned invitation' }).click()
    await expect(scanner.getByText('Group Owner')).toBeVisible()
    expect((await member.request.get(endpoint)).status()).toBe(404)

    await scanner.close()
    expect((await member.request.post('/v1/auth/logout', { headers })).status()).toBe(204)
    const recipient = await member.newPage()
    const liveConnections: WebSocket[] = []
    const readyConnections = new Set<WebSocket>()
    const changeNotifications: string[] = []
    recipient.on('websocket', socket => {
      if (!new URL(socket.url()).pathname.endsWith('/v1/events')) return
      liveConnections.push(socket)
      socket.on('framereceived', ({ payload }) => {
        if (payload === 'messages.ready') readyConnections.add(socket)
        if (payload === 'messages.changed') changeNotifications.push(payload)
      })
    })
    await recipient.goto(link)
    await expect(recipient).toHaveURL(/\/i$/)
    await recipient.getByRole('link', { name: 'Sign in to preview' }).click()
    await recipient.getByLabel('Email address').fill(memberEmail)
    await recipient.getByLabel('Password').fill(password)
    await recipient.getByRole('button', { name: 'Sign in' }).click()
    await expect(recipient.getByText('Group Owner')).toBeVisible()
    expect((await member.request.get(endpoint)).status()).toBe(404)
    await recipient.getByRole('button', { name: 'Accept invitation' }).click()
    await expect(recipient.getByRole('heading', { name: 'Private test group' })).toBeVisible()
    expect((await outsider.request.post('/v1/invitations/redeem', { headers, data: { token: inviteToken } })).status()).toBe(404)

    await expect.poll(() => readyConnections.size).toBe(1)
    const firstConnection = liveConnections[0]
    const events = '/v1/events?conversationId=' + group
    expect((await page.request.get(events, { headers: { Origin: 'https://outside.example' } })).status()).toBe(403)
    expect((await request.get(events, { headers })).status()).toBe(401)
    expect((await outsider.request.get(events, { headers })).status()).toBe(404)
    const data = { clientId: randomUUID(), body: 'First synthetic message' }
    await member.setOffline(true)
    const sends = await Promise.all([
      page.request.post(endpoint, { headers, data }),
      page.request.post(endpoint, { headers, data }),
    ])
    expect(sends.map(result => result.status()).sort()).toEqual([200, 201])
    await expect(recipient.getByText(data.body)).toHaveCount(0)
    await expect(recipient.getByText('Connection interrupted. Retrying message synchronization.')).toBeVisible()
    await member.setOffline(false)
    await expect(recipient.getByText(data.body)).toHaveCount(1, { timeout: 15000 })
    await expect.poll(() => firstConnection.isClosed()).toBe(true)
    await expect.poll(() => readyConnections.size).toBe(2)
    await recipient.getByLabel('Message', { exact: true }).fill('Reply from a member')
    await recipient.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => changeNotifications.length).toBeGreaterThan(0)
    await expect(page.getByText('Reply from a member')).toBeVisible()
    const delta = await page.request.get(endpoint + '?after=1')
    expect((await delta.json()).map((item: { sequence: number }) => item.sequence)).toEqual([2])
    expect((await outsider.request.get(endpoint)).status()).toBe(404)
    expect((await outsider.request.post(endpoint, { headers, data: { ...data, clientId: randomUUID() } })).status()).toBe(404)

    await page.getByRole('button', { name: 'Create invitation' }).click()
    await expect(page.getByAltText('QR code for this group invitation')).toBeVisible()
    const revocableToken = new URL(await page.getByLabel('Share link').inputValue()).hash.slice(1)
    await page.getByRole('button', { name: 'Revoke invitation' }).click()
    await expect(page.getByText('Invitation revoked.')).toBeVisible()
    expect((await outsider.request.post('/v1/invitations/inspect', { headers, data: { token: revocableToken } })).status()).toBe(404)
    expect((await member.request.get(endpoint)).status()).toBe(200)

    const activeSocket = liveConnections[liveConnections.length - 1]
    expect((await member.request.post('/v1/auth/logout', { headers })).status()).toBe(204)
    expect((await page.request.post(endpoint, {
      headers, data: { clientId: randomUUID(), body: 'Message after session revocation' },
    })).status()).toBe(201)
    await expect.poll(() => activeSocket.isClosed()).toBe(true)
    await expect(recipient.getByText('This conversation is unavailable.')).toBeVisible()
    await expect(recipient.getByText('Message after session revocation')).toHaveCount(0)
    expect((await member.request.post('/v1/auth/login', { headers, data: { email: memberEmail, password } })).status()).toBe(200)
  } finally {
    await Promise.all([page.request, member.request, outsider.request].map(client =>
      client.delete('/v1/account', { headers, data: { password } }),
    ))
    await Promise.all([member.close(), outsider.close()])
  }
})

test('concurrent claims consume a single-use invitation only once', async ({ page, browser, request, baseURL }) => {
  const origin = baseURL!
  const headers = { Origin: origin }
  const first = await browser.newContext({ baseURL })
  const second = await browser.newContext({ baseURL })
  const clients = [first.request, second.request]
  try {
    const email = await register(page.request, origin, 'Concurrent Owner')
    await register(first.request, origin, 'First Claimant')
    await register(second.request, origin, 'Second Claimant')
    await verifyEmail(page.request, request, origin, email)
    const group = await (await page.request.post('/v1/conversations', { headers, data: { title: 'Concurrent invitations' } })).json()
    const invitation = await (await page.request.post('/v1/invitations', { headers, data: { conversationId: group.id } })).json()
    const token = new URL(invitation.url).hash.slice(1)
    const outcomes = await Promise.all(clients.map(client => client.post('/v1/invitations/redeem', { headers, data: { token } })))
    expect(outcomes.map(result => result.status()).sort()).toEqual([200, 404])
    const memberships = await Promise.all(clients.map(client => client.get('/v1/conversations/' + group.id + '/messages')))
    expect(memberships.map(result => result.status()).sort()).toEqual([200, 404])
  } finally {
    await Promise.all([page.request, ...clients].map(client => client.delete('/v1/account', { headers, data: { password } })))
    await Promise.all([first.close(), second.close()])
  }
})
