# VoiceFlow client–server architecture

Decided 2026-10-27:
- Hosting: AWS Mumbai (`ap-south-1`).
- Online only.
- CPU servers.
- Login: email and password.
- Measurements behind the latency choices are in [DESIGN.md](DESIGN.md).

## Principles

1. **Thin, keyless client.** The installer contains no vendor keys and no speech models. It holds only the user's own session.
2. **Our logic lives on the server.** Engine choice, failover, the text pipeline and usage metering can all be updated without shipping a new app.
3. **Stream everything, buffer nothing.** Every hop forwards 20 ms audio frames as they arrive. Connections are opened ahead of time, so a dictation never waits for a TCP or TLS handshake.
4. **Lossless, unprocessed speech.** The client sends 16-bit PCM with auto gain only. Noise robustness is the speech model's job: client-side noise suppression erases soft speech (our A/B test, Deepgram's and Google's guidance).
5. **Zero retention by default.** The server never stores audio or transcripts. It keeps accounts, preferences and usage counters only. History stays on the user's PC.

## What runs where

| Windows client (`src/`) | VoiceFlow server (`server/`) + PostgreSQL |
|---|---|
| Ctrl+Win hook, hands-free, Esc | Accounts: email + Argon2id password, per-device sessions, rate limits, audit log |
| Mic capture: auto gain, no noise suppression/echo cancellation, 16 kHz, 20 ms frames, 0.5 s pre-roll | Deepgram key, warm upstream sockets, Finalize, result matching |
| Sign-in / create-account screen, pill, live caption, Home, Dictionary, Settings, Account (devices, password, delete) | Failover: streaming → Deepgram batch on the buffered clip |
| Text insertion (`SendInput`), clipboard restore | Text pipeline: dictionary fixes → optional LLM cleanup with guard → cleanup rules |
| Session tokens (DPAPI-encrypted refresh token, access token in memory) | Per-user preferences: dictionary, language, cleanup, LLM toggle |
| Local history and stats | Usage metering (seconds and words per user per day); no content |

## Wire protocol (v1)

### HTTPS (JSON)

| Endpoint | Request | Response |
|---|---|---|
| `POST /v1/auth/register` | `{email, password, device}` (only when `ALLOW_SIGNUP=1`) | `201` + a session (same body as login) |
| `POST /v1/auth/login` | `{email, password, device}` | `{accessToken, refreshToken, expiresIn, user}` |
| `POST /v1/auth/refresh` | `{refreshToken}` | a new pair (rotation; see Security) |
| `POST /v1/auth/logout` | `{refreshToken}` | `204`; ends this device's session |
| `GET /v1/me` | | `{email, createdAt}` |
| `GET /v1/me/sessions` | | `{sessions: [{id, device, createdAt, lastUsedAt, current}]}` |
| `DELETE /v1/me/sessions/:id` | | `204`; signs that device out at once |
| `POST /v1/me/sessions/revoke-all` | | `204`; signs every device out |
| `POST /v1/me/password` | `{currentPassword, newPassword}` | `204`; every other device is signed out |
| `DELETE /v1/me` | `{password}` | `204`; deletes the account and all its server data |
| `GET /v1/me/prefs` / `PUT /v1/me/prefs` | `{language, dictionary[], cleanup{}, polish}` | the stored preferences (live connections pick up changes at once) |
| `POST /v1/transcribe` | body: raw `pcm_s16le` 16 kHz mono (≤ 5 min), `?lang=` | `{text}`. Backup path when a live stream breaks mid-dictation, sent once, immediately. |
| `GET /healthz` | | `200 ok` |

Authenticated calls send `Authorization: Bearer <accessToken>`.

### WebSocket `wss://…/v1/stream`

The client opens it at sign-in, with `Authorization: Bearer <accessToken>` on the upgrade, and keeps it open.

| Direction | Message | Meaning |
|---|---|---|
| C→S | `{"t":"auth","token"}` | Fresh access token before the old one expires. Otherwise the socket closes with code 4401. |
| C→S | `{"t":"prime"}` | The user may dictate soon (first hotkey key, pill hover). The server warms the upstream socket. |
| C→S | `{"t":"start","id","lang","mode"}` | Begin dictation `id` |
| C→S | binary | `pcm_s16le` 16 kHz mono, 20 ms (640 B) per frame. Only valid between `start` and `stop`. |
| C→S | `{"t":"stop","id"}` / `{"t":"cancel","id"}` | End the dictation (Finalize) or discard it |
| C→S | `{"t":"ping"}` | Every 20 s; the server answers `pong` |
| S→C | `{"t":"ready","user"}` | Authenticated and usable |
| S→C | `{"t":"partial","id","text"}` | Live words |
| S→C | `{"t":"final","id","text","ms":{...}}` | Fully processed text, ready to type |
| S→C | `{"t":"error","id","code","message"}` | Codes: `no_speech`, `upstream`, `quota`, `bad_request` |

**Never sent by the client:**
- Audio outside a dictation. The pre-roll leaves the PC only when the user presses the keys.
- Keystrokes, clipboard contents, screen content, or the names of other apps.

**Bandwidth:** 32 KB/s while speaking. One hour of speech is about 115 MB, roughly $0.01 of AWS egress.

## Latency budget (release → text)

| Hop | Time |
|---|---|
| Last 20 ms frame | ≤ 20 ms |
| Client → Mumbai (persistent TLS WebSocket) | 10–30 ms |
| Server → Deepgram Finalize round trip (warm socket, data-center path) | ~120–180 ms |
| Text pipeline (dictionary + rules; LLM cleanup adds ~200–400 ms when on) | < 2 ms |
| Server → client, then paste | ~15–40 ms |
| **Total** | **~170–250 ms**, measured direct-to-Deepgram from the user's PC: 185–205 ms |

**Server timing rules:**
- Frames are forwarded the moment they arrive.
- `Finalize` goes out in the same tick as `stop`.
- Each session's upstream socket is opened on `prime`. It closes after 20 s if no dictation follows, or 2 minutes after the last dictation. Idle time costs nothing: Deepgram bills audio seconds only.

## When things fail (every case is covered by an automated test)

Dictation is for typing **now**. VoiceFlow never queues speech to transcribe later: a dictation either completes within seconds or ends with a clear error.

| Situation | What happens | Test result |
|---|---|---|
| Server down when you start or stop | Clear "Can't reach VoiceFlow" error; nothing typed | Error in 0.2 s; 3 reconnect attempts in the outage |
| Live connection cut while you speak | The clip goes to `POST /v1/transcribe` once over HTTPS and the text is typed; the cut stream is never replayed | Typed 22 ms after release; no extra upstream Finalize |
| Server hangs (TCP up, no replies) | A 3 s heartbeat watchdog drops the connection, then the upload backup (4 s + 0.2 s per audio second); if that also hangs, a clear error | Reported in 7.5 s; nothing typed or queued |
| Idle connection silently died | Heartbeat every 20 s; 45 s of silence → replaced before the next dictation | — |
| Connect hangs (black-holed network) | Abandoned after 10 s, then back-off | — |
| Reconnecting | Jittered back-off, 0.5 s → 30 s. Nothing bypasses it, not even audio frames. | Back-off test |
| Very slow uplink | At most 5 s of audio queued or in flight; beyond that the dictation finishes via one upload | — |
| Pooled HTTP connection died in a network blip | Network-level failures are retried once on a fresh connection | Cut-connection test |
| Deepgram stream drops | Server retries once with Deepgram's batch API on the buffered clip; silence is never sent to it | Typed 28 ms after release |
| Deepgram accepts audio but never answers Finalize | Server timeout at 2.5 s, then batch | Server e2e test |
| Deepgram too slow to accept audio | > 5 s buffered → stop streaming, batch at the end | — |
| Access token expires on a long connection | Client refreshes it in-band; a stale token closes with 4401 and the client reconnects with a fresh one | Server tests |
| Refresh token revoked or reused | The session is revoked; the client signs out and says why | Server tests |
| A device is signed out from another one (or the password changes) | Its live connection closes within milliseconds on every server instance (Postgres LISTEN/NOTIFY), and its tokens stop working | Closed in 16 ms (e2e) |
| Postgres briefly unreachable | Live dictations keep working (the dictation path never queries the database); sign-in and settings calls fail with a clear error until it's back | — |
| Client floods messages | Connection closed (1008) | Server test |
| Slow client | Live-word updates are dropped for it; the final text is always sent | — |

**Upstream sockets cost nothing idle, but they count against Deepgram's limit on simultaneous connections:**
- A key-press warm-up keeps a session's Deepgram socket for 20 s; a real dictation keeps it for 2 minutes.
- A warm-up never shortens the longer window.
- The client sends at most one warm-up every 15 s.

## Security

**Transport:**
- TLS 1.2+ only, terminated at an AWS ALB or Caddy, with HSTS.
- The Node server listens on localhost or a private subnet.

**Passwords:**
- Argon2id (RFC 9106: 64 MiB, 3 passes, 4 lanes) with a 16-byte salt, plus a server-side pepper stored outside the database.
- Compared in constant time. At most 2 hashes run at once, so a login burst can't exhaust memory.
- Older hash parameters are upgraded at the next sign-in.
- Rules follow NIST SP 800-63B: 10–200 characters and a blocklist of common passwords (and the email itself), with no composition rules.
- Emails are normalized (trimmed, lower-case) and unique in the database.

**Sessions** (one per signed-in device):
- **Access token:** a 15-minute JWT, HMAC-SHA256.
  - The header must match one the server produces byte for byte: a fixed algorithm and a known key id.
  - `iss`, `aud`, `exp` and the session id are checked.
  - The signing key rotates via `JWT_SECRET_PREVIOUS`, with no forced sign-outs.
- **Active-session check:** every authenticated request and connection also checks that the session is still active. A revoked session's token stops working at once, not 15 minutes later.
- **Refresh token:** 256 random bits; only the SHA-256 hash is stored.
  - It rotates on every use. Presenting a used token again revokes the session (theft detection).
  - The one exception: a single retry within 30 s while its replacement is still unused, because the client may simply have lost the response.
- **Lifetime:** a session ends after 30 days unused, and after 90 days in any case.
- **User control:** devices can be listed and signed out one by one or all at once. A revocation reaches every server instance via Postgres `LISTEN/NOTIFY` and closes that device's live connection.
- **Password change:** signs out every other device. Deleting the account removes every session, preference and usage row.
- **On the client:** the refresh token is encrypted with DPAPI; the access token stays in memory only.

**Abuse limits:**
- Login is rate limited per IP and per email. 10 wrong passwords lock the account for 15 minutes; the lockout lives in Postgres, so it holds across instances.
- Error messages are identical whether or not an account exists.
- Sign-ups are limited to 5 per IP per hour.
- A per-account daily speech cap (default 4 h) bounds Deepgram cost until subscriptions exist.
- One active dictation per user, 5 minutes maximum. WebSocket frames over 64 KB are rejected, and every JSON message is validated.

**Audit log** (Postgres, kept 180 days):
- Records sign-ups, sign-ins, failed and locked sign-ins, refresh-token reuse, sign-outs, device revocations, password changes and account deletions, with time and IP.
- Never records passwords, tokens, audio or text.

**Database:**
- Postgres runs in its own container on an internal Docker network, with no published port and no internet access. In production it's RDS in private subnets.
- The app connects as a non-superuser role that owns only its own database.
- Every query is parameterized. Schema changes are numbered migrations applied under an advisory lock.

**Secrets:**
- The database password, JWT secret, password pepper and Deepgram key are files (Docker secrets or AWS Secrets Manager), never baked into the image and never logged.
- `NODE_ENV=production` refuses to start without them.

**Containers:**
- Non-root, read-only filesystem, all Linux capabilities dropped, `no-new-privileges`.

**Privacy:**
- No audio or transcript is stored or logged. Logs hold latencies and counts only.
- Deepgram is called with `mip_opt_out=true`, which opts out of Deepgram's model-improvement program.

**Hardening:**
- HTTP timeouts against slow-client attacks.
- Body size limits; JSON-only API (other content types get 415).
- No CORS (the desktop client makes no browser requests).
- `nosniff`, `frame-ancestors 'none'` and `no-store` headers on every response.

## Deployment (AWS Mumbai, CPU)

- **Compute:** EC2 `c7i.large`, or ECS Fargate, in `ap-south-1`, behind an ALB with an ACM certificate and HTTP/1.1 WebSocket upgrades. Scale out on concurrent streams.
- **Data:** PostgreSQL 18. In production use RDS, Multi-AZ, encrypted, with automated backups; for a single host, use the bundled `docker compose` stack. The servers themselves are stateless.
- **Secrets:** AWS Secrets Manager provides `DEEPGRAM_API_KEY`, `JWT_SECRET` and the optional `LLM_API_KEY`.
- **Observability:** CloudWatch logs, with per-dictation timing lines and no content.

## Phases

1. **This repo:** server v1 (auth, streaming relay, pipeline, metering, batch backup) and the client moved onto it.
2. Second cloud speech vendor as hot failover; organizations, admin console, SSO.
3. Subscriptions and billing (plan per account, replacing the flat daily cap); email verification and password reset (needs an email sender, e.g. Amazon SES in Mumbai).
4. More regions for data residency; dashboards.
