import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Plain append-only log. Never pass transcript text here, only lengths/metadata.
let file = ''

export function logPath(): string {
  if (!file) {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
  }
  return file
}

export function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`
  console[level === 'info' ? 'log' : level](line)
  try {
    appendFileSync(logPath(), line + '\n')
  } catch {
    /* logging must never crash the app */
  }
}
