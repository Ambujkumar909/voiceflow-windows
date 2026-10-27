import '@fontsource-variable/figtree'
import { ArrowRight, BookOpen, Copy, Flame, Gauge, House, Mic, PanelLeft, Pencil, Plus, Search, Settings as Gear, Trash2, Type } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DictEntry, HistoryEntry, PublicSettings, Settings, Stats, Status } from '../../shared/types'
import { AuthScreen } from './auth'
import { SettingsModal } from './settings'
import { api, Keys, Logo, Modal, Switch, ToastView, Wordmark, type Toast } from './ui'
import './hub.css'

type Page = 'home' | 'dictionary'

const dayKey = (t: number): string => new Date(t).toDateString()
function dayHeading(t: number): string {
  const d = new Date(t)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today’s dictations'
  if (d.toDateString() === y.toDateString()) return 'Yesterday’s dictations'
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}
const time = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const fmt = (n: number): string => n.toLocaleString()
const greeting = (): string => {
  const h = new Date().getHours()
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** Connection state as a small chip: green when the live connection to the server is up. */
function ConnectionChip({ engine }: { engine: string }) {
  const ok = engine === 'connected'
  const wait = /connecting/.test(engine)
  return (
    <span className="chip" title={`VoiceFlow Cloud: ${engine}`}>
      <span className={`dot ${ok ? 'ok' : wait ? 'wait' : ''}`} />
      {ok ? 'Connected' : wait ? 'Connecting…' : 'Offline'}
    </span>
  )
}

/** Typing-proof global keys: j/k/arrows move, Enter = primary action, "/" or Ctrl+F = search. */
function useListKeys(count: number, onEnter: (i: number) => void, search: React.RefObject<HTMLInputElement | null>) {
  const [sel, setSel] = useState(-1)
  useEffect(() => setSel((i) => Math.min(i, count - 1)), [count])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      if (document.querySelector('.overlay')) return
      if ((e.ctrlKey && e.key === 'f') || (e.key === '/' && !typing)) {
        e.preventDefault()
        search.current?.focus()
        return
      }
      if (typing) return
      if (e.key === 'ArrowDown' || e.key === 'j') (e.preventDefault(), setSel((i) => Math.min(i + 1, count - 1)))
      else if (e.key === 'ArrowUp' || e.key === 'k') (e.preventDefault(), setSel((i) => Math.max(i - 1, 0)))
      else if (e.key === 'Escape') setSel(-1)
      else if (e.key === 'Enter' && sel >= 0) (e.preventDefault(), onEnter(sel))
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [count, sel, onEnter, search])
  useEffect(() => {
    if (sel >= 0) document.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  return [sel, setSel] as const
}

function SearchBox({ value, onChange, placeholder, inputRef }: { value: string; onChange: (v: string) => void; placeholder: string; inputRef: React.RefObject<HTMLInputElement | null> }) {
  return (
    <label className="search">
      <Search size={17} />
      <input ref={inputRef} value={value} placeholder={placeholder} aria-label={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (onChange(''), e.currentTarget.blur())} />
      {!value && <kbd>/</kbd>}
    </label>
  )
}

function Home({ s, history, stats, status, toast, onDelete }: { s: PublicSettings; history: HistoryEntry[]; stats: Stats; status: Status; toast: (t: Toast) => void; onDelete: (id: string) => void }) {
  const [q, setQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const shown = useMemo(() => (q ? history.filter((h) => h.text.toLowerCase().includes(q.toLowerCase())) : history), [history, q])
  const copy = useCallback(
    (i: number) => {
      const h = shown[i]
      if (h) void navigator.clipboard.writeText(h.text).then(() => toast({ kind: 'ok', text: 'Copied' }))
    },
    [shown, toast]
  )
  const [sel, setSel] = useListKeys(shown.length, copy, searchRef)
  const hold = s.holdKeys !== 'off' ? s.holdKeys : s.shortcut
  const groups: { key: string; at: number; items: { h: HistoryEntry; i: number }[] }[] = []
  shown.forEach((h, i) => {
    const k = dayKey(h.at)
    if (groups.at(-1)?.key !== k) groups.push({ key: k, at: h.at, items: [] })
    groups.at(-1)!.items.push({ h, i })
  })

  return (
    <>
      <div className="page-top">
        <div>
          <h1>
            {greeting()}
            {s.name ? `, ${s.name}` : ''}
          </h1>
          <p className="lede">
            Hold <Keys combo={hold} small /> anywhere and speak. Let go and it’s typed.
          </p>
        </div>
        <ConnectionChip engine={status.engine} />
      </div>
      <div className="page-scroll">
        <div className="stats">
          <div className="tile hero">
            <Type size={18} />
            <div className="v">{fmt(stats.totalWords)}</div>
            <div className="l">words dictated</div>
          </div>
          <div className="tile">
            <Gauge size={18} />
            <div className="v">{fmt(stats.wpm)}</div>
            <div className="l">words per minute</div>
          </div>
          <div className="tile">
            <Flame size={18} />
            <div className="v">{fmt(stats.streakDays)}</div>
            <div className="l">day streak</div>
          </div>
        </div>
        <div className="primary-col">
          {history.length > 0 && <SearchBox value={q} onChange={setQ} placeholder="Search your dictations" inputRef={searchRef} />}
          {history.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <Mic size={24} />
              </div>
              <h2>Your first dictation is one key-hold away</h2>
              <p>
                Click into any text box, hold <Keys combo={hold} small /> and talk. Release, and your words are typed where your cursor is. They’ll show up here.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <p className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>
              No dictations match “{q}”.
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.key}>
                <div className="day-header eyebrow">{dayHeading(g.at)}</div>
                <div className="list" role="list">
                  {g.items.map(({ h, i }) => (
                    <div key={h.id} className={`row ${sel === i ? 'selected' : ''}`} role="listitem" tabIndex={0} data-index={i} onMouseEnter={() => setSel(i)} onFocus={() => setSel(i)}>
                      <div className="row-time">{time(h.at)}</div>
                      <div className="row-text">{h.text.trim()}</div>
                      <div className="row-actions">
                        <button className="icon-btn" title="Copy transcript" aria-label="Copy transcript" onClick={() => copy(i)}>
                          <Copy size={16} />
                        </button>
                        <button className="icon-btn" title="Delete" aria-label="Delete transcript" onClick={() => onDelete(h.id)}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  )
}

function WordDialog({ entry, onSave, onClose }: { entry: DictEntry | null; onSave: (e: DictEntry) => void; onClose: () => void }) {
  const [word, setWord] = useState(entry?.word ?? '')
  const [fix, setFix] = useState(!!entry?.misspelling)
  const [mis, setMis] = useState(entry?.misspelling ?? '')
  const ok = word.trim() && (!fix || mis.trim())
  const submit = (): void => {
    if (ok) onSave(fix ? { word: word.trim(), misspelling: mis.trim() } : { word: word.trim() })
  }
  return (
    <Modal onClose={onClose} label={entry ? 'Edit word' : 'Add to vocabulary'}>
      <h2>{entry ? 'Edit word' : 'Add to vocabulary'}</h2>
      <p className="sub">Names, jargon and anything VoiceFlow should spell your way.</p>
      <div className="inline-switch">
        <span>Correct a misspelling</span>
        <Switch label="Correct a misspelling" on={fix} onChange={setFix} />
      </div>
      {fix && (
        <label className="field">
          <span>When VoiceFlow hears</span>
          <input className="input" value={mis} placeholder="e.g. cooper netties" onChange={(e) => setMis(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
      )}
      <label className="field">
        <span>{fix ? 'Write it as' : 'Word'}</span>
        <input className="input" value={word} placeholder="Add a new word" autoFocus onChange={(e) => setWord(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      <div className="dialog-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ok} onClick={submit}>
          {entry ? 'Save' : 'Add word'}
        </button>
      </div>
    </Modal>
  )
}

function Dictionary({ s, save }: { s: PublicSettings; save: (p: Partial<Settings>) => Promise<void> }) {
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<{ index: number } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const list = s.dictionary.map((e, index) => ({ e, index })).filter(({ e }) => !q || (e.word + ' ' + (e.misspelling ?? '')).toLowerCase().includes(q.toLowerCase()))
  const [sel, setSel] = useListKeys(list.length, (i) => setEditing({ index: list[i].index }), searchRef)
  const put = (entry: DictEntry): void => {
    const next = [...s.dictionary]
    if (editing && editing.index >= 0) next[editing.index] = entry
    else next.unshift(entry)
    void save({ dictionary: next })
    setEditing(null)
  }
  return (
    <>
      <div className="page-top">
        <h1>Dictionary</h1>
        <button className="btn primary" onClick={() => setEditing({ index: -1 })}>
          <Plus size={18} /> Add new
        </button>
      </div>
      <div className="page-scroll">
        <div className="primary-col">
          <SearchBox value={q} onChange={setQ} placeholder="Search your vocabulary" inputRef={searchRef} />
          {s.dictionary.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <BookOpen size={24} />
              </div>
              <h2>Teach VoiceFlow your words</h2>
              <p>Add names, product terms and jargon so they’re recognized and spelled right every time. You can also fix words it keeps mishearing.</p>
            </div>
          ) : list.length === 0 ? (
            <p className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>
              Nothing matches “{q}”.
            </p>
          ) : (
            <div className="list" role="list" style={{ marginTop: 16 }}>
              {list.map(({ e, index }, i) => (
                <div key={index} className={`row ${sel === i ? 'selected' : ''}`} role="listitem" tabIndex={0} data-index={i} onMouseEnter={() => setSel(i)} onFocus={() => setSel(i)}>
                  <div className="row-text word">
                    {e.misspelling && (
                      <>
                        <span className="misspelling">{e.misspelling}</span> <ArrowRight size={14} style={{ verticalAlign: -2, margin: '0 6px' }} />
                      </>
                    )}
                    {e.word}
                  </div>
                  <div className="row-actions">
                    <button className="icon-btn" title="Edit" aria-label={`Edit ${e.word}`} onClick={() => setEditing({ index })}>
                      <Pencil size={16} />
                    </button>
                    <button className="icon-btn" title="Delete" aria-label={`Delete ${e.word}`} onClick={() => void save({ dictionary: s.dictionary.filter((_, j) => j !== index) })}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {editing && <WordDialog entry={editing.index >= 0 ? s.dictionary[editing.index] : null} onSave={put} onClose={() => setEditing(null)} />}
    </>
  )
}

function App() {
  const [s, setS] = useState<PublicSettings | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [stats, setStats] = useState<Stats>({ totalWords: 0, wpm: 0, streakDays: 0 })
  const [version, setVersion] = useState('')
  const [page, setPage] = useState<Page>('home')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar') === 'collapsed')
  const [toast, setToast] = useState<Toast>(null)

  const refresh = useCallback(async () => {
    const [a, b, c, d] = await Promise.all([api.get(), api.status(), api.history(), api.stats()])
    setS(a)
    setStatus(b)
    setHistory(c)
    setStats(d)
  }, [])
  useEffect(() => {
    void refresh()
    void api.info().then((i) => setVersion(i.version))
    const off = api.onChanged(() => void refresh())
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    const t = setInterval(async () => setStatus(await api.status()), 3000) // engine/model status
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      clearInterval(t)
    }
  }, [refresh])
  useEffect(() => {
    try {
      localStorage.setItem('sidebar', collapsed ? 'collapsed' : 'open')
    } catch {
      /* storage unavailable: just don't remember */
    }
  }, [collapsed])

  const save = useCallback(async (patch: Partial<Settings>) => {
    const r = await api.save(patch)
    setS(r.settings)
    setStatus(await api.status())
    if (r.error) setToast({ kind: 'err', text: r.error })
  }, [])
  const del = useCallback(
    async (id: string) => {
      await api.deleteHistory(id)
      void refresh()
    },
    [refresh]
  )

  if (!s || !status) return null
  const nav: [Page, string, typeof House][] = [
    ['home', 'Home', House],
    ['dictionary', 'Dictionary', BookOpen]
  ]
  if (!s.signedIn)
    return (
      <>
        <div className="titlebar" />
        <AuthScreen s={s} status={status} save={save} toast={setToast} />
        <ToastView toast={toast} onDone={() => setToast(null)} />
      </>
    )
  return (
    <>
      <div className="titlebar">
        <button className="icon-btn" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed((c) => !c)}>
          <PanelLeft size={18} />
        </button>
      </div>
      <div className="shell">
        <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main">
          <div>
            <div className="brand">
              <Logo size={28} />
              <Wordmark />
            </div>
            <ul className="nav">
              {nav.map(([id, label, Icon]) => (
                <li key={id}>
                  <button className={`nav-item ${page === id ? 'active' : ''}`} data-hint={label} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>
                    <Icon size={20} />
                    <span>{label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="nav-divider" />
            <ul className="nav">
              <li>
                <button className="nav-item" data-hint="Settings" onClick={() => setSettingsOpen(true)}>
                  <Gear size={20} />
                  <span>Settings</span>
                </button>
              </li>
            </ul>
            <div className="side-account" title={s.accountEmail}>
              <span className="avatar">{(s.name || s.accountEmail || '?')[0]}</span>
              <div className="who">
                <div>{s.name || s.accountEmail.split('@')[0]}</div>
                <div className="muted">{s.accountEmail}</div>
              </div>
            </div>
          </div>
        </nav>
        <main className="page">
          {!status.shortcutRegistered && <p className="banner">Hands-free shortcut not active: {status.shortcutError}</p>}
          {status.holdError && <p className="banner">{status.holdError}</p>}
          {status.micAccess === 'denied' && <p className="banner">Microphone access is blocked in Windows Settings → Privacy &amp; security → Microphone.</p>}
          {page === 'home' ? <Home s={s} history={history} stats={stats} status={status} toast={setToast} onDelete={del} /> : <Dictionary s={s} save={save} />}
        </main>
      </div>
      {settingsOpen && s.signedIn && (
        <SettingsModal
          s={s}
          status={status}
          save={save}
          toast={setToast}
          version={version}
          onClose={() => setSettingsOpen(false)}
          clearHistory={async () => {
            await api.clearHistory()
            void refresh()
            setToast({ kind: 'ok', text: 'History cleared' })
          }}
        />
      )}
      <ToastView toast={toast} onDone={() => setToast(null)} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
