/*
 * Is there speech in this clip? Whisper invents text ("Thank you.", "I'm sorry.") on near
 * silence, and auto-gain lifts room noise above any fixed volume threshold. Speech has
 * loud peaks well above the background; steady noise does not. So compare loud 20 ms
 * frames (95th percentile) with the noise floor (20th percentile).
 * ponytail: energy-only check; a model VAD (e.g. Silero) would also reject loud non-speech
 * like music or typing, add one if that turns out to matter.
 */
const FRAME = 320 // 20 ms at 16 kHz

export function hasSpeech(pcm: Float32Array): boolean {
  const frames: number[] = []
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    let s = 0
    for (let j = i; j < i + FRAME; j++) s += pcm[j] * pcm[j]
    frames.push(Math.sqrt(s / FRAME))
  }
  if (frames.length < 10) return false
  frames.sort((a, b) => a - b)
  const floor = frames[Math.floor(frames.length * 0.2)]
  const peak = frames[Math.floor(frames.length * 0.95)]
  return peak > 0.005 && peak > 2.5 * floor
}
