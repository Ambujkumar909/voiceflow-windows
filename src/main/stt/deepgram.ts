/*
 * Deepgram streaming with one long-lived, warm WebSocket (see DESIGN.md).
 *
 *  - Opened ahead of time (app start, first key of the hold combo, pill hover, resume), so a
 *    dictation never waits for TCP + TLS + WebSocket setup (~700 ms from India).
 *  - Kept alive with {"type":"KeepAlive"} every 4 s while idle (idle time is not billed) and
 *    closed after 15 minutes without a dictation.
 *  - Audio is sent only while recording (billing is per second of audio). Every dictation ends
 *    with {"type":"Finalize"}, which also cuts Deepgram's segment there; results are matched to
 *    dictations by audio time (deepgram-epoch.ts).
 *  - Any failure rejects the dictation, and the caller transcribes the retained clip locally.
 */
import { log } from '../log'
import { Epoch, type DgResult } from './deepgram-epoch'
import type { StreamSession } from './xai'

export interface DgConfig {
  key: string
  region: 'auto' | 'eu' | 'us'
  model: string
  language: string
  keyterms: string[]
}

const HOSTS = { eu: 'api.eu.deepgram.com', us: 'api.deepgram.com' } as const
const KEEPALIVE_MS = 4000
const IDLE_CLOSE_MS = 15 * 60_000
const FINALIZE_TIMEOUT_MS = 2000
const BYTES_PER_SEC = 32000 // 16 kHz, 16-bit, mono

let ws: WebSocket | null = null
let sig = '' // what the open socket was configured with; a change means reconnect
let isOpen = false
let streamSec = 0 // audio seconds handed to this socket (sent or queued)
let queue: ArrayBuffer[] = []
let pendingFinalize = false
let active: { epoch: Epoch; onLive: (t: string) => void; settle?: (err?: Error) => void } | null = null
let keepAlive: NodeJS.Timeout | undefined
let idleTimer: NodeJS.Timeout | undefined
let retryTimer: NodeJS.Timeout | undefined
let retries = 0
let lastCfg: DgConfig | null = null
let lastError = ''
let region: 'eu' | 'us' | null = null
let probing: Promise<void> | null = null
let testBase: string | null = null

/** Self-test only: point the client at a local mock server (e.g. ws://127.0.0.1:1234). */
export function setDeepgramBaseForTest(base: string | null): void {
  testBase = base
  closeDeepgram()
}

export function params(cfg: DgConfig): URLSearchParams {
  const q = new URLSearchParams({
    model: cfg.model,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true', // punctuation, numbers, dates, emails, currency
    punctuate: 'true',
    dictation: 'true', // spoken "comma", "period"… become symbols
    endpointing: '300',
    language: cfg.language && cfg.language !== 'auto' ? cfg.language : 'multi'
  })
  for (const k of cfg.keyterms.slice(0, 100)) q.append('keyterm', k.slice(0, 50))
  return q
}

/** Pick the region with the faster TLS round trip (an unauthenticated HEAD: free, ~1 s once). */
function probeRegion(): Promise<void> {
  if (region || probing) return probing ?? Promise.resolve()
  const time = async (host: string): Promise<number> => {
    const t = performance.now()
    try {
      await fetch(`https://${host}/v1/projects`, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
      return performance.now() - t
    } catch {
      return Infinity
    }
  }
  probing = (async () => {
    const [eu, us] = await Promise.all([time(HOSTS.eu), time(HOSTS.us)])
    region = us < eu * 0.85 ? 'us' : 'eu' // EU wins ties: measured closer from India
    log('info', 'deepgram region', { region, euMs: Math.round(eu), usMs: Math.round(us) })
  })().finally(() => (probing = null))
  return probing
}

/** Turn a failed handshake into a useful message by asking the REST API (free) why. */
async function explain(cfg: DgConfig, host: string): Promise<string> {
  try {
    const r = await fetch(`https://${host}/v1/projects`, { headers: { authorization: `Token ${cfg.key}` }, signal: AbortSignal.timeout(5000) })
    if (r.status === 401) return 'Deepgram rejected the API key. Check it in Settings → Speech engine.'
    if (r.status === 402) return 'Your Deepgram account is out of credit.'
    if (r.status === 403) return 'This Deepgram key is not allowed to transcribe.'
    if (r.status === 429) return 'Deepgram is rate limiting requests. Try again in a moment.'
    return `Deepgram connection failed (HTTP ${r.status}).`
  } catch {
    return 'Can’t reach Deepgram. Check your internet connection.'
  }
}

function stopTimers(): void {
  clearInterval(keepAlive)
  clearTimeout(retryTimer)
}

function failActive(e: Error): void {
  const a = active
  active = null
  a?.settle?.(e)
}

export function closeDeepgram(): void {
  stopTimers()
  clearTimeout(idleTimer)
  const s = ws
  ws = null
  isOpen = false
  sig = ''
  queue = []
  failActive(new Error('Deepgram connection closed'))
  if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'CloseStream' }))
  s?.close()
}

function connect(cfg: DgConfig): void {
  const host = HOSTS[cfg.region === 'auto' ? (region ?? 'eu') : cfg.region]
  const url = `${testBase ?? 'wss://' + host}/v1/listen?${params(cfg)}`
  const want = cfg.key + '|' + url
  if (ws && sig === want && ws.readyState <= WebSocket.OPEN) return
  closeDeepgram()
  sig = want
  streamSec = 0
  pendingFinalize = false
  const started = Date.now()
  // Node's WebSocket (undici) accepts headers, which keeps the key out of the URL and renderers.
  const sock = new WebSocket(url, { headers: { Authorization: `Token ${cfg.key}` } } as unknown as string[])
  sock.binaryType = 'arraybuffer'
  ws = sock
  sock.onopen = () => {
    if (ws !== sock) return
    isOpen = true
    retries = 0
    lastError = ''
    log('info', 'deepgram connected', { host, ms: Date.now() - started })
    for (const b of queue.splice(0)) sock.send(b)
    if (pendingFinalize) sock.send(JSON.stringify({ type: 'Finalize' }))
    pendingFinalize = false
    keepAlive = setInterval(() => !active && sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: 'KeepAlive' })), KEEPALIVE_MS)
  }
  sock.onmessage = (m) => {
    if (ws !== sock || !active) return
    let r: DgResult
    try {
      r = JSON.parse(String(m.data))
    } catch {
      return
    }
    if (!active.epoch.accept(r)) return
    active.onLive(active.epoch.live())
    if (active.epoch.done) active.settle?.()
  }
  sock.onclose = (ev) => {
    if (ws !== sock) return
    const wasOpen = isOpen
    ws = null
    isOpen = false
    sig = ''
    stopTimers()
    log('warn', 'deepgram socket closed', { code: ev.code, reason: ev.reason, wasOpen })
    failActive(new Error(`Deepgram connection closed (${ev.code})`)) // the caller falls back right away
    if (!wasOpen) void explain(cfg, host).then((m) => (lastError = m)) // shown in Settings/Home status
    // A dropped warm socket comes back on its own a few times; after that, the next key press does it.
    if (wasOpen && retries < 3 && lastCfg) {
      const delay = Math.min(30_000, 500 * 2 ** retries++) * (0.75 + Math.random() / 2)
      retryTimer = setTimeout(() => lastCfg && connect(lastCfg), delay)
    }
  }
}

/** Make sure a socket for this config is open or opening. Cheap to call often. */
export function warmDeepgram(cfg: DgConfig): void {
  if (!cfg.key) return
  lastCfg = cfg
  clearTimeout(idleTimer)
  idleTimer = setTimeout(closeDeepgram, IDLE_CLOSE_MS)
  if (cfg.region === 'auto' && !region && !testBase) {
    void probeRegion().then(() => lastCfg === cfg && connect(cfg))
    if (!ws) return // the probe connects when it finishes (unless a dictation needs it sooner)
  }
  connect(cfg)
}

/** Start one dictation on the warm socket. Audio arrives through push(). */
export function beginDeepgram(cfg: DgConfig, onLive: (text: string) => void): StreamSession {
  if (!ws) region ??= 'eu' // a dictation can't wait for the region probe
  warmDeepgram(cfg)
  connect(cfg)
  failActive(new Error('superseded'))
  const me = { epoch: new Epoch(streamSec), onLive } as NonNullable<typeof active>
  active = me
  const finalize = (): void => {
    if (ws && isOpen) ws.send(JSON.stringify({ type: 'Finalize' }))
    else pendingFinalize = true
  }
  return {
    push(pcm) {
      if (active !== me) return
      const b = new Int16Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) b[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7fff
      streamSec += b.byteLength / BYTES_PER_SEC
      if (ws && isOpen) ws.send(b.buffer)
      else queue.push(b.buffer)
    },
    finish(timeoutMs = FINALIZE_TIMEOUT_MS) {
      if (active !== me) return Promise.reject(new Error('Deepgram dictation was interrupted'))
      me.epoch.endSec = streamSec
      return new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => {
          // Never insert a transcript that may be missing its last words: let the caller re-transcribe.
          log('warn', 'deepgram finalize timed out; recycling the socket', { finals: me.epoch.text().length })
          if (active === me) active = null
          closeDeepgram()
          if (lastCfg) connect(lastCfg)
          reject(new Error('Deepgram did not finish in time'))
        }, timeoutMs)
        const sentAt = Date.now()
        me.settle = (err) => {
          clearTimeout(t)
          log('info', 'deepgram dictation', { ...me.epoch.stats, audioSec: +(me.epoch.endSec - me.epoch.startSec).toFixed(2), finalizeMs: Date.now() - sentAt, ok: !err })
          if (active === me) active = null
          if (err) reject(err)
          else resolve(me.epoch.text())
        }
        finalize()
      })
    },
    abort() {
      if (active !== me) return
      active = null
      finalize() // close Deepgram's segment here so the next dictation starts clean
    }
  }
}

export function deepgramStatus(): string {
  if (lastError) return 'error: ' + lastError
  if (isOpen) return `connected (${sig.includes(HOSTS.eu) ? 'EU' : 'US'}, warm)`
  if (ws) return 'connecting'
  return 'idle (connects on demand)'
}
