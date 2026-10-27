/*
 * End-to-end self-test (`npm run selftest`, or `npm run selftest:quiet` with a WAV as the
 * microphone). Dev builds only; uses a throwaway profile.
 *
 * Drives the real client against the real VoiceFlow server (spawned as a child process with a
 * throwaway database) and a mock Deepgram that follows the protocol observed against the real
 * API. Covers sign-in and session storage, the hotkeys, OS-level text insertion into a test
 * editor, the pill and hub, live streaming, server-side dictionary, failover and reconnects.
 * Transcripts come from the mock (real recognition quality is measured by `npm run bench`).
 */
import { app, BrowserWindow, clipboard, globalShortcut, nativeTheme } from 'electron'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect as netConnect, createServer as createNetServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { signIn, signOut, syncPrefs } from './account'
import { cancelDictation, dictationState, micLatency, onDictationState, syncMic, toggleDictation } from './dictation'
import { addHistory, getHistory, recordDictation } from './history'
import { clipboardSettled, focusWindow, foregroundApp, insertText, keysDown, keysUp, pressChord } from './insert'
import { getSettings, loadSettings, publicSettings, saveSettings } from './settings'
import { registerToggle, shortcutStatus } from './shortcut'
import { connectAttempts, streamStatus } from './stt/voiceflow'
import { showHub } from './windows'

const results: { name: string; ok: boolean; detail: string }[] = []
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = (await fn()) || ''
    results.push({ name, ok: true, detail })
    console.log(`SELFTEST PASS ${name} ${detail}`)
  } catch (e) {
    results.push({ name, ok: false, detail: String((e as Error).message) })
    console.log(`SELFTEST FAIL ${name} ${(e as Error).message}`)
  }
}

function waitForState(target: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (target.includes(dictationState())) return resolve(dictationState())
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${target.join('/')} (state: ${dictationState()})`)), timeoutMs)
    onDictationState((s) => {
      if (target.includes(s)) {
        clearTimeout(t)
        resolve(s)
      }
    })
  })
}
async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (let i = 0; i < ms / 50 && !(await cond()); i++) await sleep(50)
  return cond()
}

const FAKE_MIC = process.argv.includes('--fake-mic') // test/hello.wav is the microphone; nothing plays aloud

function speak(text: string): Promise<void> {
  if (FAKE_MIC) return sleep(Math.max(2500, text.length * 50)) // let the WAV "speak" for a similar time
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $s.Volume = 100; $s.SetOutputToDefaultAudioDevice(); $s.Speak('${text}'); $s.Dispose()`
  return new Promise((resolve) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).on('exit', () => resolve()))
}

async function shot(win: BrowserWindow, name: string): Promise<void> {
  const dir = join(app.getAppPath(), 'test', 'out')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG())
}

/**
 * Stand-in for Deepgram (/v1/listen WebSocket + batch POST), following the protocol observed
 * against the real API: Results carry start/duration in audio seconds; interim results while
 * audio flows; Finalize → a final with from_finalize, then a late duplicate empty one.
 * Each Finalize answers with the next scripted transcript; `fail` drops sockets after ~1 s.
 */
async function mockDeepgram() {
  const dg = { connections: 0, urls: [] as string[], auth: '', bytes: 0, finalizes: 0, keepAlives: 0, script: [] as string[], fail: false, batchText: '' }
  const srv = createServer((req, res) => {
    req.resume()
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: dg.batchText }] }] } })))
  })
  srv.on('upgrade', (req, sock) => {
    dg.connections++
    dg.urls.push(decodeURIComponent(req.url ?? ''))
    dg.auth = String(req.headers.authorization)
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const send = (o: object): void => {
      const p = Buffer.from(JSON.stringify(o))
      sock.write(Buffer.concat([Buffer.from(p.length < 126 ? [0x81, p.length] : [0x81, 126, p.length >> 8, p.length & 255]), p]))
    }
    const result = (start: number, end: number, text: string, extra: object): object => ({ type: 'Results', start, duration: end - start, channel: { alternatives: [{ transcript: text }] }, ...extra })
    let buf = Buffer.alloc(0)
    let sec = 0
    let segStart = 0
    let lastInterim = 0
    sock.on('error', () => {})
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 2) {
        const op = buf[0] & 15
        let len = buf[1] & 127
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        }
        if (buf.length < off + 4 + len) return
        const mask = buf.subarray(off, off + 4)
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]))
        buf = buf.subarray(off + 4 + len)
        if (op === 2) {
          dg.bytes += len
          sec += len / 32000
          if (dg.fail && sec - segStart > 1) return void sock.destroy()
          if (sec - lastInterim >= 0.5) {
            lastInterim = sec
            send(result(segStart, sec, 'mock live words', { is_final: false }))
          }
        } else if (op === 1) {
          const type = JSON.parse(data.toString()).type
          if (type === 'KeepAlive') dg.keepAlives++
          else if (type === 'Finalize') {
            dg.finalizes++
            const [s, e] = [segStart, sec]
            send(result(s, e, dg.script.shift() ?? '', { is_final: true, from_finalize: true }))
            setTimeout(() => send(result(s, e, '', { is_final: true, from_finalize: true })), 150)
            segStart = sec
          } else if (type === 'CloseStream') sock.end()
        } else if (op === 8) sock.end()
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  return { dg, srv, ws: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` }
}

const freePort = (): Promise<number> =>
  new Promise((r) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => r(p))
    })
  })

/**
 * Fault-injecting TCP proxy between the app and the server: `cut()` drops every connection;
 * mode 'freeze' keeps TCP up but forwards nothing (a hung server / black-holed network).
 */
async function makeProxy(target: number) {
  let mode: 'pass' | 'freeze' = 'pass'
  const socks = new Set<Socket>()
  const srv = createNetServer((c) => {
    const up = netConnect(target, '127.0.0.1')
    for (const s of [c, up]) {
      socks.add(s)
      s.on('error', () => {})
      s.on('close', () => (socks.delete(s), c.destroy(), up.destroy()))
    }
    c.on('data', (d) => mode === 'pass' && up.write(d))
    up.on('data', (d) => mode === 'pass' && c.write(d))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return {
    port: (srv.address() as { port: number }).port,
    cut: () => socks.forEach((s) => s.destroy()),
    set: (m: 'pass' | 'freeze') => void (mode = m),
    close: () => srv.close()
  }
}

let server: ChildProcess | null = null
let proxyRef: { close(): void } | null = null
let mock: Awaited<ReturnType<typeof mockDeepgram>> | null = null

/** Start the real VoiceFlow server (node server/src/index.ts) against the mock Deepgram. */
async function startServer(root: string, port: number, env: Record<string, string>): Promise<void> {
  server = spawn('node', ['server/src/index.ts'], { cwd: root, env: { ...process.env, ...env, HOST: '127.0.0.1', PORT: String(port) }, windowsHide: true, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false)) return
    await sleep(100)
  }
  throw new Error('VoiceFlow server did not start')
}

export async function runSelfTest(overlay: BrowserWindow): Promise<void> {
  const root = app.getAppPath()
  // The fake mic loops a WAV from the moment it opens; an always-open mic would start each dictation
  // at a random point in it, so quiet runs use the on-demand mic (the pre-roll step re-enables it).
  if (FAKE_MIC) (saveSettings({ instantMic: false }), syncMic())
  const consoleErrors: string[] = []
  app.on('web-contents-created', (_e, wc) => wc.on('console-message', (ev) => ev.level === 'error' && consoleErrors.push(ev.message)))
  overlay.webContents.on('console-message', (ev) => ev.level === 'error' && consoleErrors.push(ev.message))
  await new Promise((r) => (overlay.webContents.isLoading() ? overlay.webContents.once('did-finish-load', () => r(null)) : r(null)))

  // ---------- server + account ----------
  mock = await mockDeepgram()
  const dg = mock.dg
  const port = await freePort()
  // A fresh Postgres database (throwaway container, see server/test/pg.ts).
  const databaseUrl = execFileSync('node', ['server/test/pg.ts'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  const serverEnv = { DATABASE_URL: databaseUrl, JWT_SECRET: randomBytes(32).toString('base64url'), ALLOW_SIGNUP: '1', DEEPGRAM_API_KEY: 'dg-server-key', DEEPGRAM_WS: mock.ws, DEEPGRAM_HTTP: mock.http }
  const proxy = await makeProxy(port)
  proxyRef = proxy
  const email = 'selftest@example.com'
  const password = 'a long selftest password'

  await step('VoiceFlow server starts (Postgres)', async () => {
    await startServer(root, port, serverEnv)
    return `port ${port}`
  })

  await step('signed out: the app opens on the sign-in screen; an account is created from it', async () => {
    await signOut().catch(() => {})
    saveSettings({ serverUrl: `http://127.0.0.1:${proxy.port}`, accountEmail: '' })
    const w = showHub()
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once('did-finish-load', () => r(null)))
    w.webContents.send('hub:changed')
    await sleep(800)
    const js = (code: string): Promise<any> => w.webContents.executeJavaScript(code)
    check(await js('!!document.querySelector(".auth")'), 'sign-in screen not shown while signed out')
    check(!(await js('!!document.querySelector(".sidebar")')), 'app shown while signed out')
    check((await js('document.querySelector(".auth-form h2")?.textContent')) === 'Create your account', 'new user not offered account creation')
    await shot(w, 'hub-auth.png')
    const theme = getSettings().theme
    nativeTheme.themeSource = 'light'
    await sleep(300)
    await shot(w, 'hub-auth-light.png')
    nativeTheme.themeSource = theme
    // Type into the real form (React-controlled inputs need the native setter + an input event).
    const fill = (sel: string, v: string): Promise<unknown> =>
      js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await fill('.auth-form input[type=email]', email)
    await fill('.auth-form input[autocomplete=new-password]', 'short')
    check(await js('document.querySelector(".auth-form button[type=submit]").disabled'), 'create account allowed with a 5-character password')
    await fill('.auth-form input[autocomplete=new-password]', password)
    await js('document.querySelector(".auth-form button[type=submit]").click(), true')
    check(await waitFor(() => publicSettings().signedIn, 8000), 'account not created / not signed in')
    check(await waitFor(() => streamStatus() === 'connected', 5000), `stream: ${streamStatus()}`)
    await sleep(600)
    check(await js('!!document.querySelector(".sidebar") && !document.querySelector(".auth")'), 'app did not open after creating the account')
    // Creating the same account again is refused with the server's message.
    await signOut()
    await sleep(600)
    await fill('.auth-form input[type=email]', email)
    await js('[...document.querySelectorAll(".segmented button")].find((b) => b.textContent === "Create account").click(), true')
    await sleep(100)
    await fill('.auth-form input[type=email]', email)
    await fill('.auth-form input[autocomplete=new-password]', password)
    await js('document.querySelector(".auth-form button[type=submit]").click(), true')
    check(await waitFor(async () => /already registered/.test(await js('document.querySelector(".form-error")?.textContent ?? ""')), 5000), 'duplicate account not refused clearly')
    w.hide()
    return `created ${getSettings().accountEmail || email} from the UI`
  })

  await step('sign in: session encrypted at rest, never shown to the UI; stream connects', async () => {
    await signOut().catch(() => {})
    saveSettings({ serverUrl: `http://127.0.0.1:${proxy.port}` }) // through the fault-injecting proxy
    await signIn(email, password)
    const disk = readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')
    check(!disk.includes(password), 'password stored')
    check(/"session":\s*"[A-Za-z0-9+/=]+"/.test(disk), 'no encrypted session on disk')
    const pub = JSON.stringify(publicSettings())
    check(publicSettings().signedIn && !pub.includes('keysEnc') && !pub.includes('session'), 'session leaked to the renderer view')
    check(await waitFor(() => streamStatus() === 'connected', 5000), `stream: ${streamStatus()}`)
    return getSettings().accountEmail
  })

  await step('wrong password is refused with a clear message', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'not the password' }) })
    check(r.status === 401, `HTTP ${r.status}`)
    return (await r.json()).error
  })

  await step('settings persist and reject bad input', async () => {
    const before = getSettings()
    saveSettings({ language: 'fr', insertMode: 'evil', bogus: 1, polish: 'yes', cleanup: { capitalize: 'yes', removeFillers: false } })
    const s = loadSettings() as unknown as Record<string, unknown>
    check(s.language === 'fr', 'language not persisted')
    check(s.insertMode === before.insertMode, 'invalid enum accepted')
    check(s.polish === before.polish, 'wrong type accepted')
    check(!('bogus' in s), 'unknown key accepted')
    check(getSettings().cleanup.capitalize === true && getSettings().cleanup.removeFillers === false, 'nested cleanup sanitize failed')
    saveSettings(before)
    await syncPrefs()
    return 'round-trip via disk ok'
  })

  await step('global shortcut registered; an invalid one is rejected and the old one kept', async () => {
    const sc = getSettings().shortcut
    check(globalShortcut.isRegistered(sc), `${sc} not registered: ${shortcutStatus().error}`)
    const r = registerToggle('Ctrl+Bogus+Key', toggleDictation)
    check(!r.ok && r.error, 'invalid accelerator accepted')
    check(globalShortcut.isRegistered(sc) && shortcutStatus().registered === sc, 'previous shortcut lost')
    return sc
  })

  await step('hub renders: home, dictionary, settings dialog', async () => {
    if (!getHistory().length) {
      const now = Date.now()
      const samples = [
        ['Hey team, the launch moved to Thursday. I will send the updated checklist this afternoon.', 0],
        ['Remind me to review the Kubernetes deployment notes before the standup.', 3600e3],
        ['Thanks for the quick turnaround on the design review, it looks great.', 26 * 3600e3]
      ] as const
      for (const [text, ago] of samples) {
        addHistory({ text, raw: text, durationMs: 6000, app: 'selftest', provider: 'voiceflow' }, now - ago)
        recordDictation(text, 6000, now - ago)
      }
    }
    const w = showHub()
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once('did-finish-load', () => r(null)))
    await sleep(1500)
    const js = (code: string): Promise<any> => w.webContents.executeJavaScript(code)
    check((await js('document.querySelector(".brand-name")?.textContent')) === 'VoiceFlow', 'hub did not render')
    check(/^(Good (morning|afternoon|evening)|Working late)/.test(await js('document.querySelector("h1")?.textContent ?? ""')), 'home greeting missing')
    check(/Connected/.test(await js('document.querySelector(".chip")?.textContent ?? ""')), 'connection chip does not say Connected')
    await shot(w, 'hub-home.png')
    const theme = getSettings().theme
    nativeTheme.themeSource = 'light'
    await sleep(400)
    await shot(w, 'hub-home-light.png')
    nativeTheme.themeSource = theme
    await js('document.querySelectorAll(".nav-item")[1].click(), true')
    await sleep(400)
    check((await js('document.querySelector("h1")?.textContent')) === 'Dictionary', 'dictionary page did not open')
    await shot(w, 'hub-dictionary.png')
    await js('[...document.querySelectorAll(".nav-item")].find((b) => b.textContent === "Settings").click(), true')
    await sleep(400)
    check(await js('!!document.querySelector(".settings")'), 'settings dialog did not open')
    await js('[...document.querySelectorAll(".settings .nav-item")].find((b) => b.textContent === "Account").click(), true')
    await sleep(700)
    check(/selftest@example\.com/.test(await js('document.querySelector(".settings-content")?.textContent ?? ""')), 'account page does not show the signed-in email')
    check(/This device/.test(await js('document.querySelector(".devices")?.textContent ?? ""')), 'device list does not show this device')
    await shot(w, 'hub-settings.png')
    await js('document.querySelector(".settings .close").click(), document.querySelectorAll(".nav-item")[0].click(), true')
    w.hide()
  })

  await step('pill states render at the specified sizes', async () => {
    const states = [
      ['rest', { state: 'idle' }, [36, 7]],
      ['ptt', { state: 'recording' }, [86, 32]],
      ['popo', { state: 'recording', handsFree: true }, [120, 32]],
      ['live', { state: 'recording', live: 'This is what live words look like while you speak' }, [86, 32]],
      ['processing', { state: 'processing' }, [92, 32]],
      ['error', { state: 'error', message: 'No speech detected' }, [86, 32]]
    ] as const
    const sizes: string[] = []
    for (const [name, st, [w, h]] of states) {
      overlay.webContents.send('overlay:state', { hint: 'Ctrl + Win', ...st })
      await sleep(250)
      const r = await overlay.webContents.executeJavaScript('(() => { const b = document.querySelector(".pill").getBoundingClientRect(); return [b.width, b.height] })()')
      check(Math.abs(r[0] - w) < 0.6 && Math.abs(r[1] - h) < 0.6, `${name}: pill is ${r[0]}×${r[1]}, expected ${w}×${h}`)
      sizes.push(`${name} ${r[0]}×${r[1]}`)
      await shot(overlay, `pill-${name}.png`)
    }
    overlay.webContents.send('overlay:state', { state: 'idle' })
    return sizes.join(', ')
  })

  await step('mic ready: audio flows instantly after the press', async () => {
    const was = getSettings().instantMic
    saveSettings({ instantMic: true })
    syncMic()
    try {
      await sleep(2000) // mic opens and the pre-roll fills
      toggleDictation()
      await waitFor(() => micLatency() >= 0, 1500)
      const ms = micLatency()
      cancelDictation()
      check(ms >= 0 && ms < 100, `first audio ${ms} ms after the press (mic not kept ready?)`)
      return `first audio ${ms} ms after the press`
    } finally {
      saveSettings({ instantMic: FAKE_MIC ? false : was })
      syncMic()
    }
  })

  if (process.argv.includes('--ui-only')) return finish()

  // ---------- OS-level input into a safe target: our own textarea window ----------
  const editor = new BrowserWindow({ width: 520, height: 300, x: 80, y: 80, title: 'VoiceFlow test editor', alwaysOnTop: true, show: false })
  await editor.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>VoiceFlow test editor</title><textarea style="width:100%;height:95vh" autofocus></textarea>'))
  const value = (): Promise<string> => editor.webContents.executeJavaScript('document.querySelector("textarea").value')
  // Guards: the reference app and any other VoiceFlow also listen to these hotkeys.
  const wisprRunning = (): boolean => /Wispr Flow\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Wispr Flow.exe', '/NH'], { encoding: 'utf8' }))
  const otherVoiceFlow = (): boolean =>
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='VoiceFlow.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.ProcessId -ne ${process.pid} }).Count`], { encoding: 'utf8' }).trim() !== '0'
  // Every keystroke below is gated on the editor being the foreground window.
  const reset = async (): Promise<void> => {
    check(!wisprRunning(), 'skipped: Wispr Flow is running and also uses these hotkeys; quit it first')
    check(!otherVoiceFlow(), 'skipped: another VoiceFlow is running and would also react; quit it from the tray first')
    await waitForState(['idle'], 6000) // an error from the previous step clears after 4 s
    editor.show()
    editor.focus()
    await editor.webContents.executeJavaScript('{ const t = document.querySelector("textarea"); t.value = ""; t.focus() } true')
    await sleep(300)
    if (!/electron|voiceflow/i.test(await foregroundApp())) {
      await focusWindow(editor.getNativeWindowHandle()).catch(() => {})
      await editor.webContents.executeJavaScript('document.querySelector("textarea").focus(), true')
      await sleep(300)
    }
    const fg = await foregroundApp()
    check(/electron|voiceflow/i.test(fg), `aborted: foreground is "${fg}", not the test editor`)
  }
  const sample = 'Héllo wörld — ünïcode ✓ 😀 日本語\nsecond line'
  const HOLD = [0xa2, 0x5b] // left Ctrl + left Win
  const RELEASE = [0x5b, 0xa2]
  const notStartMenu = async (): Promise<void> => {
    const fg = await foregroundApp()
    if (/electron|voiceflow/i.test(fg)) return
    await pressChord([0x1b])
    throw new Error(`foreground became "${fg}" after releasing Ctrl+Win (Start menu opened?)`)
  }
  /** Hold Ctrl+Win, "speak", release; returns what was typed and timings. */
  const holdAndSpeak = async (words: string, during?: () => void): Promise<{ end: string; v: string; ms: number; caption: string; heldMs: number }> => {
    await reset()
    const t0 = Date.now()
    await keysDown(HOLD)
    let caption = ''
    try {
      await waitForState(['recording', 'error'], 3000)
      check(dictationState() === 'recording', 'did not start recording')
      if (during) setTimeout(during, 800) // e.g. a network fault while the user is still speaking
      await speak(words)
      caption = await overlay.webContents.executeJavaScript('document.querySelector(".caption")?.textContent ?? ""')
    } finally {
      await keysUp(RELEASE)
    }
    const released = Date.now()
    const end = await waitForState(['success', 'error'], 30_000)
    const ms = Date.now() - released
    await sleep(300)
    await notStartMenu()
    return { end, v: await value(), ms, caption, heldMs: released - t0 }
  }

  await step('insert via paste preserves Unicode and restores clipboard', async () => {
    await reset()
    await clipboard.writeText('user clipboard sentinel')
    await insertText(sample, 'paste', true)
    await clipboardSettled()
    check((await value()) === sample, `editor has ${JSON.stringify(await value())}`)
    check((await clipboard.readText()) === 'user clipboard sentinel', 'clipboard not restored')
  })

  await step('insert via typing preserves Unicode', async () => {
    await reset()
    await insertText(sample, 'type', false)
    await sleep(300)
    check((await value()) === sample, `editor has ${JSON.stringify(await value())}`)
  })

  await step('Escape cancels a recording and is released afterwards', async () => {
    await reset()
    await pressChord([0x12, 0x10, 0x20]) // Alt+Shift+Space
    await waitForState(['recording'], 3000)
    await sleep(800)
    await shot(overlay, 'overlay-recording.png')
    await pressChord([0x1b])
    await waitForState(['idle'], 3000)
    check(!globalShortcut.isRegistered('Escape'), 'Escape still registered')
    check((await value()) === '', 'text was inserted')
  })

  await step('hands-free shortcut → server → Deepgram → typed', async () => {
    await reset()
    dg.script = ['testing the full pipeline']
    await pressChord([0x12, 0x10, 0x20])
    await waitForState(['recording', 'error'], 3000)
    check(dictationState() === 'recording', 'did not start recording')
    await speak('Testing the full pipeline.')
    await pressChord([0x12, 0x10, 0x20])
    const end = await waitForState(['success', 'error'], 30_000)
    await sleep(300)
    const v = await value()
    check(end === 'success' && v === 'Testing the full pipeline. ', `state ${end}, editor ${JSON.stringify(v)}`)
    return JSON.stringify(v)
  })

  await step('hold-to-talk: warm upstream, live words, cleaned text typed', async () => {
    const before = dg.bytes
    dg.script = ['um hello from hold to talk']
    const r = await holdAndSpeak('Hello from hold to talk.')
    check(/mock live words/.test(r.caption), `caption was ${JSON.stringify(r.caption)}`)
    check(dg.bytes > before + 32000, 'audio did not reach Deepgram through the server')
    check(dg.auth === 'Token dg-server-key', 'the server did not use its own Deepgram key')
    check(r.end === 'success' && r.v === 'Hello from hold to talk. ', `state ${r.end}, editor ${JSON.stringify(r.v)}`)
    return `release→typed ${r.ms} ms (local server + mock engine)`
  })

  const seen: string[] = []
  onDictationState((s) => seen.push(s))
  await step('hold-to-talk: a short tap cancels', async () => {
    await reset()
    seen.length = 0
    await keysDown(HOLD)
    await sleep(80)
    await keysUp(RELEASE)
    await sleep(800) // also lets the double-tap window expire
    await notStartMenu()
    check(seen.includes('recording') && dictationState() === 'idle', `states ${seen.join('→')}`)
    check((await value()) === '', 'text was inserted')
  })

  await step('hold-to-talk: another key while holding aborts', async () => {
    await reset()
    await keysDown(HOLD)
    try {
      await waitForState(['recording'], 3000)
      await pressChord([0x7c]) // F13: harmless with Ctrl+Win
      await waitForState(['idle'], 3000)
    } finally {
      await keysUp(RELEASE)
    }
    await sleep(300)
    await notStartMenu()
    check((await value()) === '', 'text was inserted')
  })

  await step('keep microphone ready: half-second pre-roll is captured', async () => {
    const was = getSettings().instantMic
    saveSettings({ instantMic: true })
    syncMic()
    try {
      await sleep(1500)
      dg.script = ['pre roll check']
      const r = await holdAndSpeak('Pre roll check.')
      const got = getHistory()[0]?.durationMs ?? 0
      check(r.end === 'success', `state ${r.end}`)
      check(got >= r.heldMs + 300, `clip ${got} ms vs ${r.heldMs} ms held: no pre-roll`)
      return `clip ${got} ms for ${r.heldMs} ms held (+${got - r.heldMs} ms pre-roll)`
    } finally {
      saveSettings({ instantMic: FAKE_MIC ? false : was })
      syncMic()
    }
  })

  await step('double-tap Ctrl+Win = hands-free, press again to finish', async () => {
    await reset()
    dg.script = ['', 'hands free mode works'] // the first tap is cancelled; its Finalize gets the empty answer
    await keysDown(HOLD)
    await sleep(80)
    await keysUp(RELEASE)
    await sleep(150)
    await keysDown(HOLD)
    await sleep(80)
    await keysUp(RELEASE)
    await sleep(500)
    check(dictationState() === 'recording', `not recording after release (state ${dictationState()})`)
    await speak('Hands free mode works.')
    await keysDown(HOLD)
    await keysUp(RELEASE)
    const end = await waitForState(['success', 'error'], 30_000)
    await sleep(300)
    await notStartMenu()
    const v = await value()
    check(end === 'success' && v === 'Hands free mode works. ', `state ${end}, editor ${JSON.stringify(v)}`)
  })

  await step('dictionary syncs to the server: keyterms reach Deepgram, misspellings fixed', async () => {
    saveSettings({ dictionary: [{ word: 'Kubernetes', misspelling: 'cooper netties' }] })
    await syncPrefs()
    dg.script = ['deploy to cooper netties now']
    const r = await holdAndSpeak('Deploy to Kubernetes now.')
    check(r.end === 'success' && r.v === 'Deploy to Kubernetes now. ', `state ${r.end}, editor ${JSON.stringify(r.v)}`)
    check(dg.urls.at(-1)!.includes('keyterm=Kubernetes'), `upstream URL ${dg.urls.at(-1)}`)
  })

  await step('Deepgram outage mid-dictation: the server recovers with its batch backup', async () => {
    dg.fail = true
    dg.batchText = 'recovered by the batch backup'
    try {
      const r = await holdAndSpeak('This one goes through the backup path.')
      check(r.end === 'success' && r.v === 'Recovered by the batch backup. ', `state ${r.end}, editor ${JSON.stringify(r.v)}`)
      return `release→typed ${r.ms} ms`
    } finally {
      dg.fail = false
    }
  })

  await step('connection cut mid-dictation: the clip is uploaded once over HTTPS, text typed, nothing replayed', async () => {
    check(await waitFor(() => streamStatus() === 'connected', 10_000), `not connected: ${streamStatus()}`)
    dg.batchText = 'saved by the upload'
    const finals = dg.finalizes
    const r = await holdAndSpeak('This sentence loses its connection halfway.', () => proxy.cut())
    check(r.end === 'success' && r.v === 'Saved by the upload. ', `state ${r.end}, editor ${JSON.stringify(r.v)}`)
    check(getHistory()[0]?.provider === 'voiceflow (upload)', `history provider ${getHistory()[0]?.provider}`)
    check(await waitFor(() => streamStatus() === 'connected', 10_000), 'did not reconnect')
    await sleep(1500)
    check(dg.finalizes === finals, `the cut dictation was replayed upstream (${dg.finalizes - finals} extra)`)
    return `release→typed ${r.ms} ms via upload`
  })

  const errorCard = (): Promise<string> => overlay.webContents.executeJavaScript('document.querySelector(".error-card")?.textContent ?? ""')

  await step('server hangs silently: watchdog drops it, clear error fast, nothing typed or queued; recovers', async () => {
    check(await waitFor(() => streamStatus() === 'connected', 10_000), `not connected: ${streamStatus()}`)
    proxy.set('freeze') // TCP stays up, nothing comes back: the worst kind of outage
    const r = await holdAndSpeak('Nobody answers this one.')
    const card = await errorCard()
    check(r.end === 'error' && r.v === '', `state ${r.end}, editor ${JSON.stringify(r.v)}`)
    check(/can.t reach voiceflow/i.test(card), `error shown: ${JSON.stringify(card)}`)
    check(r.ms < 9000, `took ${r.ms} ms to report the failure`)
    proxy.set('pass')
    proxy.cut() // drop the frozen sockets so the client reconnects promptly
    check(await waitFor(() => streamStatus() === 'connected', 40_000), `did not reconnect: ${streamStatus()}`)
    dg.script = ['working again']
    const up = await holdAndSpeak('Working again.')
    check(up.end === 'success' && up.v === 'Working again. ', `state ${up.end}, editor ${JSON.stringify(up.v)}`)
    return `failure reported ${r.ms} ms after release; next dictation fine after reconnect`
  })

  await step('server process down: clear error, retries back off, restart → reconnects and dictates', async () => {
    server?.kill()
    await waitFor(() => streamStatus() !== 'connected', 3000)
    const a0 = connectAttempts()
    const down = await holdAndSpeak('Nobody is listening.')
    const card = await errorCard()
    check(down.end === 'error' && down.v === '', `state ${down.end}, editor ${JSON.stringify(down.v)}`)
    check(/can.t reach voiceflow/i.test(card), `error shown: ${JSON.stringify(card)}`)
    const tries = connectAttempts() - a0
    check(tries <= 8, `${tries} reconnect attempts during the outage: not backing off`)
    await startServer(root, port, serverEnv)
    check(await waitFor(() => streamStatus() === 'connected', 35_000), `did not reconnect: ${streamStatus()}`)
    dg.script = ['back online']
    const up = await holdAndSpeak('Back online.')
    check(up.end === 'success' && up.v === 'Back online. ', `state ${up.end}, editor ${JSON.stringify(up.v)}`)
    return `error shown ${down.ms} ms after release; ${tries} connection attempts while down`
  })

  await step('signed out: dictation is refused with a sign-in message', async () => {
    await signOut()
    check(!publicSettings().signedIn, 'still signed in')
    await reset()
    await pressChord([0x12, 0x10, 0x20])
    await waitForState(['error'], 3000)
    check((await value()) === '', 'text was inserted')
    await signIn(email, password) // leave the profile usable
  })

  editor.destroy()
  await step('no renderer console errors', async () => {
    check(consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500))
  })
  finish()
}

function finish(): void {
  server?.kill()
  proxyRef?.close()
  mock?.srv.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`SELFTEST SUMMARY ${results.length - failed.length}/${results.length} passed`)
  // Normal quit path so will-quit cleanup (shortcuts, helper process) runs.
  app.once('quit', () => app.exit(failed.length ? 1 : 0))
  app.quit()
}
