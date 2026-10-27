import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryEntry, Stats } from '../shared/types'

const MAX = 200 // ponytail: whole-file JSON rewrite; move to SQLite if history needs search or grows past a few thousand
const file = (): string => join(app.getPath('userData'), 'history.json')

export function getHistory(): HistoryEntry[] {
  try {
    const v = JSON.parse(readFileSync(file(), 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(list: HistoryEntry[]): void {
  writeFileSync(file() + '.tmp', JSON.stringify(list))
  renameSync(file() + '.tmp', file())
}

export function addHistory(e: Omit<HistoryEntry, 'id' | 'at'>, at = Date.now()): void {
  write([{ id: crypto.randomUUID(), at, ...e }, ...getHistory()].sort((a, b) => b.at - a.at).slice(0, MAX))
}

export function deleteHistory(id: string): void {
  write(getHistory().filter((h) => h.id !== id))
}

export function clearHistory(): void {
  write([])
}

/*
 * Lifetime totals live in their own small file, so they survive the 200-entry history cap,
 * clearing history, and turning history off.
 */
interface Totals {
  words: number
  ms: number
  days: string[] // local YYYY-MM-DD with at least one dictation, newest last (capped)
}
const statsFile = (): string => join(app.getPath('userData'), 'stats.json')
const dayKey = (t: number): string => new Date(t).toLocaleDateString('sv-SE') // YYYY-MM-DD in local time

function readTotals(): Totals {
  try {
    const v = JSON.parse(readFileSync(statsFile(), 'utf8'))
    return { words: Number(v.words) || 0, ms: Number(v.ms) || 0, days: Array.isArray(v.days) ? v.days.map(String) : [] }
  } catch {
    return { words: 0, ms: 0, days: [] }
  }
}

export const countWords = (text: string): number => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

export function recordDictation(text: string, durationMs: number, at = Date.now()): void {
  const t = readTotals()
  t.words += countWords(text)
  t.ms += durationMs
  const d = dayKey(at)
  if (t.days.at(-1) !== d) t.days = [...t.days.filter((x) => x !== d), d].slice(-400)
  writeFileSync(statsFile() + '.tmp', JSON.stringify(t))
  renameSync(statsFile() + '.tmp', statsFile())
}

/** Streak = consecutive days with a dictation, ending today (or yesterday, so it survives until midnight). */
export function streak(days: string[], now = Date.now()): number {
  const set = new Set(days)
  let d = new Date(now)
  if (!set.has(dayKey(+d))) d.setDate(d.getDate() - 1)
  let n = 0
  while (set.has(dayKey(+d))) {
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

export function getStats(): Stats {
  const t = readTotals()
  return { totalWords: t.words, wpm: t.ms > 0 ? Math.round(t.words / (t.ms / 60000)) : 0, streakDays: streak(t.days) }
}
