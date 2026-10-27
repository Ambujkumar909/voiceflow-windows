import { Epoch, type DgResult } from './core/deepgram-epoch.ts'

/*
 * One Deepgram streaming socket per client session, opened ahead of use ("prime") so a
 * dictation never waits for a handshake; KeepAlive while idle (not billed), closed after
 * IDLE_MS. Frames are forwarded the moment they arrive; Finalize goes out with stop.
 * Results are matched to dictations by audio time (deepgram-epoch.ts, shared with the client).
 */
export interface DgOptions {
  key: string
  ws: string
  http: string
  model: string
  mipOptOut: boolean
  language: string
  keyterms: string[]
}

export interface Dictation {
  push(pcm: Buffer): void
  finish(timeoutMs: number): Promise<string>
  abort(): void
}

// Node Buffers may sit on a shared pool; WebSocket.send wants a plain ArrayBuffer view.
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => b as unknown as Uint8Array<ArrayBuffer>
const KEEPALIVE_MS = 4000
const MAX_BUFFERED = 5 * 32000 // >5 s of audio stuck in our send buffer = upstream too slow
const BYTES_PER_SEC = 32000

export function listenParams(o: DgOptions, streaming: boolean): URLSearchParams {
  const q = new URLSearchParams({
    model: o.model,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    smart_format: 'true',
    punctuate: 'true',
    dictation: 'true',
    language: o.language && o.language !== 'auto' ? o.language : 'multi'
  })
  if (streaming) (q.set('interim_results', 'true'), q.set('endpointing', '300'))
  if (o.mipOptOut) q.set('mip_opt_out', 'true')
  for (const k of o.keyterms.slice(0, 100)) q.append('keyterm', k.slice(0, 50))
  return q
}

/** Backup path: the whole buffered clip through Deepgram's batch API. */
export async function transcribeBatch(o: DgOptions, pcm: Buffer, timeoutMs = 15_000): Promise<string> {
  const r = await fetch(`${o.http}/v1/listen?${listenParams(o, false)}`, {
    method: 'POST',
    headers: { authorization: `Token ${o.key}`, 'content-type': 'application/octet-stream' },
    body: new Uint8Array(pcm),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!r.ok) throw new Error(`Deepgram batch HTTP ${r.status}`)
  const j = (await r.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } }
  return String(j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
}

export class Upstream {
  private ws: WebSocket | null = null
  private sig = ''
  private open = false
  private streamSec = 0
  private queue: Buffer[] = []
  private pendingFinalize = false
  private active: { epoch: Epoch; onPartial: (t: string) => void; settle?: (e?: Error) => void } | null = null
  private keepAlive?: NodeJS.Timeout
  private idle?: NodeJS.Timeout
  private idleUntil = 0
  private onLog: (msg: string, data?: object) => void

  constructor(onLog: (msg: string, data?: object) => void) {
    this.onLog = onLog
  }

  /** Ensure a socket for these options is open or opening. Cheap to call often. */
  warm(o: DgOptions, idleMs: number): void {
    const url = `${o.ws}/v1/listen?${listenParams(o, true)}`
    // Keep the later deadline: a quick prime never shortens the window a real dictation earned.
    const armIdle = (): void => {
      const until = Date.now() + idleMs
      if (until <= this.idleUntil) return
      clearTimeout(this.idle)
      this.idleUntil = until
      this.idle = setTimeout(() => this.close(), idleMs)
    }
    if (this.ws && this.sig === url && this.ws.readyState <= WebSocket.OPEN) return armIdle()
    this.close() // (clears the idle timer, so it is armed again below)
    armIdle()
    this.sig = url
    this.streamSec = 0
    this.pendingFinalize = false
    const started = Date.now()
    const sock = new WebSocket(url, { headers: { Authorization: `Token ${o.key}` } } as unknown as string[])
    sock.binaryType = 'arraybuffer'
    this.ws = sock
    sock.onopen = () => {
      if (this.ws !== sock) return
      this.open = true
      this.onLog('upstream open', { ms: Date.now() - started })
      for (const b of this.queue.splice(0)) sock.send(bytes(b))
      if (this.pendingFinalize) sock.send('{"type":"Finalize"}')
      this.pendingFinalize = false
      this.keepAlive = setInterval(() => !this.active && sock.readyState === WebSocket.OPEN && sock.send('{"type":"KeepAlive"}'), KEEPALIVE_MS)
    }
    sock.onmessage = (m) => {
      const a = this.active
      if (this.ws !== sock || !a) return
      let r: DgResult
      try {
        r = JSON.parse(String(m.data))
      } catch {
        return
      }
      if (!a.epoch.accept(r)) return
      a.onPartial(a.epoch.live())
      if (a.epoch.done) a.settle?.()
    }
    sock.onclose = (ev) => {
      if (this.ws !== sock) return
      this.onLog('upstream closed', { code: ev.code, wasOpen: this.open })
      this.ws = null
      this.open = false
      this.sig = ''
      clearInterval(this.keepAlive)
      this.fail(new Error(`upstream closed (${ev.code})`))
    }
  }

  private fail(e: Error): void {
    const a = this.active
    this.active = null
    a?.settle?.(e)
  }

  begin(o: DgOptions, onPartial: (t: string) => void, idleMs: number): Dictation {
    this.warm(o, idleMs)
    this.fail(new Error('superseded'))
    const me = { epoch: new Epoch(this.streamSec), onPartial } as NonNullable<Upstream['active']>
    this.active = me
    const finalize = (): void => {
      if (this.ws && this.open) this.ws.send('{"type":"Finalize"}')
      else this.pendingFinalize = true
    }
    return {
      push: (pcm) => {
        if (this.active !== me) return
        this.streamSec += pcm.length / BYTES_PER_SEC
        if (this.ws && this.open) {
          // Upstream can't keep up: stop feeding it; the caller falls back to the batch API.
          if (this.ws.bufferedAmount > MAX_BUFFERED) return this.close()
          this.ws.send(bytes(pcm))
        } else if (this.queue.reduce((a, b) => a + b.length, 0) < MAX_BUFFERED) this.queue.push(pcm)
        else this.close() // still not connected after 5 s of audio: give up on streaming
      },
      finish: (timeoutMs: number) => {
        if (this.active !== me) return Promise.reject(new Error('dictation interrupted'))
        me.epoch.endSec = this.streamSec
        return new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => {
            if (this.active === me) this.active = null
            this.close() // a socket that misses a Finalize is suspect: start fresh next time
            reject(new Error('upstream finalize timeout'))
          }, timeoutMs)
          me.settle = (err) => {
            clearTimeout(t)
            if (this.active === me) this.active = null
            if (err) reject(err)
            else resolve(me.epoch.text())
          }
          finalize()
        })
      },
      abort: () => {
        if (this.active !== me) return
        this.active = null
        finalize() // cut Deepgram's segment here so the next dictation starts clean
      }
    }
  }

  close(): void {
    clearInterval(this.keepAlive)
    clearTimeout(this.idle)
    this.idleUntil = 0
    const s = this.ws
    this.ws = null
    this.open = false
    this.sig = ''
    this.queue = []
    this.fail(new Error('upstream closed'))
    if (s && s.readyState === WebSocket.OPEN) s.send('{"type":"CloseStream"}')
    s?.close()
  }
}
