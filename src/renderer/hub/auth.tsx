import { AppWindow, Eye, EyeOff, LoaderCircle, ShieldCheck, Zap } from 'lucide-react'
import { useState } from 'react'
import type { PublicSettings, Settings, Status } from '../../shared/types'
import { api, Keys, Logo, Wordmark, type Toast } from './ui'

/*
 * Signed out: the whole window is this screen. Create an account or sign in; the password
 * goes straight to the VoiceFlow server over HTTPS and is never stored on this PC (only the
 * session, encrypted with Windows DPAPI).
 */
export function AuthScreen({ s, status, save, toast }: { s: PublicSettings; status: Status; save: (p: Partial<Settings>) => Promise<void>; toast: (t: Toast) => void }) {
  const [mode, setMode] = useState<'signup' | 'signin'>(s.accountEmail ? 'signin' : 'signup')
  const [email, setEmail] = useState(s.accountEmail)
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editServer, setEditServer] = useState(false)
  const signup = mode === 'signup'
  const longEnough = password.length >= 10
  const hold = s.holdKeys !== 'off' ? s.holdKeys : s.shortcut
  let host = s.serverUrl
  try {
    host = new URL(s.serverUrl).host
  } catch {
    /* show as typed */
  }

  const submit = async (): Promise<void> => {
    if (busy || !email || !password || (signup && !longEnough)) return
    setBusy(true)
    setError('')
    const r = signup ? await api.signUp(email.trim(), password) : await api.signIn(email.trim(), password)
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setPassword('')
    toast({ kind: 'ok', text: signup ? 'Welcome to VoiceFlow' : 'Signed in' })
  }

  return (
    <div className="auth">
      <section className="auth-brand" aria-hidden>
        <div className="brand">
          <Logo size={34} />
          <Wordmark />
        </div>
        <div>
          <h1>
            Speak.
            <br />
            We’ll type.
          </h1>
          <p className="lede">
            Hold <Keys combo={hold} small /> in any app, talk naturally, let go. Your words land right where your cursor is.
          </p>
        </div>
        <ul className="perks">
          <li>
            <span>
              <Zap size={18} />
            </span>
            Text appears about 0.2 s after you stop
          </li>
          <li>
            <span>
              <AppWindow size={18} />
            </span>
            Works in every Windows app
          </li>
          <li>
            <span>
              <ShieldCheck size={18} />
            </span>
            Your audio and words are never stored on our servers
          </li>
        </ul>
      </section>

      <section className="auth-form-wrap">
        <form
          className="auth-form"
          key={mode}
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="segmented" role="tablist">
            {(['signup', 'signin'] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => (setMode(m), setError(''))}>
                {m === 'signup' ? 'Create account' : 'Sign in'}
              </button>
            ))}
          </div>
          <h2>{signup ? 'Create your account' : 'Welcome back'}</h2>
          <p className="sub">{signup ? 'Start dictating in under a minute.' : 'Sign in to pick up where you left off.'}</p>
          {status.accountError && !error && <div className="form-note">{status.accountError}</div>}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <label className="field">
            <span>Email</span>
            <input className="input lg" type="email" autoComplete="username" autoFocus={!email} value={email} placeholder="you@company.com" onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            <span>Password</span>
            <div className="input-wrap">
              <input
                className="input lg"
                type={show ? 'text' : 'password'}
                autoComplete={signup ? 'new-password' : 'current-password'}
                autoFocus={!!email}
                value={password}
                placeholder={signup ? 'At least 10 characters' : 'Your password'}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button type="button" className="icon-btn" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((v) => !v)}>
                {show ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {signup && <small className={`hint ${longEnough ? 'good' : ''}`}>{longEnough ? '✓ Good length. A phrase is easy to remember and hard to guess.' : 'Use 10 or more characters. A short phrase works great.'}</small>}
          </label>
          <button className="btn primary block" type="submit" disabled={busy || !email || !password || (signup && !longEnough)}>
            {busy && <LoaderCircle size={18} className="spin" />}
            {busy ? (signup ? 'Creating account…' : 'Signing in…') : signup ? 'Create account' : 'Sign in'}
          </button>
          <div className="server-line">
            {editServer ? (
              <input
                className="input"
                autoFocus
                defaultValue={s.serverUrl}
                aria-label="Server address"
                placeholder="https://voiceflow.yourcompany.com"
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
                onBlur={(e) => {
                  setEditServer(false)
                  if (e.target.value.trim() !== s.serverUrl) void save({ serverUrl: e.target.value.trim() })
                }}
              />
            ) : (
              <>
                {s.serverUrl.startsWith('https://') && <ShieldCheck size={14} />}
                <span>
                  {s.serverUrl.startsWith('https://') ? 'Secure connection to' : 'Server:'} <b>{host}</b>
                </span>
                <button type="button" className="linkish" onClick={() => setEditServer(true)}>
                  Change
                </button>
              </>
            )}
          </div>
          <p className="fine">Your password is sent only to your VoiceFlow server and is never saved on this PC.</p>
        </form>
      </section>
    </div>
  )
}
