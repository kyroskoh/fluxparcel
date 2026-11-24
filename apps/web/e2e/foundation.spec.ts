import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

const password = 'test-only password for FluxParcel'
const mailOrigin = process.env.FLUXPARCEL_MAIL_ORIGIN ?? 'http://localhost:8025'

test('register, verify, update, revoke another session, and delete', async ({ page, browser, request, baseURL }) => {
  const username = 'test_' + randomUUID().replaceAll('-', '').slice(0, 20)
  const email = username + '@example.test'
  await page.goto('/register')
  await page.getByLabel('Display name').fill('Test Person')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chats$/)

  let messageID = ''
  await expect.poll(async () => {
    const mail = await request.get(mailOrigin + '/api/v1/search', { params: { query: 'to:' + email } })
    const result = await mail.json()
    messageID = result.messages?.[0]?.ID ?? ''
    return messageID
  }).not.toBe('')
  const message = await (await request.get(mailOrigin + '/api/v1/message/' + messageID)).json()
  const link = (message.Text as string).match(/https?:\/\/[^\s]+\/verify#[A-Za-z0-9_-]+/)
  expect(link).toBeTruthy()
  await page.goto(link![0])
  await expect(page).toHaveURL(/\/verify$/)
  await page.getByRole('button', { name: 'Verify email' }).click()
  await expect(page.getByText('Email verified.')).toBeVisible()
  await page.getByRole('link', { name: 'Continue to FluxParcel' }).click()

  const other = await browser.newContext({ baseURL })
  try {
    const otherPage = await other.newPage()
    await otherPage.goto('/login')
    await otherPage.getByLabel('Email address').fill(email)
    await otherPage.getByLabel('Password').fill(password)
    await otherPage.getByRole('button', { name: 'Sign in' }).click()
    await expect(otherPage).toHaveURL(/\/chats$/)

    await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByText('Email verified', { exact: true })).toBeVisible()
    await page.getByLabel('Display name').fill('Updated Person')
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Profile saved.')).toBeVisible()
    await page.getByRole('button', { name: 'Revoke' }).click()
    await expect(page.getByText('Session revoked.')).toBeVisible()
    expect((await other.request.get('/v1/account')).status()).toBe(401)
    expect((await other.request.post('/v1/auth/refresh', { headers: { Origin: baseURL! } })).status()).toBe(401)
    await otherPage.reload()
    await expect(otherPage).toHaveURL(/\/login$/)
  } finally {
    await other.close()
  }

  await page.getByLabel('Confirm password').fill(password)
  await page.getByRole('button', { name: 'Permanently delete account' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect((await request.post('/v1/auth/login', {
    headers: { Origin: baseURL! },
    data: { email, password },
  })).status()).toBe(401)
})

test('same-origin enforcement, rotating credentials and logout', async ({ request, baseURL }) => {
  const username = 'test_' + randomUUID().replaceAll('-', '').slice(0, 20)
  const origin = { Origin: baseURL! }
  expect((await request.post('/v1/auth/register', { headers: { Origin: 'https://elsewhere.example' } })).status()).toBe(403)
  try {
    const registered = await request.post('/v1/auth/register', {
      headers: origin,
      data: { email: username + '@example.test', username, displayName: 'Test Person', password },
    })
    expect(registered.status()).toBe(201)
    const oldCookies = (await request.storageState()).cookies
    expect(oldCookies.every(cookie => cookie.httpOnly && cookie.sameSite === 'Strict')).toBeTruthy()
    const oldRefresh = oldCookies.find(cookie => cookie.name === 'rv_refresh')!
    expect((await request.post('/v1/auth/refresh', { headers: origin })).status()).toBe(204)
    expect((await request.post('/v1/auth/refresh', {
      headers: { ...origin, Cookie: 'rv_refresh=' + oldRefresh.value },
    })).status()).toBe(401)
    expect((await request.get('/v1/account')).status()).toBe(200)
    expect((await request.post('/v1/auth/logout', { headers: origin })).status()).toBe(204)
    expect((await request.get('/v1/account')).status()).toBe(401)
    expect((await request.post('/v1/auth/refresh', { headers: origin })).status()).toBe(401)
  } finally {
    const login = await request.post('/v1/auth/login', {
      headers: origin,
      data: { email: username + '@example.test', password },
    })
    if (login.ok()) await request.delete('/v1/account', { headers: origin, data: { password } })
  }
})

test('responsive navigation at reference widths', async ({ page, request, baseURL }) => {
  const username = 'test_' + randomUUID().replaceAll('-', '').slice(0, 20)
  const email = username + '@example.test'
  try {
    await page.goto('/register')
    await page.getByLabel('Display name').fill('Test Person')
    await page.getByLabel('Username').fill(username)
    await page.getByLabel('Email address').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page).toHaveURL(/\/chats$/)
    for (const width of [320, 375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
      const conversation = page.getByRole('region', { name: 'Conversation' })
      if (width < 768) await expect(conversation).toBeHidden()
      else await expect(conversation).toBeVisible()
    }
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('/chats/example')
    await expect(page.getByRole('heading', { name: 'Conversation unavailable' })).toBeVisible()
    await page.getByRole('link', { name: 'Back to chats' }).click()
    await expect(page).toHaveURL(/\/chats$/)
    await page.getByRole('link', { name: 'Transfers' }).click()
    await expect(page.getByRole('heading', { name: 'Transfers' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible()
  } finally {
    const headers = { Origin: baseURL! }
    const login = await request.post('/v1/auth/login', { headers, data: { email, password } })
    if (login.ok()) await request.delete('/v1/account', { headers, data: { password } })
  }
})

test('static shell opens offline and bypasses invite and account URLs', async ({ page, context }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.evaluate(async () => navigator.serviceWorker.ready.then(() => true))
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)

  const entries = await page.evaluate(async () => {
    const cachesToInspect = await caches.keys()
    return (await Promise.all(cachesToInspect.map(async key => (await (await caches.open(key)).keys()).map(request => request.url)))).flat()
  })
  expect(entries.some(url => url.includes('/assets/'))).toBeTruthy()
  expect(entries.some(url => /\/(v1|i|invite|verify)\//.test(url))).toBeFalsy()

  await context.setOffline(true)
  try {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    expect(await page.evaluate(() => fetch('/v1/account').then(() => false, () => true))).toBeTruthy()
    await expect(page.goto('/i/synthetic-invite')).rejects.toThrow()
  } finally {
    await context.setOffline(false)
  }
})
