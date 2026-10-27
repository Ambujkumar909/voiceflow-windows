// `npm run init-secrets`: creates ./secrets with strong random values for docker compose.
// Never overwrites an existing file (a changed pepper or database password locks everyone out).
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

const dir = new URL('../secrets/', import.meta.url)
mkdirSync(dir, { recursive: true, mode: 0o700 })
chmodSync(dir, 0o700) // only the deploying account can open the folder
for (const name of ['db_admin_password', 'db_app_password', 'jwt_secret', 'password_pepper', 'deepgram_api_key']) {
  const f = new URL(name, dir)
  if (existsSync(f)) {
    console.log(`kept     secrets/${name}`)
    continue
  }
  // Readable by the containers' unprivileged users; the 0700 folder keeps other host users out.
  writeFileSync(f, name === 'deepgram_api_key' ? '' : randomBytes(48).toString('base64url'), { mode: 0o644 })
  console.log(`created  secrets/${name}`)
}
console.log('\nNext: paste your Deepgram API key into secrets/deepgram_api_key, then `docker compose up -d --build`.')
console.log('Back up secrets/password_pepper with your database backups: without it no password can be verified.')
