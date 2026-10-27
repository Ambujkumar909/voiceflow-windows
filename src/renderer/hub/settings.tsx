import { AudioLines, Settings2, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { HOLD_KEYS, type KeySlot, type PublicSettings, type Settings, type Status } from '../../shared/types'
import { api, Item, Keys, Modal, Switch, type Toast } from './ui'

const LANGUAGES: [string, string][] = [
  ['en', 'English'], ['auto', 'Auto-detect'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ru', 'Russian']
]
const LOCAL_MODELS: [string, string][] = [
  ['onnx-community/whisper-tiny', 'Whisper tiny'],
  ['onnx-community/whisper-base', 'Whisper base'],
  ['onnx-community/whisper-small', 'Whisper small']
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
type Page = 'general' | 'system' | 'engine'

/** Write-only key field: a saved key never comes back to the page, only whether one is set. */
function KeyItem({ slot, label, placeholder, has, encryption, toast }: { slot: KeySlot; label: string; placeholder: string; has: boolean; encryption: boolean; toast: (t: Toast) => void }) {
  const [v, setV] = useState('')
  return (
    <Item label={label} desc={has ? 'Saved, encrypted with Windows DPAPI' : encryption ? 'Not set' : 'OS encryption unavailable'} wide>
      <span style={{ display: 'flex', gap: 8, width: '100%' }}>
        <input className="input" type="password" placeholder={has ? '••••••••' : placeholder} value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" aria-label={label} />
        <button
          className="btn secondary"
          disabled={!v && !has}
          onClick={async () => {
            try {
              await api.setApiKey(slot, v)
              setV('')
              toast({ kind: 'ok', text: v ? 'Key saved' : 'Key removed' })
            } catch (err) {
              toast({ kind: 'err', text: String((err as Error).message) })
            }
          }}
        >
          {v ? 'Save' : 'Remove'}
        </button>
      </span>
    </Item>
  )
}

/** Text field that saves on blur. */
function Text({ value, onSave, label, placeholder }: { value: string; onSave: (v: string) => void; label: string; placeholder?: string }) {
  return <input className="input" defaultValue={value} placeholder={placeholder} aria-label={label} onBlur={(e) => e.target.value !== value && onSave(e.target.value)} />
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
    ['engine', 'Speech engine', AudioLines]
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
        <h3 className="serif">{title}</h3>
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

          {page === 'engine' && (
            <>
              <div className="s-card">
                <Item label="Engine" desc={status.provider} wide>
                  <select className="select" value={s.provider} aria-label="Engine" onChange={(e) => void save({ provider: e.target.value as Settings['provider'] })}>
                    <option value="deepgram">Deepgram Nova-3 (cloud, streaming, recommended)</option>
                    <option value="xai">xAI Grok Voice (cloud, streaming)</option>
                    <option value="local-whisper">Local Whisper (offline, private)</option>
                    <option value="openai">OpenAI-compatible API</option>
                  </select>
                </Item>
                {s.provider === 'deepgram' && (
                  <>
                    <KeyItem slot="deepgram" label="Deepgram API key" placeholder="Paste your key" has={s.keys.deepgram} encryption={status.encryptionAvailable} toast={toast} />
                    <Item label="Region" desc="Auto picks the faster of EU and US for your connection">
                      <select className="select" value={s.deepgramRegion} aria-label="Deepgram region" onChange={(e) => void save({ deepgramRegion: e.target.value as Settings['deepgramRegion'] })}>
                        <option value="auto">Auto</option>
                        <option value="eu">EU</option>
                        <option value="us">US</option>
                      </select>
                    </Item>
                  </>
                )}
                {s.provider === 'xai' && <KeyItem slot="xai" label="xAI API key" placeholder="xai-…" has={s.keys.xai} encryption={status.encryptionAvailable} toast={toast} />}
                {s.provider === 'openai' && (
                  <>
                    <Item label="API base URL" wide>
                      <Text value={s.apiBaseUrl} label="API base URL" onSave={(v) => void save({ apiBaseUrl: v })} />
                    </Item>
                    <Item label="Model" desc="e.g. whisper-large-v3-turbo" wide>
                      <Text value={s.apiModel} label="Model" onSave={(v) => void save({ apiModel: v })} />
                    </Item>
                    <KeyItem slot="openai" label="API key" placeholder="sk-…" has={s.keys.openai} encryption={status.encryptionAvailable} toast={toast} />
                  </>
                )}
                <Item label={s.provider === 'local-whisper' ? 'Model' : 'Offline fallback'} desc="Runs on this PC; downloaded once">
                  <select className="select" value={s.localModel} aria-label="Local model" onChange={(e) => void save({ localModel: e.target.value })}>
                    {LOCAL_MODELS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Item>
              </div>
              <div className="s-card">
                <div className="eyebrow">AI cleanup</div>
                <Item label="Clean up with an LLM" desc="Fixes self-corrections and punctuation. Never rewrites your words.">
                  <Switch label="AI cleanup" on={s.polish.enabled} onChange={(v) => void save({ polish: { ...s.polish, enabled: v } })} />
                </Item>
                {s.polish.enabled && (
                  <>
                    <Item label="API base URL" wide>
                      <Text value={s.polish.baseUrl} label="Cleanup API base URL" onSave={(v) => void save({ polish: { ...s.polish, baseUrl: v } })} />
                    </Item>
                    <Item label="Model" wide>
                      <Text value={s.polish.model} label="Cleanup model" onSave={(v) => void save({ polish: { ...s.polish, model: v } })} />
                    </Item>
                    <KeyItem slot="llm" label="API key" placeholder="gsk_…" has={s.keys.llm} encryption={status.encryptionAvailable} toast={toast} />
                  </>
                )}
              </div>
              <p className="muted">
                Microphone permission: {status.micAccess} · Log: {status.logPath}
              </p>
            </>
          )}
        </div>
      </section>
      {sub === 'shortcuts' && <ShortcutsDialog s={s} save={save} onClose={() => setSub(null)} />}
      {sub === 'mic' && <MicDialog s={s} save={save} onClose={() => setSub(null)} />}
    </Modal>
  )
}
