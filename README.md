<p align="center">
  <img src="build/icon.png" width="112" alt="VoiceFlow logo" />
</p>

<h1 align="center">VoiceFlow</h1>

<p align="center"><b>Hold Ctrl + Win, speak, let go. Your words are typed in any Windows app.</b><br/>
Live streaming transcription, about 0.2 s from release to text.</p>

---

VoiceFlow is voice dictation for Windows, built as a thin desktop client and a VoiceFlow server.

Hold the hotkey in any text box, whether that's email, chat, docs, code or a browser. While you talk, your words appear live above a small pill at the bottom of the screen. When you let go, the finished text is typed where your cursor is.

## Highlights

- **Fast.** Audio streams over one connection that is opened in advance: client → VoiceFlow server → Deepgram Nova-3. On release only the last 20 ms of audio is still in flight. Measured from India: **185–205 ms from release to final text**.
- **Accurate.** Nova-3 had a 2.1% word error rate on clean LibriSpeech speech and 6.4% on harder speech, measured on 100 clips. Local Whisper base scored 4.7% and 16.8% on the same clips.
- **Built for soft voices.** Capture uses auto gain without client-side noise suppression, which removes quiet speech (our A/B test). The mic can stay ready with a 0.5 s in-memory pre-roll, so your first word is never cut off.
- **Thin, keyless client.** The installer contains no speech models and no vendor keys. The server holds the Deepgram key and runs the text pipeline: dictionary, cleanup rules and optional AI cleanup.
- **Accounts with serious security:**
  - Argon2id passwords with a pepper.
  - Per-device sessions that you can see and sign out.
  - Rotating refresh tokens with theft detection.
  - Instant revocation across every server.
  - A security audit log.
  - Details in [ARCHITECTURE.md](ARCHITECTURE.md#security).
- **Private by design.**
  - Audio is sent only while you hold the key.
  - The server stores no audio and no transcripts. History stays on your PC.
  - The session is encrypted with Windows DPAPI.
- **Fails clearly, never late.** If the live connection breaks mid-dictation, the clip is uploaded once and typed. If the server can't be reached, you get a clear error at once. Nothing is queued to type later.
- **Its own premium UI.**
  - A violet glass pill with a live waveform.
  - A sign-in / create-account screen.
  - Home (stats, history, search), Dictionary, and Settings with account and device management.
  - Light and dark themes.

## Using it

| Action | How |
|---|---|
| Dictate | Hold **Ctrl + Win**, speak, release |
| Hands-free | Double-tap **Ctrl + Win** (or click the pill); press again to finish |
| Toggle shortcut | **Alt + Shift + Space** (configurable) |
| Cancel | **Esc** while recording |
| Teach words | Dictionary → Add new (names, jargon, or "misspelling → correct" fixes) |

Pressing any other key while holding Ctrl + Win cancels the dictation, so shortcuts like Ctrl + Win + D still work. A tap shorter than 0.3 s is ignored.

## Run the server

The server and PostgreSQL run together with Docker:

```bash
cd server
npm install
npm run init-secrets            # then paste your Deepgram key into server/secrets/deepgram_api_key
docker compose up -d --build    # server on 127.0.0.1:8787; put TLS / an AWS ALB in front
```

See [server/README.md](server/README.md) for configuration, AWS Mumbai deployment, backups and capacity.

## Install the app

Build the installer with your server address, then run `dist\VoiceFlow-Setup-1.1.0.exe`:

```powershell
$env:MAIN_VITE_SERVER_URL="https://voiceflow.yourcompany.com"; npm run dist
```

- The installer is per user, with no admin needed, and adds shortcuts and an uninstaller.
- On first launch, create an account or sign in. The server address can also be changed on that screen.
- The build is not code-signed, so Windows SmartScreen may ask you to confirm the first time.

**Speech cost:** Deepgram bills only seconds of actual speech, about **$0.46 per hour**. Each account has a daily cap (4 h by default) until subscriptions exist.

## Build from source

Requirements: Windows 10/11 x64, Node.js 24, npm 11 and Docker Desktop.

```powershell
git clone https://github.com/Ambujkumar909/voiceflow-windows.git
cd voiceflow-windows
npm install
npm --prefix server install
npx install-electron     # Electron 44 fetches its binary on demand
npm start                # build and run the app
```

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Run the app (dev mode has hot reload) |
| `npm run typecheck` | TypeScript check across main, preload and UI |
| `npm test` | Server tests (44): auth, sessions, streaming, failover and a 50-user load test, against a throwaway Postgres |
| `npm --prefix server run test:container` | The full Docker stack, checked from the outside |
| `npm run selftest:quiet` | End-to-end test of the real app with a test recording as the microphone (silent). It types into its own test window, so keep the PC unlocked and don't touch it for ~5 min. |
| `npm run selftest:ui` | Renders and measures every screen and pill state, including creating an account from the sign-in screen |
| `npm run icons` | Re-render all icons from `build/icon.svg` |
| `npm run dist` | Build the Windows installer into `dist\` |

## How it works

```
 hold Ctrl+Win ──► keyboard hook (uiohook-napi, listen-only) ── first key: "prime" → server warms Deepgram
                      ▼
 pill window: mic → AudioWorklet → 16 kHz PCM, 20 ms frames (+0.5 s pre-roll)
                      ▼
 app ══ persistent WebSocket (TLS) ══► VoiceFlow server ══► Deepgram Nova-3 (warm socket)
                                          │  live words ◄──┘
 release ──► stop ──► Finalize ──► dictionary + cleanup (+ optional AI) ──► final text (~0.2 s)
                      ▼
 history saved on this PC ──► pasted via SendInput, clipboard restored
```

The protocol, the failure handling for every case, and the security model are in [ARCHITECTURE.md](ARCHITECTURE.md). Measurements behind the design are in [DESIGN.md](DESIGN.md).

## Known limits

- The keyboard hook only listens. Ctrl + Win still reaches the focused app, which is harmless.
- Windows doesn't let normal apps send keystrokes into elevated (administrator) windows. VoiceFlow then leaves the text on the clipboard.
- Email verification and password reset need an email sender (for example Amazon SES) and are not built yet.
- The installer is unsigned.

## Acknowledgements

- The UX idea is inspired by Wispr Flow. VoiceFlow is an independent implementation with its own design. No code or assets are taken from it.
- Speech: [Deepgram](https://deepgram.com) Nova-3.
- Benchmark audio: [LibriSpeech](https://www.openslr.org/12) (CC BY 4.0), downloaded at run time and not redistributed.
- Font: Figtree (SIL Open Font License). Icons: [Lucide](https://lucide.dev) (ISC).
- Built with Electron, React, Vite, uiohook-napi, Node.js, PostgreSQL and `pg`.

## License

[MIT](LICENSE) © 2026 Ambuj Kumar
