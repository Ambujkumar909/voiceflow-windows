/*
 * Load: N users dictate at the same moment, each streaming 3 s of audio at real-time pace
 * (one 640-byte frame every 20 ms) through the server to a mock Deepgram. Every dictation must
 * come back correct, and the delay the server adds after "stop" must stay small.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { WebSocket as WsClient, WebSocketServer } from 'ws'

const USERS = 50
let base = ''
let app: Server
let mock: Server
let tokens: string[] = []
let db: import('../src/db.ts').Db

before(async () => {
  mock = createServer()
  new WebSocketServer({ server: mock }).on('connection', (ws) => {
    let sec = 0
    let seg = 0
    ws.on('message', (d, bin) => {
      if (bin) return void (sec += (d as Buffer).length / 32000)
      if (JSON.parse(String(d)).type === 'Finalize') {
        ws.send(JSON.stringify({ type: 'Results', start: seg, duration: sec - seg, is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: 'load test ok' }] } }))
        seg = sec
      }
    })
  })
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  Object.assign(process.env, { JWT_SECRET: 'load-secret-value', DEEPGRAM_API_KEY: 'k', DEEPGRAM_WS: `ws://127.0.0.1:${(mock.address() as { port: number }).port}` })
  const { openDb } = await import('../src/db.ts')
  const { createApp } = await import('../src/app.ts')
  const { createSession, createUser, signAccess } = await import('../src/auth.ts')
  const { config } = await import('../src/config.ts')
  const { testDatabaseUrl } = await import('./pg.ts')
  db = await openDb(await testDatabaseUrl())
  const users = await Promise.all(Array.from({ length: USERS }, (_, i) => createUser(db, `u${i}@example.com`, 'a long test password')))
  for (const u of users) tokens.push(signAccess(config.jwt, u, (await createSession(db, u.id, { device: 'load' })).sid).token)
  app = createApp(db, () => {})
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  base = `127.0.0.1:${(app.address() as { port: number }).port}`
})
after(() => {
  app?.close()
  void db?.end()
  mock?.close()
  setTimeout(() => process.exit(0), 100).unref()
})

function user(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://${base}/v1/stream`, { headers: { authorization: `Bearer ${token}` } })
    const frame = Buffer.alloc(640, 1)
    let stopAt = 0
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m.t === 'ready') {
        ws.send(JSON.stringify({ t: 'start', id: 'x', lang: 'en' }))
        let n = 0
        const iv = setInterval(() => {
          ws.send(frame)
          if (++n === 150) {
            clearInterval(iv)
            stopAt = performance.now()
            ws.send(JSON.stringify({ t: 'stop', id: 'x' }))
          }
        }, 20)
      } else if (m.t === 'final') {
        ws.close()
        if (m.text !== 'Load test ok. ') reject(new Error('wrong text ' + m.text))
        else resolve(performance.now() - stopAt)
      } else if (m.t === 'error') reject(new Error(m.message))
    })
    ws.on('error', reject)
  })
}

test(`${USERS} users dictating at once: all correct, server adds little delay`, async () => {
  const t0 = performance.now()
  const cpu0 = process.cpuUsage()
  const ms = (await Promise.all(tokens.map(user))).sort((a, b) => a - b)
  const wall = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  const p50 = ms[Math.floor(ms.length / 2)]
  const p95 = ms[Math.floor(ms.length * 0.95)]
  console.log(`  ${USERS} concurrent dictations (3 s each, real time): stop→final p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms; whole test ${(wall / 1000).toFixed(1)} s; CPU ${((cpu.user + cpu.system) / 1000 / wall * 100).toFixed(0)}% of one core (server + ${USERS} test clients + mock, one process)`)
  assert.equal(ms.length, USERS)
  assert.ok(p95 < 100, `p95 ${p95} ms`)
})
