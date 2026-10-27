/*
 * xAI Grok Voice Transcribe streaming (wss://api.x.ai/v1/stt), per docs.x.ai (Oct 2026):
 * Bearer auth header, query-string config, wait for `transcript.created`, send raw
 * 16-bit PCM binary frames, end with {"type":"audio.done"}, read `transcript.done`.
 * The socket opens when recording starts, so most of the transcript is ready by the time
 * the user releases the key; audio captured before the socket is ready is queued.
 */

// Languages xAI can format (numbers, punctuation) when `format=true` is set.
const FORMAT_LANGS = ['ar', 'de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'sv', 'vi', 'zh']

export interface StreamSession {
  push(pcm: Float32Array): void
  /** Sends audio.done and resolves with the final transcript. */
  finish(timeoutMs?: number): Promise<string>
  abort(): void
}

export interface XaiOptions {
  url: string
  model: string
  apiKey: string
  language: string
  keyterms: string[]
  onText(live: string): void
}

export function openXaiStream(o: XaiOptions): StreamSession {
  const q = new URLSearchParams({ model: o.model, sample_rate: '16000', encoding: 'pcm', interim_results: 'true' })
  if (o.language && o.language !== 'auto') {
    q.set('language', o.language)
    if (FORMAT_LANGS.includes(o.language)) q.set('format', 'true')
  }
  for (const k of o.keyterms.slice(0, 100)) q.append('keyterm', k.slice(0, 50))
  // Node's WebSocket (undici) accepts headers; browsers cannot, which is why this lives in main.
  const ws = new WebSocket(`${o.url}?${q}`, { headers: { Authorization: `Bearer ${o.apiKey}` } } as unknown as string[])
  const DONE = JSON.stringify({ type: 'audio.done' })

  let ready = false
  let ended = false
  const queue: ArrayBuffer[] = []
  // Live preview: finished utterances + finalized chunks of the current one + the interim guess.
  let committed: string[] = []
  let chunks: string[] = []
  let interim = ''
  const live = (): string => [...committed, ...chunks, interim].filter(Boolean).join(' ')

  let resolve!: (t: string) => void
  let reject!: (e: Error) => void
  const result = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)))
  result.catch(() => {})

  ws.onmessage = (m) => {
    let e: { type?: string; text?: string; message?: string; is_final?: boolean; speech_final?: boolean }
    try {
      e = JSON.parse(String(m.data))
    } catch {
      return
    }
    if (e.type === 'transcript.created') {
      ready = true
      for (const b of queue.splice(0)) ws.send(b)
      if (ended) ws.send(DONE)
    } else if (e.type === 'transcript.partial') {
      const text = (e.text ?? '').trim()
      if (e.is_final && e.speech_final) ((committed = [...committed, text]), (chunks = []), (interim = ''))
      else if (e.is_final) ((chunks = [...chunks, text]), (interim = ''))
      else interim = text
      o.onText(live())
    } else if (e.type === 'transcript.done') {
      resolve((e.text ?? '').trim() || live())
    } else if (e.type === 'error') {
      reject(new Error(`xAI: ${e.message ?? 'error'}`))
    }
  }
  ws.onerror = () => reject(new Error('xAI connection failed (check the API key and network)'))
  ws.onclose = (ev) => reject(new Error(`xAI connection closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''})`)) // no-op once resolved

  return {
    push(pcm) {
      const b = new Int16Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) b[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7fff
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(b.buffer)
      else queue.push(b.buffer)
    },
    finish(timeoutMs = 8000) {
      ended = true
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(DONE)
      const t = setTimeout(() => reject(new Error('xAI did not return a transcript in time')), timeoutMs)
      return result.finally(() => {
        clearTimeout(t)
        ws.close()
      })
    },
    abort() {
      ended = true
      reject(new Error('aborted'))
      ws.close()
    }
  }
}
