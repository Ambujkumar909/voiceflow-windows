import { randomUUID } from 'node:crypto'
import { accessExpiry, accessToken, endpoints, isSignedIn } from '../account'
import { log } from '../log'

/*
 * The one connection to the VoiceFlow server (ARCHITECTURE.md, "Wire protocol").
 *  - Opened at sign-in/start-up and kept open: a dictation never waits for TCP/TLS setup.
 *  - Authenticated on upgrade; a fresh access token is sent in-band before the old expires.
 *  - Reconnects with jittered backoff (0.5 s → 30 s); nothing, not even audio, bypasses it.
 *  - Sends only control messages and the 16-bit PCM frames of a dictation in progress.
 *
 * Failure handling, so the network is never flooded and nothing is sent twice:
 *  - Audio is queued only while a connection is being made, and at most 5 s of it; the queue is
 *    dropped when the dictation settles, so it can never be replayed after a backup upload.
 *  - finish() fails fast when there is no connection, and a heartbeat watchdog (3 s) drops a
 *    connection that silently died; the caller then uploads the clip over HTTPS once.
 *  - If outgoing audio backs up (very slow uplink), the dictation switches to the upload path.
 */
export interface StreamSession {
  push(pcm: Float32Array): void
  /** Resolves with the server's fully processed text; rejects with `code` on failure. */
  finish(): Promise<string>
  abort(): void
}

const MAX_QUEUED = 5 * 32000 // bytes of audio held while (re)connecting
const MAX_IN_FLIGHT = 5 * 32000 // bytes the socket may have unsent before we give up streaming
const WATCHDOG_MS = 3000 // silence from the server while we wait for a final = connection is dead
const FINISH_CAP_MS = 20_000 // > server worst case (2.5 s stream timeout + 15 s batch backup)
const CONNECT_GRACE_MS = 1500 // at stop, wait this long for an in-progress connect before uploading
const PRIME_EVERY_MS = 15_000
const CONNECT_TIMEOUT_MS = 10_000
const IDLE_DEAD_MS = 45_000

let ws: WebSocket | null = null
let open = false
let backoff = 500
let retry: NodeJS.Timeout | undefined
let nextAttempt = 0 // backoff deadline: nothing may reconnect before it
let ping: NodeJS.Timeout | undefined
let tokenTimer: NodeJS.Timeout | undefined
let lastServerMsg = 0
let lastPrime = 0
let attempts = 0
let state = 'not connected'
let outbox: (string | ArrayBuffer)[] = []
let queued = 0
let active: { id: string; onLive: (t: string) => void; lost: boolean; early?: Error; settle?: (err: Error | null, text?: string) => void } | null = null

export const streamStatus = (): string => state
/** Connection attempts so far (lets tests prove reconnects back off). */
export const connectAttempts = (): number => attempts

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

function sendRaw(m: string | ArrayBuffer): void {
  if (ws && open) {
    ws.send(m)
    return
  }
  const n = typeof m === 'string' ? 0 : m.byteLength
  if (queued + n > MAX_QUEUED) {
    // Not connected for 5 s of audio: stop queuing; this dictation goes through the upload path.
    outbox = []
    queued = 0
    if (active) active.lost = true
    return
  }
  outbox.push(m)
  queued += n
  connectStream()
}

/** Tear down the current socket at once (without waiting for a close handshake) and retry later. */
function drop(sock: WebSocket, reason: string, code?: number): void {
  if (ws !== sock) return
  ws = null
  open = false
  clearInterval(ping)
  clearInterval(tokenTimer)
  outbox = [] // a dictation in flight fails over to the upload path; never replay it
  queued = 0
  state = code === 4401 ? 'reconnecting (session refresh)' : 'reconnecting'
  log('warn', 'server stream closed', { reason, code })
  if (active) active.lost = true
  active?.settle?.(fail('connection', 'Connection to VoiceFlow lost'))
  try {
    sock.close()
  } catch {
    /* already closed */
  }
  scheduleRetry(code === 4401 ? 0 : undefined)
}

/** Open the connection; respects the reconnect backoff unless `force` (sign-in, retry timer). */
export function connectStream(force = false): void {
  if (ws || !isSignedIn()) return
  if (!force && Date.now() < nextAttempt) return
  attempts++
  clearTimeout(retry)
  state = 'connecting'
  void (async () => {
    let token: string
    let url: string
    try {
      token = await accessToken()
      url = endpoints().ws + '/v1/stream'
    } catch (e) {
      state = 'not connected: ' + (e as Error).message
      return scheduleRetry()
    }
    if (ws) return // another attempt won the race
    const sock = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[])
    ws = sock
    const t0 = Date.now()
    sock.onmessage = (m) => {
      lastServerMsg = Date.now()
      let msg: { t?: string; id?: string; text?: string; code?: string; message?: string }
      try {
        msg = JSON.parse(String(m.data))
      } catch {
        return
      }
      if (msg.t === 'ready') {
        open = true
        backoff = 500
        state = 'connected'
        log('info', 'server stream connected', { ms: Date.now() - t0 })
        for (const o of outbox) sock.send(o)
        outbox = []
        queued = 0
        return
      }
      const a = active
      if (!a || msg.id !== a.id) return
      if (msg.t === 'partial') a.onLive(String(msg.text ?? ''))
      else if (msg.t === 'final') a.settle?.(null, String(msg.text ?? ''))
      else if (msg.t === 'error') {
        const e = fail(String(msg.code ?? 'server'), String(msg.message ?? 'Server error'))
        if (a.settle) a.settle(e)
        else a.early ??= e // refused at start (e.g. daily limit): report it on release, not "no such dictation"
      }
    }
    sock.onclose = (ev) => drop(sock, 'closed', ev.code)
    // A black-holed network can leave a connect hanging forever: give up after 10 s and back off.
    setTimeout(() => !open && ws === sock && drop(sock, 'connect timeout'), CONNECT_TIMEOUT_MS)
    // Idle heartbeat: the server answers every ping, so 45 s of silence means a dead connection;
    // replace it now rather than discovering it at the next dictation.
    ping = setInterval(() => {
      if (!open) return
      if (Date.now() - lastServerMsg > IDLE_DEAD_MS) return drop(sock, 'idle heartbeat lost')
      sock.send('{"t":"ping"}')
    }, 20_000)
    // Keep the server's view of the token fresh without reconnecting.
    tokenTimer = setInterval(() => {
      if (!open || accessExpiry() - Date.now() > 120_000) return
      void accessToken().then((t) => open && ws === sock && sock.send(JSON.stringify({ t: 'auth', token: t }))).catch(() => {})
    }, 30_000)
  })()
}

function scheduleRetry(delay?: number): void {
  if (!isSignedIn()) return
  clearTimeout(retry)
  const d = delay ?? backoff
  nextAttempt = Date.now() + d
  retry = setTimeout(() => connectStream(true), d)
  backoff = Math.min(30_000, backoff * 2) * (0.75 + Math.random() / 2)
}

export function disconnectStream(): void {
  clearTimeout(retry)
  clearInterval(ping)
  clearInterval(tokenTimer)
  nextAttempt = 0
  backoff = 500
  const s = ws
  ws = null
  open = false
  outbox = []
  queued = 0
  state = 'not connected'
  s?.close()
}

/** The user may dictate soon: have the server warm its speech connection (throttled). */
export function primeStream(): void {
  if (!isSignedIn()) return
  if (!open) return connectStream()
  if (Date.now() - lastPrime < PRIME_EVERY_MS) return
  lastPrime = Date.now()
  ws!.send('{"t":"prime"}')
}

export function beginStream(language: string, onLive: (text: string) => void): StreamSession {
  const id = randomUUID()
  const me: NonNullable<typeof active> = { id, onLive, lost: false }
  active?.settle?.(new Error('superseded'))
  active = me
  outbox = [] // anything left from an earlier dictation is stale
  queued = 0
  sendRaw(JSON.stringify({ t: 'start', id, lang: language, mode: 'dictation' }))
  const done = (): void => {
    if (active === me) active = null
    if (!open) ((outbox = []), (queued = 0)) // never send a settled dictation later
  }
  return {
    push(pcm) {
      if (active !== me || me.lost) return
      if (ws && open && ws.bufferedAmount > MAX_IN_FLIGHT) {
        me.lost = true // uplink can't keep up: finish via a single upload instead
        ws.send(JSON.stringify({ t: 'cancel', id }))
        return
      }
      const b = new Int16Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) b[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7fff
      sendRaw(b.buffer)
    },
    async finish() {
      if (active !== me) throw fail('connection', 'interrupted')
      if (me.early) {
        done()
        throw me.early
      }
      if (!me.lost && !open && ws) {
        // A connection is being made right now; give it a moment before falling back.
        const t0 = Date.now()
        while (!open && ws && Date.now() - t0 < CONNECT_GRACE_MS) await new Promise((r) => setTimeout(r, 50))
      }
      if (me.lost || !open) {
        done()
        throw fail('connection', 'Not connected to VoiceFlow')
      }
      const sock = ws!
      return new Promise<string>((resolve, reject) => {
        const started = Date.now()
        lastServerMsg = Date.now()
        // Heartbeat while waiting: the server answers pings at once, even while it works.
        const watch = setInterval(() => {
          if (Date.now() - started > FINISH_CAP_MS) return me.settle?.(fail('timeout', 'VoiceFlow did not answer in time'))
          if (Date.now() - lastServerMsg > WATCHDOG_MS) return drop(sock, 'server silent') // settles with "connection"
          if (open) sock.send('{"t":"ping"}')
        }, 1000)
        me.settle = (err, text) => {
          clearInterval(watch)
          done()
          if (err) reject(err)
          else resolve(text ?? '')
        }
        sendRaw(JSON.stringify({ t: 'stop', id }))
      })
    },
    abort() {
      if (active !== me) return
      if (open) ws!.send(JSON.stringify({ t: 'cancel', id }))
      done()
    }
  }
}
