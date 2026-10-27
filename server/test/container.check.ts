/*
 * Container check (`npm run test:container`, needs Docker): brings up the real compose stack
 * (server + Postgres, all hardening on) under a separate project name with throwaway secrets
 * and a mock Deepgram on the host, then checks it from the outside:
 *  - sign-up, sign-in, a streamed dictation, data surviving a server restart
 *  - Postgres: no published port, no internet access, app role is not a superuser,
 *    passwords stored as Argon2id
 *  - server: non-root, read-only filesystem, no transcript text in logs, clean SIGTERM stop
 * Everything (containers, volume, network) is removed at the end.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket as WsClient, WebSocketServer } from 'ws'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const here = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

// Mock Deepgram on the host, reachable from the server container as host.docker.internal.
const mock = createServer((req, res) => (req.resume(), req.on('end', () => res.end('{}'))))
new WebSocketServer({ server: mock }).on('connection', (ws) => {
  let sec = 0
  ws.on('message', (d, bin) => {
    if (bin) return void (sec += (d as Buffer).length / 32000)
    if (JSON.parse(String(d)).type === 'Finalize')
      ws.send(JSON.stringify({ type: 'Results', start: 0, duration: sec, is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: 'hello from the container' }] } }))
  })
})
await new Promise<void>((r) => mock.listen(0, '0.0.0.0', r))
const mockPort = (mock.address() as { port: number }).port

// Throwaway secrets + an override pointing the stack at them and at the mock.
const tmp = mkdtempSync(join(tmpdir(), 'voiceflow-check-'))
const secrets = ['db_admin_password', 'db_app_password', 'jwt_secret', 'password_pepper', 'deepgram_api_key']
for (const s of secrets) writeFileSync(join(tmp, s), s === 'deepgram_api_key' ? 'k' : randomBytes(48).toString('base64url'))
writeFileSync(
  join(tmp, 'override.yml'),
  `services:
  server:
    ports: !override ["127.0.0.1::8787"]
    environment:
      DEEPGRAM_WS: ws://host.docker.internal:${mockPort}
      DEEPGRAM_HTTP: http://host.docker.internal:${mockPort}
    extra_hosts: ["host.docker.internal:host-gateway"]
secrets:
${secrets.map((s) => `  ${s}: { file: ${JSON.stringify(join(tmp, s))} }`).join('\n')}
`
)
const compose = (...a: string[]): string =>
  execFileSync('docker', ['compose', '-p', 'voiceflow-check', '-f', join(here, 'docker-compose.yml'), '-f', join(tmp, 'override.yml'), ...a], { encoding: 'utf8', cwd: here, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sql = (q: string): string => compose('exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'voiceflow', '-tAc', q)

let ok = false
try {
  const t0 = Date.now()
  compose('up', '-d', '--build', '--wait', '--wait-timeout', '120')
  console.log(`stack up and healthy in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  const base = `127.0.0.1:${compose('port', 'server', '8787').split(':').pop()}`
  const post = (p: string, b: object) => fetch(`http://${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })

  // Postgres is private and least-privileged.
  assert.equal(execFileSync('docker', ['port', compose('ps', '-q', 'db')], { encoding: 'utf8' }).trim(), '', 'Postgres port is published')
  assert.throws(() => compose('exec', '-T', 'db', 'wget', '-q', '-T', '3', '-O', '/dev/null', 'http://1.1.1.1'), 'Postgres can reach the internet')
  assert.equal(sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'voiceflow'"), 'f', 'app role is a superuser')
  // The server container is unprivileged and immutable.
  assert.equal(compose('exec', '-T', 'server', 'id', '-u'), '1000', 'server runs as root')
  assert.throws(() => compose('exec', '-T', 'server', 'touch', '/app/x'), 'server filesystem is writable')

  // Sign-up returns a session straight away; the password is stored as Argon2id.
  const reg = await post('/v1/auth/register', { email: 'c@example.com', password: 'a long container password', device: 'container check' })
  assert.equal(reg.status, 201)
  const { accessToken } = (await reg.json()) as { accessToken: string }
  assert.match(sql("SELECT pw_hash FROM users WHERE email = 'c@example.com'"), /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)

  // A dictation streamed through the stack.
  const wav = readFileSync(new URL('../../test/hello.wav', import.meta.url))
  const pcm = wav.subarray(wav.indexOf('data') + 8, wav.indexOf('data') + 8 + 64000)
  const text = await new Promise<string>((resolve, reject) => {
    const ws = new WsClient(`ws://${base}/v1/stream`, { headers: { authorization: `Bearer ${accessToken}` } })
    ws.on('message', async (d) => {
      const m = JSON.parse(String(d))
      if (m.t === 'ready') {
        ws.send(JSON.stringify({ t: 'start', id: 'c1', lang: 'en' }))
        for (let o = 0; o < pcm.length; o += 640) ws.send(pcm.subarray(o, o + 640))
        await sleep(50)
        ws.send(JSON.stringify({ t: 'stop', id: 'c1' }))
      } else if (m.t === 'final') (ws.close(), resolve(m.text))
      else if (m.t === 'error') reject(new Error(m.message))
    })
    ws.on('error', reject)
  })
  assert.equal(text, 'Hello from the container. ')
  assert.equal(sql("SELECT dictations FROM usage_daily u JOIN users s ON s.id = u.user_id WHERE s.email = 'c@example.com'"), '1')
  console.log(`dictation through the stack: ${JSON.stringify(text)}`)

  const logs = compose('logs', 'server')
  assert.match(logs, /"msg":"dictation"/)
  assert.doesNotMatch(logs, /hello from the container/i, 'transcript text in logs')
  assert.doesNotMatch(logs, /a long container password|argon2id/, 'secret material in logs')

  // Restart the server: it holds no state, the account is still there.
  const t1 = Date.now()
  compose('restart', '-t', '10', 'server')
  console.log(`server restarted (graceful stop + start) in ${Date.now() - t1} ms`)
  compose('up', '-d', '--wait', '--wait-timeout', '60')
  const base2 = `127.0.0.1:${compose('port', 'server', '8787').split(':').pop()}`
  const again = await fetch(`http://${base2}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'c@example.com', password: 'a long container password' }) })
  assert.equal(again.status, 200, 'account lost on restart')
  ok = true
  console.log('CONTAINER CHECK PASSED: server + Postgres stack, private least-privilege database, Argon2id, sign-up, streaming dictation, no text in logs, restart keeps data')
} finally {
  if (!ok)
    try {
      console.log(compose('logs', '--tail', '60'))
    } catch {
      /* stack never came up */
    }
  try {
    compose('down', '-v', '-t', '5')
  } catch {
    /* already gone */
  }
  rmSync(tmp, { recursive: true, force: true })
  mock.close()
}
