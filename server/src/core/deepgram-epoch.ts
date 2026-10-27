/*
 * One dictation ("epoch") on a long-lived Deepgram socket. Pure logic, no I/O.
 *
 * The socket is reused across dictations, so messages are matched to a dictation by audio
 * time, not arrival order: Deepgram stamps every Results message with `start`/`duration` in
 * seconds of audio received on that socket, and we know where each dictation's audio begins
 * and ends. A late or duplicate result for an earlier dictation therefore can't leak in
 * (a duplicate empty `from_finalize` was observed against the real API).
 */
export interface DgResult {
  type?: string
  start?: number
  duration?: number
  is_final?: boolean
  speech_final?: boolean
  from_finalize?: boolean
  channel?: { alternatives?: { transcript?: string }[] }
}

const EPS = 0.05 // seconds of slack for float rounding at the boundaries
const TAIL = 0.25 // a Finalize result must reach this close to the end of our audio

export class Epoch {
  readonly startSec: number
  endSec = Infinity // set when the user stops talking
  private finals = new Map<number, string>() // segment start → text (a re-sent final replaces the old one)
  private interim = ''
  done = false
  /** Diagnostics only (no text): how many results were used, and how many with words were dropped as another dictation's. */
  readonly stats = { results: 0, droppedWithWords: 0, finals: 0 }

  constructor(startSec: number) {
    this.startSec = startSec
  }

  /** Feed one server message. Returns true if it belonged to this dictation and changed the text. */
  accept(r: DgResult): boolean {
    if (this.done || r.type !== 'Results' || typeof r.start !== 'number') return false
    const start = r.start
    const end = start + (r.duration ?? 0)
    const text = (r.channel?.alternatives?.[0]?.transcript ?? '').trim()
    if (start < this.startSec - EPS || start > this.endSec + EPS) {
      if (text) this.stats.droppedWithWords++
      return false // another dictation's audio
    }
    this.stats.results++
    if (r.is_final && text) this.stats.finals++
    if (r.is_final) {
      if (text) this.finals.set(Math.round(start * 1000), text)
      else this.finals.delete(Math.round(start * 1000))
      this.interim = ''
    } else this.interim = text
    // The Finalize answer covers the tail of our audio; that's the moment we're complete.
    if (r.from_finalize && this.endSec !== Infinity && end >= this.endSec - TAIL) this.done = true
    return true
  }

  /** Confirmed words plus the current guess, for the live caption. */
  live(): string {
    return [...this.finalTexts(), this.interim].filter(Boolean).join(' ')
  }

  /** Confirmed words only, in audio order. */
  text(): string {
    return this.finalTexts().join(' ')
  }

  private finalTexts(): string[] {
    return [...this.finals.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
  }
}
