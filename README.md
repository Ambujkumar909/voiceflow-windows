<p align="center">
  <img src="build/icon.png" width="112" alt="VoiceFlow logo" />
</p>

<h1 align="center">VoiceFlow</h1>

<p align="center"><b>Hold Ctrl + Win, speak, let go. Your words are typed in any Windows app.</b><br/>
Live streaming transcription, about 0.2 s from release to text, with an offline fallback.</p>

---

VoiceFlow is voice dictation for Windows. Hold the hotkey in any text box, whether that's email, chat, docs, code or a browser. While you talk, your words appear live above a small pill at the bottom of the screen. When you let go, the finished text is typed where your cursor is.

## Highlights

- **Fast.** Audio streams to Deepgram Nova-3 while you speak, over one connection that is kept open in advance. On release only the last 20 ms of audio is still in flight. Measured from India to Deepgram's EU region: **185–205 ms from release to final text**.
- **Accurate.** Nova-3 had 2.1% word error rate on clean LibriSpeech speech and 6.4% on harder speech, measured on 100 clips. Local Whisper base scored 4.7% and 16.8% on the same clips.
- **Built for soft voices.** Capture uses auto gain without client-side noise suppression, which removes quiet speech (Deepgram's and Google's guidance, confirmed by our own A/B test). The mic can stay ready with a 0.5 s in-memory pre-roll, so your first word is never cut off.
- **One model does it all.** Nova-3 adds punctuation, formats numbers, emails and dates, drops "um"s, turns spoken "comma" or "period" into symbols, and boosts the words in your dictionary.
- **Never loses a dictation.** If the network or the cloud fails, the same audio is transcribed locally with Whisper. History is saved before anything is typed.
- **Private by design.**
  - Audio is sent only while you hold the key.
  - API keys are encrypted with Windows DPAPI and never reach the UI.
  - Logs hold timings only, never your words.
- **Polished UI.**
  - A floating pill: idle bar, live waveform, hands-free ✕/✓ buttons, spinner, error cards.
  - A main window with Home (history, streak, words, WPM), Dictionary and Settings.
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

## Install

**Installer:** build it with `npm run dist` (below), then run `dist\VoiceFlow-Setup-1.0.0.exe`.
- It installs per user, with no admin needed.
- It adds Start-menu and desktop shortcuts and an uninstaller.

The build is not code-signed, so Windows SmartScreen may ask you to confirm the first time.

**Speech engine:** open Settings → Speech engine and paste your [Deepgram](https://console.deepgram.com) API key.
- New Deepgram accounts get free credit.
- After that, cost is about **$0.46 per hour of actual speech**, because only the seconds you are dictating are billed.

Without a key, VoiceFlow uses local Whisper (offline, free, less accurate).

## Build from source

Requirements: Windows 10/11 x64, Node.js 24 and npm 11.

```powershell
git clone https://github.com/Ambujkumar909/voiceflow-windows.git
cd voiceflow-windows
npm install
npx install-electron     # Electron 44 fetches its binary on demand
npm start                # build and run
npm run dist             # build the Windows installer into dist\
```

| Command | What it does |
|---|---|
| `npm start` | Build and run the app |
| `npm run dev` | Development mode with hot reload |
| `npm run typecheck` | TypeScript check across main, preload and UI |
| `npm test` | Unit tests: transcript cleanup, dictionary, LLM guard, speech detection, Deepgram result matching |
| `npm run selftest:quiet` | End-to-end test of the real app, using a test recording as the microphone (silent). It sends keystrokes to its own test window, so don't touch the PC for ~5 min. |
| `npm run selftest` | Same, but the real microphone hears Windows text-to-speech played through the speakers |
| `npm run selftest:ui` | Renders and measures every screen and pill state |
| `npm run bench` | Word error rate and speed on LibriSpeech (local models; `BENCH_MODELS=deepgram` with `DEEPGRAM_API_KEY` for the cloud) |
| `npm run bench:frontend` | A/B of microphone processing modes on a soft-voice-in-noise recording |
| `npm run icons` | Re-render all icons from `build/icon.svg` |

npm 11 blocks dependency install scripts by default. This project denies the ones it doesn't need:
- `onnxruntime-node` would download CUDA binaries; the CPU binaries ship with the package.
- `protobufjs` is not needed.
- `uiohook-napi` ships its prebuilt binary.
- `electron-winstaller` belongs to an unused installer type.

## How it works

```
 hold Ctrl+Win ──► keyboard hook (uiohook-napi, listen-only)
                      │ first key down: warm the Deepgram socket
                      ▼
 overlay window: mic → AudioWorklet → 16 kHz PCM, 20 ms chunks (+0.5 s pre-roll)
                      │ IPC
                      ▼
 main process ──► Deepgram WebSocket (Nova-3, EU/US auto, kept warm with KeepAlive)
                      │ live words → pill caption
 release ──► Finalize ──► final text (~190 ms) ──► dictionary fixes ──► cleanup rules
                      │                                                     │
                      └─ failure/timeout: local Whisper on the same audio ──┤
                                                                            ▼
                      history (saved first) ──► paste via SendInput, clipboard restored
```

See [DESIGN.md](DESIGN.md) for the measurements and decisions behind this: latency budget, connection lifecycle, billing, failure handling and scaling.

```
src/
  main/            app lifecycle, hotkeys (hold.ts, shortcut.ts), dictation state machine,
                   stt/ (deepgram.ts + deepgram-epoch.ts, xai.ts, local-whisper.ts, openai.ts),
                   insert.ts (SendInput), settings (DPAPI keys), history + stats, vad, cleanup, polish
  preload/         the only bridge to the UI (context isolation + sandbox)
  renderer/hub/    main window: Home, Dictionary, Settings
  renderer/overlay pill, live caption, recorder + PCM AudioWorklet, UI sounds
build/             icon.svg (source), icon.ico, icon.png
resources/         runtime icons (window, tray idle/recording)
```

## Other engines

Settings → Speech engine also offers:
- **xAI Grok Voice** (streaming)
- **Local Whisper** (tiny, base or small; fully offline)
- **Any OpenAI-compatible API** (for example Groq `whisper-large-v3-turbo`)

Optional **AI cleanup** uses an OpenAI-compatible LLM (default: Groq `openai/gpt-oss-20b`). It fixes self-corrections such as "at 3, no, at 4" becoming "at 4". A guard throws away any reply that rewrites your words.

## Testing status

**Passing on the last full runs:**
- The end-to-end self-test passed **26/26** in silent mode, before the rename and new icons. The run after the rename was not completed. It covered:
  - hold-to-talk, tap-cancel, abort, hands-free and Esc
  - live streaming against a mock Deepgram server, socket reuse, KeepAlive, and fallback on an outage
  - Unicode insertion with clipboard restore
  - every pill state's size
  - Home, Dictionary and Settings rendering
- 14 unit tests pass.

**Real Deepgram use:** sustained use measured 185–205 ms from release to text.

**Known limits:**
- The keyboard hook only listens. Ctrl + Win still reaches the focused app, which is harmless.
- Windows sends no keystrokes from normal apps into elevated (administrator) windows. VoiceFlow then leaves the text on the clipboard.
- The installer is unsigned.

## Acknowledgements

- The UX is inspired by Wispr Flow. VoiceFlow is an independent implementation, and no code or assets are taken from it.
- Speech: [Deepgram](https://deepgram.com) Nova-3, [Whisper](https://github.com/openai/whisper) via [Transformers.js](https://github.com/huggingface/transformers.js) and ONNX Runtime.
- Benchmark audio: [LibriSpeech](https://www.openslr.org/12) (CC BY 4.0), downloaded at run time and not redistributed.
- Fonts: Figtree and EB Garamond (SIL Open Font License). Icons: [Lucide](https://lucide.dev) (ISC).
- Built with Electron, React, Vite and uiohook-napi.

## License

[MIT](LICENSE) © 2026 Ambuj Kumar
