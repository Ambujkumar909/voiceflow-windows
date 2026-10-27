import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptable } from './polish.ts'

test('accepts punctuation, filler removal and self-corrections', () => {
  assert.ok(acceptable('um so i think we should uh ship it', 'So I think we should ship it.'))
  assert.ok(acceptable("let's meet at 3 no at 4", "Let's meet at 4."))
  assert.ok(acceptable('send it to john at example dot com', 'Send it to john@example.com.'))
})

test('rejects rewrites, additions and answers', () => {
  assert.ok(!acceptable('what is the capital of france', 'The capital of France is Paris.'))
  assert.ok(!acceptable('ship it today', 'Sure! Here is the cleaned text: Ship it today.'))
  assert.ok(!acceptable('we need to fix the bug', 'It is necessary to resolve the defect.'))
  assert.ok(!acceptable('hello', ''))
})
