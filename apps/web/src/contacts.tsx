import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, errorMessage, type Account } from './api'
import { InvitationManager } from './chat'

type ContactRequest = {
  id: string
  name: string
  incoming: boolean
  status: 'pending' | 'approved' | 'declined'
  conversationId: string
}

export function Contacts({ account }: { account: Account }) {
  const [requests, setRequests] = useState<ContactRequest[]>()
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  useEffect(() => {
    let active = true
    api<ContactRequest[]>('/contact-requests').then(result => { if (active) setRequests(result) })
      .catch(error => { if (active) setError(errorMessage(error)) })
    return () => { active = false }
  }, [refresh])

  async function decide(item: ContactRequest, decision: 'approve' | 'decline') {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ conversationId: string }>('/contact-requests/' + item.id + '/decision', 'POST', { decision })
      if (decision === 'approve') navigate('/chats/' + result.conversationId)
      else setRequests(current => current?.map(request => request.id === item.id ? { ...request, status: 'declined' } : request))
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }

  return <div className="settings-content">
    <h1>Contacts</h1>
    <section className="settings-card">
      <h2>Contact invitations</h2>
      {account.verified ? <InvitationManager /> : <p>Verify your email in <Link to="/settings" className="secondary">Settings</Link> to create an invitation.</p>}
    </section>
    <section className="settings-card">
      <h2>Contact requests</h2>
      <button className="secondary" onClick={() => { setError(''); setRefresh(current => current + 1) }}>Refresh requests</button>
      {error && <p role="alert" className="error">{error}</p>}
      {!requests && !error && <p role="status">Loading requests…</p>}
      {requests?.length === 0 && <p>No contact requests.</p>}
      <ul className="device-list">{requests?.map(item => <li key={item.id}>
        <div><strong>{item.name}</strong><small>{item.incoming ? 'Received' : 'Sent'} · {item.status}</small></div>
        {item.incoming && item.status === 'pending' && <div className="chat-actions">
          <button className="secondary" disabled={busy} onClick={() => decide(item, 'approve')}>Approve</button>
          <button className="secondary" disabled={busy} onClick={() => decide(item, 'decline')}>Decline</button>
        </div>}
        {item.conversationId && <Link className="secondary" to={'/chats/' + item.conversationId}>Open direct chat</Link>}
      </li>)}</ul>
    </section>
  </div>
}
