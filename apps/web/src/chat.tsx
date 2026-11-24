import { useEffect, useState, type FormEvent } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Inbox, MessageCircle } from 'lucide-react'
import QRCode from 'qrcode'
import { api, ApiError, errorMessage, type Account } from './api'

type Conversation = { id: string; title: string; role: 'owner' | 'admin' | 'member'; kind: 'group' | 'direct' }
type Message = { sequence: number; clientId: string; senderId: string; sender: string; body: string; createdAt: string }
type Draft = { clientId: string; body: string }
type Invite = { id: string; expiresAt: string; maxUses: number; usedCount: number }

export function Chats({ account }: { account: Account }) {
  const { id } = useParams()
  const [groups, setGroups] = useState<Conversation[] | null>(null)
  const [newGroup, setNewGroup] = useState(false)
  const [joining, setJoining] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  useEffect(() => {
    let active = true
    api<Conversation[]>('/conversations').then(data => { if (active) setGroups(data) })
      .catch(error => { if (active) setError(errorMessage(error)) })
    return () => { active = false }
  }, [id])
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
    try {
      const link = new URL(value)
      if (link.origin !== location.origin || link.pathname !== '/i' || !inviteFragment.test(link.hash)) throw new Error()
      setJoining(false)
      navigate('/i' + link.hash)
    } catch { setError('Enter a valid FluxParcel invitation link from this server.') }
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
      {joining && <form className="action-form" onSubmit={openInvite}>
        <label>Invitation link<input name="link" type="url" required /></label>
        <button className="primary">Preview invitation</button>
      </form>}
      {error && <p role="alert" className="error">{error}</p>}
      {groups?.length === 0 && <div className="chat-list-empty"><Inbox size={20} aria-hidden /><div><strong>No conversations</strong><p>Your chats will appear here.</p></div></div>}
      <ul className="group-list">{groups?.map(group => <li key={group.id}>
        <NavLink to={'/chats/' + group.id}><MessageCircle size={19} aria-hidden />{group.title}</NavLink>
      </li>)}</ul>
    </aside>
    <section className={'conversation ' + (group ? 'open-conversation' : '')} aria-label="Conversation">
      {id && <Link className="mobile-back" to="/chats"><ArrowLeft size={18} aria-hidden /> Back to chats</Link>}
      {group ? <TextChat key={group.id} group={group} account={account} /> : <div className="empty-conversation">
        <div className="conversation-icon"><MessageCircle size={43} strokeWidth={1.5} aria-hidden /></div>
        <h2>{id ? (groups === null && !error ? 'Loading conversation…' : 'Conversation unavailable') : 'No conversation selected'}</h2>
        {id && <Link to="/chats" className="secondary">Open chats</Link>}
      </div>}
    </section>
  </div>
}

function TextChat({ group, account }: { group: Conversation; account: Account }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [attempt, setAttempt] = useState<Draft>()
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [showInvites, setShowInvites] = useState(false)
  const endpoint = '/conversations/' + group.id + '/messages'
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let after = 0
    let delay = 2000
    async function sync() {
      try {
        const page = await api<Message[]>(endpoint + '?after=' + after)
        if (!active) return
        if (page.length) {
          after = page[page.length - 1].sequence
          setMessages(current => [...current, ...page])
        }
        setSyncError('')
        delay = page.length === 100 ? 0 : 2000
      } catch (error) {
        if (!active) return
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setMessages([])
          setShowInvites(false)
          setUnavailable(true)
          setSyncError('This conversation is unavailable.')
          return
        }
        setSyncError('Connection interrupted. Retrying message synchronization.')
        delay = Math.min(30000, Math.max(2000, delay * 2))
      }
      if (active) timer = setTimeout(sync, delay + (delay ? Math.random() * 400 : 0))
    }
    void sync()
    return () => { active = false; clearTimeout(timer) }
  }, [endpoint])

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending || unavailable) return
    const pending = attempt ?? { clientId: crypto.randomUUID(), body: draft.trim() }
    if (!pending.body) return
    setAttempt(pending)
    setSending(true)
    setSendError('')
    try {
      await api<Message>(endpoint, 'POST', pending)
      setDraft('')
      setAttempt(undefined)
    } catch (error) { setSendError(errorMessage(error)) }
    finally { setSending(false) }
  }

  return <>
    <header className="group-heading"><h2>{group.title}</h2>
      {!unavailable && account.verified && group.kind === 'group' && group.role !== 'member' &&
        <button className="secondary" aria-expanded={showInvites} onClick={() => setShowInvites(!showInvites)}>Group invitations</button>}
    </header>
    {showInvites && <InvitationManager group={group} />}
    {syncError && <p role="status" className="muted">{syncError}</p>}
    <ol className="message-list" aria-label="Messages" aria-live="polite">
      {messages.map(message => <li className={message.senderId === account.id ? 'own-message' : ''} key={message.sequence}>
        <strong>{message.sender}</strong><p>{message.body}</p>
        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
      </li>)}
    </ol>
    {!unavailable && <form className="action-form composer" onSubmit={send}>
      <label>Message<input value={draft} maxLength={800} readOnly={Boolean(attempt)} onChange={event => setDraft(event.target.value)} /></label>
      {sendError && <p role="alert" className="error">{sendError}</p>}
      <div className="chat-actions">
        <button className="primary" disabled={sending || !draft.trim()}>{sending ? 'Sending…' : attempt ? 'Retry send' : 'Send'}</button>
        {attempt && !sending && <button className="secondary" type="button" onClick={() => {
          setAttempt(undefined); setDraft(''); setSendError('')
        }}>Discard retry</button>}
      </div>
    </form>}
  </>
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

export const inviteFragment = /^#(?:contact_)?[\w-]{43}$/

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
