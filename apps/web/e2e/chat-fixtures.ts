import { randomUUID } from 'node:crypto'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'

export const password = 'synthetic group chat password'
const mailOrigin = process.env.FLUXPARCEL_MAIL_ORIGIN ?? 'http://localhost:8025'

export async function register(client: APIRequestContext, origin: string, displayName: string) {
  const username = 'chat_' + randomUUID().replaceAll('-', '').slice(0, 20)
  const email = username + '@example.test'
  const result = await retryAuthentication(() =>
    client.post('/v1/auth/register', { headers: { Origin: origin }, data: { email, username, displayName, password } }))
  expect(result.status()).toBe(201)
  return email
}

// The API sheds password hashing under load with 503 authentication_busy and a Retry-After hint.
// Retry as a well-behaved client would, so parallel tests do not fail on deliberate load shedding.
export async function retryAuthentication(send: () => Promise<APIResponse>) {
  for (let attempt = 1; ; attempt++) {
    const response = await send()
    if (response.status() !== 503 || attempt === 5) return response
    if ((await response.json().catch(() => null))?.code !== 'authentication_busy') return response
    const seconds = Number(response.headers()['retry-after'] ?? 2)
    await new Promise(resolve => setTimeout(resolve, (Number.isFinite(seconds) ? seconds : 2) * 1000))
  }
}

export function login(client: APIRequestContext, origin: string, email: string) {
  return retryAuthentication(() => client.post('/v1/auth/login', { headers: { Origin: origin }, data: { email, password } }))
}

export function deleteAccount(client: APIRequestContext, origin: string) {
  return retryAuthentication(() => client.delete('/v1/account', { headers: { Origin: origin }, data: { password } }))
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
