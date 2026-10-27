import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Epoch, type DgResult } from './deepgram-epoch.ts'

const res = (start: number, duration: number, text: string, extra: Partial<DgResult> = {}): DgResult => ({
  type: 'Results',
  start,
  duration,
  is_final: true,
  channel: { alternatives: [{ transcript: text }] },
  ...extra
})

test('collects finals in audio order and completes on the Finalize answer', () => {
  const e = new Epoch(10)
  e.accept(res(10, 0.8, 'hello there', { is_final: false }))
  assert.equal(e.live(), 'hello there')
  e.accept(res(12, 1.5, 'world.'))
  e.accept(res(10, 2, 'Hello there,'))
  assert.equal(e.text(), 'Hello there, world.')
  e.endSec = 14
  assert.equal(e.done, false)
  e.accept(res(13.5, 0.5, 'Bye.', { from_finalize: true }))
  assert.equal(e.done, true)
  assert.equal(e.text(), 'Hello there, world. Bye.')
})

test('ignores results from an earlier dictation on the same socket', () => {
  const e = new Epoch(20)
  // Late duplicate empty from_finalize for the previous dictation (audio 15..18 s).
  assert.equal(e.accept(res(17.6, 0.4, '', { from_finalize: true })), false)
  assert.equal(e.accept(res(18, 1, 'old words')), false)
  e.accept(res(20, 1, 'New words.'))
  e.endSec = 21.5
  assert.equal(e.done, false)
  e.accept(res(21, 0.5, '', { from_finalize: true }))
  assert.equal(e.done, true)
  assert.equal(e.text(), 'New words.')
})

test('a from_finalize that does not reach the end of our audio does not complete it', () => {
  const e = new Epoch(0)
  e.accept(res(0, 1, 'one'))
  e.endSec = 5
  e.accept(res(1, 1, '', { from_finalize: true }))
  assert.equal(e.done, false)
})

test('nothing is accepted after completion', () => {
  const e = new Epoch(0)
  e.endSec = 1
  e.accept(res(0, 1, 'Done.', { from_finalize: true }))
  assert.equal(e.accept(res(0.5, 0.5, 'extra')), false)
  assert.equal(e.text(), 'Done.')
})
