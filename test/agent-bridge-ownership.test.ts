import assert from 'node:assert/strict'
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'

const source = resolve('customizations/agent-mcp/lib')
const originalSpawn = childProcess.spawn
const originalKill = process.kill

type StopMode = 'normal' | 'fail' | 'no-exit' | 'already-exited' | 'hung-helper'

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await closeServer(server)
  return port
}

async function fixture(t: TestContext) {
  if (!existsSync(join(source, 'bridge-link.js'))) {
    t.skip('归档插件缺失（CI 全新检出）')
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'agent-bridge-ownership-'))
  const home = join(scratch, 'home'), directory = join(scratch, 'bridge'), packageDir = join(scratch, 'package')
  await Promise.all([mkdir(home), mkdir(directory), mkdir(packageDir)])
  await Promise.all(['bridge-link.js', 'settings-api.js'].map(name => copyFile(join(source, name), join(packageDir, name))))
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ type: 'module' }))
  // start.py contains a Node CJS fixture, not Python; do not inherit the repo's ESM scope.
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  const port = await freePort()
  // Node executes this CJS fixture; this is not Python or the user's Bridge.
  await writeFile(join(directory, 'start.py'), `const http = require('node:http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/health'
    ? { service: 'agent-bridge', instances: 0, pid: process.pid }
    : { runs: [], messages: [], workspaces: [], agents: [], adapters: {} }));
});
server.listen(${port}, '127.0.0.1');
`)
  const previousHome = process.env.DSH_HOME, previousPython = process.env.DSH_BRIDGE_PYTHON
  process.env.DSH_HOME = home
  process.env.DSH_BRIDGE_PYTHON = process.execPath
  const children: ChildProcess[] = [], helpers: ChildProcess[] = [], servers: Server[] = [], disposers: (() => Promise<void>)[] = []
  let stopMode: StopMode = 'normal', stopSignals = 0, helperSignals = 0
  const nativeSpawn = (command: string, args: readonly string[], options?: SpawnOptions) => originalSpawn(command, args, options ?? {})
  t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[] = [], options?: SpawnOptions) => {
    if (command !== 'taskkill') {
      assert.equal(command, process.execPath, 'only the controlled Node fixture may be launched')
      assert.deepEqual(args, ['start.py'])
      assert.equal(options?.windowsHide, true)
      assert.equal(options?.env, undefined, 'inherited NODE_OPTIONS and host guards must not be replaced')
      const child = nativeSpawn(command, args, options)
      children.push(child)
      return child
    }
    stopSignals++
    assert.equal(args[1], String(children[0]?.pid), 'taskkill may only target the controlled fixture child')
    if (stopMode === 'normal') return nativeSpawn(command, args, options)
    const helper = new childProcess.ChildProcess()
    helpers.push(helper)
    if (stopMode === 'hung-helper') {
      t.mock.method(helper, 'kill', () => { helperSignals++; return true })
    } else if (stopMode === 'already-exited') {
      const child = children[0]!
      child.once('exit', () => helper.emit('error', new Error('fixture helper failed after target exit')))
      child.kill('SIGKILL')
    } else queueMicrotask(() => helper.emit('exit', stopMode === 'fail' ? 1 : 0, null))
    return helper
  })
  if (process.platform !== 'win32') t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    stopSignals++
    assert.equal(pid, -children[0]?.pid!, 'signals may only target the controlled fixture process group')
    if (stopMode === 'fail') throw Object.assign(new Error('fixture denied signal'), { code: 'EPERM' })
    if (stopMode === 'no-exit') return true
    if (stopMode === 'already-exited') { children[0]!.kill('SIGKILL'); return true }
    return originalKill(pid, signal)
  })
  syncBuiltinESMExports()
  const bridge = await import(pathToFileURL(join(packageDir, 'bridge-link.js')).href)
  const settings = await import(pathToFileURL(join(packageDir, 'settings-api.js')).href)
  const ownership = join(home, 'agent-bridge-ownership.json')
  const config = { bridgeDir: directory, port }
  t.after(async () => {
    for (const dispose of disposers) await dispose()
    for (const server of servers) await closeServer(server)
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGKILL') // Direct known fixture handle, never a guessed pid.
      await exited
    }
    t.mock.restoreAll(); syncBuiltinESMExports()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousPython === undefined) delete process.env.DSH_BRIDGE_PYTHON
    else process.env.DSH_BRIDGE_PYTHON = previousPython
  })
  async function serveSettings(bridgeConfig: { dir: string; port: number }) {
    let handler: ((req: unknown, res: unknown) => unknown) | undefined
    const server = createServer((req, res) => handler ? void handler(req, res) : res.writeHead(404).end()).listen(0, '127.0.0.1')
    await once(server, 'listening'); servers.push(server)
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const inner = {
      webServer: { register(route: { handler: typeof handler }) { handler = route.handler; return () => { handler = undefined } } },
      connection: { requestRejection(req: { headers: { cookie?: string } }) { return req.headers.cookie === 'fixture=authenticated' ? undefined : 401 } },
      effect(effect: () => () => Promise<void>) { disposers.push(effect()) },
    }
    settings.registerMcpSettings({ inject(_services: string[], apply: (value: typeof inner) => void) { apply(inner) } },
      { status: () => ({ running: true }) }, bridgeConfig)
    return async (operation: string, authenticated = true) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/dsh-agent-mcp/settings`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-agent-mcp': '1',
          ...(authenticated ? { cookie: 'fixture=authenticated' } : {}) },
        body: JSON.stringify({ operation }), signal: AbortSignal.timeout(12_000),
      })
      return { status: response.status, body: await response.json() }
    }
  }
  return { bridge, directory, scratch, port, ownership, config, children, helpers, serveSettings,
    signals: () => stopSignals, mode: (value: StopMode) => { stopMode = value },
    helperSignals: () => helperSignals,
    start: () => bridge.startBridge(config),
    record: async () => JSON.parse(await readFile(ownership, 'utf8')),
    health: () => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }),
  }
}

test('missing, malformed and prior-run ownership records never authorize a signal', async t => {
  const f = await fixture(t); if (!f) return
  for (const body of [null, '{broken', JSON.stringify({ token: 'old', pid: 4242, owner: 1, port: f.port, bridgeDir: f.directory, startedAt: 1 })]) {
    if (body !== null) await writeFile(f.ownership, body)
    assert.deepEqual(f.bridge.bridgeOwnership(f.config), { owned: false, pid: 0 })
    assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: false, error: 'NOT_OWNED' })
    assert.deepEqual(await f.bridge.stopBridge(), { ok: false, error: 'NOT_OWNED' })
  }
  assert.equal(f.signals(), 0)
})

test('status and stop require exact trusted record, port and canonical directory identity', async t => {
  const f = await fixture(t); if (!f) return
  assert.equal((await f.start()).ok, true)
  const record = await f.record(), child = f.children[0]!
  assert.deepEqual(f.bridge.bridgeOwnership(f.config), { owned: true, pid: child.pid })
  assert.equal(f.bridge.bridgeOwnership({ ...f.config, bridgeDir: relative(process.cwd(), f.directory) }).owned, true)
  const alias = join(f.scratch, 'bridge-alias')
  await symlink(f.directory, alias, 'junction')
  assert.equal(f.bridge.bridgeOwnership({ ...f.config, bridgeDir: alias }).owned, true, 'directory aliases normalize by realpath')
  const other = join(f.scratch, 'other'); await mkdir(other)
  for (const config of [{ ...f.config, port: await freePort() }, { ...f.config, bridgeDir: other }, {}]) {
    assert.equal(f.bridge.bridgeOwnership(config).owned, false)
    assert.deepEqual(await f.bridge.stopBridge(config), { ok: false, error: 'NOT_OWNED' })
  }
  for (const change of [{ token: 'different' }, { owner: record.owner + 1 }, { pid: record.pid + 1 },
    { port: record.port + 1 }, { bridgeDir: other }, { startedAt: record.startedAt + 1 }]) {
    await writeFile(f.ownership, JSON.stringify({ ...record, ...change }))
    assert.equal(f.bridge.bridgeOwnership(f.config).owned, false)
    assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: false, error: 'NOT_OWNED' })
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null)
    assert.equal((await f.health()).ok, true, 'mismatch must leave the controlled child alive and responding')
  }
  await writeFile(f.ownership, JSON.stringify(record))
  assert.equal(f.bridge.bridgeOwnership(f.config).owned, true)
  assert.equal(f.signals(), 0, 'no ownership mismatch may issue a signal')
})

test('a matching controlled Node child starts and stops only once, with confirmed exit', async t => {
  const f = await fixture(t); if (!f) return
  assert.deepEqual(await f.start(), { ok: true, adopted: false, instances: 0 })
  assert.equal(f.bridge.bridgeOwnership(f.config).owned, true)
  const results = await Promise.all([f.bridge.stopBridge(f.config), f.bridge.stopBridge(f.config)])
  assert.deepEqual(results, [{ ok: true }, { ok: true }])
  assert.equal(f.signals(), 1, 'concurrent stop requests must share one operation')
  assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null)
  assert.equal(f.bridge.bridgeOwnership(f.config).owned, false)
  assert.equal(existsSync(f.ownership), false, 'only observed target exit permits ownership cleanup')
})

test('a child that has exited cannot authorize a reused pid or another stop', async t => {
  const f = await fixture(t); if (!f) return
  await f.start()
  const record = await f.record(), child = f.children[0]!
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  await writeFile(f.ownership, JSON.stringify(record))
  assert.deepEqual(f.bridge.bridgeOwnership(f.config), { owned: false, pid: 0 })
  assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: false, error: 'NOT_OWNED' })
  assert.equal(f.signals(), 0)
})

test('a failed stop never claims success or discards a still-live trusted child', async t => {
  const f = await fixture(t); if (!f) return
  await f.start(); const record = await f.record()
  f.mode('fail')
  assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: false, error: 'BRIDGE_STOP_FAILED' })
  assert.deepEqual(await f.record(), record)
  assert.equal(f.bridge.bridgeOwnership(f.config).owned, true)
  assert.equal((await f.health()).ok, true)
  f.mode('normal')
  assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: true }, 'the preserved handle remains recoverable')
})

test('signal success without target exit times out and retains ownership for retry', async t => {
  const f = await fixture(t); if (!f) return
  await f.start(); const record = await f.record()
  f.mode('no-exit')
  const started = Date.now()
  assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: false, error: 'BRIDGE_STOP_TIMEOUT' })
  assert.ok(Date.now() - started < 12_000, 'backend budget must fit below the 15s settings deadline')
  assert.deepEqual(await f.record(), record)
  assert.equal(f.bridge.bridgeOwnership(f.config).owned, true)
  assert.equal((await f.health()).ok, true)
  f.mode('normal'); assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: true })
})

test('a helper timeout awaits cleanup and retains a helper until its actual exit', async t => {
  if (process.platform !== 'win32') return t.skip('taskkill helper is Windows-only')
  const f = await fixture(t); if (!f) return
  await f.start(); const record = await f.record()
  f.mode('hung-helper')
  const started = Date.now()
  assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: false, error: 'BRIDGE_STOP_TIMEOUT' })
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 6000 && elapsed < 12_000, 'helper signal is followed by bounded exit observation')
  assert.equal(f.helperSignals(), 1, 'only the helper created by this operation is signalled')
  assert.deepEqual(await f.record(), record)
  assert.equal(f.bridge.bridgeOwnership(f.config).owned, true)
  assert.equal((await f.health()).ok, true)
  const signals = f.signals()
  assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: false, error: 'BRIDGE_STOP_FAILED' })
  assert.equal(f.signals(), signals, 'a retained live helper prevents launching a duplicate killer')
  f.helpers[0]!.emit('exit', 0, null)
  f.mode('normal'); assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: true })
})

test('helper failure after confirmed target exit is distinguished from a live failed stop', async t => {
  const f = await fixture(t); if (!f) return
  await f.start(); f.mode('already-exited')
  assert.deepEqual(await f.bridge.stopBridge(f.config), { ok: true })
  assert.equal(f.bridge.bridgeOwnership(f.config).owned, false)
  assert.equal(existsSync(f.ownership), false)
})

test('the identity is rechecked immediately before issuing the stop signal', async t => {
  const f = await fixture(t); if (!f) return
  await f.start(); const record = await f.record()
  let reads = 0
  const config = { port: f.port, get bridgeDir() {
    if (++reads === 2) writeFileSync(f.ownership, JSON.stringify({ ...record, token: 'changed-before-signal' }))
    return f.directory
  } }
  assert.deepEqual(await f.bridge.stopBridge(config), { ok: false, error: 'NOT_OWNED' })
  assert.equal(f.signals(), 0)
  assert.equal((await f.health()).ok, true)
})

test('authenticated settings status and stop use the same configured ownership identity', async t => {
  const f = await fixture(t); if (!f) return
  await f.start()
  const request = await f.serveSettings({ dir: f.directory, port: f.port })
  assert.equal((await request('bridge.status', false)).status, 401)
  const state = await request('bridge.status')
  assert.equal(state.status, 200); assert.equal(state.body.value.online, true)
  assert.equal(state.body.value.owned, true); assert.equal(state.body.value.dir, f.directory)
  assert.equal(state.body.value.port, f.port)
  const other = join(f.scratch, 'other'); await mkdir(other)
  const wrong = await f.serveSettings({ dir: other, port: f.port })
  assert.equal((await wrong('bridge.status')).body.value.owned, false)
  assert.deepEqual((await wrong('bridge.stop')).body.value, { ok: false, error: 'NOT_OWNED' })
  assert.equal(f.signals(), 0); assert.equal((await f.health()).ok, true)
  const unconfigured = await f.serveSettings({ dir: '', port: f.port })
  assert.deepEqual((await unconfigured('bridge.status')).body.value,
    { online: false, reason: 'BRIDGE_DIR_NOT_CONFIGURED', owned: false, dir: '', port: f.port })
  assert.deepEqual((await request('bridge.stop')).body.value, { ok: true })
  const offline = await request('bridge.status')
  assert.equal(offline.body.value.online, false); assert.equal(offline.body.value.owned, false)
  assert.equal(offline.body.value.dir, f.directory); assert.equal(offline.body.value.port, f.port)
})
