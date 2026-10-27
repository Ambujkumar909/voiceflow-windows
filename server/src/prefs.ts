import type { CleanupOptions } from './core/cleanup.ts'
import type { Db } from './db.ts'

/** Per-user preferences that shape transcription and text processing (stored server-side). */
export interface Prefs {
  language: string
  dictionary: { word: string; misspelling?: string }[]
  cleanup: CleanupOptions
  polish: boolean
}

export const DEFAULT_PREFS: Prefs = {
  language: 'en',
  dictionary: [],
  cleanup: { removeFillers: true, capitalize: true, finalPunctuation: true, spokenCommands: true, trailingSpace: true },
  polish: false
}

/** Untrusted input → valid preferences (unknown fields dropped, sizes capped). */
export function sanitizePrefs(input: unknown, base: Prefs = DEFAULT_PREFS): Prefs {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out: Prefs = structuredClone(base)
  if (typeof src.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$|^multi$/.test(src.language)) out.language = src.language
  if (typeof src.polish === 'boolean') out.polish = src.polish
  if (src.cleanup && typeof src.cleanup === 'object')
    for (const k of Object.keys(base.cleanup) as (keyof CleanupOptions)[]) {
      const v = (src.cleanup as Record<string, unknown>)[k]
      if (typeof v === 'boolean') out.cleanup[k] = v
    }
  if (Array.isArray(src.dictionary)) {
    const seen = new Set<string>()
    out.dictionary = []
    for (const e of src.dictionary.slice(0, 1000)) {
      if (!e || typeof e !== 'object') continue
      const word = String((e as Record<string, unknown>).word ?? '').trim().slice(0, 100)
      const mis = String((e as Record<string, unknown>).misspelling ?? '').trim().slice(0, 100)
      const key = (mis || word).toLowerCase()
      if (!word || seen.has(key)) continue
      seen.add(key)
      out.dictionary.push(mis && mis.toLowerCase() !== word.toLowerCase() ? { word, misspelling: mis } : { word })
      if (out.dictionary.length >= 500) break
    }
  }
  return out
}

export async function getPrefs(db: Db, userId: string): Promise<Prefs> {
  const { rows } = await db.query('SELECT data FROM prefs WHERE user_id = $1', [userId])
  return rows[0] ? sanitizePrefs(rows[0].data) : structuredClone(DEFAULT_PREFS)
}

export async function putPrefs(db: Db, userId: string, input: unknown): Promise<Prefs> {
  const p = sanitizePrefs(input, await getPrefs(db, userId))
  await db.query(
    'INSERT INTO prefs (user_id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = now()',
    [userId, p]
  )
  return p
}
