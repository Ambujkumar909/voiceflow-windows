import { CircleUser, KeyRound, Laptop, LogOut, Settings2, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { HOLD_KEYS, type PublicSettings, type Settings, type Status } from '../../shared/types'
import { api, Item, Keys, Modal, Switch, type Toast } from './ui'

const LANGUAGES: [string, string][] = [
  ['en', 'English'], ['auto', 'Auto-detect'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ru', 'Russian']
]

/** Keydown → Electron accelerator ("Alt+Shift+Space"); null until a usable combo is pressed. */
function toAccelerator(e: React.KeyboardEvent): string | null {
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
  const c = e.code
  const key =
    c === 'Space' ? 'Space'
    : /^Key[A-Z]$/.test(c) ? c.slice(3)
    : /^Digit\d$/.test(c) ? c.slice(5)
    : /^F\d{1,2}$/.test(c) ? c
    : ({ Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' } as Record<string, string>)[c]
  if (!key) return null
  if (!mods.length && !/^F\d/.test(key)) return null // a bare letter would hijack normal typing
  return [...mods, key].join('+')
}

type Save = (patch: Partial<Settings>) => Promise<void>
type Page = 'account' | 'general' | 'system'

/** Text field that saves on blur. */
function Text({ value, onSave, label, placeholder }: { value: string; onSave: (v: string) => void; label: string; placeholder?: string }) {
  return <input className="input" defaultValue={value} placeholder={placeholder} aria-label={label} onBlur={(e) => e.target.value !== value && onSave(e.target.value)} />
}

type Device = { id: string; device: string; createdAt: string; lastUsedAt: string; current: boolean }

const ago = (iso: string): string => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function ChangePasswordDialog({ onClose, toast }: { onClose: () => void; toast: (t: Toast) => void }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (): Promise<void> => {
    if (busy || !cur || next.length < 10) return
    setBusy(true)
    const r = await api.changePassword(cur, next)
    setBusy(false)
    if (!r.ok) return setError(r.error)
    toast({ kind: 'ok', text: 'Password changed. Other devices were signed out.' })
    onClose()
  }
  return (
    <Modal onClose={onClose} label="Change password">
      <h2>Change password</h2>
      <p className="sub">Every other device will be signed out.</p>
      {error && <div className="form-error">{error}</div>}
      <label className="field">
        <span>Current password</span>
        <input className="input" type="password" autoComplete="current-password" autoFocus value={cur} onChange={(e) => setCur(e.target.value)} />
      </label>
      <label className="field">
        <span>New password</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        <small className={`hint ${next.length >= 10 ? 'good' : ''}`}>{next.length >= 10 ? '✓ Good length' : 'At least 10 characters'}</small>
      </label>
      <div className="dialog-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !cur || next.length < 10} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </Modal>
  )
}

function DeleteAccountDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (): Promise<void> => {
    if (busy || !pw) return
    setBusy(true)
    const r = await api.deleteAccount(pw)
    setBusy(false)
    if (!r.ok) setError(r.error)
  }
  return (
    <Modal onClose={onClose} label="Delete account">
      <h2>Delete your account?</h2>
      <p className="sub">
        This permanently deletes <b>{email}</b>, its settings, dictionary and usage on the server, and signs out every device. Dictation history on this PC stays until you clear it. This can’t be undone.
      </p>
      {error && <div className="form-error">{error}</div>}
      <label className="field">
        <span>Enter your password to confirm</span>
        <input className="input" type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </label>
      <div className="dialog-actions">
        <button className="btn secondary" onClick={onClose}>
          Keep my account
        </button>
        <button className="btn danger" disabled={busy || !pw} onClick={() => void submit()}>
          {busy ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
    </Modal>
  )
}

function AccountPage({ s, status, save, toast }: { s: PublicSettings; status: Status; save: Save; toast: (t: Toast) => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [dialog, setDialog] = useState<'password' | 'delete' | null>(null)
  const load = (): void => void api.devices().then((r) => setDevices(r.ok ? (r.data ?? []) : []))
  useEffect(load, [])
  const signOutDevice = async (id: string): Promise<void> => {
    const r = await api.signOutDevice(id)
    if (!r.ok) toast({ kind: 'err', text: r.error })
    load()
  }
  return (
    <>
      <div className="s-card">
        <div className="profile">
          <span className="avatar lg">{(s.name || s.accountEmail || '?')[0]}</span>
          <div className="who">
            <div className="email">{s.accountEmail}</div>
            <div className="muted">VoiceFlow Cloud · {status.engine}</div>
          </div>
          <span className="badge">Free plan</span>
        </div>
      </div>

      <div className="s-card">
        <div className="eyebrow">Signed-in devices</div>
        <div className="devices">
          {devices === null ? (
            <span className="muted">Loading…</span>
          ) : devices.length === 0 ? (
            <span className="muted">Couldn’t load your devices.</span>
          ) : (
            devices.map((d) => (
              <div className="device" key={d.id}>
                <Laptop size={18} />
                <div className="what">
                  <div>{d.device || 'Unknown device'}</div>
                  <div className="muted">Active {ago(d.lastUsedAt)} · signed in {ago(d.createdAt)}</div>
                </div>
                {d.current ? (
                  <span className="badge neutral">This device</span>
                ) : (
                  <button className="btn ghost sm" onClick={() => void signOutDevice(d.id)}>
                    Sign out
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="s-card">
        <div className="eyebrow">Security</div>
        <Item label="Password" desc="Changing it signs out every other device">
          <button className="btn secondary" onClick={() => setDialog('password')}>
            <KeyRound size={16} /> Change
          </button>
        </Item>
        <Item label="Sign out everywhere" desc="Ends every session, including this one">
          <button
            className="btn secondary"
            onClick={async () => {
              const r = await api.signOutEverywhere()
              if (!r.ok) toast({ kind: 'err', text: r.error })
            }}
          >
            <LogOut size={16} /> Sign out all
          </button>
        </Item>
        <Item label="Sign out" desc="Only on this PC">
          <button className="btn secondary" onClick={() => void api.signOut()}>
            Sign out
          </button>
        </Item>
      </div>

      <div className="s-card">
        <div className="eyebrow">Transcription</div>
        <Item label="AI cleanup" desc="Fixes self-corrections (“at 3, no, at 4” → “at 4”) and punctuation on the server. Never rewrites your words.">
          <Switch label="AI cleanup" on={s.polish} onChange={(v) => void save({ polish: v })} />
        </Item>
        <Item label="Server" desc="Your organization's VoiceFlow server" wide>
          <Text value={s.serverUrl} label="Server address" placeholder="https://voiceflow.example.com" onSave={(v) => void save({ serverUrl: v.trim() })} />
        </Item>
      </div>

      <div className="s-card danger">
        <div className="eyebrow">Danger zone</div>
        <Item label="Delete account" desc="Permanently removes your account and everything stored for it on the server">
          <button className="btn danger-outline" onClick={() => setDialog('delete')}>
            Delete account
          </button>
        </Item>
      </div>

      <p className="muted" style={{ fontSize: 12.5 }}>
        Microphone permission: {status.micAccess} · Log: {status.logPath}
      </p>
      {dialog === 'password' && <ChangePasswordDialog onClose={() => setDialog(null)} toast={toast} />}
      {dialog === 'delete' && <DeleteAccountDialog email={s.accountEmail} onClose={() => setDialog(null)} />}
    </>
  )
}

function ShortcutsDialog({ s, save, onClose }: { s: PublicSettings; save: Save; onClose: () => void }) {
  const [listening, setListening] = useState(false)
  return (
    <Modal onClose={onClose} label="Shortcuts">
      <h2>Shortcuts</h2>
      <p className="sub">Choose your preferred shortcuts for using VoiceFlow.</p>
      <label className="field">
        <span>Push to talk</span>
        <select className="select" value={s.holdKeys} onChange={(e) => void save({ holdKeys: e.target.value as Settings['holdKeys'] })}>
          {HOLD_KEYS.map((k) => (
            <option key={k} value={k}>
              {k === 'off' ? 'Off' : k}
            </option>
          ))}
        </select>
        <small className="muted">Hold to dictate, release to insert. Double-tap for hands-free.</small>
      </label>
      <div className="field">
        <span>Hands-free mode</span>
        <button
          className={`choice capture ${listening ? 'listening' : ''}`}
          onClick={() => setListening(true)}
          onBlur={() => setListening(false)}
          onKeyDown={(e) => {
            if (!listening) return
            e.preventDefault()
            if (e.key === 'Escape') return setListening(false)
            const acc = toAccelerator(e)
            if (acc) {
              setListening(false)
              void save({ shortcut: acc })
            }
          }}
        >
          {listening ? <span className="muted">Press a key combination…</span> : <Keys combo={s.shortcut} small />}
          <span className="muted">{listening ? 'Esc to cancel' : 'Change'}</span>
        </button>
        <small className="muted">Press to start, press again to stop.</small>
      </div>
      <div className="dialog-actions">
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}

function MicDialog({ s, save, onClose }: { s: PublicSettings; save: Save; onClose: () => void }) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then((d) => setMics(d.filter((m) => m.kind === 'audioinput' && m.deviceId !== 'default' && m.deviceId !== 'communications')))
  }, [])
  const options: [string, string][] = [['', 'Auto-detect (system default)'], ...mics.map((m): [string, string] => [m.deviceId, m.label || 'Microphone ' + m.deviceId.slice(0, 6)])]
  return (
    <Modal onClose={onClose} label="Microphone">
      <h2>Microphone</h2>
      <p className="sub">Used for dictation.</p>
      <div className="field">
        {options.map(([id, name]) => (
          <button key={id} className={`choice ${s.micDeviceId === id ? 'on' : ''}`} onClick={() => void save({ micDeviceId: id })}>
            <span style={{ flex: 1 }}>{name}</span>
            {s.micDeviceId === id && '✓'}
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}

export function SettingsModal({ s, status, save, toast, onClose, version, clearHistory }: { s: PublicSettings; status: Status; save: Save; toast: (t: Toast) => void; onClose: () => void; version: string; clearHistory: () => void }) {
  const [page, setPage] = useState<Page>('general')
  const [sub, setSub] = useState<'shortcuts' | 'mic' | null>(null)
  const [micName, setMicName] = useState('Auto-detect')
  useEffect(() => {
    if (!s.micDeviceId) return setMicName('Auto-detect (system default)')
    void navigator.mediaDevices.enumerateDevices().then((d) => setMicName(d.find((m) => m.deviceId === s.micDeviceId)?.label || 'Selected microphone'))
  }, [s.micDeviceId])
  const cl = s.cleanup
  const pages: [Page, string, typeof Settings2][] = [
    ['general', 'General', Settings2],
    ['system', 'System', SlidersHorizontal],
    ['account', 'Account', CircleUser]
  ]
  const title = pages.find((p) => p[0] === page)![1]

  return (
    <Modal onClose={sub ? () => {} : onClose} className="settings" label="Settings">
      <aside className="settings-side">
        <div>
          <div className="eyebrow">Settings</div>
          {pages.map(([id, label, Icon]) => (
            <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}>
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="version">VoiceFlow v{version}</div>
      </aside>

      <section className="settings-main">
        <button className="icon-btn close" aria-label="Close settings" onClick={onClose}>
          <X size={18} />
        </button>
        <h3>{title}</h3>
        <div className="settings-content">
          {page === 'general' && (
            <>
              <div className="s-card">
                <Item
                  label="Shortcuts"
                  desc={
                    s.holdKeys !== 'off' ? (
                      <>
                        Hold <Keys combo={s.holdKeys} small /> and speak.
                      </>
                    ) : (
                      <>
                        Press <Keys combo={s.shortcut} small /> to start and stop.
                      </>
                    )
                  }
                >
                  <button className="btn secondary" onClick={() => setSub('shortcuts')}>
                    Change
                  </button>
                </Item>
                <Item label="Microphone" desc={micName}>
                  <button className="btn secondary" onClick={() => setSub('mic')}>
                    Change
                  </button>
                </Item>
                <Item label="Audio processing" desc="Speech engines are trained on real-world noise; extra noise suppression can erase soft speech.">
                  <select className="select" value={s.audioProcessing} aria-label="Audio processing" onChange={(e) => void save({ audioProcessing: e.target.value as Settings['audioProcessing'] })}>
                    <option value="gain">Auto level (recommended)</option>
                    <option value="raw">Raw microphone</option>
                    <option value="denoise">Noise suppression (very loud rooms)</option>
                  </select>
                </Item>
                <Item label="Keep microphone ready" desc="Never misses your first word. Only the last half-second is held in memory until you dictate; Windows shows the mic as in use.">
                  <Switch label="Keep microphone ready" on={s.instantMic} onChange={(v) => void save({ instantMic: v })} />
                </Item>
                <Item label="Language" desc="A fixed language is faster and more accurate than auto-detect">
                  <select className="select" value={s.language} aria-label="Language" onChange={(e) => void save({ language: e.target.value })}>
                    {LANGUAGES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Item>
              </div>
              <div className="s-card">
                <Item label="Theme">
                  <select className="select" value={s.theme} aria-label="Theme" onChange={(e) => void save({ theme: e.target.value as Settings['theme'] })}>
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </Item>
                <Item label="Your name" desc="Used in the greeting on Home">
                  <Text value={s.name} label="Your name" onSave={(v) => void save({ name: v })} />
                </Item>
              </div>
            </>
          )}

          {page === 'system' && (
            <>
              <div className="s-card">
                <div className="eyebrow">App</div>
                <Item label="Launch at login" desc="Starts quietly in the tray">
                  <Switch label="Launch at login" on={s.openAtLogin} onChange={(v) => void save({ openAtLogin: v })} />
                </Item>
                <Item label="Dictation sounds" desc="Soft tones when recording starts and stops">
                  <Switch label="Dictation sounds" on={s.sounds} onChange={(v) => void save({ sounds: v })} />
                </Item>
                <Item label="Keep history" desc="Transcripts are stored only on this PC">
                  <Switch label="Keep history" on={s.saveHistory} onChange={(v) => void save({ saveHistory: v })} />
                </Item>
                <Item label="Clear history" desc="Deletes all saved transcripts. Your stats are kept.">
                  <button className="btn secondary" onClick={clearHistory}>
                    Clear
                  </button>
                </Item>
              </div>
              <div className="s-card">
                <div className="eyebrow">Inserting text</div>
                <Item label="Method" desc="Paste is fastest; Type works where paste is blocked">
                  <select className="select" value={s.insertMode} aria-label="Insert method" onChange={(e) => void save({ insertMode: e.target.value as Settings['insertMode'] })}>
                    <option value="paste">Paste</option>
                    <option value="type">Type characters</option>
                  </select>
                </Item>
                <Item label="Restore clipboard" desc="Puts your clipboard back after pasting">
                  <Switch label="Restore clipboard" on={s.restoreClipboard} onChange={(v) => void save({ restoreClipboard: v })} />
                </Item>
              </div>
              <div className="s-card">
                <div className="eyebrow">Formatting</div>
                {(
                  [
                    ['removeFillers', 'Remove filler words', 'um, uh, erm'],
                    ['capitalize', 'Capitalize sentences', undefined],
                    ['finalPunctuation', 'End with punctuation', undefined],
                    ['spokenCommands', 'Spoken commands', 'Say “new line” or “new paragraph”'],
                    ['trailingSpace', 'Space after each dictation', undefined]
                  ] as const
                ).map(([k, label, desc]) => (
                  <Item key={k} label={label} desc={desc}>
                    <Switch label={label} on={cl[k]} onChange={(v) => void save({ cleanup: { ...cl, [k]: v } })} />
                  </Item>
                ))}
              </div>
            </>
          )}

          {page === 'account' && <AccountPage s={s} status={status} save={save} toast={toast} />}
        </div>
      </section>
      {sub === 'shortcuts' && <ShortcutsDialog s={s} save={save} onClose={() => setSub(null)} />}
      {sub === 'mic' && <MicDialog s={s} save={save} onClose={() => setSub(null)} />}
    </Modal>
  )
}
