import { isIP } from 'node:net'
import pg from 'pg'

/*
 * PostgreSQL: accounts, sessions, refresh-token hashes, preferences, usage counters and the
 * security audit log. No audio and no transcripts, ever.
 *  - Every query is parameterized (no string-built SQL).
 *  - Schema changes are numbered migrations, applied once at start-up under an advisory lock,
 *    so several server instances can start at the same time safely.
 *  - Cross-instance events (a session revoked, preferences changed) go over LISTEN/NOTIFY,
 *    so every server reacts within milliseconds without polling.
 */
export type Db = pg.Pool

const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
    pw_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    failed_logins int NOT NULL DEFAULT 0,
    locked_until timestamptz
  );
  -- One row per signed-in device. Revoking it ends that device's access everywhere.
  CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device text NOT NULL DEFAULT '',
    ip inet,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoke_reason text
  );
  CREATE INDEX sessions_live ON sessions(user_id) WHERE revoked_at IS NULL;
  -- Only SHA-256 hashes of refresh tokens are stored.
  CREATE TABLE refresh_tokens (
    hash bytea PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    replaced_by bytea
  );
  CREATE INDEX refresh_session ON refresh_tokens(session_id);
  CREATE TABLE prefs (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE usage_daily (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day date NOT NULL,
    dictations int NOT NULL DEFAULT 0,
    seconds double precision NOT NULL DEFAULT 0,
    words int NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  -- Security events. No foreign key: the trail outlives a deleted account until retention ends.
  CREATE TABLE audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    user_id uuid,
    event text NOT NULL,
    ip inet,
    detail jsonb
  );
  CREATE INDEX audit_user ON audit_log(user_id, at);
  CREATE INDEX audit_at ON audit_log(at);
  `
]

export async function openDb(url: string): Promise<Db> {
  const db = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000, // no query may hold a connection for long
    application_name: 'voiceflow'
  })
  db.on('error', (e) => console.error(JSON.stringify({ msg: 'db idle client error', error: e.message }))) // never crash on a dropped idle connection
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    await c.query('SELECT pg_advisory_xact_lock(727274)') // one migrator at a time
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const { rows } = await c.query<{ v: number }>('SELECT coalesce(max(version), 0) AS v FROM schema_migrations')
    for (let v = rows[0].v + 1; v <= MIGRATIONS.length; v++) {
      await c.query(MIGRATIONS[v - 1])
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v])
    }
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
  return db
}

/** Postgres `inet` or null (X-Forwarded-For is client-controlled until the proxy rewrites it). */
export const inet = (ip: string | undefined): string | null => (ip && isIP(ip) ? ip : null)

export async function audit(db: Db, event: string, userId: string | null, ip?: string, detail?: object): Promise<void> {
  await db.query('INSERT INTO audit_log (user_id, event, ip, detail) VALUES ($1, $2, $3, $4)', [userId, event, inet(ip), detail ?? null]).catch((e) => {
    console.error(JSON.stringify({ msg: 'audit write failed', event, error: e.message }))
  })
}

export async function recordUsage(db: Db, userId: string, seconds: number, words: number): Promise<void> {
  await db.query(
    `INSERT INTO usage_daily (user_id, day, dictations, seconds, words) VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1, $2, $3)
     ON CONFLICT (user_id, day) DO UPDATE SET dictations = usage_daily.dictations + 1, seconds = usage_daily.seconds + excluded.seconds, words = usage_daily.words + excluded.words`,
    [userId, seconds, words]
  )
}

export async function secondsToday(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ s: number }>(`SELECT seconds AS s FROM usage_daily WHERE user_id = $1 AND day = (now() AT TIME ZONE 'utc')::date`, [userId])
  return rows[0]?.s ?? 0
}

/** Hourly housekeeping: expired tokens and sessions, audit entries past retention. */
export async function prune(db: Db, auditDays: number): Promise<void> {
  await db.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'`)
  await db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '30 days'`)
  await db.query(`DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)`, [auditDays])
}

// ---------- Cross-instance events ----------
export type BusEvent = { t: 'revoke'; sid: string } | { t: 'prefs'; user: string }
const CHANNEL = 'voiceflow_events'

export async function publish(db: Db, e: BusEvent): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(e)])
}

/**
 * Delivers every published event (from any instance) to `on`; reconnects by itself. Events
 * sent during a reconnect gap are missed; the in-band token refresh re-checks the session.
 */
export function subscribe(db: Db, on: (e: BusEvent) => void): () => void {
  let stopped = false
  let client: pg.PoolClient | null = null
  const connect = async (): Promise<void> => {
    let c: pg.PoolClient | undefined
    let dead = false
    const lost = (): void => {
      if (dead) return
      dead = true
      if (client === c) client = null
      c?.release(true)
      if (!stopped) setTimeout(connect, 1000).unref()
    }
    try {
      c = await db.connect()
      if (stopped) return c.release()
      client = c
      c.on('notification', (n) => {
        try {
          on(JSON.parse(n.payload ?? ''))
        } catch {
          /* malformed payload */
        }
      })
      c.on('error', lost)
      await c.query(`LISTEN ${CHANNEL}`)
    } catch {
      lost()
    }
  }
  void connect()
  return () => {
    stopped = true
    client?.release(true)
    client = null
  }
}
