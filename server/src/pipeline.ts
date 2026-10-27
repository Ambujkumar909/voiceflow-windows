import { applyDictionary, cleanup } from './core/cleanup.ts'
import { polish } from './core/polish.ts'
import type { Prefs } from './prefs.ts'

/*
 * Transcript → text to type. Same tested modules the desktop app used locally:
 * optional LLM cleanup (with its no-rewrite guard) → dictionary fixes → cleanup rules.
 */
export async function finishText(raw: string, prefs: Prefs, llm: { key: string; baseUrl: string; model: string }): Promise<{ text: string; polished: boolean }> {
  let t = raw
  let polished = false
  if (prefs.polish && llm.key && raw.trim()) {
    try {
      const r = await polish(raw, { baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key }, 3000)
      t = r.text
      polished = r.applied
    } catch {
      /* the plain transcript is still correct; never fail a dictation over cleanup */
    }
  }
  return { text: cleanup(applyDictionary(t, prefs.dictionary), prefs.cleanup), polished }
}

export const wordCount = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
