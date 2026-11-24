import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { password, register, verifyEmail } from './chat-fixtures'

test('senders edit and delete messages, moderators delete, and every device converges', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(60000)
  const origin = baseURL!
  const headers = { Origin: origin }
  const member = await browser.newContext({ baseURL })
  const outsider = await browser.newContext({ baseURL })
  const clients = [page.request, member.request, outsider.request]
  try {
    const ownerEmail = await register(page.request, origin, 'Edit Owner')
    await register(member.request, origin, 'Edit Member')
    await register(outsider.request, origin, 'Edit Outsider')
    await verifyEmail(page.request, request, origin, ownerEmail)
    const group = await (await page.request.post('/v1/conversations', { headers, data: { title: 'Edited group' } })).json()
    const base = '/v1/conversations/' + group.id + '/messages'
    const invite = await page.request.post('/v1/invitations', { headers, data: { conversationId: group.id, maxUses: 2 } })
    expect(invite.status()).toBe(201)
    const token = new URL((await invite.json()).url).hash.slice(1)
    expect((await member.request.post('/v1/invitations/redeem', { headers, data: { token } })).status()).toBe(200)

    const send = async (client: APIRequestContext, body: string, clientId = randomUUID()) => {
      const response = await client.post(base, { headers, data: { clientId, body } })
      expect([200, 201]).toContain(response.status())
      return { ...(await response.json()), clientId }
    }
    const edit = (client: APIRequestContext, sequence: number, data: object) =>
      client.patch(base + '/' + sequence, { headers, data })
    const remove = (client: APIRequestContext, sequence: number) => client.delete(base + '/' + sequence, { headers })

    const original = await send(member.request, 'Original member text')
    expect((await edit(outsider.request, original.sequence, { body: 'Hijacked' })).status()).toBe(404)
    expect((await edit(page.request, original.sequence, { body: 'Owner rewrite' })).status()).toBe(403)
    expect((await edit(member.request, original.sequence, { body: '   ' })).status()).toBe(400)
    expect((await edit(member.request, 9999, { body: 'Missing' })).status()).toBe(404)

    const edited = await edit(member.request, original.sequence, { body: 'Edited member text', expectedVersion: original.version })
    expect(edited.status()).toBe(200)
    const editedMessage = await edited.json()
    expect(editedMessage).toMatchObject({ sequence: original.sequence, body: 'Edited member text' })
    expect(editedMessage.version).toBeGreaterThan(original.version)
    expect(editedMessage.editedAt).toBeTruthy()
    // A retried edit is idempotent, and an edit based on a stale copy is rejected.
    const retried = await (await edit(member.request, original.sequence, { body: 'Edited member text', expectedVersion: editedMessage.version })).json()
    expect(retried.version).toBe(editedMessage.version)
    expect((await edit(member.request, original.sequence, { body: 'Stale rewrite', expectedVersion: original.version })).status()).toBe(409)
    // An outbox retry of the original send still succeeds after the edit.
    const resend = await send(member.request, 'Original member text', original.clientId)
    expect(resend).toMatchObject({ sequence: original.sequence, body: 'Edited member text' })

    const changes = await (await member.request.get(base + '?changedSince=' + original.version)).json()
    expect(changes.map((item: { sequence: number }) => item.sequence)).toEqual([original.sequence])
    expect((await member.request.get(base + '?after=0&changedSince=0')).status()).toBe(400)

    // The owner's open chat receives the edit without reloading.
    await page.goto('/chats/' + group.id)
    const memberItem = page.getByRole('listitem').filter({ hasText: 'Edit Member' })
    await expect(memberItem.getByText('Edited member text')).toBeVisible()
    await expect(memberItem.getByText('Edited', { exact: true })).toBeVisible()
    const second = await send(member.request, 'Second member text')
    await expect(page.getByText('Second member text')).toBeVisible()
    await edit(member.request, second.sequence, { body: 'Second text, edited live' })
    await expect(page.getByText('Second text, edited live')).toBeVisible({ timeout: 20000 })

    // The owner edits and deletes their own message in the browser.
    await page.getByLabel('Message', { exact: true }).fill('Owner draft message')
    await page.getByRole('button', { name: 'Send' }).click()
    const ownItem = page.getByRole('listitem').filter({ hasText: 'Owner draft message' })
    await ownItem.getByRole('button', { name: 'Edit' }).click()
    // The message text becomes an input while editing, so address the open form directly.
    const editor = page.getByLabel('Edit message')
    await expect(editor).toHaveValue('Owner draft message')
    await editor.fill('Owner final message')
    await page.getByRole('button', { name: 'Save' }).click()
    const finalItem = page.getByRole('listitem').filter({ hasText: 'Owner final message' })
    await expect(finalItem.getByText('Edited', { exact: true })).toBeVisible()

    // A group owner moderates the member's message; the member's open chat converges.
    const memberPage = await member.newPage()
    await memberPage.goto('/chats/' + group.id)
    await expect(memberPage.getByText('Edited member text')).toBeVisible()
    await memberItem.filter({ hasText: 'Edited member text' }).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(page.getByText('Edited member text')).toHaveCount(0)
    await expect(memberPage.getByText('Edited member text')).toHaveCount(0, { timeout: 20000 })
    await expect(memberPage.getByText('Message deleted')).toBeVisible()
    expect((await remove(member.request, original.sequence)).status()).toBe(204)
    expect((await edit(member.request, original.sequence, { body: 'Back again' })).status()).toBe(409)
    const [stored] = await (await member.request.get(base + '?after=' + (original.sequence - 1))).json()
    expect(stored.body).toBe('')
    expect(stored.deletedAt).toBeTruthy()

    // Members cannot delete other people's messages; the sender can delete their own.
    const ownerMessage = await send(page.request, 'Owner announcement')
    expect((await remove(member.request, ownerMessage.sequence)).status()).toBe(403)
    expect((await remove(outsider.request, ownerMessage.sequence)).status()).toBe(404)
    expect((await remove(page.request, ownerMessage.sequence)).status()).toBe(204)
  } finally {
    await Promise.all(clients.map(client => client.delete('/v1/account', { headers, data: { password } })))
    await Promise.all([member.close(), outsider.close()])
  }
})
