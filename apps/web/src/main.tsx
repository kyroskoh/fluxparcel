import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowDownUp, ArrowRight, CircleHelp, LockKeyhole, LogOut, Mail, MessageCircle, Moon, Settings as Gear, Sun, UserRound } from 'lucide-react'
import { api, ApiError, errorMessage, type Account, type Device } from './api'
import { Chats, InviteReview } from './chat'
import { inviteFragment } from './invite-link'
import { Contacts } from './contacts'
import './style.css'

function Brand() {
  return <div className="brand"><img className="brand-mark" src="/logo.svg" alt="" width="38" height="38" /><span>Flux<span className="brand-accent">Parcel</span></span></div>
}

function ActionForm({ children, label, action }: {
  children?: ReactNode
  label: string
  action: (values: FormData) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const data = new FormData(event.currentTarget)
    setPending(true)
    setError('')
    try { await action(data) }
    catch (error) { setError(errorMessage(error)) }
    finally { setPending(false) }
  }
  return <form className="action-form" onSubmit={submit}>
    {children}
    {error && <p role="alert" className="error">{error}</p>}
    <button className="primary" disabled={pending}>{pending ? 'Working…' : label}<ArrowRight size={17} aria-hidden /></button>
  </form>
}

function AuthScreen({ register, onAccount }: { register: boolean; onAccount: (account: Account) => void }) {
  const location = useLocation()
  return <main className="auth-layout">
    <aside className="auth-aside">
      <Brand />
      <div className="auth-illustration" aria-hidden>
        <div className="orbit orbit-outer" /><div className="orbit orbit-inner" />
        <span className="orbit-icon"><MessageCircle size={58} strokeWidth={1.35} /></span>
        <span className="orbit-small orbit-lock"><LockKeyhole size={23} /></span>
        <span className="orbit-small orbit-file"><ArrowDownUp size={22} /></span>
        <span className="orbit-dot" />
      </div>
      <div className="auth-aside-copy">
        <h2>Connect.<br />Transfer. Discover.</h2>
        <p>FluxParcel is a self-hosted workspace for conversations and file sharing.</p>
      </div>
    </aside>
    <section className="auth-main">
      <div className="auth-card">
        <div className="mobile-brand"><Brand /></div>
        <div className="section-icon"><UserRound size={23} aria-hidden /></div>
        <h1>{register ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted">{register ? 'Set up your FluxParcel profile to get started.' : 'Sign in to your FluxParcel workspace.'}</p>
        <ActionForm key={String(register)} label={register ? 'Create account' : 'Sign in'} action={async data => {
          const account = await api<Account>(register ? '/auth/register' : '/auth/login', 'POST', Object.fromEntries(data), false)
          onAccount(account)
        }}>
          {register && <>
            <label>Display name<input name="displayName" autoComplete="name" maxLength={80} required /></label>
            <label>Username<input name="username" autoComplete="username" pattern="[A-Za-z0-9_]{3,32}" title="3–32 letters, digits or underscores" required /></label>
          </>}
          <label>Email address<input name="email" type="email" autoComplete={register ? 'email' : 'username'} placeholder="you@example.com" required /></label>
          <label>Password<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 12 : undefined} required /></label>
          {register && <p className="field-hint">Use at least 12 characters.</p>}
        </ActionForm>
        <p className="auth-switch">{register ? 'Already have an account?' : 'New to FluxParcel?'} <Link state={location.state} to={register ? '/login' : '/register'}>{register ? 'Sign in' : 'Create an account'}</Link></p>
      </div>
    </section>
  </main>
}

function VerifyEmail({ reload }: { reload: () => Promise<void> }) {
  const [token] = useState(() => window.location.hash.slice(1))
  const [done, setDone] = useState(false)
  useEffect(() => {
    window.history.replaceState(window.history.state, '', '/verify')
  }, [])
  return <main className="standalone"><section className="settings-card">
    <Brand />
    <h1>Verify your email</h1>
    {done ? <p role="status">Email verified. <Link to="/chats">Continue to FluxParcel</Link></p>
      : token ? <ActionForm label="Verify email" action={async () => {
        await api('/auth/verify', 'POST', { token }, false)
        setDone(true)
        await reload()
      }} /> : <p>Open the link in your verification email. <Link to="/settings">Account settings</Link></p>}
  </section></main>
}

function Settings({ account, onAccount, signOut }: {
  account: Account
  onAccount: (account: Account) => void
  signOut: () => void
}) {
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceError, setDeviceError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    api<Device[]>('/account/devices').then(result => { if (active) setDevices(result) })
      .catch(error => { if (active) setDeviceError(errorMessage(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  return <div className="settings-content">
    <header className="page-heading"><span className="section-icon"><Gear size={23} aria-hidden /></span><h1>Settings</h1></header>
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="settings-card">
      <h2>Profile</h2>
      <p className="muted">@{account.username} · {account.email}</p>
      <ActionForm label="Save profile" action={async data => {
        onAccount(await api<Account>('/account', 'PATCH', Object.fromEntries(data)))
        setNotice('Profile saved.')
      }}>
        <label>Display name<input name="displayName" defaultValue={account.displayName} maxLength={80} required /></label>
      </ActionForm>
    </section>
    <section className="settings-card">
      <h2>Email verification</h2>
      {account.verified ? <p className="muted">Email verified</p> : <>
        <p className="muted">Open the link sent to your email address to verify your account.</p>
        <ActionForm label="Resend verification email" action={async () => {
          await api('/auth/verification', 'POST')
          setNotice('Verification email sent.')
        }} />
      </>}
    </section>
    <section className="settings-card">
      <h2>Device sessions</h2>
      {deviceError && <p role="alert" className="error">{deviceError}</p>}
      {loading && <p role="status">Loading sessions…</p>}
      <ul className="device-list">
        {devices.map(device => <li key={device.id}>
          <div><strong>{device.current ? 'This session' : 'Other session'}</strong><small>Signed in {new Date(device.createdAt).toLocaleString()}</small></div>
          {!device.current && <button className="secondary" onClick={async () => {
            setDeviceError('')
            try {
              await api('/account/devices/' + device.id, 'DELETE')
              setDevices(current => current.filter(item => item.id !== device.id))
              setNotice('Session revoked.')
            } catch (error) { setDeviceError(errorMessage(error)) }
          }}>Revoke</button>}
        </li>)}
      </ul>
    </section>
    <section className="settings-card">
      <h2>Delete account</h2>
      <p className="muted">Permanently delete your account and sign out all devices.</p>
      <ActionForm label="Permanently delete account" action={async data => {
        await api('/account', 'DELETE', Object.fromEntries(data))
        signOut()
      }}>
        <label>Confirm password<input name="password" type="password" autoComplete="current-password" required /></label>
      </ActionForm>
    </section>
  </div>
}

function Workspace({ account, onAccount, signOut }: { account: Account; onAccount: (user: Account) => void; signOut: () => void }) {
  const [offline, setOffline] = useState(!navigator.onLine)
  const [dark, setDark] = useState(() => localStorage.getItem('fluxparcel-theme') === 'dark'
    || (!localStorage.getItem('fluxparcel-theme') && matchMedia('(prefers-color-scheme: dark)').matches))
  const [error, setError] = useState('')
  const location = useLocation()
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  return <div className="workspace">
    <a className="skip-link" href="#content">Skip to content</a>
    <header className="topbar">
      <Brand />
      <div className="top-actions">
        <button className="icon-button" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => {
          localStorage.setItem('fluxparcel-theme', dark ? 'light' : 'dark')
          setDark(!dark)
        }}>{dark ? <Sun size={19} aria-hidden /> : <Moon size={19} aria-hidden />}</button>
        <Link className="avatar" to="/settings" aria-label="Account settings">{Array.from(account.displayName)[0]?.toLocaleUpperCase()}</Link>
      </div>
    </header>
    {offline && <p className="banner" role="status"><CircleHelp size={17} aria-hidden /> You’re offline. Account changes need a connection.</p>}
    {!account.verified && location.pathname !== '/settings' && <p className="banner"><Mail size={17} aria-hidden /><Link to="/settings">Verify your email in Settings</Link></p>}
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="workspace-body">
      <nav className="rail" aria-label="Workspace">
        <NavLink to="/chats"><MessageCircle size={21} aria-hidden />Chats</NavLink>
        <NavLink to="/transfers"><ArrowDownUp size={21} aria-hidden />Transfers</NavLink>
        <NavLink to="/settings"><Gear size={21} aria-hidden />Settings</NavLink>
        <button className="signout" onClick={async () => {
          setError('')
          try { await api('/auth/logout', 'POST', undefined, false); signOut() }
          catch (error) { setError(errorMessage(error)) }
        }}><LogOut size={20} aria-hidden />Sign out</button>
      </nav>
      <main id="content" tabIndex={-1}>
        <Routes>
          <Route path="/chats" element={<Chats account={account} />} />
          <Route path="/chats/:id" element={<Chats account={account} />} />
          <Route path="/contacts" element={<Contacts account={account} />} />
          <Route path="/transfers" element={<div className="settings-content">
            <header className="page-heading"><span className="section-icon"><ArrowDownUp size={23} aria-hidden /></span><h1>Transfers</h1></header>
            <section className="settings-card"><h2>No transfers</h2><p className="muted">File sharing will be available in a later release.</p></section>
          </div>} />
          <Route path="/settings" element={<Settings account={account} onAccount={onAccount} signOut={signOut} />} />
          <Route path="*" element={<Navigate to="/chats" replace />} />
        </Routes>
      </main>
    </div>
  </div>
}

function App() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  const [inviteToken, setInviteToken] = useState('')
  useEffect(() => {
    if (location.pathname === '/i' && location.hash) {
      setInviteToken(inviteFragment.test(location.hash) ? location.hash.slice(1) : '')
      navigate('/i', { replace: true })
    }
  }, [location.hash, location.pathname, navigate])
  useEffect(() => {
    let active = true
    api<Account>('/account').then(account => { if (active) setAccount(account) }).catch(error => {
      if (!active) return
      if (!(error instanceof ApiError && error.status === 401)) setError(errorMessage(error))
      setAccount(null)
    })
    return () => { active = false }
  }, [])
  function signedOut() {
    setInviteToken('')
    setAccount(null)
    navigate('/login', { replace: true })
  }
  if (location.pathname === '/i' || location.pathname.startsWith('/i/') || location.pathname.startsWith('/invite/')) {
    const token = location.pathname === '/i' && !location.hash ? inviteToken : ''
    return <InviteReview key={token} token={token} account={account ?? null} authenticated={account !== undefined} />
  }
  if (location.pathname === '/verify') return <VerifyEmail reload={async () => {
    if (!account) return
    setAccount(await api<Account>('/account'))
  }} />
  if (account === undefined) return <main className="standalone"><p role="status">Loading FluxParcel…</p></main>
  if (!account) {
    if (location.pathname !== '/login' && location.pathname !== '/register') {
      const returnTo = /^\/(chats(?:\/[a-zA-Z0-9_-]+)?|settings|transfers|contacts)$/.test(location.pathname)
        ? location.pathname : '/chats'
      return <Navigate to="/login" state={{ returnTo }} replace />
    }
    return <>{error && <p role="status" className="banner">{error}</p>}
      <AuthScreen register={location.pathname === '/register'} onAccount={user => { setError(''); setAccount(user) }} /></>
  }
  if (location.pathname === '/login' || location.pathname === '/register') {
    return <Navigate to={location.state?.returnTo ?? '/chats'} replace />
  }
  return <Workspace account={account} onAccount={setAccount} signOut={signedOut} />
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><App /></BrowserRouter>)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
