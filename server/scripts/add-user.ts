// Create an account: `npm run add-user -- someone@company.com`, then type the password.
// The password is read from stdin, so it doesn't end up in shell history.
import { createInterface } from 'node:readline/promises'
import { createUser } from '../src/auth.ts'
import { config } from '../src/config.ts'
import { openDb } from '../src/db.ts'

const email = process.argv[2]
if (!email) {
  console.error('usage: npm run add-user -- <email>')
  process.exit(1)
}
const rl = createInterface({ input: process.stdin, output: process.stdout })
const password = await rl.question('Password (10+ characters): ')
rl.close()
try {
  const db = await openDb(config.databaseUrl)
  const u = await createUser(db, email, password)
  await db.end()
  console.log(`created ${u.email}`)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
