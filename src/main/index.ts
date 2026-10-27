import { app, ipcMain, nativeTheme, powerMonitor, safeStorage, session, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import { cpSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { KeySlot, Status } from '../shared/types'
import { holdPressed, holdReleased, initDictation, onDictationState, primeEngine, setMicSuspended, syncMic, toggleDictation } from './dictation'
import { closeDeepgram, deepgramStatus } from './stt/deepgram'
import { initHoldHook, setHoldKeys, stopHoldHook } from './hold'
import { clearHistory, deleteHistory, getHistory, getStats } from './history'
import { disposeInserter, warmupInserter } from './insert'
import { log, logPath } from './log'
import { makeStimulus, runFrontendBench, stimulusPath } from './frontend-bench'
import { getSettings, loadSettings, publicSettings, saveSettings, setApiKey } from './settings'
import { registerToggle, shortcutStatus, unregisterAll } from './shortcut'
import { getProvider } from './stt'
import { createOverlay, createTray, positionOverlay, setTrayStatus, showHub } from './windows'

process.on('uncaughtException', (e) => log('error', 'uncaught exception', { error: String(e?.stack ?? e) }))
process.on('unhandledRejection', (e) => log('error', 'unhandled rejection', { error: String(e) }))

// One-time move of the profile from the app's old name (FlowType) to VoiceFlow. The whole folder
// moves, including Chromium's "Local State", which holds the key that decrypts saved API keys.
{
  const now = app.getPath('userData')
  const old = join(app.getPath('appData'), 'FlowType')
  if (existsSync(old) && !existsSync(join(now, 'settings.json'))) {
    try {
      if (existsSync(now)) cpSync(old, now, { recursive: true })
      else renameSync(old, now)
    } catch (e) {
      console.error('profile migration failed (is the old app still running?)', e)
    }
  }
}

// Models live in the real profile; the self-test gets a throwaway profile for everything else.
process.env.VOICEFLOW_MODELS ??= join(app.getPath('userData'), 'models')
const frontendBench = process.argv.includes('--bench-frontend') && !app.isPackaged
if (process.argv.some((a) => a === '--selftest' || a === '--bench' || a === '--bench-frontend') && !app.isPackaged) app.setPath('userData', join(app.getPath('temp'), 'voiceflow-selftest'))

// Self-test without speakers or a real mic: Chromium plays a WAV file as the microphone.
if ((process.argv.includes('--fake-mic') || frontendBench) && !app.isPackaged) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  const file = frontendBench ? (makeStimulus(app.getAppPath()), stimulusPath(app.getAppPath())) : join(app.getAppPath(), 'test', 'hello.wav')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', file)
}

// A second copy hands off to the first and exits before creating anything (in particular the
// native keyboard hook, which must not be torn down mid-startup).
app.setAppUserModelId('com.voiceflow.desktop') // taskbar grouping and pinning identity
const primary = app.requestSingleInstanceLock()
if (!primary) app.exit(0)
app.on('second-instance', () => showHub())

/** Only our own pages (dev server or packaged files) may use IPC or the microphone. */
const appUrl = (url: string): boolean => {
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  return (!!dev && url.startsWith(dev)) || url.startsWith(pathToFileURL(app.getAppPath()).href)
}
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args) => {
    if (!appUrl(e.senderFrame?.url ?? '')) throw new Error('Untrusted sender')
    return fn(...args)
  })
}

function applyShortcut(): { ok: boolean; error: string } {
  return registerToggle(getSettings().shortcut, toggleDictation)
}

let holdError = ''
function applyHoldKeys(): void {
  holdError = setHoldKeys(getSettings().holdKeys).error
}

function warmProvider(): void {
  getProvider(getSettings())
    .warmup?.()
    .catch(() => {}) // status() reports the error
}

function status(): Status {
  const s = shortcutStatus()
  return {
    shortcutRegistered: !!s.registered,
    shortcutError: s.error,
    holdError,
    micAccess: systemPreferences.getMediaAccessStatus('microphone'),
    provider: getSettings().provider === 'deepgram' ? 'Deepgram Nova-3 · ' + deepgramStatus() : getProvider(getSettings()).status(),
    logPath: logPath(),
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }
}

app.whenReady().then(async () => {
  if (!primary) return
  // Dev helper: store a key from the environment in the real profile (encrypted), then exit.
  if (process.argv.includes('--import-deepgram-key') && !app.isPackaged) {
    loadSettings()
    setApiKey('deepgram', process.env.VOICEFLOW_IMPORT_KEY ?? '')
    saveSettings({ provider: 'deepgram' })
    console.log('IMPORTED deepgram key; provider =', getSettings().provider, '; on disk encrypted:', !JSON.stringify(publicSettings()).includes(process.env.VOICEFLOW_IMPORT_KEY ?? '~'))
    return app.exit(0)
  }
  loadSettings()
  nativeTheme.themeSource = getSettings().theme // drives prefers-color-scheme in every window
  log('info', 'starting', { version: app.getVersion(), electron: process.versions.electron })
  if (process.argv.includes('--bench') && !app.isPackaged) return (await import('./bench')).runBench()
  if (frontendBench) {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
    return runFrontendBench()
  }

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && appUrl(wc.getURL())))
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && appUrl(wc?.getURL() ?? ''))

  const overlay = createOverlay()
  initDictation(overlay, () => void showHub())
  onDictationState((s) => {
    setTrayStatus(s)
    if (s === 'recording') positionOverlay(overlay)
  })

  handle('settings:get', () => publicSettings())
  handle('settings:save', (patch: unknown) => {
    const before = getSettings()
    const after = saveSettings(patch)
    let shortcut = { ok: true, error: '' }
    if (after.shortcut !== before.shortcut) {
      shortcut = applyShortcut()
      if (!shortcut.ok) saveSettings({ shortcut: before.shortcut }) // keep what actually works on disk
    }
    if (after.holdKeys !== before.holdKeys) applyHoldKeys()
    if (after.theme !== before.theme) nativeTheme.themeSource = after.theme
    if (after.instantMic !== before.instantMic || after.micDeviceId !== before.micDeviceId || after.audioProcessing !== before.audioProcessing) syncMic()
    if (after.openAtLogin !== before.openAtLogin) app.setLoginItemSettings({ openAtLogin: after.openAtLogin, args: ['--hidden'] })
    if (after.provider !== before.provider || after.localModel !== before.localModel) warmProvider()
    if (after.provider !== 'deepgram') closeDeepgram()
    else primeEngine() // reconnects if language, region or dictionary changed
    return { settings: publicSettings(), error: shortcut.error }
  })
  handle('settings:setApiKey', (slot: unknown, key: unknown) => {
    setApiKey(slot as KeySlot, typeof key === 'string' ? key : '')
    if (slot === 'deepgram') (closeDeepgram(), primeEngine())
  })
  handle('status:get', () => status())
  handle('history:get', () => getHistory())
  handle('history:clear', () => clearHistory())
  handle('history:delete', (id: unknown) => deleteHistory(String(id)))
  handle('stats:get', () => getStats())
  handle('app:info', () => ({ version: app.getVersion() }))

  const sc = applyShortcut()
  initHoldHook({ prime: primeEngine, press: holdPressed, release: holdReleased })
  applyHoldKeys()
  createTray({ toggle: toggleDictation, settings: showHub, quit: () => app.quit() })
  warmupInserter().catch((e) => log('error', 'insert helper failed to start', { error: String(e) }))
  warmProvider() // the local model is also the offline fallback
  primeEngine()
  powerMonitor.on('resume', primeEngine)
  // Never hold the microphone while the PC sleeps or is locked.
  powerMonitor.on('suspend', () => setMicSuspended(true))
  powerMonitor.on('lock-screen', () => setMicSuspended(true))
  powerMonitor.on('resume', () => setMicSuspended(false))
  powerMonitor.on('unlock-screen', () => setMicSuspended(false))

  if (process.argv.includes('--selftest') && !app.isPackaged) {
    const { runSelfTest } = await import('./selftest')
    return runSelfTest(overlay)
  }
  if (!process.argv.includes('--hidden') || !sc.ok) showHub()
})

// Keep running in the tray when the settings window closes.
app.on('window-all-closed', () => {})
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (ev, url) => !appUrl(url) && ev.preventDefault())
})
app.on('will-quit', () => {
  unregisterAll()
  stopHoldHook()
  closeDeepgram()
  disposeInserter()
  log('info', 'shutdown')
})
