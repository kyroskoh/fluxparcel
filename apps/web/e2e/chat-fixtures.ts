import { randomUUID } from 'node:crypto'
import { expect, type APIRequestContext } from '@playwright/test'

export const password = 'synthetic group chat password'
const mailOrigin = process.env.FLUXPARCEL_MAIL_ORIGIN ?? 'http://localhost:8025'

export async function register(client: APIRequestContext, origin: string, displayName: string) {
  const username = 'chat_' + randomUUID().replaceAll('-', '').slice(0, 20)
  const email = username + '@example.test'
  const result = await client.post('/v1/auth/register', { headers: { Origin: origin }, data: { email, username, displayName, password } })
  expect(result.status()).toBe(201)
  return email
}

export async function verifyEmail(client: APIRequestContext, request: APIRequestContext, origin: string, email: string) {
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
