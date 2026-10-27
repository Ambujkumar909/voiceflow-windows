/*
 * Short, quiet UI tones synthesized in code (no audio files): a rising blip when recording
 * starts, a falling blip when it stops, a low double tone on errors. A separate output-only
 * context; the capture graph is never touched.
 */
let ctx: AudioContext | null = null

function tone(freqs: number[], step = 0.07, gain = 0.06): void {
  ctx ??= new AudioContext()
  const t0 = ctx.currentTime + 0.005
  freqs.forEach((f, i) => {
    const o = ctx!.createOscillator()
    const g = ctx!.createGain()
    o.type = 'sine'
    o.frequency.value = f
    const s = t0 + i * step
    g.gain.setValueAtTime(0, s)
    g.gain.linearRampToValueAtTime(gain, s + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, s + step * 0.95)
    o.connect(g).connect(ctx!.destination)
    o.start(s)
    o.stop(s + step)
  })
}

export const sounds = {
  start: () => tone([740, 988]),
  stop: () => tone([988, 740]),
  error: () => tone([330, 262], 0.11, 0.05)
}
