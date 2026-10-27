import { app } from 'electron'
import { join } from 'node:path'
import { log } from '../log'
import type { SttProvider } from './index'

// One loaded model at a time, shared across provider instances.
type Asr = (audio: Float32Array, opts: object) => Promise<{ text: string } | { text: string }[]>
let loaded: { model: string; asr: Promise<Asr> } | null = null
let state = 'not loaded'

function load(model: string): Promise<Asr> {
  if (loaded?.model === model) return loaded.asr
  state = 'loading ' + model
  const started = Date.now()
  const asr = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    // Models download once from huggingface.co into userData, never into the project folder.
    env.cacheDir = process.env.VOICEFLOW_MODELS || join(app.getPath('userData'), 'models')
    const p = await pipeline('automatic-speech-recognition', model, { dtype: 'q8' })
    return p as unknown as Asr
  })()
  asr.then(
    () => {
      state = 'ready (' + model + ')'
      log('info', 'whisper model loaded', { model, ms: Date.now() - started })
    },
    (e) => {
      state = 'error: ' + String(e?.message ?? e)
      loaded = null
      log('error', 'whisper model failed to load', { model, error: String(e) })
    }
  )
  loaded = { model, asr }
  return asr
}

export function localWhisper(model: string): SttProvider {
  return {
    id: 'local-whisper',
    status: () => state,
    warmup: async () => void (await load(model)),
    async transcribe(pcm, language) {
      const asr = await load(model)
      const out = await asr(pcm, {
        task: 'transcribe',
        ...(language && language !== 'auto' ? { language } : {}),
        chunk_length_s: 30,
        stride_length_s: 5
      })
      return (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim()
    }
  }
}
