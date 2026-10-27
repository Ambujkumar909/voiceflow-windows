import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

/*
 * All configuration comes from the environment. Any secret can instead be given as a file
 * (`NAME_FILE=/run/secrets/name`, i.e. Docker/ECS secrets), which keeps it out of
 * `docker inspect` and process listings. Secrets are never logged.
 */
const env = process.env
const production = env.NODE_ENV === 'production'

function optional(name: string): string {
  const file = env[`${name}_FILE`]
  return (file ? readFileSync(file, 'utf8') : (env[name] ?? '')).trim()
}

function secret(name: string): string {
  const v = optional(name)
  if (v) {
    if (production && v.length < 32) throw new Error(`${name} must be at least 32 characters`)
    return v
  }
  if (production) throw new Error(`${name} (or ${name}_FILE) must be set in production`)
  // Development only: a random secret per process (tokens die on restart).
  console.warn(`[config] ${name} not set; using a random development value`)
  return randomBytes(32).toString('base64url')
}

function databaseUrl(): string {
  const raw = optional('DATABASE_URL') || (production ? '' : 'postgres://voiceflow:voiceflow@127.0.0.1:5432/voiceflow')
  if (!raw) throw new Error('DATABASE_URL must be set in production')
  const u = new URL(raw)
  const pw = optional('DATABASE_PASSWORD') // lets the password live in a secret file, not the URL
  if (pw) u.password = encodeURIComponent(pw)
  return u.toString()
}

const pepper = optional('PASSWORD_PEPPER')
if (production && pepper.length < 32) throw new Error('PASSWORD_PEPPER (or PASSWORD_PEPPER_FILE) must be set in production (32+ characters)')

export const config = {
  production,
  host: env.HOST ?? '127.0.0.1', // behind a TLS gateway; never exposed directly
  port: Number(env.PORT ?? 8787),
  databaseUrl: databaseUrl(),
  trustProxy: env.TRUST_PROXY === '1', // read the client IP from X-Forwarded-For (ALB/Caddy)
  allowSignup: env.ALLOW_SIGNUP === '1',
  // Mixed into every password hash and kept outside the database: a stolen database alone
  // is not enough to start guessing passwords. Never change it once users exist.
  pepper,
  jwt: {
    secret: secret('JWT_SECRET'),
    // Rotation: move the old secret here and put a new one in JWT_SECRET. Tokens signed with
    // the old one stay valid until they expire (15 min); then remove it.
    previousSecret: optional('JWT_SECRET_PREVIOUS'),
    issuer: 'voiceflow',
    audience: 'voiceflow-desktop',
    accessTtlSec: Number(env.ACCESS_TTL_SEC ?? 15 * 60)
  },
  refreshTtlSec: 30 * 24 * 3600, // a device unused for 30 days must sign in again
  sessionMaxSec: 90 * 24 * 3600, // and every device signs in again after 90 days regardless
  auditRetentionDays: 180,
  limits: {
    // A key-press "prime" keeps the Deepgram socket only briefly; a real dictation keeps it longer.
    primeIdleMs: Number(env.PRIME_IDLE_MS ?? 20_000),
    upstreamIdleMs: Number(env.UPSTREAM_IDLE_MS ?? 120_000),
    finalizeTimeoutMs: Number(env.FINALIZE_TIMEOUT_MS ?? 2500),
    maxMessagesPerSec: 300, // ~50 audio frames/s is normal
    maxDictationSec: 5 * 60,
    maxFrameBytes: 64 * 1024,
    socketsPerUser: 3,
    // Cost guard per account until subscriptions exist: speech seconds per UTC day (0 = off).
    dailyAudioSec: Number(env.DAILY_AUDIO_CAP_SEC ?? 4 * 3600)
  },
  deepgram: {
    key: optional('DEEPGRAM_API_KEY'),
    // From AWS Mumbai the EU endpoint is the closer of Deepgram's two hosted regions.
    ws: env.DEEPGRAM_WS ?? 'wss://api.eu.deepgram.com',
    http: env.DEEPGRAM_HTTP ?? 'https://api.eu.deepgram.com',
    model: env.DEEPGRAM_MODEL ?? 'nova-3',
    // Opt out of Deepgram's model-improvement program (customer audio is not used for training).
    mipOptOut: env.DEEPGRAM_MIP_OPT_OUT !== '0'
  },
  llm: {
    key: optional('LLM_API_KEY'),
    baseUrl: env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1',
    model: env.LLM_MODEL ?? 'openai/gpt-oss-20b'
  }
}
