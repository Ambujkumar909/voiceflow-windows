/*
 * End to end: a real server instance + a mock Deepgram (WebSocket + batch HTTP) that follows
 * the protocol observed against the real API, including the late duplicate empty
 * from_finalize. A client streams test/hello.wav exactly like the desktop app does.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { WebSocket as WsClient, WebSocketServer } from 'ws'

// ---------- mock Deepgram ----------
const dg = { connections: 0, closes: 0, urls: [] as string[], auth: '', bytes: 0, finalizes: 0, keepAlives: 0, script: [] as string[], failAfterSec: 0, hang: false, batchText: 'batch transcript here' }
const mock: Server = createServer((req, res) => {
  // batch endpoint: POST /v1/listen
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: dg.batchText }] }] } }))
  })
})
const mockWss = new WebSocketServer({ server: mock })
mockWss.on('connection', (ws, req) => {
  dg.connections++
  dg.urls.push(decodeURIComponent(req.url ?? ''))
  dg.auth = String(req.headers.authorization)
  let sec = 0
  let segStart = 0
  let lastInterim = 0
  ws.on('close', () => dg.closes++)
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const n = (data as Buffer).length
      dg.bytes += n
      sec += n / 32000
      if (dg.failAfterSec && sec > dg.failAfterSec) return ws.terminate()
      if (sec - lastInterim >= 0.5) {
        lastInterim = sec
        ws.send(JSON.stringify({ type: 'Results', start: segStart, duration: sec - segStart, is_final: false, channel: { alternatives: [{ transcript: 'live words' }] } }))
      }
      return
    }
    const type = JSON.parse(String(data)).type
    if (type === 'KeepAlive') dg.keepAlives++
    if (type === 'Finalize' && !dg.hang) {
      const [s, e] = [segStart, sec]
      ws.send(JSON.stringify({ type: 'Results', start: s, duration: e - s, is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: dg.script[dg.finalizes++] ?? '' }] } }))
      setTimeout(() => ws.send(JSON.stringify({ type: 'Results', start: s, duration: e - s, is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: '' }] } })), 150)
      segStart = sec
    }
  })
})

// ---------- server under test ----------
let base = ''
let app: Server
let db: import('../src/db.ts').Db
const pcm = ((): Buffer => {
  const b = readFileSync(new URL('../../test/hello.wav', import.meta.url))
  return b.subarray(b.indexOf('data') + 8)
})()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  const port = (mock.address() as { port: number }).port
  Object.assign(process.env, { PRIME_IDLE_MS: '400', FINALIZE_TIMEOUT_MS: '800', JWT_SECRET: 'e2e-secret-value', DEEPGRAM_API_KEY: 'dg-server-key', DEEPGRAM_WS: `ws://127.0.0.1:${port}`, DEEPGRAM_HTTP: `http://127.0.0.1:${port}` })
  const { openDb } = await import('../src/db.ts')
  const { createApp } = await import('../src/app.ts')
  const { createUser } = await import('../src/auth.ts')
  const { testDatabaseUrl } = await import('./pg.ts')
  db = await openDb(await testDatabaseUrl())
  await createUser(db, 'user@example.com', 'a long test password')
  await createUser(db, 'other@example.com', 'a long test password')
  app = createApp(db, () => {})
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  base = `127.0.0.1:${(app.address() as { port: number }).port}`
})
after(() => {
  app?.close()
  void db?.end()
  mock.close()
  mockWss.close()
  setTimeout(() => process.exit(0), 100).unref()
})

const api = async (path: string, body?: object, token?: string, method = 'POST'): Promise<{ status: number; json: any }> => {
  const r = await fetch(`http://${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: r.status === 204 ? null : await r.json() }
}
// One sign-in for the suite: the login endpoint is rate limited per email (8 per 15 min).
let session: Promise<{ accessToken: string; refreshToken: string }> | null = null
const login = (): Promise<{ accessToken: string; refreshToken: string }> => (session ??= api('/v1/auth/login', { email: 'user@example.com', password: 'a long test password' }).then((r) => r.json))
/** A signed-in device for `email` without going through the (rate-limited) login endpoint. */
async function device(email: string): Promise<{ accessToken: string; sid: string }> {
  const { createSession, signAccess } = await import('../src/auth.ts')
  const { config } = await import('../src/config.ts')
  const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [email])
  const s = await createSession(db, rows[0].id, { device: 'test' })
  return { accessToken: signAccess(config.jwt, { id: rows[0].id, email }, s.sid).token, sid: s.sid }
}
const freshLogin = async (): Promise<{ accessToken: string; refreshToken: string }> => (await api('/v1/auth/login', { email: 'user@example.com', password: 'a long test password' })).json

/** Connect like the desktop app and collect server messages. */
async function connect(token: string): Promise<{ ws: WsClient; msgs: any[]; next: (t: string) => Promise<any> }> {
  const ws = new WsClient(`ws://${base}/v1/stream`, { headers: { authorization: `Bearer ${token}` } })
  const msgs: any[] = []
  const waiters: { t: string; r: (m: any) => void }[] = []
  ws.on('message', (d) => {
    const m = JSON.parse(String(d))
    const i = waiters.findIndex((w) => w.t === m.t || (w.t === 'final|error' && (m.t === 'final' || m.t === 'error')))
    if (i >= 0) waiters.splice(i, 1)[0].r(m) // handed to the waiting test; not kept
    else msgs.push(m)
  })
  const next = (t: string): Promise<any> => {
    const i = msgs.findIndex((m) => m.t === t || (t === 'final|error' && (m.t === 'final' || m.t === 'error')))
    if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0])
    return new Promise((r, j) => {
      waiters.push({ t, r })
      setTimeout(() => j(new Error(`timeout waiting for ${t}`)), 8000)
    })
  }
  await next('ready')
  return { ws, msgs, next }
}

/** Stream `seconds` of hello.wav in 20 ms frames (faster than real time). */
async function dictate(c: Awaited<ReturnType<typeof connect>>, id: string, seconds = 2): Promise<{ result: any; ms: number }> {
  c.ws.send(JSON.stringify({ t: 'start', id, lang: 'en', mode: 'hold' }))
  for (let o = 0; o < Math.min(pcm.length, seconds * 32000); o += 640) {
    c.ws.send(pcm.subarray(o, o + 640))
    if (o % 6400 === 0) await sleep(5)
  }
  await sleep(50)
  const t = Date.now()
  c.ws.send(JSON.stringify({ t: 'stop', id }))
  const result = await c.next('final|error')
  return { result, ms: Date.now() - t }
}

test('sign-up is closed by default; wrong password and unknown email look identical', async () => {
  assert.equal((await api('/v1/auth/register', { email: 'x@y.co', password: 'long enough password' })).status, 403)
  const a = await api('/v1/auth/login', { email: 'user@example.com', password: 'wrong password!' })
  const b = await api('/v1/auth/login', { email: 'ghost@example.com', password: 'wrong password!' })
  assert.equal(a.status, 401)
  assert.deepEqual(a.json, b.json)
})

test('the stream rejects missing or bad tokens', async () => {
  for (const headers of [{}, { authorization: 'Bearer nope' }]) {
    const status = await new Promise<number>((r) => {
      const ws = new WsClient(`ws://${base}/v1/stream`, { headers })
      ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0))
      ws.on('open', () => r(101))
    })
    assert.equal(status, 401)
  }
})

test('prime warms Deepgram before the dictation; live words; cleaned final text', async () => {
  const c = await connect((await login()).accessToken)
  dg.script = ['um so the streamed words']
  c.ws.send(JSON.stringify({ t: 'prime' }))
  for (let i = 0; i < 50 && dg.connections === 0; i++) await sleep(20)
  assert.equal(dg.connections, 1, 'not warm before start')
  assert.equal(dg.auth, 'Token dg-server-key')
  assert.equal(dg.bytes, 0, 'audio sent before start')
  const { result, ms } = await dictate(c, 'd1')
  assert.equal(result.t, 'final', JSON.stringify(result))
  assert.equal(result.text, 'So the streamed words. ')
  assert.ok(c.msgs.some((m) => m.t === 'partial' && m.text === 'live words'), 'no live words were sent')
  assert.ok(dg.urls[0].includes('model=nova-3') && dg.urls[0].includes('mip_opt_out=true') && dg.urls[0].includes('encoding=linear16'), dg.urls[0])
  console.log(`  stop → final through the server (mock upstream): ${ms} ms; server pipeline ${result.ms.total} ms`)
  c.ws.close()
})

test('second dictation reuses the warm socket; the late duplicate result is ignored', async () => {
  const c = await connect((await login()).accessToken)
  dg.script = ['first one', 'second one']
  dg.finalizes = 0
  const before = dg.connections
  const a = await dictate(c, 'a')
  const b = await dictate(c, 'b')
  assert.equal(a.result.text, 'First one. ')
  assert.equal(b.result.text, 'Second one. ')
  assert.equal(dg.connections, before + 1, 'opened more than one upstream socket')
  c.ws.close()
})

test('server-side dictionary: keyterms reach Deepgram and misspellings are fixed', async () => {
  const { accessToken } = await login()
  const put = await api('/v1/me/prefs', { dictionary: [{ word: 'Kubernetes', misspelling: 'cooper netties' }] }, accessToken, 'PUT')
  assert.equal(put.status, 200)
  const c = await connect(accessToken)
  dg.script = ['deploy to cooper netties now']
  dg.finalizes = 0
  const { result } = await dictate(c, 'k')
  assert.equal(result.text, 'Deploy to Kubernetes now. ')
  assert.ok(dg.urls.at(-1)!.includes('keyterm=Kubernetes'), dg.urls.at(-1))
  c.ws.close()
})

test('upstream dropping mid-dictation falls back to the batch API on the buffered clip', async () => {
  const c = await connect((await login()).accessToken)
  dg.failAfterSec = 1
  const { result } = await dictate(c, 'f', 2)
  dg.failAfterSec = 0
  assert.equal(result.t, 'final', JSON.stringify(result))
  assert.equal(result.text, 'Batch transcript here. ')
  c.ws.close()
})

test('silence: the engine hears nothing → no_speech error, nothing typed', async () => {
  const c = await connect((await login()).accessToken)
  dg.script = ['']
  dg.finalizes = 0
  const { result } = await dictate(c, 's', 1)
  assert.deepEqual([result.t, result.code], ['error', 'no_speech'])
  c.ws.close()
})

test('refresh rotates; replaying a superseded refresh token ends the session', async () => {
  const s = await freshLogin()
  const r1 = await api('/v1/auth/refresh', { refreshToken: s.refreshToken })
  const r2 = await api('/v1/auth/refresh', { refreshToken: r1.json.refreshToken })
  assert.equal(r2.status, 200)
  assert.equal((await api('/v1/auth/refresh', { refreshToken: s.refreshToken })).status, 401, 'stolen token accepted')
  assert.equal((await api('/v1/auth/refresh', { refreshToken: r2.json.refreshToken })).status, 401, 'session survived')
  assert.equal((await api('/v1/me', undefined, r2.json.accessToken, 'GET')).status, 401, 'access token of a revoked session still works')
})

test('signing a device out from another closes its live stream at once', async () => {
  const laptop = await device('other@example.com')
  const desktop = await device('other@example.com')
  const c = await connect(laptop.accessToken)
  const list = await api('/v1/me/sessions', undefined, desktop.accessToken, 'GET')
  assert.equal(list.json.sessions.filter((s: { current: boolean }) => s.current).length, 1)
  const t0 = Date.now()
  const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)))
  assert.equal((await api(`/v1/me/sessions/${laptop.sid}`, undefined, desktop.accessToken, 'DELETE')).status, 204)
  assert.equal(await closed, 4401)
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`)
  assert.equal((await api('/v1/me', undefined, laptop.accessToken, 'GET')).status, 401)
  assert.equal((await api('/v1/me', undefined, desktop.accessToken, 'GET')).json.email, 'other@example.com')
  assert.equal((await api(`/v1/me/sessions/${laptop.sid}`, undefined, desktop.accessToken, 'DELETE')).status, 404)
})

test('preferences saved while connected apply to the very next dictation', async () => {
  const d = await device('other@example.com')
  const c = await connect(d.accessToken)
  await api('/v1/me/prefs', { dictionary: [{ word: 'VoiceFlow', misspelling: 'voice flow' }] }, d.accessToken, 'PUT')
  await sleep(100)
  dg.script = ['try voice flow today']
  dg.finalizes = 0
  const { result } = await dictate(c, 'p')
  assert.equal(result.text, 'Try VoiceFlow today. ')
  c.ws.close()
})

test('a bad in-band token closes the stream with 4401', async () => {
  const c = await connect((await login()).accessToken)
  const code = await new Promise<number>((r) => {
    c.ws.on('close', (code) => r(code))
    c.ws.send(JSON.stringify({ t: 'auth', token: 'forged.token.value' }))
  })
  assert.equal(code, 4401)
})

test('login attempts per email are rate limited', async () => {
  let last = 0
  for (let i = 0; i < 9; i++) last = (await api('/v1/auth/login', { email: 'victim@example.com', password: 'guess number ' + i })).status
  assert.equal(last, 429)
})

test('Deepgram accepts audio but never answers Finalize: batch backup after the timeout', async () => {
  const c = await connect((await login()).accessToken)
  dg.hang = true
  dg.batchText = 'answered by the batch backup'
  try {
    const { result, ms } = await dictate(c, 'h', 1)
    assert.equal(result.text, 'Answered by the batch backup. ', JSON.stringify(result))
    assert.ok(ms < 3000, `took ${ms} ms`)
  } finally {
    dg.hang = false
    c.ws.close()
  }
})

test('a key-press prime alone keeps the Deepgram socket only briefly', async () => {
  const c = await connect((await login()).accessToken)
  const [opened, closed] = [dg.connections, dg.closes]
  c.ws.send(JSON.stringify({ t: 'prime' }))
  for (let i = 0; i < 50 && dg.connections === opened; i++) await sleep(20)
  assert.equal(dg.connections, opened + 1, 'prime did not open an upstream socket')
  await sleep(700) // PRIME_IDLE_MS is 400 in this test
  assert.equal(dg.closes, closed + 1, 'idle upstream socket was not closed')
  c.ws.close()
})

test('a client flooding messages is disconnected (1008)', async () => {
  const c = await connect((await login()).accessToken)
  const code = await new Promise<number>((r) => {
    c.ws.on('close', (code) => r(code))
    for (let i = 0; i < 400; i++) c.ws.send('{"t":"ping"}')
  })
  assert.equal(code, 1008)
})

test('silent client audio while no dictation is running is ignored, not forwarded', async () => {
  const c = await connect((await login()).accessToken)
  const before = dg.bytes
  for (let i = 0; i < 20; i++) c.ws.send(pcm.subarray(0, 640))
  await sleep(100)
  assert.equal(dg.bytes, before, 'audio outside a dictation reached Deepgram')
  c.ws.close()
})
