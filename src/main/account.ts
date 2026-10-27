import { hostname } from 'node:os'
import { log } from './log'
import { getApiKey, getSettings, saveSettings, setApiKey } from './settings'

/*
 * VoiceFlow account: email + password sign-in against the VoiceFlow server.
 *  - The refresh token is stored encrypted (Windows DPAPI via safeStorage, key slot "session").
 *  - The access token (15 min) lives in memory only and is refreshed ahead of expiry.
 *  - Preferences that shape transcription (language, dictionary, cleanup, AI cleanup) are
 *    pushed to the server, which applies them; the server never receives anything else.
 */
let access: { token: string; exp: number } | null = null
let refreshing: Promise<string> | null = null
let lastError = ''
const listeners: (() => void)[] = []

export const onAccountChange = (fn: () => void): void => void listeners.push(fn)
const changed = (): void => listeners.forEach((f) => f())

/** https://host → { http: 'https://host', ws: 'wss://host' } (http/ws for localhost only). */
export function endpoints(): { http: string; ws: string } {
  const u = new URL(getSettings().serverUrl)
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (u.protocol !== 'https:' && !local) throw new Error('The server address must start with https://')
  const http = `${u.protocol}//${u.host}`
  return { http, ws: http.replace(/^http/, 'ws') }
}

/**
 * fetch, retried once on a network-level failure. After a network blip the HTTP client may hand
 * out a pooled keep-alive connection that is already dead; the retry gets a fresh one.
 * HTTP errors (4xx/5xx) are answers, not network failures, and are never retried here.
 */
async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (e) {
    if (init.signal?.aborted) throw e // our own timeout: don't double it
    await new Promise((r) => setTimeout(r, 200))
    return fetch(url, init)
  }
}

async function call(path: string, body: object | undefined, token?: string, method = 'POST'): Promise<any> {
  const r = await fetchOnce(endpoints().http + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000)
  })
  const j = r.status === 204 ? null : await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j?.error || `Server error (${r.status})`), { status: r.status })
  return j
}

function accept(j: { accessToken: string; expiresIn: number; refreshToken: string; user: { email: string } }): string {
  setApiKey('session', j.refreshToken)
  access = { token: j.accessToken, exp: Date.now() + j.expiresIn * 1000 }
  lastError = ''
  if (getSettings().accountEmail !== j.user.email) saveSettings({ accountEmail: j.user.email })
  return j.accessToken
}

// Shown in the account's device list ("Signed-in devices").
const device = (): string => `VoiceFlow for Windows · ${hostname().slice(0, 40)}`

export async function signIn(email: string, password: string): Promise<void> {
  accept(await call('/v1/auth/login', { email, password, device: device() }))
  log('info', 'signed in')
  changed()
  void syncPrefs()
}

/** Create an account; the server signs the new account straight in. */
export async function signUp(email: string, password: string): Promise<void> {
  accept(await call('/v1/auth/register', { email, password, device: device() }))
  log('info', 'account created')
  changed()
  void syncPrefs()
}

function forget(): void {
  access = null
  setApiKey('session', '')
  saveSettings({ accountEmail: '' })
  changed()
}

export async function signOut(): Promise<void> {
  const rt = getApiKey('session')
  forget()
  if (rt) await call('/v1/auth/logout', { refreshToken: rt }).catch(() => {})
}

// ---------- Account management (all need the current session) ----------
export interface Device {
  id: string
  device: string
  createdAt: string
  lastUsedAt: string
  current: boolean
}
export const listDevices = async (): Promise<Device[]> => (await call('/v1/me/sessions', undefined, await accessToken(), 'GET')).sessions
export const signOutDevice = async (id: string): Promise<void> => void (await call(`/v1/me/sessions/${encodeURIComponent(id)}`, undefined, await accessToken(), 'DELETE'))
export async function signOutEverywhere(): Promise<void> {
  await call('/v1/me/sessions/revoke-all', {}, await accessToken())
  forget()
}
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await call('/v1/me/password', { currentPassword, newPassword }, await accessToken())
}
export async function deleteAccount(password: string): Promise<void> {
  await call('/v1/me', { password }, await accessToken(), 'DELETE')
  forget()
}

/** A valid access token, refreshing it (once, shared) when it's close to expiry. */
export function accessToken(): Promise<string> {
  if (access && access.exp - Date.now() > 60_000) return Promise.resolve(access.token)
  return (refreshing ??= (async () => {
    const rt = getApiKey('session')
    if (!rt) throw new Error('Not signed in')
    try {
      const token = accept(await call('/v1/auth/refresh', { refreshToken: rt }))
      changed()
      return token
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        // Session revoked or expired: sign out locally so the UI asks to sign in again.
        access = null
        setApiKey('session', '')
        lastError = 'Your session ended. Sign in again.'
        changed()
      }
      throw e
    }
  })().finally(() => (refreshing = null)))
}

export const isSignedIn = (): boolean => !!getApiKey('session')
export const accountStatus = (): { signedIn: boolean; email: string; error: string } => ({ signedIn: isSignedIn(), email: getSettings().accountEmail, error: lastError })

/** Push the preferences the server applies (language, dictionary, cleanup, AI cleanup). */
export async function syncPrefs(): Promise<void> {
  if (!isSignedIn()) return
  const s = getSettings()
  try {
    const token = await accessToken()
    const r = await fetchOnce(endpoints().http + '/v1/me/prefs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ language: s.language, dictionary: s.dictionary, cleanup: s.cleanup, polish: s.polish }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    log('warn', 'preference sync failed', { error: String((e as Error).message) })
  }
}

/** Backup path when a live stream breaks: upload the whole clip once over HTTPS. */
export async function transcribeClip(pcm: Float32Array, language: string): Promise<string> {
  const body = new Int16Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) body[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7fff
  const r = await fetchOnce(`${endpoints().http}/v1/transcribe?lang=${encodeURIComponent(language)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${await accessToken()}` },
    body: new Uint8Array(body.buffer),
    signal: AbortSignal.timeout(Math.round(4000 + (pcm.length / 16000) * 200)) // 4 s + 0.2 s per audio second (integer ms!)
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error || `Server error (${r.status})`)
  return String(j.text ?? '')
}

/** Expose the current access token's expiry so the stream can send a fresh one in time. */
export const accessExpiry = (): number => access?.exp ?? 0
