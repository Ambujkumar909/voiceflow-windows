import type { SttProvider } from './index'

/** 16-bit PCM WAV, 16 kHz mono. */
export function encodeWav(pcm: Float32Array, rate = 16000): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + pcm.length * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(pcm.length * 2, 40)
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2)
  return b
}

/**
 * Any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, local servers).
 * The key is read in the main process at call time and never reaches a renderer.
 */
export function openAiCompatible(baseUrl: string, model: string, apiKey: () => string): SttProvider {
  return {
    id: 'openai',
    status: () => (apiKey() ? `ready (${baseUrl}, ${model})` : 'no API key set'),
    async transcribe(pcm, language) {
      const key = apiKey()
      if (!key) throw new Error('No API key set. Add one in Settings → Speech-to-text.')
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(encodeWav(pcm))], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', model)
      if (language && language !== 'auto') form.append('language', language)
      const res = await fetch(baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(60_000)
      })
      if (!res.ok) throw new Error(`Transcription API error ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as { text?: string }
      return (json.text ?? '').trim()
    }
  }
}
