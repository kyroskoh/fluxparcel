import type { Outbox } from './use-outbox'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Inbox, MessageCircle } from 'lucide-react'
import QRCode from 'qrcode'
import { InviteScanner } from './invite-scanner'
import { invitePath } from './invite-link'
import { api, ApiError, errorMessage, type Account } from './api'

type Conversation = { id: string; title: string; role: 'owner' | 'admin' | 'member'; kind: 'group' | 'direct'; unread: number }
type Message = { sequence: number; clientId: string; senderId: string; sender: string; body: string; createdAt: string }
type Receipts = { sharing: boolean; readers: { userId: string; displayName: string; sequence: number }[] }
type Member = { userId: string; displayName: string; role: Conversation['role'] }
type Invite = { id: string; expiresAt: string; maxUses: number; usedCount: number }

export function Chats({ account, outbox }: { account: Account; outbox: Outbox }) {
  const { id } = useParams()
  const [groups, setGroups] = useState<Conversation[] | null>(null)
  const [listRevision, setListRevision] = useState(0)
  const onRead = useCallback(() => setListRevision(current => current + 1), [])
  const [newGroup, setNewGroup] = useState(false)
  const [joining, setJoining] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let first = true
    async function refresh() {
      try {
        const data = await api<Conversation[]>('/conversations')
        if (active) setGroups(data)
      } catch (error) {
        if (active && first) setError(errorMessage(error))
      } finally {
        first = false
        if (active) timer = setTimeout(refresh, 10000)
      }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [id, listRevision])
  const group = groups?.find(group => group.id === id)
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api<Conversation>('/conversations', 'POST', Object.fromEntries(new FormData(event.currentTarget)))
      setGroups(groups => [result, ...(groups ?? []).filter(group => group.id !== result.id)])
      setNewGroup(false)
      navigate('/chats/' + result.id)
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }

  function openInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('link')).trim()
    const path = invitePath(value, window.location.origin)
    if (!path) {
      setError('Enter a valid FluxParcel invitation link from this server.')
      return
    }
    previewInvite(path)
  }

  function previewInvite(path: string) {
    setJoining(false)
    setError('')
    navigate(path)
  }

  return <div className={'chat-layout ' + (id ? 'chat-direct' : '')}>
    <aside className="chat-sidebar">
      <header><h1>Chats</h1><div className="chat-actions">
        <button className="secondary" aria-expanded={newGroup} onClick={() => { setNewGroup(!newGroup); setJoining(false); setError('') }}>New group</button>
        <Link className="secondary" to="/contacts">Contacts</Link>
        <button className="secondary" aria-expanded={joining} onClick={() => { setJoining(!joining); setNewGroup(false); setError('') }}>Open invite</button>
      </div></header>
      {newGroup && <form className="action-form" onSubmit={create}>
        <label>Group name<input name="title" required maxLength={80} /></label>
        <button className="primary" disabled={busy}>Create group</button>
      </form>}
      {joining && <>
        <InviteScanner onPreview={previewInvite} />
        <form className="action-form" onSubmit={openInvite}>
          <label>Invitation link<input name="link" type="url" required /></label>
          <button className="primary">Preview invitation</button>
        </form>
      </>}
      {error && <p role="alert" className="error">{error}</p>}
      {groups?.length === 0 && <div className="chat-list-empty"><Inbox size={20} aria-hidden /><div><strong>No conversations</strong><p>Your chats will appear here.</p></div></div>}
      <ul className="group-list">{groups?.map(group => <li key={group.id}>
        <NavLink to={'/chats/' + group.id}>
          <MessageCircle size={19} aria-hidden /><span className="chat-list-title">{group.title}</span>
          {group.unread > 0 && <span className="unread-badge" aria-label={group.unread === 1 ? '1 unread message' : group.unread + ' unread messages'}>
            {group.unread}
          </span>}
        </NavLink>
      </li>)}</ul>
    </aside>
    <section className={'conversation ' + (group ? 'open-conversation' : '')} aria-label="Conversation">
      {id && <Link className="mobile-back" to="/chats"><ArrowLeft size={18} aria-hidden /> Back to chats</Link>}
      {group ? <TextChat key={group.id} group={group} account={account} outbox={outbox} onRead={onRead} /> : <div className="empty-conversation">
        <div className="conversation-icon"><MessageCircle size={43} strokeWidth={1.5} aria-hidden /></div>
        <h2>{id ? (groups === null && !error ? 'Loading conversation…' : 'Conversation unavailable') : 'No conversation selected'}</h2>
        {id && <Link to="/chats" className="secondary">Open chats</Link>}
      </div>}
    </section>
  </div>
}

function markerInView(marker: HTMLElement, list: HTMLElement) {
  const bounds = marker.getBoundingClientRect()
  const viewport = list.getBoundingClientRect()
  return bounds.height > 0 && viewport.height > 0 && bounds.top >= Math.max(0, viewport.top) && bounds.bottom <= Math.min(window.innerHeight, viewport.bottom)
}

function TextChat({ group, account, outbox, onRead }: { group: Conversation; account: Account; outbox: Outbox; onRead: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [showInvites, setShowInvites] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [receipts, setReceipts] = useState<Receipts>({ sharing: false, readers: [] })
  const [syncRevision, setSyncRevision] = useState(0)
  const conversationPath = '/conversations/' + group.id
  const endpoint = conversationPath + '/messages'
  const marker = useRef<HTMLLIElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const acknowledged = useRef(0)
  const [markerVisible, setMarkerVisible] = useState(false)
  const [tabVisible, setTabVisible] = useState(document.visibilityState === 'visible')
  const latestSequence = messages.at(-1)?.sequence ?? 0
  const hasMessages = latestSequence > 0
  useEffect(() => {
    const node = marker.current
    if (!node || !hasMessages) return
    const observer = typeof IntersectionObserver === 'undefined' ? undefined
      : new IntersectionObserver(([entry]) => setMarkerVisible(entry.intersectionRatio === 1), { threshold: 1 })
    const measure = () => {
      setMarkerVisible(Boolean(list.current && markerInView(node, list.current)))
    }
    if (observer) observer.observe(node)
    else {
      window.addEventListener('scroll', measure, true)
      window.addEventListener('resize', measure)
      measure()
    }
    const visibility = () => setTabVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', visibility)
    visibility()
    return () => {
      observer?.disconnect()
      if (!observer) {
        window.removeEventListener('scroll', measure, true)
        window.removeEventListener('resize', measure)
      }
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [hasMessages])

  useEffect(() => {
    if (!markerVisible || !tabVisible || latestSequence <= acknowledged.current) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function markRead() {
      if (!active || !marker.current || !list.current || document.visibilityState !== 'visible') return
      if (!markerInView(marker.current, list.current)) return
      try {
        const response = await api<{ sequence: number }>(conversationPath + '/read', 'POST', { sequence: latestSequence, expectedAccountId: account.id })
        if (active) {
          acknowledged.current = Math.max(acknowledged.current, response.sequence)
          onRead()
        }
      } catch (error) {
        if (active && !(error instanceof ApiError && [400, 401, 403, 404].includes(error.status))) {
          timer = setTimeout(markRead, 3000 + Math.random() * 400)
        }
      }
    }
    void markRead()
    return () => { active = false; clearTimeout(timer) }
  }, [account.id, conversationPath, latestSequence, markerVisible, onRead, tabVisible])

  useEffect(() => {
    let active = true
    let syncTimer: ReturnType<typeof setTimeout>
    let reconnectTimer: ReturnType<typeof setTimeout>
    let socket: WebSocket | undefined
    let after = 0
    let syncing = false
    let requested = false
    let retry = 2000
    let reconnect = 1000
    const jitter = () => Math.random() * 400

    function disconnect() {
      const current = socket
      socket = undefined
      current?.close()
    }

    async function sync() {
      if (!active) return
      if (syncing) {
        requested = true
        return
      }
      clearTimeout(syncTimer)
      syncing = true
      let next = 0
      try {
        if (!navigator.onLine) throw new Error('Offline')
        const page = await api<Message[]>(endpoint + '?after=' + after)
        if (!active) return
        if (page.length) {
          after = page[page.length - 1].sequence
          setMessages(current => [...current, ...page])
        }
        setSyncError('')
        setSyncRevision(current => current + 1)
        retry = 2000
        if (page.length < 100) next = socket && socket.readyState === WebSocket.OPEN ? 15000 : 2000
      } catch (error) {
        if (!active) return
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          active = false
          disconnect()
          clearTimeout(reconnectTimer)
          setMessages([])
          setShowInvites(false)
          setShowMembers(false)
          setUnavailable(true)
          setSyncError('This conversation is unavailable.')
          return
        }
        setSyncError('Connection interrupted. Retrying message synchronization.')
        next = retry
        retry = Math.min(30000, retry * 2)
      } finally {
        syncing = false
        if (active) syncTimer = setTimeout(sync, requested || next === 0 ? 0 : next + jitter())
        requested = false
      }
    }

    function connect() {
      clearTimeout(reconnectTimer)
      if (!active || socket || !navigator.onLine || typeof WebSocket === 'undefined') return
      const url = new URL('/v1/events', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('conversationId', group.id)
      const schedule = () => {
        reconnectTimer = setTimeout(connect, reconnect + jitter())
        reconnect = Math.min(30000, reconnect * 2)
      }
      try {
        const connection = new WebSocket(url)
        socket = connection
        connection.onopen = () => {
          if (socket !== connection) return
          reconnect = 1000
          void sync()
        }
        connection.onmessage = event => {
          if (socket === connection && event.data === 'messages.changed') void sync()
        }
        connection.onclose = () => {
          if (!active || socket !== connection) return
          socket = undefined
          void sync()
          if (navigator.onLine) schedule()
        }
      } catch {
        schedule()
      }
    }

    function online() {
      reconnect = 1000
      connect()
      void sync()
    }

    function offline() {
      clearTimeout(reconnectTimer)
      disconnect()
      void sync()
    }

    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    connect()
    void sync()
    return () => {
      active = false
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      disconnect()
      clearTimeout(syncTimer)
      clearTimeout(reconnectTimer)
    }
  }, [endpoint, group.id])

  useEffect(() => {
    if (unavailable || syncRevision === 0) return
    const controller = new AbortController()
    // The server applies both accounts' sharing preferences; a failed refresh keeps the last known receipts.
    api<Receipts>(conversationPath + '/receipts', 'GET', undefined, true, controller.signal)
      .then(result => { if (!controller.signal.aborted) setReceipts(result) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [account.shareReadReceipts, conversationPath, syncRevision, unavailable])

  function receiptLabel(sequence: number) {
    if (!receipts.sharing || !account.shareReadReceipts) return ''
    const readers = receipts.readers.filter(reader => reader.sequence >= sequence).length
    if (readers === 0) return 'Sent'
    return group.kind === 'direct' ? 'Read' : 'Read by ' + readers
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending || unavailable) return
    const body = draft.trim()
    if (!body) return
    setSending(true)
    setSendError('')
    try {
      await outbox.enqueue(group.id, body)
      setDraft(current => current === draft ? '' : current)
    } catch {
      setSendError('Could not save the message to the local queue. Your draft is still here.')
    } finally { setSending(false) }
  }

  const pending = outbox.messages.filter(item => item.conversationId === group.id
    && !messages.some(message => message.senderId === account.id && message.clientId === item.clientId))

  return <>
    <header className="group-heading"><h2>{group.title}</h2>
      {!unavailable && group.kind === 'group' && <div className="chat-actions">
        <button className="secondary" aria-expanded={showMembers} onClick={() => setShowMembers(!showMembers)}>Members</button>
        {account.verified && group.role !== 'member' &&
          <button className="secondary" aria-expanded={showInvites} onClick={() => setShowInvites(!showInvites)}>Group invitations</button>}
      </div>}
    </header>
    {showMembers && !unavailable && <MemberManager group={group} account={account} refresh={syncRevision} onChanged={onRead} />}
    {showInvites && !unavailable && <InvitationManager group={group} />}
    {syncError && <p role="status" className="muted">{syncError}</p>}
    <ol ref={list} className="message-list" aria-label="Messages" aria-live="polite">
      {messages.map(message => <li className={message.senderId === account.id ? 'own-message' : ''} key={message.sequence}>
        <strong>{message.sender}</strong><p>{message.body}</p>
        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
        {message.senderId === account.id && receiptLabel(message.sequence) && <small className="receipt">{receiptLabel(message.sequence)}</small>}
      </li>)}
      {hasMessages && <li ref={marker} className="read-marker" aria-hidden="true" />}
      {pending.map(item => <li className="own-message" key={item.clientId}>
        <p>{item.body}</p>
        <small>{item.failure ? 'Failed: ' + item.failure : 'Queued'}</small>
        {item.failure && <div className="chat-actions">
          <button className="secondary" type="button" onClick={() => {
            void outbox.retry(item).catch(() => setSendError('Could not retry the queued message.'))
          }}>Retry send</button>
          <button className="secondary" type="button" onClick={() => {
            void outbox.discard(item).catch(() => setSendError('Could not discard the queued message.'))
          }}>Discard</button>
        </div>}
      </li>)}
    </ol>
    {sendError && <p role="alert" className="error">{sendError}</p>}
    {!unavailable && <form className="action-form composer" onSubmit={send}>
      <label>Message<input value={draft} maxLength={800} onChange={event => setDraft(event.target.value)} /></label>
      <div className="chat-actions">
        <button className="primary" disabled={sending || !draft.trim()}>{sending ? 'Saving…' : 'Send'}</button>
      </div>
    </form>}
  </>
}

const roleNames: Record<Member['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

function MemberManager({ group, account, refresh, onChanged }: { group: Conversation; account: Account; refresh: number; onChanged: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null)
  const [confirming, setConfirming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const navigate = useNavigate()
  const endpoint = '/conversations/' + group.id + '/members'
  useEffect(() => {
    const controller = new AbortController()
    api<Member[]>(endpoint, 'GET', undefined, true, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setMembers(result)
      // Pick up a role change made by the owner on another device.
      if (result.find(item => item.userId === account.id)?.role !== group.role) onChanged()
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
    return () => controller.abort()
  }, [account.id, endpoint, group.role, onChanged, refresh])

  async function change(target: Member, action: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await action()
      setConfirming('')
      if (target.userId === account.id) {
        onChanged()
        navigate('/chats', { replace: true })
        return
      }
      setMembers(await api<Member[]>(endpoint))
      setNotice(done)
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }

  const canRemove = (target: Member) => target.userId !== account.id && target.role !== 'owner'
    && (group.role === 'owner' || (group.role === 'admin' && target.role === 'member'))
  const self = members?.find(item => item.userId === account.id)
  return <div className="settings-card member-panel">
    <h3>Members{members ? ' (' + members.length + ')' : ''}</h3>
    {!members && !error && <p role="status">Loading members…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <ul className="device-list" aria-label="Group members">{members?.map(item => <li key={item.userId}>
      <div><strong>{item.displayName}{item.userId === account.id ? ' (you)' : ''}</strong><small>{roleNames[item.role]}</small></div>
      <div className="chat-actions">
        {group.role === 'owner' && item.role !== 'owner' && <button className="secondary" type="button" disabled={busy} onClick={() => {
          const role = item.role === 'admin' ? 'member' : 'admin'
          void change(item, () => api(endpoint + '/' + item.userId, 'PATCH', { role }),
            item.displayName + (role === 'admin' ? ' is now an admin.' : ' is now a member.'))
        }}>{item.role === 'admin' ? 'Make member' : 'Make admin'}</button>}
        {canRemove(item) && (confirming === item.userId ? <>
          <button className="primary" type="button" disabled={busy} onClick={() => {
            void change(item, () => api(endpoint + '/' + item.userId, 'DELETE'), item.displayName + ' was removed.')
          }}>Confirm removal of {item.displayName}</button>
          <button className="secondary" type="button" onClick={() => setConfirming('')}>Cancel</button>
        </> : <button className="secondary" type="button" disabled={busy} onClick={() => setConfirming(item.userId)}>Remove</button>)}
      </div>
    </li>)}</ul>
    {self && self.role !== 'owner' && (confirming === account.id ? <div className="chat-actions">
      <button className="primary" type="button" disabled={busy} onClick={() => {
        void change(self, () => api(endpoint + '/' + account.id, 'DELETE'), '')
      }}>Confirm leaving {group.title}</button>
      <button className="secondary" type="button" onClick={() => setConfirming('')}>Cancel</button>
    </div> : <button className="secondary" type="button" disabled={busy} onClick={() => setConfirming(account.id)}>Leave group</button>)}
    {self?.role === 'owner' && <p className="muted">As the owner, you cannot leave this group.</p>}
  </div>
}

export function InvitationManager({ group }: { group?: Conversation }) {
  const [invites, setInvites] = useState<Invite[]>([])
  const [link, setLink] = useState('')
  const [linkId, setLinkId] = useState('')
  const [qr, setQR] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const collection = group ? '/invitations' : '/contact-invitations'
  const endpoint = group ? '/conversations/' + group.id + '/invitations' : collection
  useEffect(() => {
    let active = true
    api<Invite[]>(endpoint).then(result => { if (active) setInvites(result) })
      .catch(error => { if (active) setError(errorMessage(error)) })
    return () => { active = false }
  }, [endpoint])

  return <div className="settings-card invite-panel">
    <form className="action-form" onSubmit={async event => {
      event.preventDefault()
      if (busy) return
      const data = new FormData(event.currentTarget)
      setBusy(true); setError(''); setNotice(''); setLink(''); setQR('')
      try {
        const result = await api<{ url: string; id: string }>(collection, 'POST', {
          maxUses: Number(data.get('uses')),
          ...(group
            ? { conversationId: group.id, expiresHours: Number(data.get('expiry')) }
            : { expiresMinutes: Number(data.get('expiry')) }),
        })
        setLink(result.url)
        setLinkId(result.id)
        setInvites(await api<Invite[]>(endpoint))
        setQR(await QRCode.toDataURL(result.url, { width: 224, margin: 3 }))
      } catch (error) { setError(errorMessage(error)) }
      finally { setBusy(false) }
    }}>
      <label>Maximum uses<input name="uses" type="number" min={1} max={group ? 100 : 20} defaultValue={1} required /></label>
      <label>Expires in {group ? 'hours' : 'minutes'}<input name="expiry" type="number" min={1} max={group ? 24 : 60} defaultValue={group ? 24 : 15} required /></label>
      <button className="primary" disabled={busy}>Create invitation</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {link && <div className="action-form">
      <label>Share link<input readOnly value={link} onFocus={event => event.currentTarget.select()} /></label>
      <button className="secondary" type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(link); setNotice('Link copied.') }
        catch { setNotice('Select and copy the link from the field above.') }
      }}>Copy link</button>
      {qr && <><img src={qr} alt={group ? "QR code for this group invitation" : "QR code for this contact invitation"} width={224} height={224} />
        <a className="secondary" href={qr} download="fluxparcel-invitation.png">Download QR</a></>}
    </div>}
    <ul className="device-list">{invites.map(invite => <li key={invite.id}>
      <span>{invite.usedCount}/{invite.maxUses} used · {new Date(invite.expiresAt).toLocaleString()}</span>
      <button className="secondary" type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); setNotice('')
        try {
          await api(collection + '/' + invite.id, 'DELETE')
          setInvites(current => current.filter(item => item.id !== invite.id))
          if (invite.id === linkId) { setLink(''); setQR('') }
          setNotice('Invitation revoked.')
        } catch (error) { setError(errorMessage(error)) }
        finally { setBusy(false) }
      }}>Revoke invitation</button>
    </li>)}</ul>
  </div>
}

export function InviteReview({ token, account, authenticated }: { token: string; account: Account | null; authenticated: boolean }) {
  const [preview, setPreview] = useState<{ title: string; issuer: string; expiresAt: string }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const [requested, setRequested] = useState(false)
  const contact = token.startsWith('contact_')
  const endpoint = contact ? '/contact-invitations' : '/invitations'
  const secret = contact ? token.slice('contact_'.length) : token
  useEffect(() => {
    if (!account || !secret) return
    let active = true
    api<NonNullable<typeof preview>>(endpoint + '/inspect', 'POST', { token: secret })
      .then(result => { if (active) setPreview(result) })
      .catch(error => { if (active) setError(errorMessage(error)) })
    return () => { active = false }
  }, [account, endpoint, secret])
  return <main className="standalone"><section className="settings-card">
    <h1>{contact ? 'Contact invitation' : 'Group invitation'}</h1>
    {!token && <p>Open a valid FluxParcel invitation link.</p>}
    {token && !authenticated && <p role="status">Checking your session…</p>}
    {token && authenticated && !account && <Link state={{ returnTo: '/i' }} to="/login">Sign in to preview</Link>}
    {token && account && !preview && !error && <p role="status">Loading invitation…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {requested && <p role="status">Request sent. The issuer must approve it before a direct chat opens.</p>}
    {preview && !requested && <>
      <p><strong>{preview.issuer}</strong>{contact ? ' shared a contact invitation with you.' : <> invited you to <strong>{preview.title}</strong>.</>}</p>
      <p>Expires {new Date(preview.expiresAt).toLocaleString()}.</p>
      <button className="primary" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try {
          if (contact) {
            await api(endpoint + '/redeem', 'POST', { token: secret })
            setRequested(true)
          } else {
            const result = await api<{ conversationId: string }>(endpoint + '/redeem', 'POST', { token: secret })
            navigate('/chats/' + result.conversationId, { replace: true })
          }
        } catch (error) { setError(errorMessage(error)); setBusy(false) }
      }}>{contact ? 'Send contact request' : 'Accept invitation'}</button>
    </>}
    <p><Link to="/chats">Open chats</Link></p>
  </section></main>
}
