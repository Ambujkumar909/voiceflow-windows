import workletUrl from './pcm-worklet.js?url&no-inline' // a data: URL would be blocked by the CSP

/*
 * Microphone capture. An AudioWorklet delivers 16 kHz mono Float32 PCM in 20 ms chunks that
 * are streamed live (onChunk) and also kept, so the whole clip can be handed over at the end.
 *
 * Two modes:
 *  - On demand: the mic opens on start and closes on stop. Opening takes Windows ~100–300 ms,
 *    so the first word can be clipped.
 *  - Ready ("armed"): the mic stays open and the last PRE_ROLL of audio is kept in memory only.
 *    Start is instant and that pre-roll is prepended, so a word begun as the keys go down is
 *    kept. Nothing leaves this buffer unless a dictation starts.
 */
import type { AudioProcessing } from '../../shared/types'

const PRE_ROLL_CHUNKS = 25 // 25 × 20 ms = 500 ms

/*
 * Capture settings. Speech engines are trained on noisy audio, and client-side noise suppression
 * removes parts of quiet speech (Deepgram's and Google's guidance; Braun & Gamper 2021), so it is
 * off unless chosen. Echo cancellation is always off: dictation has no far end.
 */
const CONSTRAINTS: Record<AudioProcessing, MediaTrackConstraints> = {
  raw: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  gain: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  denoise: { echoCancellation: false, noiseSuppression: true, autoGainControl: true }
}

interface Mic {
  deviceId: string
  processing: AudioProcessing
  stream: MediaStream
  src: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  analyser: AnalyserNode
}

let mic: Mic | null = null
let armed = false
let armedDevice = ''
let armedProcessing: AudioProcessing = 'gain'
let recording = false
let onChunk: ((pcm: Float32Array) => void) | undefined
let chunks: Float32Array[] = []
let ring: Float32Array[] = []
let flushed: (() => void) | null = null
let starting: Promise<void> | null = null

export function micErrorMessage(e: unknown): string {
  const name = (e as DOMException)?.name
  if (name === 'NotAllowedError') return 'Microphone blocked. Allow it in Windows Settings → Privacy & security → Microphone.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Selected microphone not found. Pick another in Settings.'
  if (name === 'NotReadableError') return 'Microphone is busy or unavailable.'
  return 'Microphone error: ' + String((e as Error)?.message ?? e)
}

// The 16 kHz context + capture worklet are built once and suspended while no mic is open.
let engine: Promise<AudioContext> | null = null
function audioEngine(): Promise<AudioContext> {
  return (engine ??= (async () => {
    const c = new AudioContext({ sampleRate: 16000 }) // Chromium resamples the mic to 16 kHz
    await c.audioWorklet.addModule(workletUrl)
    await c.suspend()
    return c
  })().catch((e) => {
    engine = null
    throw e
  }))
}
void audioEngine().catch(() => {}) // warm up now; errors surface on the first start

function onPcm(e: MessageEvent<{ pcm: Float32Array; flush?: boolean }>): void {
  const pcm = e.data.pcm
  if (pcm.length) {
    if (recording) {
      chunks.push(pcm)
      onChunk?.(pcm)
    } else if (armed) {
      ring.push(pcm)
      if (ring.length > PRE_ROLL_CHUNKS) ring.shift()
    }
  }
  if (e.data.flush) flushed?.()
}

async function openMic(deviceId: string, processing: AudioProcessing): Promise<void> {
  const [stream, ctx] = await Promise.all([
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, ...CONSTRAINTS[processing] }
    }),
    audioEngine().then(async (c) => (await c.resume(), c))
  ])
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfOutputs: 0 })
  node.port.onmessage = onPcm
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  const src = ctx.createMediaStreamSource(stream)
  src.connect(analyser)
  src.connect(node)
  const m: Mic = { deviceId, processing, stream, src, node, analyser }
  mic = m
  // Device unplugged or taken away: drop it; an armed mic comes back by itself.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (mic !== m || recording) return
    closeMic()
    if (armed) setTimeout(() => void arm(armedDevice, armedProcessing).catch(() => {}), 1000)
  })
}

function closeMic(): void {
  const m = mic
  mic = null
  ring = []
  if (!m) return
  m.stream.getTracks().forEach((t) => t.stop())
  m.src.disconnect()
  m.node.port.close()
  void engine?.then((c) => c.suspend()).catch(() => {})
}

/** Keep the mic open with a pre-roll buffer (no-op if already open on this device). */
export async function arm(deviceId: string, processing: AudioProcessing): Promise<void> {
  armed = true
  armedDevice = deviceId
  armedProcessing = processing
  if (recording || (mic && mic.deviceId === deviceId && mic.processing === processing)) return
  closeMic()
  await openMic(deviceId, processing)
}

export function disarm(): void {
  armed = false
  if (!recording) closeMic()
}

// The default mic changed (e.g. earbuds connected): an idle armed mic follows it.
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (armed && !recording && !armedDevice) {
    closeMic()
    void arm('', armedProcessing).catch(() => {})
  }
})

export function startRecording(deviceId: string, processing: AudioProcessing, stream?: (pcm: Float32Array) => void): Promise<void> {
  starting = (async () => {
    chunks = []
    onChunk = stream
    if (!mic || mic.deviceId !== deviceId || mic.processing !== processing) {
      closeMic()
      await openMic(deviceId, processing)
    }
    // Pre-roll first, then live audio, in order (no await in between).
    for (const c of ring) {
      chunks.push(c)
      onChunk?.(c)
    }
    ring = []
    recording = true
  })()
  return starting
}

/** Current RMS of the mic signal (0 when closed), for the waveform. */
export function rms(): number {
  if (!mic) return 0
  const buf = new Float32Array(mic.analyser.fftSize)
  mic.analyser.getFloatTimeDomainData(buf)
  return Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length)
}

/** True once audio is actually flowing (bars turn from dim to white). */
export const micLive = (): boolean => recording && chunks.length > 0

/** Stops capture (after the last partial chunk is delivered) and returns the whole clip. */
export async function stopRecording(): Promise<Float32Array> {
  await starting // a quick start→stop must wait for the mic
  const m = mic
  if (!m || !recording) throw new Error('Not recording')
  await new Promise<void>((resolve) => {
    flushed = resolve
    m.node.port.postMessage('flush')
  })
  flushed = null
  recording = false
  onChunk = undefined
  if (!armed) closeMic()
  const out = new Float32Array(chunks.reduce((a, c) => a + c.length, 0))
  let o = 0
  for (const c of chunks) out.set(c, (o += c.length) - c.length)
  chunks = []
  return out
}

export async function cancelRecording(): Promise<void> {
  await starting?.catch(() => {})
  recording = false
  onChunk = undefined
  chunks = []
  if (!armed) closeMic()
}
