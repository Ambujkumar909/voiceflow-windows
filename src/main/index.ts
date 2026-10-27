import { app, ipcMain, nativeTheme, powerMonitor, safeStorage, session, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import { cpSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Status } from '../shared/types'
import { accountStatus, changePassword, deleteAccount, listDevices, onAccountChange, signIn, signOut, signOutDevice, signOutEverywhere, signUp, syncPrefs } from './account'
import { holdPressed, holdReleased, initDictation, onDictationState, primeEngine, setMicSuspended, syncMic, toggleDictation } from './dictation'
import { connectStream, disconnectStream, streamStatus } from './stt/voiceflow'
import { initHoldHook, setHoldKeys, stopHoldHook } from './hold'
import { clearHistory, deleteHistory, getHistory, getStats } from './history'
import { disposeInserter, warmupInserter } from './insert'
import { log, logPath } from './log'
import { makeStimulus, runFrontendBench, stimulusPath } from './dev/frontend-bench'
import { getSettings, loadSettings, publicSettings, saveSettings } from './settings'
import { registerToggle, shortcutStatus, unregisterAll } from './shortcut'
import { createOverlay, createTray, notifyHub, positionOverlay, setTrayStatus, showHub } from './windows'

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

// Dev tooling models (benchmarks) live in the real profile; tests get a throwaway profile.
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

function status(): Status {
  const s = shortcutStatus()
  return {
    shortcutRegistered: !!s.registered,
    shortcutError: s.error,
    holdError,
    micAccess: systemPreferences.getMediaAccessStatus('microphone'),
    engine: accountStatus().signedIn ? streamStatus() : 'signed out',
    accountError: accountStatus().error,
    logPath: logPath(),
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }
}

app.whenReady().then(async () => {
  if (!primary) return
  loadSettings()
  nativeTheme.themeSource = getSettings().theme // drives prefers-color-scheme in every window
  log('info', 'starting', { version: app.getVersion(), electron: process.versions.electron })
  if (process.argv.includes('--bench') && !app.isPackaged) return (await import('./dev/bench')).runBench()
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
    // What the server applies (language, dictionary, cleanup, AI cleanup) is pushed to it.
    if (JSON.stringify([after.language, after.dictionary, after.cleanup, after.polish]) !== JSON.stringify([before.language, before.dictionary, before.cleanup, before.polish])) void syncPrefs()
    if (after.serverUrl !== before.serverUrl) (disconnectStream(), connectStream())
    return { settings: publicSettings(), error: shortcut.error }
  })
  // Account calls answer { ok, error, data } so the UI can show the server's message.
  const result = async (f: () => Promise<unknown>): Promise<{ ok: boolean; error: string; data?: unknown }> => {
    try {
      return { ok: true, error: '', data: await f() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
  const str = (v: unknown, max: number): string => String(v ?? '').slice(0, max)
  handle('account:signIn', (email: unknown, password: unknown) => result(() => signIn(str(email, 254), str(password, 200))))
  handle('account:signUp', (email: unknown, password: unknown) => result(() => signUp(str(email, 254), str(password, 200))))
  handle('account:devices', () => result(() => listDevices()))
  handle('account:signOutDevice', (id: unknown) => result(() => signOutDevice(str(id, 64))))
  handle('account:signOutEverywhere', () => result(() => signOutEverywhere()))
  handle('account:changePassword', (cur: unknown, next: unknown) => result(() => changePassword(str(cur, 200), str(next, 200))))
  handle('account:delete', (password: unknown) => result(() => deleteAccount(str(password, 200))))
  handle('account:signOut', () => signOut())
  onAccountChange(() => {
    if (accountStatus().signedIn) connectStream(true)
    else disconnectStream()
    notifyHub() // sign-in screen ⇄ app, at once
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
  connectStream() // open the server connection now (no-op when signed out)
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
  disconnectStream()
  disposeInserter()
  log('info', 'shutdown')
})
