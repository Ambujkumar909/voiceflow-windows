# VoiceFlow: system design (Deepgram engine)

Agreed 2026-10-27. Measurements were taken on the target machine: Windows 11, Jio (India) connection, the user's Deepgram key.

## Measured constraints

| Fact | Value | Consequence |
|---|---|---|
| Round trip to `api.deepgram.com` (US) | 250–330 ms | |
| Round trip to `api.eu.deepgram.com` | 160–200 ms | Use EU. Probe both at startup and pick the faster one. |
| New TLS + WebSocket connection | ~700 ms | Never connect on key press. Keep one connection warm. |
| Finalize → final text (EU, warm) | 181–194 ms | This is the release-to-text floor from India. |
| Same socket reused after 20 s idle | 194 ms | One connection can serve every dictation. |
| A late, empty, duplicate `from_finalize` result | Observed | Results must be matched to dictations by audio time, not arrival order. |
| Nova-3 WER, LibriSpeech, 50+50 clips | 2.06% clean / 6.42% other | Local Whisper small: 2.9% / 11.5%. Whisper base: 4.7% / 16.8%. |
| Billing | Audio seconds sent. KeepAlive and idle time are free. | Stream only while recording. Keep the connection warm at no cost. |

"Under 100 ms from release to final text" is physically impossible with any cloud ASR from India, because one round trip is at least 160 ms. Two things make it feel instant:
- Words show live in the pill while you speak.
- Only the last ~20 ms of audio is still in flight at release.

The budget is ~20 ms tail chunk, ~80 ms uplink, ~20 ms server finalize, ~80 ms downlink and ~25 ms paste, about **210 ms**.

A speculative "type the draft, then correct it" mode was rejected. It would visibly edit text in the user's document, which breaks the error-free requirement.

## Processes

| Process | Responsibilities |
|---|---|
| Main | Hotkeys (uiohook + globalShortcut), dictation state machine, **Deepgram connection manager**, keys (DPAPI, never sent to a renderer), local-Whisper fallback, history, logs |
| Overlay renderer | Mic capture (AudioWorklet, engine kept warm), the pill, live caption |
| Hub renderer | Home / history / dictionary / settings |
| Insert helper | Persistent PowerShell + `SendInput`: paste (~20 ms) with background clipboard restore |

## Deepgram connection manager (`src/main/stt/deepgram.ts`)

States: closed → connecting → warm → streaming → finalizing → warm.

**Endpoint and model:**
- `wss://api.{eu.}deepgram.com/v1/listen`, auth header `Authorization: Token <key>`.
- `model=nova-3`, `encoding=linear16`, `sample_rate=16000`, `channels=1`.
- `interim_results=true`, `smart_format=true`, `punctuate=true`, `dictation=true`, fillers removed (default).
- `language` from settings (`en` default, `en-IN` available).
- `keyterm` repeated per entry from the user's dictionary (≤500 tokens).

**Keeping it warm:**
- Opens at startup.
- Reopens on: hold-modifier key-down, pill hover, system resume, network change, settings change.
- `{"type":"KeepAlive"}` every 4 s while warm (the server closes after 10 s of silence).
- Closes after 15 min without a dictation.

**Cold path:** audio chunks are queued locally until the socket is open, so no words are lost.

**One dictation is one epoch:**
- Remember the stream time when the epoch starts (total audio seconds sent so far).
- Results whose `start` falls inside the epoch belong to it. Late or duplicate results for an older epoch are dropped.
- Live text = `is_final` segments plus the latest interim.

**Release:**
- Flush the last partial worklet chunk, then send `{"type":"Finalize"}` in the same tick.
- The epoch completes on its `from_finalize` result, or after 1.2 s, using whatever finals are in hand.

**Failure handling:**
- Exponential backoff with jitter on reconnect.
- If a Finalize goes unanswered, the epoch fails over to local Whisper on the retained PCM and the socket is recycled.
- Errors are classified as 401 bad key, 402 no credit, 429 rate limited, network or timeout. Each is shown as a pill card.

## Audio

- 16 kHz mono Float32 from an AudioWorklet in **20 ms chunks**, converted to Int16 in main and sent as binary frames (32 KB/s).
- Not Opus. It would save upload bandwidth, but it adds 20–60 ms and some accuracy loss, and 32 KB/s is trivial.
- Audio is sent only while recording, because billing is per second sent.
- Noise suppression and AGC are on. Echo cancellation is off, because dictation has no far end.
- The audio graph is pre-built and suspended between dictations, so a key press only opens the mic.

## Never lose a dictation

- The full clip is kept in memory until the text is inserted.
- If the cloud fails, local Whisper (offline) transcribes it. That costs nothing and there's no double billing.
- History is written before insertion. If insertion fails, the text stays on the clipboard.
- An energy VAD rejects clips without speech, so neither engine invents text from silence.

## Observability

Each dictation logs timings, never text:
- press → mic live
- release → final
- final → inserted
- endpoint, reconnects, fallback used

## Scaling, if VoiceFlow ships to other users

- Clients stream straight to Deepgram; no audio passes through our servers.
- A stateless token service (behind user auth) issues short-lived Deepgram tokens (`/v1/auth/grant`, ~30 s TTL). No long-lived key ships in the app.
- It scales horizontally at zero relay cost. Not built for the single-user setup, where the key lives in DPAPI.

## Cost

- Nova-3 streaming is ~$0.0077/min, about **$0.46 per hour of actual speech**. Keyterms add ~$0.0013/min when used.
- Typical use: 15 min/day ≈ $3.50/month, 30 min/day ≈ $7/month, 1 h/day ≈ $14/month.
- Idle connection time, offline fallback and VAD-rejected taps cost nothing.

## Build order

1. **UI:** a hub window modeled on the reference's observed design (independent code), and the pill's finishing touches (own sounds, notification cards).
2. **Deepgram backend** as above, tested against a mock Deepgram server (free).
3. **One real end-to-end check** with the user's key: about 10 s of audio, under $0.002, run only with approval.
