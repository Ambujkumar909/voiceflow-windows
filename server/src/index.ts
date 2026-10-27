import { createApp } from './app.ts'
import { config } from './config.ts'
import { openDb } from './db.ts'

const db = await openDb(config.databaseUrl) // applies pending migrations first
const server = createApp(db)
server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ msg: 'voiceflow server listening', host: config.host, port: config.port, deepgram: !!config.deepgram.key, signup: config.allowSignup }))
})
const stop = (): void => {
  server.close()
  server.closeAllConnections()
  void db.end().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
