import { app, globalShortcut, ipcMain, Menu, type BrowserWindow } from 'electron'
import type { DictationState, OverlayAction, OverlayCommand, OverlayState } from '../shared/types'
import { isSignedIn, transcribeClip } from './account'
import { encodeWav } from './dev/openai'
import { addHistory, recordDictation } from './history'
import { foregroundApp, insertText } from './insert'
import { log } from './log'
import { getSettings } from './settings'
import { beginStream, primeStream, type StreamSession } from './stt/voiceflow'
import { notifyHub } from './windows'
import { writeFileSync } from 'node:fs'

const MAX_RECORDING_MS = 5 * 60_000
const MIN_SAMPLES = 16000 * 0.3
const MIN_HOLD_MS = 300 // a shorter hold is a tap: cancel instead of transcribing
const DOUBLE_TAP_MS = 500 // press again this soon after a tap = hands-free

let overlay: BrowserWindow
let state: DictationState = 'idle'
let maxTimer: NodeJS.Timeout | undefined
let resetTimer: NodeJS.Timeout | undefined
// 'hold': stops when the hold combo is released. 'handsfree': started by the toggle shortcut
// or a double-tap of the hold combo; stops on the next press of either.
let mode: 'hold' | 'handsfree' = 'handsfree'
let startedAt = 0
let micLiveAt = 0
let lastMicLatency = -1
/** ms from key press to the first audio chunk of the last dictation (streaming engines only). */
export const micLatency = (): number => lastMicLatency
let micSuspended = false // PC asleep or locked: never hold the mic then
let lastTapAt = 0
let stream: StreamSession | null = null
let openSettings = (): void => {}
let pendingAudio: { resolve: (pcm: Float32Array) => void; reject: (e: Error) => void } | null = null
const listeners: ((s: DictationState) => void)[] = []

export const dictationState = (): DictationState => state
export const onDictationState = (fn: (s: DictationState) => void): void => void listeners.push(fn)

const hint = (): string => {
  const s = getSettings()
  return (s.holdKeys !== 'off' ? s.holdKeys : s.shortcut).split('+').join(' + ')
}

function send(extra: Partial<OverlayState> = {}): void {
  if (!overlay.isDestroyed()) overlay.webContents.send('overlay:state', { state, handsFree: state === 'recording' && mode === 'handsfree', hint: hint(), sounds: getSettings().sounds, ...extra })
}

function setState(s: DictationState, message?: string): void {
  state = s
  clearTimeout(resetTimer)
  send({ message })
  listeners.forEach((fn) => fn(s))
  if (s === 'success' || s === 'error') resetTimer = setTimeout(() => setState('idle'), s === 'error' ? 4000 : 1200)
}

const command = (c: OverlayCommand): void => overlay.webContents.send('overlay:cmd', c)

/** Live words while streaming; no state change, so listeners and the overlay position stay put. */
function sendLive(live: string): void {
  if (state === 'recording') send({ live })
}

function endRecordingHooks(): void {
  clearTimeout(maxTimer)
  if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
}

function fail(msg: string): void {
  endRecordingHooks()
  stream?.abort()
  stream = null
  pendingAudio?.reject(new Error(msg))
  pendingAudio = null
  log('warn', 'dictation failed', { msg })
  setState('error', msg)
}

export function initDictation(win: BrowserWindow, showSettings: () => void): void {
  overlay = win
  openSettings = showSettings
  // The pill is the only clickable part of the overlay window; elsewhere clicks pass through.
  ipcMain.on('overlay:interactive', (e, on: unknown) => {
    if (e.sender !== overlay.webContents) return
    overlay.setIgnoreMouseEvents(on !== true, { forward: true })
    if (on === true) primeEngine() // hovering the pill usually means a dictation is coming
  })
  ipcMain.on('overlay:action', (e, a: OverlayAction) => {
    if (e.sender !== overlay.webContents) return
    if (a === 'start' && state !== 'recording' && state !== 'processing') start('handsfree')
    else if (a === 'stop' && state === 'recording') void stop()
    else if (a === 'cancel') cancelDictation()
    else if (a === 'menu') showMenu()
  })
  ipcMain.handle('overlay:hint', (e) => (e.sender === overlay.webContents ? hint() : ''))
  ipcMain.handle('overlay:audio', (e, pcm: unknown) => {
    if (e.sender !== overlay.webContents) return
    if (pcm instanceof Float32Array) pendingAudio?.resolve(pcm)
    else pendingAudio?.reject(new Error('Bad audio payload'))
  })
  ipcMain.on('overlay:chunk', (e, pcm: unknown) => {
    if (e.sender !== overlay.webContents || !(pcm instanceof Float32Array)) return
    if (micLiveAt === 0 && state === 'recording') {
      micLiveAt = Date.now()
      lastMicLatency = micLiveAt - startedAt
      log('info', 'mic live', { msAfterPress: lastMicLatency })
    }
    stream?.push(pcm)
  })
  // Keep the mic ready once the overlay page exists (and again after any reload).
  overlay.webContents.on('did-finish-load', () => syncMic(true))
  // Overlay problems (e.g. the mic failing to arm) belong in the log, not only in DevTools.
  overlay.webContents.on('console-message', (ev) => {
    if (ev.level === 'warning' || ev.level === 'error') log('warn', 'overlay: ' + ev.message.slice(0, 300))
  })
  ipcMain.handle('overlay:error', (e, msg: unknown) => {
    if (e.sender !== overlay.webContents) return
    if (state === 'recording' || state === 'processing') fail(String(msg).slice(0, 300))
  })
}

function showMenu(): void {
  Menu.buildFromTemplate([
    { label: 'Settings', click: openSettings },
    {
      label: 'Hide for 1 hour',
      click: () => {
        overlay.hide() // dictating still shows it again (positionOverlay)
        setTimeout(() => !overlay.isDestroyed() && overlay.showInactive(), 3600_000)
      }
    },
    { type: 'separator' },
    { label: 'Quit VoiceFlow', click: () => app.quit() }
  ]).popup({ window: overlay })
}

export function toggleDictation(): void {
  if (state === 'recording') void stop()
  else if (state !== 'processing') start('handsfree')
}

/** Hold combo pressed: start holding, start hands-free (double-tap), or finish a hands-free recording. */
export function holdPressed(): void {
  if (state === 'recording') void stop()
  else if (state !== 'processing') start(Date.now() - lastTapAt < DOUBLE_TAP_MS ? 'handsfree' : 'hold')
}

/** Hold combo released. `aborted` means another key was pressed (the user wanted a normal shortcut). */
export function holdReleased(aborted: boolean): void {
  if (state !== 'recording' || mode !== 'hold') return
  const tap = Date.now() - startedAt < MIN_HOLD_MS
  if (aborted || tap) cancelDictation()
  else void stop()
  lastTapAt = tap && !aborted ? Date.now() : 0
}

/** A dictation may follow (first hotkey key, pill hover): have the server warm its speech socket. */
export function primeEngine(): void {
  if (state !== 'recording') primeStream()
}

/** Keep the microphone open with a short in-memory pre-roll (setting), or release it. */
export function syncMic(loaded = false): void {
  if (overlay.isDestroyed() || (!loaded && overlay.webContents.isLoading())) return
  const s = getSettings()
  log('info', 'mic ready mode', { on: s.instantMic && !micSuspended })
  command(s.instantMic && !micSuspended ? { cmd: 'arm', deviceId: s.micDeviceId, processing: s.audioProcessing } : { cmd: 'disarm' })
}
export function setMicSuspended(v: boolean): void {
  micSuspended = v
  syncMic()
}

function start(how: typeof mode): void {
  mode = how
  startedAt = Date.now()
  micLiveAt = 0
  lastMicLatency = -1
  setState('recording')
  lastTapAt = 0
  const s = getSettings()
  if (!isSignedIn()) return fail('Sign in to VoiceFlow first (Settings → Account).')
  // Audio streams to the VoiceFlow server while the user speaks; it relays to the speech engine.
  stream = beginStream(s.language, sendLive)
  command({ cmd: 'start', deviceId: s.micDeviceId, stream: true, processing: s.audioProcessing })
  // Escape cancels, but only while recording so it is not stolen from other apps the rest of the time.
  globalShortcut.register('Escape', cancelDictation)
  maxTimer = setTimeout(() => void stop(), MAX_RECORDING_MS)
}

export function cancelDictation(): void {
  if (state !== 'recording') return
  endRecordingHooks()
  stream?.abort()
  stream = null
  command({ cmd: 'cancel' })
  setState('idle')
}

async function stop(): Promise<void> {
  endRecordingHooks()
  const session = stream
  stream = null
  setState('processing')
  try {
    const pcm = await new Promise<Float32Array>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Recorder did not respond')), 10_000)
      pendingAudio = {
        resolve: (p) => (clearTimeout(t), resolve(p)),
        reject: (e) => (clearTimeout(t), reject(e))
      }
      command({ cmd: 'stop' })
    })
    pendingAudio = null
    const durationMs = Math.round(pcm.length / 16)
    const rms = Math.sqrt(pcm.reduce((a, v) => a + v * v, 0) / (pcm.length || 1))
    log('info', 'audio captured', { durationMs, rms: +rms.toFixed(4) })
    if (process.env.VOICEFLOW_DUMP_AUDIO) writeFileSync(process.env.VOICEFLOW_DUMP_AUDIO, encodeWav(pcm)) // dev: inspect what the mic heard
    if (pcm.length < MIN_SAMPLES) {
      session?.abort()
      return fail('No speech detected')
    }

    const s = getSettings()
    const started = Date.now()
    let via = 'stream'
    let text: string
    try {
      text = await session!.finish() // already processed by the server (dictionary, cleanup, AI cleanup)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'no_speech') return fail('No speech detected')
      if (code !== 'connection' && code !== 'timeout') return fail((e as Error).message)
      // The live stream broke: the whole clip is still here, so upload it once over HTTPS.
      log('warn', 'stream failed, uploading the clip', { error: String((e as Error).message) })
      via = 'upload'
      try {
        text = await transcribeClip(pcm, s.language)
      } catch (e2) {
        // Dictation is for typing now: nothing is queued for later. Say clearly what happened.
        log('warn', 'upload failed', { error: String((e2 as Error).message) })
        return fail("Can't reach VoiceFlow. Check your connection and try again.")
      }
    }
    log('info', 'transcribed', { via, ms: Date.now() - started, chars: text.length })
    if (!text.trim()) return fail('No speech detected')
    const raw = text

    const app = await foregroundApp()
    // Save before inserting so the transcript survives an insertion failure.
    if (s.saveHistory) addHistory({ text, raw, durationMs, app, provider: 'voiceflow' + (via === 'upload' ? ' (upload)' : '') })
    recordDictation(text, durationMs)
    await insertText(text, s.insertMode, s.restoreClipboard)
    setState('success')
    notifyHub()
  } catch (e) {
    if (state === 'processing') fail((e as Error).message)
  }
}
