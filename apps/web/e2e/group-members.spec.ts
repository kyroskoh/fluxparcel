import { expect, test, type APIRequestContext } from '@playwright/test'
import { deleteAccount, password, register, verifyEmail } from './chat-fixtures'

test('group roles gate member administration and removal blocks rejoining', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(60000)
  const origin = baseURL!
  const headers = { Origin: origin }
  const admin = await browser.newContext({ baseURL })
  const member = await browser.newContext({ baseURL })
  const outsider = await browser.newContext({ baseURL })
  const clients = [page.request, admin.request, member.request, outsider.request]
  try {
    const ownerEmail = await register(page.request, origin, 'Group Owner')
    const adminEmail = await register(admin.request, origin, 'Future Admin')
    await register(member.request, origin, 'Plain Member')
    await register(outsider.request, origin, 'Group Outsider')
    await verifyEmail(page.request, request, origin, ownerEmail)
    await verifyEmail(admin.request, request, origin, adminEmail)
    const id = async (client: APIRequestContext) => (await (await client.get('/v1/account')).json()).id as string
    const [ownerId, adminId, memberId] = await Promise.all([id(page.request), id(admin.request), id(member.request)])

    const group = await (await page.request.post('/v1/conversations', { headers, data: { title: 'Administered group' } })).json()
    const members = '/v1/conversations/' + group.id + '/members'
    const invite = async (client: APIRequestContext) => {
      const response = await client.post('/v1/invitations', { headers, data: { conversationId: group.id, maxUses: 10 } })
      expect(response.status()).toBe(201)
      return new URL((await response.json()).url).hash.slice(1)
    }
    const redeem = async (client: APIRequestContext, token: string) =>
      (await client.post('/v1/invitations/redeem', { headers, data: { token } })).status()
    const ownerInvite = await invite(page.request)
    expect(await redeem(admin.request, ownerInvite)).toBe(200)
    expect(await redeem(member.request, ownerInvite)).toBe(200)

    expect((await outsider.request.get(members)).status()).toBe(404)
    const listed = await (await member.request.get(members)).json()
    expect(listed.map((item: { role: string }) => item.role)).toEqual(['owner', 'member', 'member'])
    expect(listed[0]).toEqual({ userId: ownerId, displayName: 'Group Owner', role: 'owner' })

    const role = (client: APIRequestContext, target: string, value: string) =>
      client.patch(members + '/' + target, { headers, data: { role: value } }).then(response => response.status())
    const remove = (client: APIRequestContext, target: string) =>
      client.delete(members + '/' + target, { headers }).then(response => response.status())
    expect(await role(member.request, adminId, 'admin')).toBe(403)
    expect(await remove(member.request, adminId)).toBe(403)
    expect(await role(outsider.request, adminId, 'admin')).toBe(404)
    expect(await remove(outsider.request, memberId)).toBe(404)
    expect(await role(page.request, adminId, 'owner')).toBe(400)
    expect(await role(page.request, ownerId, 'member')).toBe(409)
    expect(await remove(page.request, ownerId)).toBe(409)

    expect(await role(page.request, adminId, 'admin')).toBe(200)
    const adminInvite = await invite(admin.request)
    expect(await role(admin.request, memberId, 'admin')).toBe(403)
    expect(await remove(admin.request, ownerId)).toBe(403)

    // The removed member's open chat closes, and no unexpired invitation lets them back in.
    const memberPage = await member.newPage()
    await memberPage.goto('/chats/' + group.id)
    await expect(memberPage.getByRole('heading', { name: 'Administered group' })).toBeVisible()
    await page.goto('/chats/' + group.id)
    await page.getByRole('button', { name: 'Members' }).click()
    const list = page.getByRole('list', { name: 'Group members' })
    const plain = list.getByRole('listitem').filter({ hasText: 'Plain Member' })
    await plain.getByRole('button', { name: 'Remove' }).click()
    await page.getByRole('button', { name: 'Confirm removal of Plain Member' }).click()
    await expect(page.getByText('Plain Member was removed.')).toBeVisible()
    await expect(plain).toHaveCount(0)
    await expect(memberPage.getByText('This conversation is unavailable.')).toBeVisible({ timeout: 20000 })
    expect((await member.request.get('/v1/conversations/' + group.id + '/messages')).status()).toBe(404)
    expect(await redeem(member.request, ownerInvite)).toBe(403)
    expect(await redeem(member.request, adminInvite)).toBe(403)

    // Demotion revokes the invitations the former admin issued; the owner's remain valid.
    await list.getByRole('listitem').filter({ hasText: 'Future Admin' }).getByRole('button', { name: 'Make member' }).click()
    await expect(page.getByText('Future Admin is now a member.')).toBeVisible()
    expect(await redeem(outsider.request, adminInvite)).toBe(404)
    expect(await remove(admin.request, ownerId)).toBe(403)

    // Leaving is voluntary, so it does not block rejoining.
    const adminPage = await admin.newPage()
    await adminPage.goto('/chats/' + group.id)
    await adminPage.getByRole('button', { name: 'Members' }).click()
    await adminPage.getByRole('button', { name: 'Leave group' }).click()
    await adminPage.getByRole('button', { name: 'Confirm leaving Administered group' }).click()
    await expect(adminPage).toHaveURL(/\/chats$/)
    await expect(adminPage.getByRole('link', { name: /Administered group/ })).toHaveCount(0)
    expect(await redeem(admin.request, ownerInvite)).toBe(200)
    expect(await redeem(outsider.request, ownerInvite)).toBe(200)
    expect((await (await page.request.get(members)).json()).map((item: { displayName: string }) => item.displayName))
      .toEqual(['Group Owner', 'Future Admin', 'Group Outsider'])
  } finally {
    await Promise.all(clients.map(client => client.delete('/v1/account', { headers, data: { password } })))
    await Promise.all([admin.close(), member.close(), outsider.close()])
  }
})

test('the owner hands a group to a member and can then leave', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(60000)
  const origin = baseURL!
  const headers = { Origin: origin }
  const heir = await browser.newContext({ baseURL })
  let ownerDeleted = false
  try {
    const ownerEmail = await register(page.request, origin, 'Departing Owner')
    await register(heir.request, origin, 'Group Heir')
    await verifyEmail(page.request, request, origin, ownerEmail)
    const id = async (client: APIRequestContext) => (await (await client.get('/v1/account')).json()).id as string
    const [ownerId, heirId] = await Promise.all([id(page.request), id(heir.request)])
    const group = await (await page.request.post('/v1/conversations', { headers, data: { title: 'Inherited group' } })).json()
    const invitation = await (await page.request.post('/v1/invitations', { headers, data: { conversationId: group.id } })).json()
    const token = new URL(invitation.url).hash.slice(1)
    expect((await heir.request.post('/v1/invitations/redeem', { headers, data: { token } })).status()).toBe(200)

    const members = '/v1/conversations/' + group.id + '/members'
    const transfer = (client: APIRequestContext, target: string) =>
      client.post(members + '/' + target + '/ownership', { headers }).then(response => response.status())
    expect(await transfer(heir.request, heirId)).toBe(403)
    expect(await transfer(page.request, ownerId)).toBe(409)
    expect(await transfer(page.request, '00000000-0000-4000-8000-000000000000')).toBe(404)

    await page.goto('/chats/' + group.id)
    await page.getByRole('button', { name: 'Members' }).click()
    await expect(page.getByText('Transfer ownership to another member before leaving this group.')).toBeVisible()
    const heirItem = page.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Group Heir' })
    await heirItem.getByRole('button', { name: 'Make owner' }).click()
    await page.getByRole('button', { name: 'Confirm transfer to Group Heir' }).click()
    await expect(page.getByText('Group Heir now owns this group. You are an admin.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Make owner' })).toHaveCount(0)
    const roles = (await (await heir.request.get(members)).json()).map((item: { displayName: string; role: string }) => [item.displayName, item.role])
    expect(roles).toEqual([['Group Heir', 'owner'], ['Departing Owner', 'admin']])
    expect(await transfer(page.request, heirId)).toBe(403)

    await page.getByRole('button', { name: 'Leave group' }).click()
    await page.getByRole('button', { name: 'Confirm leaving Inherited group' }).click()
    await expect(page).toHaveURL(/\/chats$/)
    // The group now belongs to the heir, so deleting the former owner's account keeps it.
    expect((await deleteAccount(page.request, origin)).status()).toBe(204)
    ownerDeleted = true
    expect((await heir.request.get('/v1/conversations/' + group.id + '/messages')).status()).toBe(200)
    expect((await (await heir.request.get(members)).json()).map((item: { role: string }) => item.role)).toEqual(['owner'])
  } finally {
    await Promise.all([heir.request, ...(ownerDeleted ? [] : [page.request])]
      .map(client => client.delete('/v1/account', { headers, data: { password } })))
    await heir.close()
  }
})
