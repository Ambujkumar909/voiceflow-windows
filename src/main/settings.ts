import { app, safeStorage } from 'electron'
import { userInfo } from 'node:os'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOLD_KEYS, type DictEntry, type KeySlot, type PublicSettings, type Settings } from '../shared/types'

function osFirstName(): string {
  try {
    const n = userInfo().username.split(/[._\s-]/)[0]
    return n.charAt(0).toUpperCase() + n.slice(1)
  } catch {
    return ''
  }
}

export const DEFAULTS: Settings = {
  shortcut: 'Alt+Shift+Space',
  holdKeys: 'Ctrl+Win',
  micDeviceId: '',
  instantMic: true,
  audioProcessing: 'gain',
  provider: 'local-whisper',
  localModel: 'onnx-community/whisper-base',
  deepgramRegion: 'auto',
  deepgramModel: 'nova-3',
  xaiUrl: 'wss://api.x.ai/v1/stt',
  xaiModel: 'grok-voice-transcribe-2.0',
  dictionary: [],
  // Light cleanup only; see polish.ts. Groq gpt-oss-20b: ~1000 tokens/s, $0.075/$0.30 per 1M tokens (Oct 2026).
  polish: { enabled: false, baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b' },
  apiBaseUrl: 'https://api.openai.com/v1',
  apiModel: 'whisper-1',
  language: 'en',
  insertMode: 'paste',
  restoreClipboard: true,
  cleanup: { removeFillers: true, capitalize: true, finalPunctuation: true, spokenCommands: true, trailingSpace: true },
  openAtLogin: false,
  saveHistory: true,
  sounds: true,
  name: osFirstName(),
  theme: 'system'
}

const ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  holdKeys: HOLD_KEYS,
  provider: ['deepgram', 'xai', 'local-whisper', 'openai'],
  deepgramRegion: ['auto', 'eu', 'us'],
  theme: ['system', 'light', 'dark'],
  audioProcessing: ['raw', 'gain', 'denoise'],
  insertMode: ['paste', 'type']
}

const SLOTS: KeySlot[] = ['deepgram', 'openai', 'xai', 'llm']
type Stored = Settings & { keysEnc: Partial<Record<KeySlot, string>> }
let current: Stored = { ...structuredClone(DEFAULTS), keysEnc: {} }
const file = (): string => join(app.getPath('userData'), 'settings.json')

/** Copy only known keys with the right type. Input comes from the renderer or disk, so it is untrusted. */
function sanitize(input: unknown, base: Settings): Settings {
  const out = structuredClone(base)
  if (!input || typeof input !== 'object') return out
  const src = input as Record<string, unknown>
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = src[key]
    const def = DEFAULTS[key]
    if (key === 'dictionary') {
      if (Array.isArray(v)) out.dictionary = cleanDictionary(v)
    } else if (def && typeof def === 'object') {
      // Nested option groups (cleanup, polish): same rule, one level down.
      if (v && typeof v === 'object') {
        const o = out[key] as unknown as Record<string, unknown>
        for (const [ck, cd] of Object.entries(def)) {
          const cv = (v as Record<string, unknown>)[ck]
          if (typeof cv === typeof cd) o[ck] = typeof cv === 'string' ? cv.trim().slice(0, 500) : cv
        }
      }
    } else if (typeof v === typeof DEFAULTS[key] && (!ENUMS[key] || ENUMS[key]!.includes(v as string))) {
      ;(out as unknown as Record<string, unknown>)[key] = typeof v === 'string' ? v.trim().slice(0, 500) : v
    }
  }
  return out
}

const MAX_DICT = 500
/** Untrusted list → unique, trimmed entries; a misspelling equal to its word is dropped. */
function cleanDictionary(v: unknown[]): DictEntry[] {
  const seen = new Set<string>()
  const out: DictEntry[] = []
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const word = String((e as DictEntry).word ?? '').trim().slice(0, 100)
    const mis = String((e as DictEntry).misspelling ?? '').trim().slice(0, 100)
    const key = (mis || word).toLowerCase()
    if (!word || seen.has(key)) continue
    seen.add(key)
    out.push(mis && mis.toLowerCase() !== word.toLowerCase() ? { word, misspelling: mis } : { word })
    if (out.length >= MAX_DICT) break
  }
  return out
}

function write(): void {
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(current, null, 2))
  renameSync(tmp, file())
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'))
    const keysEnc: Stored['keysEnc'] = {}
    for (const s of SLOTS) if (typeof raw.keysEnc?.[s] === 'string') keysEnc[s] = raw.keysEnc[s]
    if (typeof raw.apiKeyEnc === 'string') keysEnc.openai ??= raw.apiKeyEnc // v0.1 stored a single key
    if (typeof raw.vocabulary === 'string' && !Array.isArray(raw.dictionary)) // v0.2 stored a comma-separated list
      raw.dictionary = raw.vocabulary.split(',').map((w: string) => ({ word: w }))
    current = { ...sanitize(raw, DEFAULTS), keysEnc }
  } catch {
    current = { ...structuredClone(DEFAULTS), keysEnc: {} } // first run or corrupt file
  }
  return getSettings()
}

export function getSettings(): Settings {
  const { keysEnc: _omit, ...s } = current
  return structuredClone(s)
}

export function publicSettings(): PublicSettings {
  return { ...getSettings(), keys: { deepgram: !!current.keysEnc.deepgram, openai: !!current.keysEnc.openai, xai: !!current.keysEnc.xai, llm: !!current.keysEnc.llm } }
}

export function saveSettings(patch: unknown): Settings {
  current = { ...sanitize({ ...getSettings(), ...(patch as object) }, getSettings()), keysEnc: current.keysEnc }
  write()
  return getSettings()
}

/** API keys are encrypted with the OS keychain (DPAPI on Windows) and never sent to a renderer. */
export function setApiKey(slot: KeySlot, key: string): void {
  if (!SLOTS.includes(slot)) throw new Error('Unknown key slot')
  if (!key) {
    delete current.keysEnc[slot]
  } else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable; refusing to store the API key in plain text.')
    current.keysEnc[slot] = safeStorage.encryptString(key.trim()).toString('base64')
  }
  write()
}

export function getApiKey(slot: KeySlot): string {
  const enc = current.keysEnc[slot]
  if (!enc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}
