// Isolated HTTP fixture only. It never dispatches tasks or accesses a real Bridge.
const http = require('node:http')
const fs = require('node:fs')
const { join, resolve, relative, isAbsolute } = require('node:path')
const { createHash } = require('node:crypto')

function guardIdentity(environment = process.env) {
  return Object.fromEntries(Object.keys(environment)
    .filter(key => key === 'NODE_OPTIONS' || key.startsWith('CODEBUDDY_SAFE_DELETE_'))
    .sort().map(key => [key, createHash('sha256').update(environment[key] || '').digest('hex')]))
}

function fixturePath(directory, name) {
  const base = fs.realpathSync(directory), target = resolve(base, name), suffix = relative(base, target)
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('Fixture file escaped its directory')
  return target
}

async function createFixtureBridge({ port = 0, service = 'agent-bridge', directory } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid fixture port')
  const requests = [], sockets = new Set()
  const server = http.createServer((request, response) => {
    const record = { method: request.method, path: new URL(request.url, 'http://127.0.0.1').pathname }
    requests.push(record)
    if (directory) fs.appendFileSync(fixturePath(directory, 'requests.jsonl'), JSON.stringify(record) + '\n')
    response.setHeader('content-type', 'application/json')
    // Only the actual read paths are implemented. Cancellation/task submission
    // is a fixture failure, not a simulated success that might mask a side effect.
    if (record.method === 'GET' && record.path === '/health') {
      response.end(JSON.stringify({ service, instances: 1 }))
    } else if (service === 'agent-bridge' && record.method === 'GET' && record.path === '/console/state') {
      response.end(JSON.stringify({ generated_at: Date.now() / 1000, runs: [], messages: [], workspaces: [], agents: [], adapters: {} }))
    } else {
      response.statusCode = 405
      response.end(JSON.stringify({ error_code: 'FIXTURE_READ_ONLY' }))
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept() })
  })
  let closing
  return {
    port: server.address().port,
    requests,
    close() {
      closing ||= new Promise(accept => {
        server.close(() => accept())
        // Every connection belongs to this exact test HTTP server.
        for (const socket of sockets) socket.destroy()
      })
      return closing
    },
  }
}

async function runControlled({ directory, port, expectedHome }) {
  const base = fs.realpathSync(directory)
  // Windows realpath preserves the supplied spelling even when it resolves
  // the same directory. Match canonical identities, not drive/name casing.
  const identity = path => process.platform === 'win32' ? path.toLowerCase() : path
  if (identity(fs.realpathSync(process.cwd())) !== identity(base)
    || identity(fs.realpathSync(process.env.DSH_HOME || '')) !== identity(fs.realpathSync(expectedHome))) {
    throw new Error('Controlled Bridge must run in the isolated Profile')
  }
  const bridge = await createFixtureBridge({ directory: base, port })
  const ownerPid = process.ppid
  fs.writeFileSync(fixturePath(base, 'started.json'), JSON.stringify({
    pid: process.pid, ownerPid, port: bridge.port, cwd: base, home: fs.realpathSync(expectedHome), guards: guardIdentity(),
  }))
  const stop = () => { clearInterval(ownerWatch); void bridge.close().then(() => process.exit(0)) }
  // If the isolated DSH exits during a failed probe, the fake child closes
  // itself rather than leaving an orphan. This never signals another PID.
  const ownerWatch = setInterval(() => {
    try { process.kill(ownerPid, 0) } catch (error) { if (error.code === 'ESRCH') stop() }
  }, 1000)
  ownerWatch.unref()
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop)
}

module.exports = { createFixtureBridge, guardIdentity, runControlled }
