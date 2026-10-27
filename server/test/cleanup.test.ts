import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup } from '../src/core/cleanup.ts'

const all = { removeFillers: true, capitalize: true, finalPunctuation: true, spokenCommands: true, trailingSpace: false }
const none = { removeFillers: false, capitalize: false, finalPunctuation: false, spokenCommands: false, trailingSpace: false }

test('normalizes whitespace, fillers, capitalization, punctuation', () => {
  assert.equal(cleanup('  um so i think   uh this works , right ', all), 'So I think this works, right.')
  assert.equal(cleanup('hello world. second sentence', all), 'Hello world. Second sentence.')
  assert.equal(cleanup('Done!', all), 'Done!')
})

test('spoken commands become newlines', () => {
  assert.equal(cleanup('first line new line second line new paragraph third', all), 'First line\nSecond line\n\nThird.')
})

test('strips whisper non-speech tags and keeps unicode', () => {
  assert.equal(cleanup('[BLANK_AUDIO]', all), '')
  assert.equal(cleanup('café naïve résumé', all), 'Café naïve résumé.')
})

test('options off leaves words alone', () => {
  assert.equal(cleanup('um hello  world', none), 'um hello world')
  assert.equal(cleanup('hi', { ...none, trailingSpace: true }), 'hi ')
  assert.equal(cleanup('umbrella items', all), 'Umbrella items.')
})

test('dictionary replaces misspellings as whole words, any case', async () => {
  const { applyDictionary } = await import('../src/core/cleanup.ts')
  const dict = [{ word: 'Kubernetes', misspelling: 'cooper netties' }, { word: 'VoiceFlow' }, { word: 'C++', misspelling: 'see plus plus' }]
  assert.equal(applyDictionary('Deploy to Cooper Netties now.', dict), 'Deploy to Kubernetes now.')
  assert.equal(applyDictionary('I like see plus plus.', dict), 'I like C++.')
  assert.equal(applyDictionary('cooper nettiesx stays', dict), 'cooper nettiesx stays')
})
