import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import type { OverlayState } from '../../shared/types'
import { arm, cancelRecording, disarm, micLive, micErrorMessage, rms, startRecording, stopRecording } from './recorder'
import { sounds } from './sounds'
import './overlay.css'

const api = window.api.overlay

// Commands from main are handled outside React so they work even before first render,
// one at a time so a quick cancel→start cannot interleave.
let queue = Promise.resolve()
api.onCommand((c) => (queue = queue.then(() => run(c))))
async function run(c: Parameters<Parameters<typeof api.onCommand>[0]>[0]): Promise<void> {
  if (c.cmd === 'arm') return arm(c.deviceId, c.processing).catch((e) => console.warn('mic arm failed: ' + micErrorMessage(e))) // a real start also reports it
  if (c.cmd === 'disarm') return disarm()
  try {
    if (c.cmd === 'start') await startRecording(c.deviceId, c.processing, c.stream ? api.sendChunk : undefined)
    else if (c.cmd === 'stop') await api.sendAudio(await stopRecording())
    else await cancelRecording()
  } catch (e) {
    await cancelRecording()
    await api.sendError(c.cmd === 'start' ? micErrorMessage(e) : String((e as Error)?.message ?? e))
  }
}

/*
 * The pill. Sizes, colours and timings follow the reference app's observed design (they were
 * measured, not copied); drawing and code are our own. States: rest 40×8 → ready (hover) 50×30 →
 * ptt (holding) 73×30 → popo (hands-free, with cancel/finish) 102.5×30 → processing 98×30;
 * errors flash a red border for 500 ms and show a card above.
 */
type Look = 'rest' | 'ready' | 'ptt' | 'popo' | 'processing' | 'error'

const BARS = 10
const SHAPE = Array.from({ length: BARS }, (_, i) => Math.max(0, 1 - (i - 4.5) ** 2 / 48)) // gentle dome
const DELAYS = [0, 0.1, 0.2, 0.3, 0.4, -0.5, -0.4, -0.3, -0.2, -0.1]

/** Mic level → --amp on the waveform: dB over an adaptive noise floor, smoothed per frame. */
function Waveform({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    let raf = 0
    let floor = Infinity
    let v = 0
    const tick = (): void => {
      const r = rms()
      if (r > 0) {
        const db = 20 * Math.log10(r)
        floor = Math.max(-60, Math.min(floor, db))
        v = 0.85 * v + 0.15 * Math.min(1, Math.max(0, (db - floor) / 20))
      }
      ref.current?.style.setProperty('--amp', String(Math.max(1, 5 * v)))
      ref.current?.classList.toggle('live', micLive())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      ref.current?.style.setProperty('--amp', '1')
    }
  }, [active])
  return (
    <div className={`wave ${active ? 'moving' : ''}`} ref={ref} aria-hidden>
      {SHAPE.map((s, i) => (
        <span key={i} style={{ '--shape': s, animationDelay: `${DELAYS[i]}s` } as CSSProperties}>
          <i />
        </span>
      ))}
    </div>
  )
}

function Spinner() {
  return (
    <span className="spinner" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} style={{ transform: `rotate(${i * 45}deg) translateY(-6px)`, animationDelay: `${-(7 - i) * 0.1375}s` }} />
      ))}
    </span>
  )
}

const MicIcon = () => (
  <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden>
    <rect x="3" y="0.5" width="6" height="10" rx="3" fill="#fff" />
    <path d="M1 7.5a5 5 0 0 0 10 0M6 12.5V15" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
  </svg>
)
const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <path d="M3 3l6 6M9 3l-6 6" stroke="#FCFCFB" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <path d="M2.5 6.5l2.5 2.5 4.5-6" stroke="#1A1A1A" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function Overlay() {
  const [st, setSt] = useState<OverlayState>({ state: 'idle' })
  const [hover, setHover] = useState(false)
  const [tip, setTip] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)
  const [hint, setHint] = useState('')
  const leaveTimer = useRef(0)
  const tipTimer = useRef(0)

  useEffect(() => api.onState(setSt), [])
  // Tones on transitions only (live-word updates resend the same state).
  const prev = useRef(st.state)
  useEffect(() => {
    const from = prev.current
    prev.current = st.state
    if (from === st.state || st.sounds === false) return
    if (st.state === 'recording') sounds.start()
    else if (from === 'recording' && st.state === 'processing') sounds.stop()
    else if (st.state === 'error') sounds.error()
  }, [st])
  useEffect(() => void api.hint().then(setHint), [])
  useEffect(() => {
    if (st.hint) setHint(st.hint)
    if (st.state !== 'error') return setFlash(false)
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 500)
    return () => clearTimeout(t)
  }, [st])

  const recording = st.state === 'recording'
  const look: Look = recording ? (st.handsFree ? 'popo' : 'ptt') : st.state === 'processing' ? 'processing' : flash ? 'error' : hover ? 'ready' : 'rest'
  const card = st.state === 'error' ? st.message || 'Something went wrong' : ''
  const live = recording && st.live ? (st.live.length > 160 ? '…' + st.live.slice(-160) : st.live) : ''

  const showTip = (text: string | null, delay: number): void => {
    clearTimeout(tipTimer.current)
    if (!text) return setTip(null)
    tipTimer.current = window.setTimeout(() => setTip(text), delay)
  }
  const enter = (): void => {
    clearTimeout(leaveTimer.current)
    api.setInteractive(true)
    setHover(true)
    showTip(recording && st.handsFree ? `Press|${hint}|to finish and paste` : recording ? null : `Dictate|${hint}`, 150)
  }
  const leave = (): void => {
    // Short lock against flicker when the pointer grazes the edge.
    leaveTimer.current = window.setTimeout(() => {
      api.setInteractive(false)
      setHover(false)
      showTip(null, 0)
    }, 100)
  }
  const click = (): void => {
    if (look === 'ready' || look === 'rest') api.action('start')
    else if (look === 'ptt') api.action('stop')
  }

  const [pre, key, post] = (tip ?? '').split('|')
  return (
    <div className="root">
      {card && <div className="card error-card">{card}</div>}
      {live && <div className="card caption">{live}</div>}
      {tip && !card && !live && (
        <div className="tooltip">
          {pre} {key && <b>{key}</b>} {post}
        </div>
      )}
      <div className="hot" onMouseEnter={enter} onMouseLeave={leave} onContextMenu={() => api.action('menu')}>
        <div className={`pill ${look} ${card ? 'suppressed' : ''}`} onClick={click} role="status" aria-label={`Dictation ${look}`}>
          <button className="btn cancel" tabIndex={-1} aria-label="Cancel" onMouseEnter={() => showTip('Cancel', 50)} onClick={(e) => (e.stopPropagation(), api.action('cancel'))}>
            <XIcon />
          </button>
          {look === 'ready' ? <MicIcon /> : <Waveform active={recording} />}
          {look === 'processing' && <Spinner />}
          <button className="btn finish" tabIndex={-1} aria-label="Finish and paste" onMouseEnter={() => showTip('Finish and paste', 50)} onClick={(e) => (e.stopPropagation(), api.action('stop'))}>
            <CheckIcon />
          </button>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
