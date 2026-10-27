import type { WebSocket as WsSocket } from 'ws'
import { sessionActive, verifyAccess, type Claims } from './auth.ts'
import { config } from './config.ts'
import { recordUsage, type Db } from './db.ts'
import { finishText, wordCount } from './pipeline.ts'
import { getPrefs, type Prefs } from './prefs.ts'
import { hasSpeech } from './core/vad.ts'
import { transcribeBatch, Upstream, type DgOptions, type Dictation } from './upstream.ts'

/*
 * One authenticated client connection (see ARCHITECTURE.md, "Wire protocol").
 * Audio frames are forwarded upstream the moment they arrive and also kept in memory for
 * the batch backup; both are dropped as soon as the dictation ends (nothing is stored).
 */
const BYTES_PER_SEC = 32000

export function pcm16ToFloat(b: Buffer): Float32Array {
  const out = new Float32Array(b.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2) / 32768
  return out
}

export function dgOptions(language: string, keyterms: string[]): DgOptions {
  return { key: config.deepgram.key, ws: config.deepgram.ws, http: config.deepgram.http, model: config.deepgram.model, mipOptOut: config.deepgram.mipOptOut, language, keyterms }
}

export function handleStream(
  ws: WsSocket,
  db: Db,
  ctx: { claims: Claims; prefs: Prefs; usedSec: number },
  log: (msg: string, data?: object) => void
): { prefsChanged: () => void } {
  const user = { id: ctx.claims.sub, email: ctx.claims.email }
  let exp = ctx.claims.exp
  // Cached for the connection: no database round trip on the dictation path. Updated when the
  // user saves preferences on any server instance.
  let prefs = ctx.prefs
  let usedSec = ctx.usedSec
  let usageDay = new Date().toISOString().slice(0, 10)
  const upstream = new Upstream((m, d) => log(m, { user: user.id, ...d }))
  let cur: { id: string; d: Dictation; frames: Buffer[]; bytes: number; started: number; language: string; keyterms: string[]; timer: NodeJS.Timeout } | null = null
  const send = (o: object): void => void (ws.readyState === ws.OPEN && ws.send(JSON.stringify(o)))
  // Live words are optional: drop them for a client that isn't keeping up (the final always goes).
  const sendPartial = (o: object): void => void (ws.bufferedAmount < 256 * 1024 && send(o))
  const err = (code: string, message: string, id?: string): void => send({ t: 'error', id, code, message })

  // Access tokens are short-lived; the client sends a fresh one in-band before expiry.
  const authTimer = setInterval(() => exp * 1000 <= Date.now() && ws.close(4401, 'token expired'), Math.min(5000, config.jwt.accessTtlSec * 500))
  // Flood protection: a desktop client sends ~50 audio frames a second plus a few control messages.
  let windowStart = Date.now()
  let inWindow = 0

  const prime = (): void => {
    if (!config.deepgram.key) return
    upstream.warm(dgOptions(prefs.language, prefs.dictionary.map((d) => d.word)), config.limits.primeIdleMs)
  }

  const end = async (id: string): Promise<void> => {
    const c = cur
    if (!c || c.id !== id) return err('bad_request', 'No such dictation', id)
    cur = null
    clearTimeout(c.timer)
    const audioSec = c.bytes / BYTES_PER_SEC
    const t0 = Date.now()
    let raw: string
    let via = 'stream'
    try {
      raw = await c.d.finish(config.limits.finalizeTimeoutMs)
    } catch (e) {
      // Stream failed (network, timeout): the whole clip is still here; try the batch API once.
      log('stream failed, using batch', { user: user.id, error: String((e as Error).message) })
      via = 'batch'
      const clip = Buffer.concat(c.frames)
      if (!hasSpeech(pcm16ToFloat(clip))) return err('no_speech', 'No speech detected', id) // don't pay to transcribe silence
      try {
        raw = await transcribeBatch(dgOptions(c.language, c.keyterms), clip)
      } catch (e2) {
        log('batch failed', { user: user.id, error: String((e2 as Error).message) })
        return err('upstream', 'Speech service unavailable. Try again.', id)
      }
    }
    const asrMs = Date.now() - t0
    if (!raw.trim()) return err('no_speech', 'No speech detected', id)
    const { text, polished } = await finishText(raw, prefs, config.llm)
    const totalMs = Date.now() - t0
    send({ t: 'final', id, text, ms: { asr: asrMs, total: totalMs } })
    usedSec += audioSec
    recordUsage(db, user.id, audioSec, wordCount(text)).catch((e) => log('usage write failed', { user: user.id, error: String(e.message) }))
    log('dictation', { user: user.id, via, audioSec: +audioSec.toFixed(2), asrMs, totalMs, polished, chars: text.length })
  }

  ws.on('message', (data, isBinary) => {
    const now = Date.now()
    if (now - windowStart >= 1000) ((windowStart = now), (inWindow = 0))
    if (++inWindow > config.limits.maxMessagesPerSec) return ws.close(1008, 'too many messages')
    if (isBinary) {
      if (!cur) return // stray frames after stop/cancel: ignore
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (b.length % 2) return err('bad_request', 'Audio must be 16-bit PCM', cur.id)
      if ((cur.bytes += b.length) > config.limits.maxDictationSec * BYTES_PER_SEC) return void end(cur.id)
      cur.frames.push(b)
      cur.d.push(b)
      return
    }
    let m: Record<string, unknown>
    try {
      m = JSON.parse(String(data))
    } catch {
      return err('bad_request', 'Invalid JSON')
    }
    const id = typeof m.id === 'string' && m.id.length <= 64 ? m.id : ''
    switch (m.t) {
      case 'ping':
        return send({ t: 'pong' })
      case 'auth': {
        const c = verifyAccess(config.jwt, String(m.token ?? ''))
        if (!c || c.sub !== user.id || c.sid !== ctx.claims.sid) return ws.close(4401, 'bad token')
        // Also catches a revocation whose event this instance missed (database reconnect).
        void sessionActive(db, c.sid).then(
          (ok) => (ok ? (exp = c.exp) : ws.close(4401, 'session revoked')),
          () => (exp = c.exp) // database briefly unreachable: don't cut a working dictation
        )
        return
      }
      case 'prime':
        return prime()
      case 'start': {
        if (!id) return err('bad_request', 'Missing dictation id')
        if (cur) return err('bad_request', 'A dictation is already running', id)
        if (!config.deepgram.key) return err('upstream', 'Speech service is not configured on the server.', id)
        const today = new Date().toISOString().slice(0, 10)
        if (today !== usageDay) ((usageDay = today), (usedSec = 0))
        if (config.limits.dailyAudioSec && usedSec >= config.limits.dailyAudioSec) return err('quota', "You've reached today's dictation limit. It resets at midnight UTC.", id)
        const language = typeof m.lang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$/.test(m.lang) ? m.lang : prefs.language
        const keyterms = prefs.dictionary.map((d) => d.word)
        const d = upstream.begin(dgOptions(language, keyterms), (text) => sendPartial({ t: 'partial', id, text }), config.limits.upstreamIdleMs)
        cur = { id, d, frames: [], bytes: 0, started: Date.now(), language, keyterms, timer: setTimeout(() => void end(id), (config.limits.maxDictationSec + 5) * 1000) }
        return
      }
      case 'stop':
        return void end(id)
      case 'cancel': {
        if (cur?.id !== id) return
        clearTimeout(cur.timer)
        cur.d.abort()
        cur = null
        return
      }
      default:
        return err('bad_request', 'Unknown message')
    }
  })

  ws.on('close', () => {
    clearInterval(authTimer)
    if (cur) clearTimeout(cur.timer)
    cur = null
    upstream.close()
  })
  send({ t: 'ready', user: { email: user.email } })
  return {
    prefsChanged: () =>
      void getPrefs(db, user.id).then(
        (p) => (prefs = p),
        () => {}
      )
  }
}
