/*
 * Accuracy/speed benchmark, run with `npm run bench` (dev builds only).
 * Clips: LibriSpeech test-clean and test-other (real read speech, CC BY 4.0), sampled
 * evenly across each split through the Hugging Face datasets-server and cached in
 * test/bench-data. Each clip goes through the same provider code the app uses.
 * WER uses a simple normalizer (lowercase, letters/digits/apostrophes only); it does not
 * convert "1847" ↔ "eighteen forty seven" the way Whisper's paper normalizer does, so
 * numbers make these WERs slightly pessimistic compared with published figures.
 * Env: BENCH_N (clips per split, default 100), BENCH_MODELS (comma list). Besides local
 * model ids, `xai` (needs XAI_API_KEY; batch endpoint of grok-voice-transcribe-2.0, format off
 * so digits don't count as errors), `groq` (needs GROQ_API_KEY; whisper-large-v3-turbo) and
 * `deepgram` (needs DEEPGRAM_API_KEY; Nova-3 via the EU endpoint).
 */
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SttProvider } from './stt'
import { localWhisper } from './stt/local-whisper'
import { encodeWav, openAiCompatible } from './stt/openai'

function cloudXai(): SttProvider {
  return {
    id: 'xai',
    status: () => '',
    async transcribe(pcm, language) {
      const form = new FormData()
      form.append('language', language)
      form.append('file', new Blob([new Uint8Array(encodeWav(pcm))], { type: 'audio/wav' }), 'audio.wav') // must be last
      const r = await fetch('https://api.x.ai/v1/stt', { method: 'POST', headers: { authorization: `Bearer ${process.env.XAI_API_KEY}` }, body: form })
      if (!r.ok) throw new Error(`xAI ${r.status}: ${(await r.text()).slice(0, 200)}`)
      return String((await r.json()).text ?? '').trim()
    }
  }
}

/** Deepgram Nova-3, prerecorded endpoint (same model as streaming). EU region: closest to India. */
function cloudDeepgram(): SttProvider {
  return {
    id: 'deepgram',
    status: () => '',
    async transcribe(pcm, language) {
      const q = new URLSearchParams({ model: 'nova-3', language, punctuate: 'true' })
      const r = await fetch(`https://api.eu.deepgram.com/v1/listen?${q}`, {
        method: 'POST',
        headers: { authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'content-type': 'audio/wav' },
        body: new Uint8Array(encodeWav(pcm))
      })
      if (!r.ok) throw new Error(`Deepgram ${r.status}: ${(await r.text()).slice(0, 200)}`)
      return String((await r.json()).results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
    }
  }
}

function providerFor(model: string): SttProvider {
  if (model === 'deepgram') return cloudDeepgram()
  if (model === 'xai') return cloudXai()
  if (model === 'groq') return openAiCompatible('https://api.groq.com/openai/v1', 'whisper-large-v3-turbo', () => process.env.GROQ_API_KEY ?? '')
  return localWhisper(model)
}

const SPLITS = [
  { name: 'test-clean', config: 'clean' },
  { name: 'test-other', config: 'other' }
]
const N = Number(process.env.BENCH_N || 100)
const MODELS = (process.env.BENCH_MODELS || 'onnx-community/whisper-tiny,onnx-community/whisper-base,onnx-community/whisper-small').split(',')
const API = 'https://datasets-server.huggingface.co/rows?dataset=openslr/librispeech_asr'

interface Clip { id: string; text: string; pcm: Float32Array }

export function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9']+/g, ' ').replace(/(^|\s)'|'(\s|$)/g, ' ').split(/\s+/).filter(Boolean)
}

/** Word-level edit distance. */
export function edits(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i]
    for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[hyp.length]
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

/** Decode FLAC to 16 kHz mono with Chromium (no ffmpeg needed). */
async function decode(win: BrowserWindow, flac: Buffer): Promise<Float32Array> {
  const b64: string = await win.webContents.executeJavaScript(`(async () => {
    const b = Uint8Array.from(atob(${JSON.stringify(flac.toString('base64'))}), (c) => c.charCodeAt(0))
    const f = (await new OfflineAudioContext(1, 1, 16000).decodeAudioData(b.buffer)).getChannelData(0)
    const u = new Uint8Array(f.buffer); let s = ''
    for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768))
    return btoa(s)
  })()`)
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
}

async function loadSplit(win: BrowserWindow, split: (typeof SPLITS)[number]): Promise<Clip[]> {
  const dir = join(app.getAppPath(), 'test', 'bench-data', split.name)
  mkdirSync(dir, { recursive: true })
  const indexFile = join(dir, `index-${N}.json`)
  if (!existsSync(indexFile)) {
    const base = `${API}&config=${split.config}&split=test`
    const total: number = (await getJson(`${base}&offset=0&length=1`)).num_rows_total
    const blocks = Math.ceil(N / 10)
    const index: { id: string; text: string }[] = []
    for (let b = 0; b < blocks; b++) {
      const rows = (await getJson(`${base}&offset=${Math.floor((b * total) / blocks)}&length=10`)).rows
      for (const { row } of rows.slice(0, N - index.length)) {
        const f32 = join(dir, row.id + '.f32')
        if (!existsSync(f32)) {
          const flac = Buffer.from(await (await fetch(row.audio[0].src)).arrayBuffer())
          writeFileSync(f32, await decode(win, flac))
        }
        index.push({ id: row.id, text: row.text })
      }
      process.stdout.write(`BENCH data ${split.name} ${index.length}/${N}\r`)
    }
    writeFileSync(indexFile, JSON.stringify(index))
  }
  return (JSON.parse(readFileSync(indexFile, 'utf8')) as { id: string; text: string }[]).map((c) => {
    const b = readFileSync(join(dir, c.id + '.f32'))
    return { ...c, pcm: new Float32Array(b.buffer, b.byteOffset, b.length / 4) }
  })
}

export async function runBench(): Promise<void> {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('about:blank')
  const data = []
  for (const s of SPLITS) data.push({ split: s.name, clips: await loadSplit(win, s) })
  win.destroy()

  const results = []
  for (const model of MODELS) {
    const p = providerFor(model)
    let t = Date.now()
    await p.warmup?.()
    const loadMs = Date.now() - t
    await p.transcribe(data[0].clips[0].pcm, 'en') // first inference is slower (graph init); not counted
    for (const { split, clips } of data) {
      let errs = 0, refWords = 0, procMs = 0, audioS = 0
      const worst: { id: string; ref: string; hyp: string; wer: number }[] = []
      for (const c of clips) {
        t = Date.now()
        const hyp = await p.transcribe(c.pcm, 'en')
        procMs += Date.now() - t
        audioS += c.pcm.length / 16000
        const r = words(c.text), e = edits(r, words(hyp))
        errs += e
        refWords += r.length
        worst.push({ id: c.id, ref: c.text.toLowerCase(), hyp, wer: e / r.length })
      }
      const row = {
        model, split, clips: clips.length, words: refWords,
        wer: +((100 * errs) / refWords).toFixed(2),
        avgClipS: +(audioS / clips.length).toFixed(1),
        avgLatencyMs: Math.round(procMs / clips.length),
        rtf: +(procMs / 1000 / audioS).toFixed(3),
        loadMs,
        worst: worst.sort((a, b) => b.wer - a.wer).slice(0, 3)
      }
      results.push(row)
      console.log(`BENCH ${model} ${split} WER ${row.wer}% | ${row.avgLatencyMs} ms per ${row.avgClipS}s clip | RTF ${row.rtf}`)
    }
  }
  const out = join(app.getAppPath(), 'test', 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'bench.json'), JSON.stringify({ at: new Date().toISOString(), cpu: process.env.PROCESSOR_IDENTIFIER, results }, null, 2))
  app.exit(0)
}
