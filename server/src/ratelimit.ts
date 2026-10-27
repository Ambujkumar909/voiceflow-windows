/** Fixed-window counter per key (IP, email…). In memory: one server instance in v1. */
export class RateLimiter {
  private hits = new Map<string, { n: number; until: number }>()
  private max: number
  private windowMs: number

  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
    setInterval(() => {
      const now = Date.now()
      for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k)
    }, windowMs).unref()
  }

  /** Counts a hit; false once the key is over its limit for the current window. */
  hit(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.until <= now) {
      this.hits.set(key, { n: 1, until: now + this.windowMs })
      return true
    }
    return ++h.n <= this.max
  }
}
