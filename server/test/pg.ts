/*
 * A fresh, empty Postgres database for a test run. Uses TEST_DATABASE_URL (an admin URL) if
 * set; otherwise starts a throwaway container `voiceflow-test-pg` (in-memory storage, fsync
 * off) and leaves it running for the next run. Each call creates its own database, so test
 * files run in parallel without seeing each other's data.
 * CLI: `node test/pg.ts` prints such a URL (used by the desktop app's selftest).
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

const IMAGE = 'postgres:18.4-alpine3.22'
const NAME = 'voiceflow-test-pg'
const PORT = 55432

async function adminUrl(): Promise<string> {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL
  const url = `postgres://postgres:test@127.0.0.1:${PORT}/postgres`
  const docker = (...a: string[]): void => void execFileSync('docker', a, { stdio: 'ignore' })
  try {
    docker('start', NAME)
  } catch {
    try {
      docker('run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:5432`, '-e', 'POSTGRES_PASSWORD=test', '--tmpfs', '/var/lib/postgresql',
        IMAGE, '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=300')
    } catch {
      /* another test process started it a moment ago */
    }
  }
  for (let i = 0; ; i++) {
    const c = new pg.Client(url)
    try {
      await c.connect()
      await c.end()
      return url
    } catch (e) {
      await c.end().catch(() => {})
      if (i > 150) throw new Error(`test Postgres did not come up: ${(e as Error).message}`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

export async function testDatabaseUrl(): Promise<string> {
  const admin = await adminUrl()
  const name = `t_${randomBytes(6).toString('hex')}`
  const c = new pg.Client(admin)
  await c.connect()
  await c.query(`CREATE DATABASE ${name}`)
  await c.end()
  const u = new URL(admin)
  u.pathname = `/${name}`
  return u.toString()
}

if (import.meta.main) console.log(await testDatabaseUrl())
