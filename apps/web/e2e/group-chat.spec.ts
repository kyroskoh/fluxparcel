import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

const password = 'synthetic group chat password'
const mailOrigin = process.env.FLUXPARCEL_MAIL_ORIGIN ?? 'http://localhost:8025'

async function register(client: APIRequestContext, origin: string, displayName: string) {
  const username = 'chat_' + randomUUID().replaceAll('-', '').slice(0, 20)
  const email = username + '@example.test'
  const result = await client.post('/v1/auth/register', { headers: { Origin: origin }, data: { email, username, displayName, password } })
  expect(result.status()).toBe(201)
  return email
}

async function verifyEmail(client: APIRequestContext, request: APIRequestContext, origin: string, email: string) {
  const headers = { Origin: origin }
  let messageID = ''
  await expect.poll(async () => {
    const response = await request.get(mailOrigin + '/api/v1/search', { params: { query: 'to:' + email } })
    messageID = (await response.json()).messages?.[0]?.ID ?? ''
    return messageID
  }).not.toBe('')
  const message = await (await request.get(mailOrigin + '/api/v1/message/' + messageID)).json()
  const verification = (message.Text as string).match(/\/verify#([\w-]+)/)?.[1]
  expect(verification).toBeTruthy()
  expect((await client.post('/v1/auth/verify', { headers, data: { token: verification } })).status()).toBe(204)
}

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

    expect((await member.request.post('/v1/auth/logout', { headers })).status()).toBe(204)
    const recipient = await member.newPage()
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
    await recipient.getByLabel('Message', { exact: true }).fill('Reply from a member')
    await recipient.getByRole('button', { name: 'Send', exact: true }).click()
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
