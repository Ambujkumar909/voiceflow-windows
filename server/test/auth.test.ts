import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import {
  changePassword,
  checkLogin,
  createSession,
  createUser,
  deleteUser,
  hashPassword,
  listSessions,
  passwordProblem,
  revokeSessions,
  rotateRefresh,
  sessionActive,
  signAccess,
  verifyAccess,
  verifyPassword
} from '../src/auth.ts'
import { openDb, type Db } from '../src/db.ts'
import { testDatabaseUrl } from './pg.ts'

const cfg = { secret: 'test-secret-0123456789', issuer: 'voiceflow', audience: 'voiceflow-desktop', accessTtlSec: 900 }
const PW = 'long enough password'
let db: Db
before(async () => (db = await openDb(await testDatabaseUrl())))
after(() => db?.end())

test('passwords: Argon2id PHC hash verifies; wrong password, junk and absurd parameters do not', async () => {
  const h = await hashPassword('correct horse battery')
  assert.match(h, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)
  assert.ok(await verifyPassword('correct horse battery', h))
  assert.ok(!(await verifyPassword('correct horse batterx', h)))
  assert.ok(!(await verifyPassword('x', 'plain$text')))
  assert.ok(!(await verifyPassword('correct horse battery', h.replace('m=65536', 'm=99999999'))), 'unbounded memory parameter accepted')
})

test('password rules: length and a blocklist, no composition rules', () => {
  assert.ok(passwordProblem('short'))
  assert.ok(passwordProblem('x'.repeat(201)))
  assert.ok(passwordProblem('Password123'), 'common password allowed')
  assert.ok(passwordProblem('aaaaaaaaaaaa'), 'one repeated character allowed')
  assert.ok(passwordProblem('someone@example.com', 'Someone@example.com'), 'email as password allowed')
  assert.equal(passwordProblem('purple monkey dishwasher'), null)
})

test('access tokens: valid, then rejected when tampered, alg none, wrong key, expired, foreign or session-less', () => {
  const { token } = signAccess(cfg, { id: 'u1', email: 'a@b.co' }, 's1')
  assert.deepEqual({ ...verifyAccess(cfg, token), exp: 0 }, { sub: 'u1', sid: 's1', email: 'a@b.co', exp: 0 })
  const [h, body, sig] = token.split('.')
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString())
  const evil = Buffer.from(JSON.stringify({ ...claims, sub: 'admin' })).toString('base64url')
  assert.equal(verifyAccess(cfg, `${h}.${evil}.${sig}`), null, 'tampered payload accepted')
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')
  assert.equal(verifyAccess(cfg, `${none}.${body}.`), null, 'alg none accepted')
  const other = createHmac('sha256', 'other-secret').update(`${h}.${body}`).digest('base64url')
  assert.equal(verifyAccess(cfg, `${h}.${body}.${other}`), null, 'wrong key accepted')
  assert.equal(verifyAccess(cfg, token, Date.now() + 901_000), null, 'expired accepted')
  assert.equal(verifyAccess({ ...cfg, audience: 'web' }, token), null, 'foreign audience accepted')
  const noSid = Buffer.from(JSON.stringify({ ...claims, sid: undefined })).toString('base64url')
  assert.equal(verifyAccess(cfg, `${h}.${noSid}.${createHmac('sha256', cfg.secret).update(`${h}.${noSid}`).digest('base64url')}`), null, 'token without a session accepted')
})

test('signing-key rotation: old tokens valid while the previous secret is configured, then not', () => {
  const old = signAccess(cfg, { id: 'u1', email: 'a@b.co' }, 's1').token
  const rotated = { ...cfg, secret: 'brand-new-secret-9876543210', previousSecret: cfg.secret }
  assert.equal(verifyAccess(rotated, old)?.sub, 'u1')
  assert.equal(verifyAccess(rotated, signAccess(rotated, { id: 'u2', email: 'b@b.co' }, 's2').token)?.sub, 'u2')
  assert.equal(verifyAccess({ ...rotated, previousSecret: '' }, old), null, 'retired key still accepted')
})

test('refresh: rotates; a lost response may retry once; real reuse revokes the session', async () => {
  const u = await createUser(db, 'Rot@Example.com', PW)
  const s = await createSession(db, u.id, { device: 'test', ip: '10.0.0.1' })
  const r1 = await rotateRefresh(db, s.refreshToken)
  assert.ok(r1 && r1.user.id === u.id && r1.sid === s.sid && r1.refreshToken !== s.refreshToken)
  // Response lost: the client retries with the same token within 30 s → allowed, and r1 dies.
  const r1b = await rotateRefresh(db, s.refreshToken)
  assert.ok(r1b, 'retry after a lost response refused')
  assert.equal(await rotateRefresh(db, r1!.refreshToken), null, 'superseded branch still usable')
  assert.equal(await sessionActive(db, s.sid), false, 'using a dead branch did not revoke the session')
  assert.equal(await rotateRefresh(db, r1b!.refreshToken), null, 'session still usable after theft detection')
})

test('refresh: replaying a token whose successor was already used revokes the session', async () => {
  const u = await createUser(db, 'thief@example.com', PW)
  const s = await createSession(db, u.id, {})
  const r1 = await rotateRefresh(db, s.refreshToken)
  const r2 = await rotateRefresh(db, r1!.refreshToken)
  assert.ok(r2)
  assert.equal(await rotateRefresh(db, s.refreshToken), null, 'stolen old token accepted')
  assert.equal(await rotateRefresh(db, r2!.refreshToken), null, 'session survived the theft')
})

test('login: same answer for unknown email and wrong password; lockout after 10 failures', async () => {
  await createUser(db, 'me@example.com', PW)
  assert.deepEqual(await checkLogin(db, 'nobody@example.com', 'whatever'), { ok: false, locked: false })
  assert.deepEqual(await checkLogin(db, 'me@example.com', 'wrong password'), { ok: false, locked: false })
  assert.equal((await checkLogin(db, ' ME@example.com ', PW)).ok, true)
  let last
  for (let i = 0; i < 10; i++) last = await checkLogin(db, 'me@example.com', 'wrong password')
  assert.deepEqual(last, { ok: false, locked: true })
  assert.deepEqual(await checkLogin(db, 'me@example.com', PW), { ok: false, locked: true }, 'locked account let in')
})

test('account rules: valid email, password rules, no duplicates (case-insensitive)', async () => {
  await assert.rejects(createUser(db, 'not-an-email', PW))
  await assert.rejects(createUser(db, 'a@b.co', 'short'))
  await createUser(db, 'a@b.co', PW)
  await assert.rejects(createUser(db, 'A@B.CO', PW), /already registered/)
})

test('sessions: listed per device, revocable one by one or all at once', async () => {
  const u = await createUser(db, 'devices@example.com', PW)
  const a = await createSession(db, u.id, { device: 'Laptop' })
  const b = await createSession(db, u.id, { device: 'Desktop\u0000\u001b[31m' })
  assert.deepEqual((await listSessions(db, u.id)).map((s) => s.device).sort(), ['Desktop[31m', 'Laptop'])
  assert.equal(await revokeSessions(db, u.id, 'test', { only: a.sid }), 1)
  assert.equal(await sessionActive(db, a.sid), false)
  assert.equal(await sessionActive(db, b.sid), true)
  assert.equal(await revokeSessions(db, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'test', { only: b.sid }), 0, "revoked someone else's session")
  assert.equal(await revokeSessions(db, u.id, 'test'), 1)
  assert.equal(await sessionActive(db, b.sid), false)
})

test('password change: needs the current password, signs out every other device', async () => {
  const u = await createUser(db, 'change@example.com', PW)
  const here = await createSession(db, u.id, {})
  const there = await createSession(db, u.id, {})
  await assert.rejects(changePassword(db, u.id, here.sid, 'wrong password', 'a brand new password'), /not correct/)
  await assert.rejects(changePassword(db, u.id, here.sid, PW, 'password123'), /too easy/)
  await changePassword(db, u.id, here.sid, PW, 'a brand new password')
  assert.equal(await sessionActive(db, here.sid), true)
  assert.equal(await sessionActive(db, there.sid), false)
  assert.equal((await checkLogin(db, 'change@example.com', PW)).ok, false)
  assert.equal((await checkLogin(db, 'change@example.com', 'a brand new password')).ok, true)
})

test('account deletion: needs the password, removes the user and every session', async () => {
  const u = await createUser(db, 'gone@example.com', PW)
  const s = await createSession(db, u.id, {})
  await assert.rejects(deleteUser(db, u.id, 'wrong password'))
  await deleteUser(db, u.id, PW)
  assert.equal(await sessionActive(db, s.sid), false)
  assert.equal((await db.query('SELECT 1 FROM users WHERE id = $1', [u.id])).rowCount, 0)
  assert.equal((await checkLogin(db, 'gone@example.com', PW)).ok, false)
})
