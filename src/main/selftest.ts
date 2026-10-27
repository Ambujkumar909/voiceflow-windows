/*
 * End-to-end self-test, run with `npm run selftest` (dev builds only; uses a throwaway
 * userData folder). Drives the real app: settings, secrets, global shortcut, local
 * transcription, OS-level text insertion into a test editor window, and the full
 * hotkey → microphone → transcribe → insert pipeline (Windows TTS plays through the
 * speakers so the microphone has something to hear).
 */
import { app, BrowserWindow, clipboard, globalShortcut, nativeTheme } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cancelDictation, dictationState, micLatency, onDictationState, primeEngine, syncMic, toggleDictation } from './dictation'
import { clipboardSettled, focusWindow, foregroundApp, insertText, keysDown, keysUp, pressChord } from './insert'
import { addHistory, getHistory, recordDictation } from './history'
import { polish } from './polish'
import { getApiKey, getSettings, loadSettings, publicSettings, saveSettings, setApiKey } from './settings'
import { registerToggle, shortcutStatus } from './shortcut'
import { getProvider } from './stt'
import { closeDeepgram, deepgramStatus, setDeepgramBaseForTest } from './stt/deepgram'
import { showHub } from './windows'
import { openAiCompatible } from './stt/openai'

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

function readWav16k(path: string): Float32Array {
  const b = readFileSync(path)
  const data = b.indexOf('data') + 8
  const pcm = new Int16Array(b.buffer.slice(b.byteOffset + data, b.byteOffset + b.length - ((b.length - data) % 2)))
  return Float32Array.from(pcm, (v) => v / 32768)
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

const FAKE_MIC = process.argv.includes('--fake-mic') // test/hello.wav is the microphone; nothing plays aloud

function speak(text: string): Promise<void> {
  if (FAKE_MIC) return sleep(Math.max(3000, text.length * 60)) // let the WAV "speak" for a similar time
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $s.Volume = 100; $s.SetOutputToDefaultAudioDevice(); $s.Speak('${text}'); $s.Dispose()`
  return new Promise((resolve) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).on('exit', () => resolve()))
}

/**
 * Minimal stand-in for wss://api.x.ai/v1/stt that follows the documented protocol:
 * transcript.created → binary PCM frames → audio.done → transcript.partial/done.
 * 'fail' sends an error after ~1 s of audio, like an outage mid-dictation.
 */
async function mockXai(mode: 'ok' | 'fail') {
  const got = { auth: '', url: '', bytes: 0, done: false }
  const srv = createServer()
  srv.on('upgrade', (req, sock) => {
    got.auth = String(req.headers.authorization)
    got.url = decodeURIComponent(req.url ?? '')
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const send = (o: object): void => {
      const p = Buffer.from(JSON.stringify(o))
      sock.write(Buffer.concat([Buffer.from(p.length < 126 ? [0x81, p.length] : [0x81, 126, p.length >> 8, p.length & 255]), p]))
    }
    send({ type: 'transcript.created' })
    let buf = Buffer.alloc(0)
    let frames = 0
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
          got.bytes += len
          if (++frames % 10) continue
          if (mode === 'fail') {
            send({ type: 'error', message: 'mock outage' })
            sock.end()
          } else send({ type: 'transcript.partial', text: `mock live ${frames / 10}`, is_final: false, speech_final: false })
        } else if (op === 1 && JSON.parse(data.toString()).type === 'audio.done') {
          got.done = true
          send({ type: 'transcript.partial', text: 'um so the streamed words', is_final: true, speech_final: true })
          send({ type: 'transcript.done', text: 'um so the streamed words', duration: 1 })
        } else if (op === 8) sock.end()
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, got, url: `ws://127.0.0.1:${(srv.address() as { port: number }).port}/v1/stt` }
}

/**
 * Stand-in for Deepgram's /v1/listen WebSocket, following the protocol observed against the
 * real API: binary linear16 audio in; Results with start/duration in audio seconds; interim
 * results while speaking; {"type":"Finalize"} answered by a final with from_finalize=true,
 * followed 150 ms later by a duplicate empty from_finalize (the real API did this too).
 * 'fail' drops the connection after ~1 s of audio, like a network outage.
 */
async function mockDeepgram(mode: 'ok' | 'fail', transcripts: string[]) {
  const got = { auth: '', url: '', connections: 0, bytes: 0, finalizes: 0, keepAlives: 0 }
  const srv = createServer()
  srv.on('upgrade', (req, sock) => {
    got.connections++
    got.auth = String(req.headers.authorization)
    got.url = decodeURIComponent(req.url ?? '')
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const send = (o: object): void => {
      const p = Buffer.from(JSON.stringify(o))
      sock.write(Buffer.concat([Buffer.from(p.length < 126 ? [0x81, p.length] : [0x81, 126, p.length >> 8, p.length & 255]), p]))
    }
    const result = (start: number, end: number, text: string, extra: object): object => ({ type: 'Results', start, duration: end - start, channel: { alternatives: [{ transcript: text }] }, ...extra })
    let buf = Buffer.alloc(0)
    let sec = 0 // audio seconds received on this socket
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
          got.bytes += len
          sec += len / 32000
          if (mode === 'fail' && sec > 1) return void sock.destroy()
          if (sec - lastInterim >= 0.5) {
            lastInterim = sec
            send(result(segStart, sec, `mock live ${Math.round(sec * 2)}`, { is_final: false }))
          }
        } else if (op === 1) {
          const type = JSON.parse(data.toString()).type
          if (type === 'KeepAlive') got.keepAlives++
          else if (type === 'Finalize') {
            const [s, e] = [segStart, sec]
            send(result(s, e, transcripts[got.finalizes++] ?? '', { is_final: true, from_finalize: true }))
            setTimeout(() => send(result(s, e, '', { is_final: true, from_finalize: true })), 150)
            segStart = sec
          } else if (type === 'CloseStream') sock.end()
        } else if (op === 8) sock.end()
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, got, base: `ws://127.0.0.1:${(srv.address() as { port: number }).port}` }
}

/** OpenAI-compatible /chat/completions stand-in that records the request. */
async function mockChat(reply: string) {
  const got: { auth?: string; body?: any } = {}
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      got.auth = req.headers.authorization
      got.body = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, got, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1` }
}

async function shot(win: BrowserWindow, name: string): Promise<void> {
  const dir = join(app.getAppPath(), 'test', 'out')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG())
}

export async function runSelfTest(overlay: BrowserWindow): Promise<void> {
  const root = app.getAppPath()
  // The fake mic loops a WAV from the moment it opens; an always-open mic would start each dictation
  // at a random point in it, so quiet runs use the on-demand mic (the pre-roll step below re-enables it).
  if (FAKE_MIC) (saveSettings({ instantMic: false }), syncMic())
  const consoleErrors: string[] = []
  app.on('web-contents-created', (_e, wc) => wc.on('console-message', (ev) => ev.level === 'error' && consoleErrors.push(ev.message)))
  overlay.webContents.on('console-message', (ev) => ev.level === 'error' && consoleErrors.push(ev.message))
  await new Promise((r) => (overlay.webContents.isLoading() ? overlay.webContents.once('did-finish-load', () => r(null)) : r(null)))

  await step('settings persist and reject bad input', async () => {
    const before = getSettings()
    saveSettings({ language: 'fr', insertMode: 'evil', bogus: 1, cleanup: { capitalize: 'yes', removeFillers: false } })
    const s = loadSettings() as unknown as Record<string, unknown>
    check(s.language === 'fr', 'language not persisted')
    check(s.insertMode === before.insertMode, 'invalid enum accepted')
    check(!('bogus' in s), 'unknown key accepted')
    check(getSettings().cleanup.capitalize === true && getSettings().cleanup.removeFillers === false, 'nested cleanup sanitize failed')
    saveSettings(before)
    return 'round-trip via disk ok'
  })

  await step('API keys encrypted at rest, hidden from renderer', async () => {
    for (const slot of ['openai', 'xai', 'llm'] as const) setApiKey(slot, `key-${slot}-SECRET-123`)
    const disk = readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')
    check(!disk.includes('SECRET'), 'plaintext key found on disk')
    check(getApiKey('xai') === 'key-xai-SECRET-123' && getApiKey('llm') === 'key-llm-SECRET-123', 'decrypt mismatch')
    const pub = publicSettings()
    check(!JSON.stringify(pub).includes('SECRET') && pub.keys.xai && pub.keys.llm && pub.keys.openai, 'key leaked into public settings')
    for (const slot of ['openai', 'xai', 'llm'] as const) setApiKey(slot, '')
    check(!Object.values(publicSettings().keys).some(Boolean), 'key not removed')
  })

  await step('global shortcut registered', async () => {
    const sc = getSettings().shortcut
    check(globalShortcut.isRegistered(sc), `${sc} not registered: ${shortcutStatus().error}`)
    return sc
  })

  await step('invalid shortcut rejected, previous kept', async () => {
    const sc = getSettings().shortcut
    const r = registerToggle('Ctrl+Bogus+Key', toggleDictation)
    check(!r.ok && r.error, 'invalid accelerator accepted')
    check(globalShortcut.isRegistered(sc) && shortcutStatus().registered === sc, 'previous shortcut lost')
    return r.error
  })

  await step('local Whisper transcribes test/hello.wav', async () => {
    const t = Date.now()
    const text = await getProvider(getSettings()).transcribe(readWav16k(join(root, 'test/hello.wav')), 'en')
    check(/dictation test/i.test(text), `unexpected transcript: "${text}"`)
    return `"${text}" in ${Date.now() - t} ms`
  })

  await step('OpenAI-compatible adapter (local mock server)', async () => {
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('latin1')
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        const ok = req.url === '/v1/audio/transcriptions' && req.headers.authorization === 'Bearer test-key' && body.includes('RIFF') && body.includes('whisper-1')
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { text: ' mock transcript ' } : { error: 'bad request' }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const p = openAiCompatible(`http://127.0.0.1:${port}/v1/`, 'whisper-1', () => 'test-key')
      check((await p.transcribe(new Float32Array(16000), 'en')) === 'mock transcript', 'wrong text')
      const noKey = openAiCompatible(`http://127.0.0.1:${port}/v1`, 'whisper-1', () => '')
      const err = await noKey.transcribe(new Float32Array(16000), 'en').catch((e) => e.message)
      check(/No API key/.test(err), 'missing-key error not raised')
    } finally {
      server.close()
    }
  })

  await step('hub renders: home, dictionary, settings dialog', async () => {
    // Sample data in the throwaway profile so every screen has something to show.
    if (!getHistory().length) {
      const now = Date.now()
      const samples = [
        ['Hey team, the launch moved to Thursday. I will send the updated checklist this afternoon.', 0],
        ['Remind me to review the Kubernetes deployment notes before the standup.', 3600e3],
        ['Thanks for the quick turnaround on the design review, it looks great.', 26 * 3600e3]
      ] as const
      for (const [text, ago] of samples) {
        addHistory({ text, raw: text, durationMs: 6000, app: 'selftest', provider: 'local-whisper' }, now - ago)
        recordDictation(text, 6000, now - ago)
      }
      saveSettings({ dictionary: [{ word: 'Kubernetes', misspelling: 'cooper netties' }, { word: 'VoiceFlow' }, { word: 'Deepgram' }] })
    }
    const w = showHub()
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once('did-finish-load', () => r(null)))
    await sleep(1500)
    const js = (code: string): Promise<any> => w.webContents.executeJavaScript(code)
    const brand = await js('document.querySelector(".brand-name")?.textContent')
    check(brand === 'VoiceFlow', `hub did not render (brand=${brand})`)
    check(/get back into the flow|Welcome back/.test(await js('document.querySelector("h1")?.textContent ?? ""')), 'home greeting missing')
    await shot(w, 'hub-home.png')
    const theme = getSettings().theme
    saveSettings({ theme: 'light' })
    nativeTheme.themeSource = 'light'
    await sleep(400)
    await shot(w, 'hub-home-light.png')
    saveSettings({ theme })
    nativeTheme.themeSource = theme
    await js('document.querySelectorAll(".nav-item")[1].click(), true')
    await sleep(400)
    check((await js('document.querySelector("h1")?.textContent')) === 'Dictionary', 'dictionary page did not open')
    await shot(w, 'hub-dictionary.png')
    await js('[...document.querySelectorAll(".nav-item")].find((b) => b.textContent === "Settings").click(), true')
    await sleep(400)
    check(await js('!!document.querySelector(".settings")'), 'settings dialog did not open')
    await shot(w, 'hub-settings.png')
    await js('document.querySelector(".settings .close").click(), document.querySelectorAll(".nav-item")[0].click(), true')
    w.hide()
  })

  await step('pill states render at the specified sizes', async () => {
    const states = [
      ['rest', { state: 'idle' }, [40, 8]],
      ['ptt', { state: 'recording' }, [73, 30]],
      ['popo', { state: 'recording', handsFree: true }, [102.5, 30]],
      ['live', { state: 'recording', live: 'This is what live words look like while you speak' }, [73, 30]],
      ['processing', { state: 'processing' }, [98, 30]],
      ['error', { state: 'error', message: 'No speech detected' }, [91, 30]]
    ] as const
    const sizes: string[] = []
    for (const [name, st, [w, h]] of states) {
      overlay.webContents.send('overlay:state', { hint: 'Ctrl + Win', ...st })
      await sleep(250) // 100 ms morph
      const r = await overlay.webContents.executeJavaScript('(() => { const b = document.querySelector(".pill").getBoundingClientRect(); return [b.width, b.height] })()')
      check(Math.abs(r[0] - w) < 0.6 && Math.abs(r[1] - h) < 0.6, `${name}: pill is ${r[0]}×${r[1]}, expected ${w}×${h}`)
      sizes.push(`${name} ${r[0]}×${r[1]}`)
      await shot(overlay, `pill-${name}.png`)
    }
    overlay.webContents.send('overlay:state', { state: 'idle' })
    return sizes.join(', ')
  })

  await step('mic ready: dictation starts instantly (no Windows mic start-up delay)', async () => {
    // Chunks only reach main for streaming engines, so measure with a Deepgram config pointed nowhere.
    const before = getSettings()
    setDeepgramBaseForTest('ws://127.0.0.1:9') // nothing listens there: audio just queues, nothing is billed
    saveSettings({ provider: 'deepgram', instantMic: true })
    setApiKey('deepgram', 'dg-test-key')
    syncMic()
    try {
      await sleep(2000) // mic opens and the pre-roll fills
      toggleDictation()
      for (let i = 0; i < 30 && micLatency() < 0; i++) await sleep(50)
      const ms = micLatency()
      cancelDictation()
      check(ms >= 0 && ms < 100, `first audio ${ms} ms after the press (mic not kept ready?)`)
      return `first audio ${ms} ms after the press`
    } finally {
      setDeepgramBaseForTest(null)
      saveSettings(before)
      setApiKey('deepgram', '')
      syncMic()
    }
  })

  if (process.argv.includes('--ui-only')) return finish()

  // A safe target for OS-level input: our own textarea window.
  const editor = new BrowserWindow({ width: 520, height: 300, x: 80, y: 80, title: 'VoiceFlow test editor', alwaysOnTop: true, show: false })
  await editor.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>VoiceFlow test editor</title><textarea style="width:100%;height:95vh" autofocus></textarea>'))
  const value = (): Promise<string> => editor.webContents.executeJavaScript('document.querySelector("textarea").value')
  // Every OS-level keystroke below is gated on the editor being the foreground window,
  // so a focus failure can never type into another app.
  const reset = async (): Promise<void> => {
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

  await step('test editor is the foreground window', async () => {
    await reset()
    return foregroundApp()
  })

  await step('insert via paste preserves Unicode and restores clipboard', async () => {
    await reset()
    await clipboard.writeText('user clipboard sentinel')
    await insertText(sample, 'paste', true)
    await clipboardSettled()
    const v = await value()
    check(v === sample, `editor has ${JSON.stringify(v)}`)
    check((await clipboard.readText()) === 'user clipboard sentinel', 'clipboard not restored')
  })

  await step('insert via typing preserves Unicode', async () => {
    await reset()
    await insertText(sample, 'type', false)
    await sleep(300)
    const v = await value()
    check(v === sample, `editor has ${JSON.stringify(v)}`)
  })

  await step('Escape cancels a recording and is released afterwards', async () => {
    await reset()
    await pressChord([0x12, 0x10, 0x20]) // Alt+Shift+Space (default shortcut)
    await waitForState(['recording'], 3000)
    await sleep(1200)
    await shot(overlay, 'overlay-recording.png')
    await pressChord([0x1b])
    await waitForState(['idle'], 3000)
    check(!globalShortcut.isRegistered('Escape'), 'Escape still registered')
  })

  await step('full pipeline: hotkey → mic → Whisper → insert (TTS via speakers)', async () => {
    await reset()
    await pressChord([0x12, 0x10, 0x20])
    await waitForState(['recording', 'error'], 3000)
    check(dictationState() === 'recording', 'did not start recording')
    await sleep(700)
    await speak('Testing one two three. The quick brown fox jumps over the lazy dog.')
    await sleep(500)
    await pressChord([0x12, 0x10, 0x20])
    const end = await waitForState(['success', 'error'], 60_000)
    await sleep(300)
    const v = await value()
    check(end === 'success' && v.trim().length > 0, `state ${end}, editor ${JSON.stringify(v)} (mic may not hear the speakers)`)
    return JSON.stringify(v)
  })

  // Hold-to-talk through the real keyboard hook: injected key-down/up of left Ctrl + left Win.
  const HOLD = [0xa2, 0x5b]
  const RELEASE = [0x5b, 0xa2]
  const seen: string[] = []
  onDictationState((s) => seen.push(s))
  // The reference app also listens for Ctrl+Win; pressing it would make Wispr Flow record
  // and upload the test audio, so these steps refuse to run while it is open.
  const wisprRunning = (): boolean => /Wispr Flow\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Wispr Flow.exe', '/NH'], { encoding: 'utf8' }))
  const reset0 = reset
  // Another VoiceFlow (the user's own copy) would also react to the injected Ctrl+Win and type/bill.
  const otherVoiceFlow = (): boolean =>
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.ProcessId -ne ${process.pid} }).Count`], { encoding: 'utf8' }).trim() !== '0'
  const resetHold = async (): Promise<void> => {
    check(!wisprRunning(), 'skipped: Wispr Flow is running and also uses Ctrl+Win; quit it first')
    check(!otherVoiceFlow(), 'skipped: another VoiceFlow is running and would also react to Ctrl+Win; quit it from the tray first')
    await reset0()
  }
  const notStartMenu = async (): Promise<void> => {
    const fg = await foregroundApp()
    if (/electron|voiceflow/i.test(fg)) return
    await pressChord([0x1b])
    throw new Error(`foreground became "${fg}" after releasing Ctrl+Win (Start menu opened?)`)
  }

  await step('hold-to-talk: hold Ctrl+Win, speak, release → inserted', async () => {
    await resetHold()
    const t0 = Date.now()
    await keysDown(HOLD)
    try {
      await waitForState(['recording', 'error'], 3000)
      check(dictationState() === 'recording', 'did not start recording')
      await speak('Hello from hold to talk. The quick brown fox jumps over the lazy dog.') // starts right away: first word must not be clipped
    } finally {
      await keysUp(RELEASE)
    }
    const released = Date.now()
    const end = await waitForState(['success', 'error'], 60_000)
    const latency = Date.now() - released
    await sleep(300)
    await notStartMenu()
    const v = await value()
    check(end === 'success' && /^hello/i.test(v), `state ${end}, editor ${JSON.stringify(v)} (first word clipped?)`)
    return `${JSON.stringify(v)}; release→inserted ${latency} ms (hold ${released - t0} ms)`
  })

  await step('hold-to-talk: a short tap cancels', async () => {
    await resetHold()
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
    await resetHold()
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
      await sleep(1500) // armed: the pre-roll buffer fills
      await resetHold()
      const t0 = Date.now()
      await keysDown(HOLD)
      try {
        await waitForState(['recording', 'error'], 3000)
        await speak('Pre roll check.')
      } finally {
        await keysUp(RELEASE)
      }
      const held = Date.now() - t0
      const end = await waitForState(['success', 'error'], 60_000)
      const got = getHistory()[0]?.durationMs ?? 0
      check(end === 'success', `state ${end}`)
      check(got >= held + 300, `clip ${got} ms vs ${held} ms held: no pre-roll`)
      return `clip ${got} ms for ${held} ms held (+${got - held} ms pre-roll)`
    } finally {
      saveSettings({ instantMic: FAKE_MIC ? false : was })
      syncMic()
    }
  })

  await step('double-tap Ctrl+Win = hands-free, press again to finish', async () => {
    await resetHold()
    await keysDown(HOLD)
    await sleep(80)
    await keysUp(RELEASE)
    await sleep(150)
    await keysDown(HOLD)
    await sleep(80)
    await keysUp(RELEASE)
    await sleep(500)
    check(dictationState() === 'recording', `not recording after release (state ${dictationState()})`)
    await speak('Hands free mode is working.')
    await keysDown(HOLD)
    await keysUp(RELEASE)
    const end = await waitForState(['success', 'error'], 60_000)
    await sleep(300)
    await notStartMenu()
    const v = await value()
    check(end === 'success' && v.trim().length > 0, `state ${end}, editor ${JSON.stringify(v)}`)
    return JSON.stringify(v)
  })

  await step('LLM cleanup: request shape, accepted edit, rewrite rejected', async () => {
    const ok = await mockChat('Meet me at 4.')
    const bad = await mockChat('Sure! Here is a polished version of your note about the meeting time.')
    try {
      const a = await polish('um meet me at 3 no at 4', { baseUrl: ok.url, model: 'openai/gpt-oss-20b', apiKey: 'llm-key' })
      check(a.applied && a.text === 'Meet me at 4.', `edit not applied: ${JSON.stringify(a)}`)
      const b0 = ok.got.body
      check(ok.got.auth === 'Bearer llm-key' && b0.model === 'openai/gpt-oss-20b' && b0.reasoning_effort === 'low' && b0.messages[1].content === 'um meet me at 3 no at 4', 'bad request shape')
      const b = await polish('um meet me at 3 no at 4', { baseUrl: bad.url, model: 'x', apiKey: 'k' })
      check(!b.applied && b.text === 'um meet me at 3 no at 4', 'rewrite was not rejected')
    } finally {
      ok.srv.close()
      bad.srv.close()
    }
  })

  await step('xAI streaming + LLM cleanup (mock servers): live words, then cleaned text inserted', async () => {
    const xai = await mockXai('ok')
    const chat = await mockChat('So, the streamed words!')
    const before = getSettings()
    let caption = ''
    try {
      saveSettings({ provider: 'xai', xaiUrl: xai.url, dictionary: [{ word: 'VoiceFlow' }, { word: 'Kubernetes' }], polish: { enabled: true, baseUrl: chat.url, model: 'openai/gpt-oss-20b' } })
      setApiKey('xai', 'xai-test-key')
      setApiKey('llm', 'llm-test-key')
      await resetHold()
      await keysDown(HOLD)
      try {
        await waitForState(['recording', 'error'], 3000)
        check(dictationState() === 'recording', 'did not start recording')
        await speak('Testing the streaming path with live words.')
        caption = await overlay.webContents.executeJavaScript('document.querySelector(".caption")?.textContent ?? ""')
        await shot(overlay, 'overlay-live.png')
      } finally {
        await keysUp(RELEASE)
      }
      const end = await waitForState(['success', 'error'], 30_000)
      await sleep(300)
      const v = await value()
      check(xai.got.auth === 'Bearer xai-test-key', 'missing auth header')
      for (const q of ['model=grok-voice-transcribe-2.0', 'sample_rate=16000', 'encoding=pcm', 'interim_results=true', 'language=en', 'format=true', 'keyterm=VoiceFlow', 'keyterm=Kubernetes'])
        check(xai.got.url.includes(q), `query missing ${q}: ${xai.got.url}`)
      check(xai.got.bytes > 32000, `only ${xai.got.bytes} bytes of audio streamed`)
      check(xai.got.done, 'audio.done not sent')
      check(/mock live/.test(caption), `overlay caption was ${JSON.stringify(caption)}`)
      check(chat.got.body?.messages?.[1]?.content === 'um so the streamed words', 'LLM did not get the streamed transcript')
      check(end === 'success' && v === 'So, the streamed words! ', `state ${end}, editor ${JSON.stringify(v)}`)
      return `${xai.got.bytes} bytes streamed live; caption ${JSON.stringify(caption)}; inserted ${JSON.stringify(v)}`
    } finally {
      saveSettings(before)
      setApiKey('xai', '')
      setApiKey('llm', '')
      xai.srv.close()
      chat.srv.close()
    }
  })

  await step('xAI outage mid-dictation falls back to local Whisper', async () => {
    const xai = await mockXai('fail')
    const before = getSettings()
    try {
      saveSettings({ provider: 'xai', xaiUrl: xai.url })
      setApiKey('xai', 'xai-test-key')
      await resetHold()
      await keysDown(HOLD)
      try {
        await waitForState(['recording', 'error'], 3000)
        await speak('The local fallback keeps working.')
      } finally {
        await keysUp(RELEASE)
      }
      const end = await waitForState(['success', 'error'], 60_000)
      await sleep(300)
      const v = await value()
      check(end === 'success' && v.trim().length > 0, `state ${end}, editor ${JSON.stringify(v)}`)
      check(getHistory()[0]?.provider === 'local-whisper (fallback)', `history provider ${getHistory()[0]?.provider}`)
      return JSON.stringify(v)
    } finally {
      saveSettings(before)
      setApiKey('xai', '')
      xai.srv.close()
    }
  })

  {
    // Deepgram: one warm socket shared by consecutive dictations (mock server, free).
    const dg = await mockDeepgram('ok', ['um so the streamed words', 'second dictation works'])
    const before = getSettings()
    setDeepgramBaseForTest(dg.base)
    saveSettings({ provider: 'deepgram', language: 'en', dictionary: [{ word: 'Kubernetes' }, { word: 'VoiceFlow' }] })
    setApiKey('deepgram', 'dg-test-key')
    const holdAndSpeak = async (words: string): Promise<{ end: string; v: string; ms: number; caption: string }> => {
      await resetHold()
      await keysDown(HOLD)
      let caption = ''
      try {
        await waitForState(['recording', 'error'], 3000)
        check(dictationState() === 'recording', 'did not start recording')
        await speak(words)
        caption = await overlay.webContents.executeJavaScript('document.querySelector(".caption")?.textContent ?? ""')
      } finally {
        await keysUp(RELEASE)
      }
      const released = Date.now()
      const end = await waitForState(['success', 'error'], 30_000)
      const ms = Date.now() - released
      await sleep(300)
      return { end, v: await value(), ms, caption }
    }

    await step('Deepgram: socket is warm before the key press', async () => {
      primeEngine()
      for (let i = 0; i < 30 && dg.got.connections === 0; i++) await sleep(100)
      await sleep(200)
      check(dg.got.connections === 1, `connections: ${dg.got.connections}`)
      check(dg.got.auth === 'Token dg-test-key', `auth header: ${dg.got.auth}`)
      for (const q of ['model=nova-3', 'encoding=linear16', 'sample_rate=16000', 'channels=1', 'interim_results=true', 'smart_format=true', 'punctuate=true', 'dictation=true', 'language=en', 'keyterm=Kubernetes', 'keyterm=VoiceFlow'])
        check(dg.got.url.includes(q), `query missing ${q}: ${dg.got.url}`)
      check(dg.got.bytes === 0, 'audio was sent before recording')
    })

    await step('Deepgram: hold → live words → Finalize → cleaned text inserted', async () => {
      const r = await holdAndSpeak('Testing the Deepgram streaming path.')
      check(/mock live/.test(r.caption), `overlay caption was ${JSON.stringify(r.caption)}`)
      check(dg.got.finalizes === 1, `finalizes: ${dg.got.finalizes}`)
      check(dg.got.bytes > 32000, `only ${dg.got.bytes} bytes streamed`)
      check(r.end === 'success' && r.v === 'So the streamed words. ', `state ${r.end}, editor ${JSON.stringify(r.v)}`)
      return `${dg.got.bytes} bytes streamed; caption ${JSON.stringify(r.caption)}; release→inserted ${r.ms} ms (mock server, no network)`
    })

    await step('Deepgram: next dictation reuses the socket; late duplicate result ignored', async () => {
      const r = await holdAndSpeak('Second one.')
      check(dg.got.connections === 1, `opened ${dg.got.connections} sockets`)
      check(r.end === 'success' && r.v === 'Second dictation works. ', `state ${r.end}, editor ${JSON.stringify(r.v)}`)
      return `release→inserted ${r.ms} ms`
    })

    await step('Deepgram: KeepAlive while idle, no audio sent', async () => {
      const [k, b] = [dg.got.keepAlives, dg.got.bytes]
      await sleep(4500)
      check(dg.got.keepAlives > k, 'no KeepAlive in 4.5 s')
      check(dg.got.bytes === b, 'audio sent while idle')
      return `${dg.got.keepAlives} KeepAlive messages`
    })

    const down = await mockDeepgram('fail', ['never'])
    setDeepgramBaseForTest(down.base)
    await step('Deepgram outage mid-dictation falls back to local Whisper', async () => {
      primeEngine()
      await sleep(500)
      const r = await holdAndSpeak('The local fallback keeps working.')
      check(r.end === 'success' && r.v.trim().length > 0, `state ${r.end}, editor ${JSON.stringify(r.v)}`)
      check(getHistory()[0]?.provider === 'local-whisper (fallback)', `history provider ${getHistory()[0]?.provider}`)
      return `${JSON.stringify(r.v)}; release→inserted ${r.ms} ms`
    })

    // Real Deepgram, only when a key is given for it (costs ~$0.001: ~4 s of audio).
    if (process.env.DEEPGRAM_LIVE_KEY)
      await step('Deepgram LIVE: real API, release → typed text', async () => {
        setDeepgramBaseForTest(null)
        saveSettings({ provider: 'deepgram', deepgramRegion: 'auto' })
        setApiKey('deepgram', process.env.DEEPGRAM_LIVE_KEY!)
        primeEngine()
        for (let i = 0; i < 50 && !deepgramStatus().startsWith('connected'); i++) await sleep(100)
        const warm = deepgramStatus()
        const r = await holdAndSpeak('Hello, this is a live dictation check.')
        check(r.end === 'success' && /hello|dictation|check/i.test(r.v), `state ${r.end}, editor ${JSON.stringify(r.v)} (${deepgramStatus()})`)
        return `${JSON.stringify(r.v)}; release→inserted ${r.ms} ms; socket before press: ${warm}`
      })

    setDeepgramBaseForTest(null)
    closeDeepgram()
    saveSettings(before)
    setApiKey('deepgram', '')
    dg.srv.close()
    down.srv.close()
  }

  editor.destroy()
  await step('no renderer console errors', async () => {
    check(consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500))
  })
  finish()
}

function finish(): void {
  const failed = results.filter((r) => !r.ok)
  console.log(`SELFTEST SUMMARY ${results.length - failed.length}/${results.length} passed`)
  // Normal quit path so will-quit cleanup (shortcuts, helper process) runs.
  app.once('quit', () => app.exit(failed.length ? 1 : 0))
  app.quit()
}
