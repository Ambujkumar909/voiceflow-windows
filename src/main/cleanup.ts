import type { CleanupOptions } from '../shared/types'

const FILLERS = /(^|\s)(?:um+|uh+|uhm+|erm+|hmm+|mm+)[,.]?(?=\s|$)/gi

/** Rule-based transcript cleanup. Pure function; covered by cleanup.test.ts. */
export function cleanup(raw: string, o: CleanupOptions): string {
  // Whisper emits tags like [BLANK_AUDIO] or [MUSIC] for non-speech.
  let t = raw.replace(/\[[A-Z _]+\]/g, ' ')

  if (o.spokenCommands) {
    t = t
      .replace(/[,.]?\s*\bnew paragraph\b[,.]?\s*/gi, '\n\n')
      .replace(/[,.]?\s*\bnew line\b[,.]?\s*/gi, '\n')
  }
  if (o.removeFillers) t = t.replace(FILLERS, '$1')

  t = t
    .split('\n')
    .map((line) =>
      line
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .replace(/^[,;:\s]+/, '')
        .trim()
    )
    .join('\n')
    .trim()

  if (o.capitalize) {
    t = t
      .replace(/(^|[.!?]\s+|\n)(\p{Ll})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase())
      .replace(/\bi\b(?=[\s,.!?']|$)/g, 'I')
  }
  if (o.finalPunctuation && /[\p{L}\p{N}]$/u.test(t)) t += '.'
  if (o.trailingSpace && t && !t.endsWith('\n')) t += ' '
  return t
}

/** Replace each dictionary misspelling with its correct word (whole words, case-insensitive). */
export function applyDictionary(text: string, entries: { word: string; misspelling?: string }[]): string {
  for (const e of entries) {
    if (!e.misspelling) continue
    const esc = e.misspelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), e.word)
  }
  return text
}
