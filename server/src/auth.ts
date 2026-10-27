import { argon2, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import { config } from './config.ts'
import { audit, inet, publish, type Db } from './db.ts'

/*
 * Accounts and sessions (see ARCHITECTURE.md, "Security").
 *  - Passwords: Argon2id (RFC 9106: 64 MiB, 3 passes, 4 lanes) with a per-password salt and a
 *    server-side pepper kept outside the database. Old parameters are upgraded at next login.
 *    Unknown emails still run a full hash, so timing doesn't reveal which accounts exist.
 *  - Access tokens: 15-minute JWTs, HMAC-SHA256 with a fixed header (no algorithm
 *    confusion) carrying a key id, so the signing secret can be rotated without sign-outs.
 *    They name their session, and the server refuses tokens whose session was revoked.
 *  - Sessions: one per signed-in device; listable and revocable by the user. A revocation
 *    reaches every server instance at once and closes that device's live connection.
 *  - Refresh tokens: 256 random bits, only SHA-256 stored, rotated on every use. Presenting
 *    a used token again revokes the session (theft detection), except once within 30 s while
 *    its replacement is still unused: the client may simply have lost the response.
 *  - Brute force: 10 wrong passwords lock the account for 15 minutes, shared by all instances,
 *    on top of per-IP and per-email rate limits in the HTTP layer.
 */

// ---------- Passwords ----------
const A2 = { memory: 65536, passes: 3, parallelism: 4 }
const TAG_LEN = 32
const MAX_FAILS = 10
const LOCK_MIN = 15

// At most 2 hashes at once (128 MiB): a login burst queues instead of exhausting memory or
// the libuv thread pool that DNS and other work also need.
let hashing = 0
const waiting: (() => void)[] = []
async function limited<T>(f: () => Promise<T>): Promise<T> {
  if (hashing >= 2) await new Promise<void>((r) => waiting.push(r))
  hashing++
  try {
    return await f()
  } finally {
    hashing--
    waiting.shift()?.()
  }
}

function a2(pw: string, salt: Buffer, p: typeof A2): Promise<Buffer> {
  const params = { message: pw.normalize('NFKC'), nonce: salt, ...p, tagLength: TAG_LEN, ...(config.pepper ? { secret: Buffer.from(config.pepper) } : {}) }
  return limited(() => new Promise((res, rej) => argon2('argon2id', params, (e, k) => (e ? rej(e) : res(k)))))
}

const b64n = (b: Buffer): string => b.toString('base64').replace(/=+$/, '')

/** PHC string: $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash> */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  return `$argon2id$v=19$m=${A2.memory},t=${A2.passes},p=${A2.parallelism}$${b64n(salt)}$${b64n(await a2(pw, salt, A2))}`
}

function parseHash(stored: string): { p: typeof A2; salt: Buffer; hash: Buffer } | null {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored)
  if (!m) return null
  const p = { memory: +m[1], passes: +m[2], parallelism: +m[3] }
  if (p.memory > 262144 || p.passes > 10 || p.parallelism > 16) return null
  return { p, salt: Buffer.from(m[4], 'base64'), hash: Buffer.from(m[5], 'base64') }
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const h = parseHash(stored)
  if (!h) return false
  const got = await a2(pw, h.salt, h.p)
  return got.length === h.hash.length && timingSafeEqual(got, h.hash)
}

const needsRehash = (stored: string): boolean => {
  const h = parseHash(stored)
  return !h || h.p.memory !== A2.memory || h.p.passes !== A2.passes || h.p.parallelism !== A2.parallelism
}

let dummy: Promise<string> | undefined // a real hash, compared against when the email is unknown

export const normalizeEmail = (e: string): string => e.trim().toLowerCase()
export const validEmail = (e: string): boolean => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

// The most common long passwords in breach corpora (all lower-case).
const COMMON = new Set(
  '1234567890 12345678910 0987654321 1111111111 0000000000 1234512345 qwertyuiop 1q2w3e4r5t 1qaz2wsx3edc zaq12wsxcde qazwsxedcrfv asdfghjkl1 password12 password123 password1234 passw0rd123 p@ssw0rd123 iloveyou12 iloveyou123 qwerty1234 qwerty12345 qwerty123456 abcd123456 abc1234567 a1234567890 football123 princess123 sunshine123 welcome123 letmein123 superman123 monkey12345 dragon12345 changeme123 administrator voiceflow123'.split(' ')
)

/** Why a new password is unacceptable, or null if it's fine (NIST SP 800-63B style: length + blocklist, no composition rules). */
export function passwordProblem(pw: string, email = ''): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.'
  if (pw.length > 200) return 'Use at most 200 characters.'
  const l = pw.toLowerCase()
  const local = normalizeEmail(email).split('@')[0]
  if (COMMON.has(l) || /^(.)\1+$/.test(pw) || l === normalizeEmail(email) || (local.length >= 4 && l === local)) return 'That password is too easy to guess. Try a longer phrase.'
  return null
}

// ---------- Access tokens (JWT, HS256) ----------
export interface JwtConfig {
  secret: string
  previousSecret?: string
  issuer: string
  audience: string
  accessTtlSec: number
}
export interface Claims {
  sub: string
  sid: string
  email: string
  exp: number
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url')
const headers = new Map<string, string>()
const headerFor = (secret: string): string => {
  let h = headers.get(secret)
  if (!h) headers.set(secret, (h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: createHash('sha256').update(secret).digest('base64url').slice(0, 8) }))))
  return h
}

export function signAccess(cfg: JwtConfig, u: { id: string; email: string }, sid: string, now = Date.now()): { token: string; exp: number } {
  const exp = Math.floor(now / 1000) + cfg.accessTtlSec
  const h = headerFor(cfg.secret)
  const body = b64(JSON.stringify({ sub: u.id, sid, email: u.email, iss: cfg.issuer, aud: cfg.audience, iat: Math.floor(now / 1000), exp }))
  return { token: `${h}.${body}.${createHmac('sha256', cfg.secret).update(`${h}.${body}`).digest('base64url')}`, exp }
}

/** The claims, or null for anything malformed, tampered, foreign or expired (signature only; see sessionActive). */
export function verifyAccess(cfg: JwtConfig, token: string, now = Date.now()): Claims | null {
  if (typeof token !== 'string' || token.length > 4096) return null
  const [h, body, sig] = token.split('.')
  if (!body || !sig) return null
  // The header must equal one we produce, byte for byte: fixed algorithm, known key id.
  const key = h === headerFor(cfg.secret) ? cfg.secret : cfg.previousSecret && h === headerFor(cfg.previousSecret) ? cfg.previousSecret : null
  if (!key) return null
  const want = createHmac('sha256', key).update(`${h}.${body}`).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (c.iss !== cfg.issuer || c.aud !== cfg.audience || typeof c.sub !== 'string' || typeof c.sid !== 'string' || typeof c.exp !== 'number') return null
    if (c.exp * 1000 <= now) return null
    return { sub: c.sub, sid: c.sid, email: String(c.email ?? ''), exp: c.exp }
  } catch {
    return null
  }
}

// ---------- Sessions and refresh tokens ----------
export interface Meta {
  ip?: string
  device?: string
}
const sha = (t: string): Buffer => createHash('sha256').update(t).digest()
const newToken = (): string => randomBytes(32).toString('base64url')
const cleanDevice = (d: unknown): string => String(d ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, 80)

async function tx<T>(db: Db, f: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await f(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

export async function createSession(db: Db, userId: string, meta: Meta): Promise<{ sid: string; refreshToken: string }> {
  const sid = randomUUID()
  const token = newToken()
  await db.query(
    `WITH s AS (INSERT INTO sessions (id, user_id, device, ip, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id)
     INSERT INTO refresh_tokens (hash, session_id, expires_at) SELECT $6, id, now() + make_interval(secs => $7) FROM s`,
    [sid, userId, cleanDevice(meta.device), inet(meta.ip), config.sessionMaxSec, sha(token), config.refreshTtlSec]
  )
  return { sid, refreshToken: token }
}

const REUSE_GRACE_MS = 30_000

/** Rotate a refresh token: the user, session and a new token; or null (expired, revoked, stolen). */
export async function rotateRefresh(db: Db, token: string, ip?: string): Promise<{ user: { id: string; email: string }; sid: string; refreshToken: string } | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const h = sha(token)
  let stolen: { sid: string; user: string } | null = null
  const out = await tx(db, async (c) => {
    const { rows } = await c.query(
      `SELECT r.session_id, r.used_at IS NOT NULL AS used, r.replaced_by, extract(epoch FROM now() - r.used_at)::float8 * 1000 AS used_ago,
              r.expires_at > now() AND s.revoked_at IS NULL AND s.expires_at > now() AS ok, s.user_id, u.email
       FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id JOIN users u ON u.id = s.user_id
       WHERE r.hash = $1 FOR UPDATE OF r`,
      [h]
    )
    const r = rows[0]
    if (!r?.ok) return null
    if (r.used) {
      const succ = r.replaced_by ? (await c.query('SELECT used_at FROM refresh_tokens WHERE hash = $1 FOR UPDATE', [r.replaced_by])).rows[0] : null
      if (!(r.used_ago < REUSE_GRACE_MS && succ && !succ.used_at)) {
        await c.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'refresh token reuse' WHERE id = $1`, [r.session_id])
        stolen = { sid: r.session_id, user: r.user_id }
        return null
      }
      await c.query('UPDATE refresh_tokens SET used_at = now() WHERE hash = $1', [r.replaced_by]) // only one live branch
    }
    const next = newToken()
    await c.query('INSERT INTO refresh_tokens (hash, session_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))', [sha(next), r.session_id, config.refreshTtlSec])
    await c.query('UPDATE refresh_tokens SET used_at = coalesce(used_at, now()), replaced_by = $2 WHERE hash = $1', [h, sha(next)])
    await c.query('UPDATE sessions SET last_used_at = now(), ip = coalesce($2, ip) WHERE id = $1', [r.session_id, inet(ip)])
    return { user: { id: r.user_id as string, email: r.email as string }, sid: r.session_id as string, refreshToken: next }
  })
  if (stolen) {
    const s = stolen as { sid: string; user: string }
    await publish(db, { t: 'revoke', sid: s.sid })
    await audit(db, 'refresh_reuse_revoked', s.user, ip, { sid: s.sid })
  }
  return out
}

export async function sessionActive(db: Db, sid: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()', [sid])
  return rowCount === 1
}

/** Revoke sessions of a user (one, or all but `keep`), and close their live connections everywhere. */
export async function revokeSessions(db: Db, userId: string, reason: string, which: { only?: string; keep?: string } = {}): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id = $3) AND ($4::uuid IS NULL OR id <> $4) RETURNING id`,
    [userId, reason, which.only ?? null, which.keep ?? null]
  )
  for (const r of rows) await publish(db, { t: 'revoke', sid: r.id })
  return rows.length
}

/** Sign-out with a refresh token (the client may have lost its access token). */
export async function logout(db: Db, token: string): Promise<{ userId: string; sid: string } | null> {
  if (typeof token !== 'string' || token.length > 200) return null
  const { rows } = await db.query<{ session_id: string; user_id: string }>(
    'SELECT r.session_id, s.user_id FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id WHERE r.hash = $1',
    [sha(token)]
  )
  if (!rows[0]) return null
  await revokeSessions(db, rows[0].user_id, 'signed out', { only: rows[0].session_id })
  return { userId: rows[0].user_id, sid: rows[0].session_id }
}

export async function listSessions(db: Db, userId: string): Promise<{ id: string; device: string; createdAt: string; lastUsedAt: string }[]> {
  const { rows } = await db.query(
    `SELECT id, device, created_at, last_used_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC LIMIT 50`,
    [userId]
  )
  return rows.map((r) => ({ id: r.id, device: r.device, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at.toISOString() }))
}

// ---------- Users ----------
export class AuthError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export async function createUser(db: Db, email: string, password: string): Promise<{ id: string; email: string }> {
  const e = normalizeEmail(String(email ?? ''))
  if (!validEmail(e)) throw new AuthError('Enter a valid email address.')
  const bad = passwordProblem(password, e)
  if (bad) throw new AuthError(bad)
  const id = randomUUID()
  try {
    await db.query('INSERT INTO users (id, email, pw_hash) VALUES ($1, $2, $3)', [id, e, await hashPassword(password)])
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AuthError('That email is already registered. Sign in instead.', 409)
    throw err
  }
  return { id, email: e }
}

export type LoginResult = { ok: true; user: { id: string; email: string } } | { ok: false; locked: boolean }

export async function checkLogin(db: Db, email: string, password: string): Promise<LoginResult> {
  const e = normalizeEmail(String(email ?? '')).slice(0, 254)
  const pw = String(password ?? '').slice(0, 200)
  const { rows } = await db.query('SELECT id, email, pw_hash, locked_until > now() AS locked FROM users WHERE email = $1', [e])
  const row = rows[0]
  const good = await verifyPassword(pw, row?.pw_hash ?? (await (dummy ??= hashPassword(randomBytes(16).toString('hex')))))
  if (!row) return { ok: false, locked: false }
  if (row.locked) return { ok: false, locked: true } // checked after hashing: same timing
  if (!good) {
    const { rows: r } = await db.query(
      `UPDATE users SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1 RETURNING coalesce(locked_until > now(), false) AS locked`,
      [row.id, MAX_FAILS, LOCK_MIN]
    )
    return { ok: false, locked: !!r[0]?.locked }
  }
  await db.query('UPDATE users SET failed_logins = 0 WHERE id = $1 AND failed_logins <> 0', [row.id])
  if (needsRehash(row.pw_hash)) await db.query('UPDATE users SET pw_hash = $2 WHERE id = $1', [row.id, await hashPassword(pw)])
  return { ok: true, user: { id: row.id, email: row.email } }
}

async function passwordMatches(db: Db, userId: string, password: string): Promise<{ email: string } | null> {
  const { rows } = await db.query('SELECT email, pw_hash FROM users WHERE id = $1', [userId])
  if (!rows[0] || !(await verifyPassword(String(password ?? '').slice(0, 200), rows[0].pw_hash))) return null
  return { email: rows[0].email }
}

/** Change the password; every other device is signed out. */
export async function changePassword(db: Db, userId: string, sid: string, current: string, next: string): Promise<void> {
  const u = await passwordMatches(db, userId, current)
  if (!u) throw new AuthError('Your current password is not correct.', 403)
  const bad = passwordProblem(next, u.email)
  if (bad) throw new AuthError(bad)
  await db.query('UPDATE users SET pw_hash = $2, password_changed_at = now() WHERE id = $1', [userId, await hashPassword(next)])
  await revokeSessions(db, userId, 'password changed', { keep: sid })
}

/** Delete the account and everything stored for it (sessions, preferences, usage). */
export async function deleteUser(db: Db, userId: string, password: string): Promise<void> {
  if (!(await passwordMatches(db, userId, password))) throw new AuthError('Your password is not correct.', 403)
  await revokeSessions(db, userId, 'account deleted')
  await db.query('DELETE FROM users WHERE id = $1', [userId])
}
