/*
 * Long-lived connections and short-lived tokens: the server closes a stream whose token has
 * expired (4401) and keeps one alive when the client refreshes the token in-band.
 * Separate file: it needs its own short token lifetime.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { WebSocket as WsClient } from 'ws'

let base = ''
let close: () => void = () => {}
before(async () => {
  Object.assign(process.env, { JWT_SECRET: 'expiry-secret-value', ACCESS_TTL_SEC: '2', DEEPGRAM_API_KEY: '' })
  const { openDb } = await import('../src/db.ts')
  const { createApp } = await import('../src/app.ts')
  const { createUser } = await import('../src/auth.ts')
  const { testDatabaseUrl } = await import('./pg.ts')
  const db = await openDb(await testDatabaseUrl())
  await createUser(db, 'exp@example.com', 'a long test password')
  const app = createApp(db, () => {})
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  base = `127.0.0.1:${(app.address() as { port: number }).port}`
  close = () => (app.close(), void db.end())
})
after(() => {
  close()
  setTimeout(() => process.exit(0), 100).unref()
})

const login = async (): Promise<{ accessToken: string; refreshToken: string }> =>
  (await fetch(`http://${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'exp@example.com', password: 'a long test password' }) })).json() as never

const open = (token: string): Promise<WsClient> =>
  new Promise((r) => {
    const ws = new WsClient(`ws://${base}/v1/stream`, { headers: { authorization: `Bearer ${token}` } })
    ws.on('message', (d) => JSON.parse(String(d)).t === 'ready' && r(ws))
  })

test('expired token: the stream is closed with 4401', async () => {
  const ws = await open((await login()).accessToken)
  const t0 = Date.now()
  const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)))
  assert.equal(code, 4401)
  assert.ok(Date.now() - t0 < 4500, 'took too long to notice the expiry')
})

test('in-band refresh keeps the stream open past the original expiry', async () => {
  let s = await login()
  const ws = await open(s.accessToken)
  let closed = 0
  ws.on('close', (c) => (closed = c))
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const r = await fetch(`http://${base}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) })
    s = (await r.json()) as never
    ws.send(JSON.stringify({ t: 'auth', token: s.accessToken }))
  }
  assert.equal(closed, 0, `closed with ${closed}`)
  ws.close()
})
