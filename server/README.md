# VoiceFlow server

The backend the VoiceFlow desktop app talks to. It handles:
- **Accounts:** email and password, devices and sessions.
- **The streaming speech relay** to Deepgram Nova-3.
- **The text pipeline:** dictionary, cleanup rules, and optional LLM cleanup with a no-rewrite guard.
- **Usage metering.**

All data lives in PostgreSQL. The server itself is stateless, so you can run as many copies as you need behind a load balancer. It stores no audio and no transcripts.

The protocol and security model are in [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Run it with Docker (server + Postgres)

```bash
cd server
npm run init-secrets        # creates ./secrets with strong random values (never overwrites)
# paste your Deepgram key into secrets/deepgram_api_key
docker compose up -d --build
curl http://127.0.0.1:8787/healthz
```

The stack:
- **`db`:** `postgres:18.4`.
  - Its data lives in the `pgdata` volume.
  - It has no published port and sits on an internal network with no internet access.
  - Uses SCRAM authentication and data checksums.
  - On first start, `deploy/postgres-init.sh` creates a non-superuser `voiceflow` role that owns only the `voiceflow` database. The app never uses the superuser.
- **`server`:**
  - Runs as a non-root user with a read-only filesystem and all Linux capabilities dropped (`no-new-privileges`).
  - Secrets are mounted as files under `/run/secrets` (`*_FILE` variables), not environment variables, so they don't appear in `docker inspect`.
  - It waits until Postgres is healthy, then applies any database migrations itself.
- **Port:** published on `127.0.0.1:8787` only. Put a TLS proxy or an AWS ALB in front of it.

`npm run test:container` brings up this exact stack with throwaway secrets and checks it from the outside:
- Sign-up and a streamed dictation work.
- Postgres has no published port and no internet access, and the app role isn't a superuser.
- Passwords are stored as Argon2id.
- No transcript text appears in the logs.
- Data survives a restart.

It then removes the stack completely.

### Secrets (`./secrets`, never committed, never in the image)

| File | What |
|---|---|
| `db_admin_password` | Postgres superuser; used only at first start |
| `db_app_password` | the app's own database role |
| `jwt_secret` | signs access tokens |
| `password_pepper` | mixed into every password hash; **back it up with the database. Without it, no password can be verified.** |
| `deepgram_api_key` | your Deepgram key |

## Run it without Docker (development)

```bash
cd server && npm install
docker run -d --name vf-pg -p 127.0.0.1:5432:5432 -e POSTGRES_USER=voiceflow -e POSTGRES_PASSWORD=voiceflow postgres:18.4-alpine3.22
DEEPGRAM_API_KEY=… ALLOW_SIGNUP=1 npm start     # listens on 127.0.0.1:8787
npm run add-user -- you@company.com             # prompts for the password
npm test                                        # 44 tests; starts its own throwaway Postgres
```

## Configuration (environment)

Any secret can also be given as `NAME_FILE=/path/to/file`.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | dev: `postgres://voiceflow:voiceflow@127.0.0.1:5432/voiceflow` | **Required in production.** For RDS, add `?sslmode=verify-full&sslrootcert=/path/global-bundle.pem` |
| `DATABASE_PASSWORD` | — | Overrides the password in the URL |
| `JWT_SECRET` | random per process in development | **Required in production**, 32+ characters |
| `JWT_SECRET_PREVIOUS` | — | Key rotation: still accepted for verifying, never used for signing |
| `PASSWORD_PEPPER` | none in development | **Required in production**, 32+ characters. Never change it once users exist. |
| `DEEPGRAM_API_KEY` | — | Required for transcription |
| `DEEPGRAM_WS` / `DEEPGRAM_HTTP` | `wss://` / `https://api.eu.deepgram.com` | EU is the closer hosted region from Mumbai |
| `DEEPGRAM_MIP_OPT_OUT` | `1` | `0` re-enables Deepgram's model-improvement program |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | — / Groq / `openai/gpt-oss-20b` | Optional AI cleanup |
| `ALLOW_SIGNUP` | off (compose: on) | `1` lets anyone create an account from the app. Otherwise use `npm run add-user`. |
| `DAILY_AUDIO_CAP_SEC` | 14400 (4 h) | Speech seconds per account per UTC day; caps cost until subscriptions exist. `0` turns it off. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Keep it private behind the TLS gateway |
| `TRUST_PROXY` | off (image: on) | `1` behind an ALB or Caddy, so rate limits use the real client IP |
| `NODE_ENV` | — (image: `production`) | `production` refuses to start without the required secrets |

Tuning variables, mainly for tests:

| Variable | Default |
|---|---|
| `ACCESS_TTL_SEC` | 900 |
| `PRIME_IDLE_MS` | 20 s |
| `UPSTREAM_IDLE_MS` | 2 min |
| `FINALIZE_TIMEOUT_MS` | 2.5 s |

## Deploy on AWS Mumbai (`ap-south-1`)

1. **Database:** RDS for PostgreSQL 18, Multi-AZ, encrypted, with automated backups. It sits in private subnets, and its security group allows 5432 only from the app.
   - Create the `voiceflow` role and database as in `deploy/postgres-init.sh`.
   - Connect with `sslmode=verify-full` and the RDS CA bundle.
2. **Compute:** ECS Fargate (or EC2 with the compose file) running `voiceflow-server`.
   - Secrets come from AWS Secrets Manager, mounted as files or injected as environment variables.
   - The service scales on CPU or connection count. Instances share nothing but the database.
3. **TLS:** an Application Load Balancer with an ACM certificate, HTTPS on 443, forwarding to 8787.
   - Idle timeout 60 s. The client pings every 20 s, and the server's keep-alive timeout is 65 s.
   - Optionally, add AWS WAF with a rate rule on `/v1/auth/*` for a fleet-wide per-IP limit.
4. **Network:** outbound 443 to `api.eu.deepgram.com` (and the LLM provider, if used).
5. **Desktop app:** build it with your server address baked in:

   ```powershell
   $env:MAIN_VITE_SERVER_URL="https://voiceflow.yourcompany.com"; npm run dist
   ```

   Users can also change the address on the sign-in screen.

**Backups (single host):** `docker compose exec db pg_dump -U postgres -Fc voiceflow > voiceflow.dump`. Keep `secrets/password_pepper` with it.

**Logs:** JSON lines on stdout, containing timings and counts, never text or secrets, for example:

```json
{"msg":"dictation","via":"stream","audioSec":3.1,"asrMs":184,"totalMs":186}
```

## Capacity

Measured by `test/load.test.ts` (Postgres-backed):
- 50 users dictating at the same moment, each streaming real-time audio.
- The server adds a p95 of **6 ms** between stop and the final text.
- Everything (server, the 50 simulated clients and a mock engine) used **16% of one CPU core**.

The dictation path makes no database queries: preferences are cached per connection, and usage is written after the text is sent.
