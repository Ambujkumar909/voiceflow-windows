import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { hasSpeech } from '../src/core/vad.ts'

const noise = (amp: number, seconds = 5): Float32Array => Float32Array.from({ length: 16000 * seconds }, () => (Math.random() * 2 - 1) * amp)

test('steady noise and silence are not speech, at any gain', () => {
  for (const amp of [0, 0.001, 0.005, 0.02, 0.1]) assert.equal(hasSpeech(noise(amp)), false, `noise ${amp}`)
})

test('the TTS test clip is speech', () => {
  const b = readFileSync(new URL('../../test/hello.wav', import.meta.url))
  const d = b.indexOf('data') + 8
  const pcm = Float32Array.from(new Int16Array(b.buffer.slice(b.byteOffset + d, b.byteOffset + b.length - ((b.length - d) % 2))), (v) => v / 32768)
  assert.ok(hasSpeech(pcm))
})

test('every cached LibriSpeech clip is speech (run `npm run bench` once to fetch them)', (t) => {
  let n = 0
  for (const split of ['test-clean', 'test-other']) {
    const dir = new URL(`../../test/bench-data/${split}/`, import.meta.url)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.f32'))) {
      const b = readFileSync(new URL(f, dir))
      assert.ok(hasSpeech(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))), `${split}/${f}`)
      n++
    }
  }
  if (!n) t.skip('no cached clips')
})
