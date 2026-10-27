/*
 * Audio front-end A/B (dev only): `npm run bench:frontend`. Free: local Whisper scores it.
 *
 * Builds a "soft voice in a noisy room" stimulus from cached LibriSpeech clips (run
 * `npm run bench` once to fetch them): every clip is turned down to a quiet speaking level and
 * steady background noise is added. Chromium plays that file as the microphone, and it is
 * captured once per capture setting (noise suppression / auto gain / raw), exactly as the app
 * captures audio, then transcribed and scored by word error rate.
 */
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { edits, words } from './bench'
import { localWhisper } from './stt/local-whisper'
import { encodeWav } from './stt/openai'

const SPEECH_RMS = 0.006 // ≈ -44 dBFS: a soft voice at laptop-mic distance
const NOISE_RMS = 0.0015 // steady room/fan noise ≈ -56 dBFS (≈12 dB SNR)
const CLIPS = 10

/** Deterministic noise so every run hears the same room. */
function noise(n: number): Float32Array {
  let x = 12345
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // Sum of 4 uniforms ≈ Gaussian, scaled to NOISE_RMS (uniform(-1,1) has RMS 1/√3).
    let s = 0
    for (let k = 0; k < 4; k++) s += ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1
    out[i] = (s / 2) * Math.sqrt(3) * NOISE_RMS
  }
  return out
}

export const stimulusPath = (root: string): string => join(root, 'test', 'out', 'frontend-stimulus.wav')

/** Writes the stimulus WAV and returns its reference text. Pure file work, safe before app ready. */
export function makeStimulus(root: string): { refs: string[]; seconds: number; segs: [number, number][]; signal: Float32Array } {
  const dir = join(root, 'test', 'bench-data', 'test-clean')
  const index = ['index-50.json', 'index-100.json', 'index-10.json'].map((f) => join(dir, f)).find(existsSync)
  if (!index) throw new Error('Run `npm run bench` once first to download the LibriSpeech clips.')
  const all = JSON.parse(readFileSync(index, 'utf8')) as { id: string; text: string }[]
  const picked = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / CLIPS)) === 0).slice(0, CLIPS)
  const parts: Float32Array[] = [new Float32Array(16000 * 1.5)]
  const segs: [number, number][] = []
  let at = 16000 * 1.5
  for (const c of picked) {
    const b = readFileSync(join(dir, c.id + '.f32'))
    const pcm = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))
    const rms = Math.sqrt(pcm.reduce((a, v) => a + v * v, 0) / pcm.length)
    parts.push(pcm.map((v) => (v / rms) * SPEECH_RMS), new Float32Array(16000 * 0.8))
    segs.push([at, at + pcm.length])
    at += pcm.length + 16000 * 0.8
  }
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = noise(total)
  let o = 0
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) out[o + i] += p[i]
    o += p.length
  }
  mkdirSync(join(root, 'test', 'out'), { recursive: true })
  writeFileSync(stimulusPath(root), encodeWav(out))
  return { refs: picked.map((c) => c.text), seconds: total / 16000, segs, signal: out }
}

const CONDITIONS = [
  { name: 'noise suppression + auto gain (old default)', ns: true, agc: true },
  { name: 'auto gain only', ns: false, agc: true },
  { name: 'raw (no processing)', ns: false, agc: false }
]

export async function runFrontendBench(): Promise<void> {
  try {
    await frontendBench()
  } catch (e) {
    console.log('FRONTEND failed: ' + String((e as Error)?.message ?? e))
    app.exit(1)
  }
}

async function frontendBench(): Promise<void> {
  const root = app.getAppPath()
  const { refs, seconds, segs, signal } = makeStimulus(root) // same content as the file the fake mic is playing
  // A file:// page: getUserMedia needs a secure context (data: URLs are not).
  const page = join(root, 'test', 'out', 'frontend-bench.html')
  writeFileSync(page, '<!doctype html><title>front-end bench</title>')
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await win.loadFile(page)
  const asr = localWhisper('onnx-community/whisper-base')
  await asr.warmup!()
  const ref = words(refs.join(' '))
  // Where does the stimulus start inside a capture? Match 20 ms energy envelopes over ±3 s.
  const env = (x: Float32Array): number[] => {
    const e: number[] = []
    for (let i = 0; i + 320 <= x.length; i += 320) {
      let a = 0
      for (let j = i; j < i + 320; j++) a += x[j] * x[j]
      e.push(Math.log(a / 320 + 1e-9))
    }
    // Standardize, so captures with very different noise floors still line up on speech shape.
    const m = e.reduce((x, y) => x + y, 0) / e.length
    const sd = Math.sqrt(e.reduce((x, y) => x + (y - m) ** 2, 0) / e.length) || 1
    return e.map((v) => (v - m) / sd)
  }
  const refEnv = env(signal)
  // The fake mic loops the file continuously, so a capture can begin anywhere in the loop:
  // find the rotation that best matches (all offsets, 20 ms resolution).
  const lagOf = (cap: Float32Array): number => {
    const ce = env(cap)
    const n = refEnv.length
    let best = 0
    let bestScore = -Infinity
    for (let L = 0; L < n; L++) {
      let sc = 0
      for (let j = 0; j < Math.min(n, ce.length); j++) sc += ce[j] * refEnv[(j + L) % n]
      if (sc > bestScore) ((bestScore = sc), (best = L))
    }
    return best * 320 // capture sample j ↔ stimulus sample (j + lag) mod length
  }
  /** Transcribe each clip on its own (like real, short dictations) and total the errors. */
  const score = async (audio: Float32Array, lag: number): Promise<number> => {
    let errs = 0
    const n = signal.length
    for (let k = 0; k < segs.length; k++) {
      const [a, b] = segs[k]
      const at = (a - lag + n) % n // where clip k starts in this capture
      if (at + (b - a) + 3200 > audio.length) {
        // Wrapped across the capture's end: it also appears one loop earlier.
        if (at - n >= 3200) {
          const hyp = await asr.transcribe(audio.slice(at - n - 3200, at - n + (b - a) + 3200), 'en')
          errs += edits(words(refs[k]), words(hyp))
          continue
        }
        errs += words(refs[k]).length // not captured whole: count as all wrong (rare)
        continue
      }
      const hyp = await asr.transcribe(audio.slice(Math.max(0, at - 3200), at + (b - a) + 3200), 'en')
      errs += edits(words(refs[k]), words(hyp))
    }
    return +((100 * errs) / ref.length).toFixed(1)
  }
  const rows = []
  for (const c of CONDITIONS) {
    // Capture exactly like the app: 16 kHz context, echo cancellation off, the given NS/AGC.
    const b64: string = await win.webContents.executeJavaScript(`(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: ${c.ns}, autoGainControl: ${c.agc} } })
      const ctx = new AudioContext({ sampleRate: 16000 }), parts = []
      // Same as the app: an AudioWorklet on the audio thread (a ScriptProcessor drops audio when busy).
      const code = "class C extends AudioWorkletProcessor { process(i) { const c = i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true } } registerProcessor('cap', C)"
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
      const node = new AudioWorkletNode(ctx, 'cap', { numberOfOutputs: 0 })
      node.port.onmessage = (e) => parts.push(e.data)
      ctx.createMediaStreamSource(s).connect(node)
      await new Promise((r) => setTimeout(r, ${Math.ceil((seconds + 1) * 1000)}))
      s.getTracks().forEach((t) => t.stop()); await ctx.close()
      const n = parts.reduce((a, x) => a + x.length, 0), f = new Float32Array(n); let o = 0
      for (const x of parts) { f.set(x, o); o += x.length }
      const u = new Uint8Array(f.buffer); let str = ''
      for (let i = 0; i < u.length; i += 32768) str += String.fromCharCode(...u.subarray(i, i + 32768))
      return btoa(str)
    })()`)
    const buf = Buffer.from(b64, 'base64')
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
    const lag = lagOf(pcm)
    console.log(`FRONTEND (${c.name}: capture began ${(lag / 16000).toFixed(2)} s into the looping stimulus)`)
    for (const [label, audio] of [[c.name, pcm]] as const) {
      const wer = await score(audio, lag)
      const r = Math.sqrt(audio.reduce((a, v) => a + v * v, 0) / audio.length)
      const clipped = audio.reduce((a, v) => a + (Math.abs(v) >= 0.999 ? 1 : 0), 0)
      rows.push({ condition: label, wer, rms: +r.toFixed(4), clippedSamples: clipped })
      console.log(`FRONTEND ${label}: WER ${wer}% | level RMS ${r.toFixed(4)} | clipped samples ${clipped} | ${(audio.length / 16000).toFixed(1)} s captured`)
      if (process.env.FRONTEND_SAVE) writeFileSync(join(root, 'test', 'out', `frontend-${rows.length}.wav`), encodeWav(audio))
    }
  }
  writeFileSync(join(root, 'test', 'out', 'frontend-bench.json'), JSON.stringify({ at: new Date().toISOString(), speechRms: SPEECH_RMS, noiseRms: NOISE_RMS, rows }, null, 2))
  app.exit(0)
}
