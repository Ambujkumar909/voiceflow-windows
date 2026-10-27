import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import {
  AuthError,
  changePassword,
  checkLogin,
  createSession,
  createUser,
  deleteUser,
  listSessions,
  logout,
  revokeSessions,
  rotateRefresh,
  sessionActive,
  signAccess,
  verifyAccess,
  type Claims,
  type Meta
} from './auth.ts'
import { config } from './config.ts'
import { audit, prune, publish, secondsToday, subscribe, type Db } from './db.ts'
import { getPrefs, putPrefs } from './prefs.ts'
import { RateLimiter } from './ratelimit.ts'
import { dgOptions, handleStream } from './stream.ts'
import { transcribeBatch } from './upstream.ts'

/*
 * HTTP API + the streaming WebSocket. Runs behind a TLS gateway (AWS ALB / Caddy) on a
 * private address. Every response carries strict headers; bodies are size-limited; auth
 * routes are rate limited per IP and per email on top of the per-account lockout. Every
 * authenticated request checks that its session is still active.
 */
const json = (res: ServerResponse, status: number, body?: object): void => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      if ((n += c.length) > max) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }))
        req.destroy()
      } else parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('Expected application/json'), { status: 415 })
  const b = await readBody(req, 64 * 1024)
  try {
    const v = JSON.parse(b.toString('utf8') || '{}')
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch {
    /* fall through */
  }
  throw Object.assign(new Error('Invalid JSON body'), { status: 400 })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createApp(db: Db, log: (msg: string, data?: object) => void = (m, d) => console.log(JSON.stringify({ at: new Date().toISOString(), msg: m, ...d }))): Server {
  const ipLimiter = new RateLimiter(20, 60_000) // auth calls per IP per minute
  const emailLimiter = new RateLimiter(8, 15 * 60_000) // login attempts per email per 15 min
  const signupLimiter = new RateLimiter(5, 60 * 60_000) // new accounts per IP per hour
  const conns = new Set<{ userId: string; sid: string; ws: WsSocket; prefsChanged: () => void }>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxFrameBytes, perMessageDeflate: false })

  // Events from every server instance: close revoked sessions' sockets, refresh changed prefs.
  const unsubscribe = subscribe(db, (e) => {
    for (const c of conns) {
      if (e.t === 'revoke' && c.sid === e.sid) c.ws.close(4401, 'session revoked')
      if (e.t === 'prefs' && c.userId === e.user) c.prefsChanged()
    }
  })
  const housekeeping = setInterval(() => prune(db, config.auditRetentionDays).catch((e) => log('prune failed', { error: e.message })), 3600_000)
  housekeeping.unref()

  const ipOf = (req: IncomingMessage): string =>
    (config.trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || '?'
  const metaOf = (req: IncomingMessage, b: Record<string, unknown>): Meta => ({ ip: ipOf(req), device: String(b.device ?? req.headers['user-agent'] ?? '') })

  /** Valid token AND its session still active (not signed out, not revoked, not expired). */
  const authed = async (req: IncomingMessage): Promise<Claims | null> => {
    const h = String(req.headers.authorization ?? '')
    const c = h.startsWith('Bearer ') ? verifyAccess(config.jwt, h.slice(7)) : null
    return c && (await sessionActive(db, c.sid)) ? c : null
  }
  const tokens = async (user: { id: string; email: string }, meta: Meta): Promise<object> => {
    const s = await createSession(db, user.id, meta)
    const a = signAccess(config.jwt, user, s.sid)
    return { accessToken: a.token, expiresIn: config.jwt.accessTtlSec, refreshToken: s.refreshToken, user: { email: user.email } }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const route = `${req.method} ${url.pathname}`
    const ip = ipOf(req)
    try {
      if (route === 'GET /healthz') return json(res, 200, { ok: true })

      if ((url.pathname.startsWith('/v1/auth/') || url.pathname.startsWith('/v1/me/password') || route === 'DELETE /v1/me') && !ipLimiter.hit(ip))
        return json(res, 429, { error: 'Too many requests. Try again in a minute.' })

      if (route === 'POST /v1/auth/register') {
        if (!config.allowSignup) return json(res, 403, { error: 'Sign-up is closed. Ask your administrator for an account.' })
        if (!signupLimiter.hit(ip)) return json(res, 429, { error: 'Too many new accounts from this network. Try again later.' })
        const b = await readJson(req)
        const u = await createUser(db, String(b.email ?? ''), String(b.password ?? ''))
        await audit(db, 'register', u.id, ip)
        return json(res, 201, await tokens(u, metaOf(req, b)))
      }
      if (route === 'POST /v1/auth/login') {
        const b = await readJson(req)
        const email = String(b.email ?? '').trim().toLowerCase().slice(0, 254)
        if (!emailLimiter.hit(email)) return json(res, 429, { error: 'Too many attempts. Try again later.' })
        const r = await checkLogin(db, email, String(b.password ?? ''))
        if (!r.ok) {
          await audit(db, r.locked ? 'login_locked' : 'login_failed', null, ip, { email })
          return json(res, 401, { error: r.locked ? 'Too many failed attempts. Try again in 15 minutes.' : 'Wrong email or password.' })
        }
        await audit(db, 'login', r.user.id, ip)
        return json(res, 200, await tokens(r.user, metaOf(req, b)))
      }
      if (route === 'POST /v1/auth/refresh') {
        const b = await readJson(req)
        const r = await rotateRefresh(db, String(b.refreshToken ?? ''), ip)
        if (!r) return json(res, 401, { error: 'Your session ended. Sign in again.' })
        const a = signAccess(config.jwt, r.user, r.sid)
        return json(res, 200, { accessToken: a.token, expiresIn: config.jwt.accessTtlSec, refreshToken: r.refreshToken, user: { email: r.user.email } })
      }
      if (route === 'POST /v1/auth/logout') {
        const b = await readJson(req)
        const r = await logout(db, String(b.refreshToken ?? ''))
        if (r) await audit(db, 'logout', r.userId, ip)
        return json(res, 204)
      }

      // Everything below needs a valid access token for an active session.
      const claims = await authed(req)
      if (!claims) return json(res, 401, { error: 'Not signed in.' })
      const me = claims.sub

      if (route === 'GET /v1/me') {
        const { rows } = await db.query('SELECT email, created_at FROM users WHERE id = $1', [me])
        return rows[0] ? json(res, 200, { email: rows[0].email, createdAt: rows[0].created_at.toISOString() }) : json(res, 401, { error: 'Not signed in.' })
      }
      if (route === 'GET /v1/me/prefs') return json(res, 200, await getPrefs(db, me))
      if (route === 'PUT /v1/me/prefs') {
        const p = await putPrefs(db, me, await readJson(req))
        await publish(db, { t: 'prefs', user: me })
        return json(res, 200, p)
      }
      if (route === 'GET /v1/me/sessions') {
        const list = await listSessions(db, me)
        return json(res, 200, { sessions: list.map((s) => ({ ...s, current: s.id === claims.sid })) })
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/me/sessions/')) {
        const sid = url.pathname.slice('/v1/me/sessions/'.length)
        if (!UUID.test(sid)) return json(res, 404, { error: 'No such session.' })
        if (!(await revokeSessions(db, me, 'signed out remotely', { only: sid }))) return json(res, 404, { error: 'No such session.' })
        await audit(db, 'session_revoked', me, ip, { sid })
        return json(res, 204)
      }
      if (route === 'POST /v1/me/sessions/revoke-all') {
        const n = await revokeSessions(db, me, 'signed out everywhere')
        await audit(db, 'logout_all', me, ip, { sessions: n })
        return json(res, 204)
      }
      if (route === 'POST /v1/me/password') {
        const b = await readJson(req)
        await changePassword(db, me, claims.sid, String(b.currentPassword ?? ''), String(b.newPassword ?? ''))
        await audit(db, 'password_changed', me, ip)
        return json(res, 204)
      }
      if (route === 'DELETE /v1/me') {
        const b = await readJson(req)
        await deleteUser(db, me, String(b.password ?? ''))
        await audit(db, 'account_deleted', me, ip)
        return json(res, 204)
      }
      if (route === 'POST /v1/transcribe') {
        if (!config.deepgram.key) return json(res, 503, { error: 'Speech service is not configured on the server.' })
        const pcm = await readBody(req, config.limits.maxDictationSec * 32000)
        if (pcm.length % 2) return json(res, 400, { error: 'Audio must be 16-bit PCM' })
        const p = await getPrefs(db, me)
        const raw = await transcribeBatch(dgOptions(url.searchParams.get('lang') || p.language, p.dictionary.map((d) => d.word)), pcm)
        const { finishText } = await import('./pipeline.ts')
        return json(res, 200, { text: raw.trim() ? (await finishText(raw, p, config.llm)).text : '' })
      }
      return json(res, 404, { error: 'Not found' })
    } catch (e) {
      const status = e instanceof AuthError ? e.status : ((e as { status?: number }).status ?? 500)
      if (status === 500) log('error', { route, error: String((e as Error).message) })
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Server error' : (e as Error).message })
    }
  })
  // Slow-client protection.
  server.headersTimeout = 10_000
  server.requestTimeout = 60_000
  server.keepAliveTimeout = 65_000 // longer than the ALB idle timeout (60 s)

  server.on('upgrade', async (req, socket, head) => {
    const reject = (code: number, text: string): void => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    socket.on('error', () => {})
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/v1/stream') return reject(404, 'Not Found')
    try {
      const claims = await authed(req)
      if (!claims) return reject(401, 'Unauthorized')
      if ([...conns].filter((c) => c.userId === claims.sub).length >= config.limits.socketsPerUser) return reject(429, 'Too Many Requests')
      const [prefs, usedSec] = await Promise.all([getPrefs(db, claims.sub), secondsToday(db, claims.sub)])
      wss.handleUpgrade(req, socket, head, (ws) => {
        const ctl = handleStream(ws, db, { claims, prefs, usedSec }, log)
        const conn = { userId: claims.sub, sid: claims.sid, ws, prefsChanged: ctl.prefsChanged }
        conns.add(conn)
        ws.on('close', () => conns.delete(conn))
      })
    } catch (e) {
      log('upgrade failed', { error: String((e as Error).message) })
      reject(503, 'Service Unavailable')
    }
  })
  server.on('close', () => {
    unsubscribe()
    clearInterval(housekeeping)
  })
  return server
}
