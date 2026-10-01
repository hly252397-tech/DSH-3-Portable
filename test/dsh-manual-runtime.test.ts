import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

async function fixture(t: TestContext, allowModelEdits = true, sourceMode: 'explicit' | 'auto' | 'missing-auto' = 'explicit') {
  const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))
  if (!runtime || !existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'))) {
    t.skip('实机官方运行时缺失（CI 全新检出）')
    return
  }
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const load = (name: string) => import(pathToFileURL(join(official, name, 'lib/index.js')).href)
  const portableRoot = await mkdtemp(join(tmpdir(), 'dsh-manual-runtime-'))
  const home = join(portableRoot, 'Data/DSH-generations/manual-test/home')
  const dir = join(home, 'profiles/web')
  const sourceRoot = sourceMode === 'explicit' ? join(portableRoot, 'project') : portableRoot
  const plugin = join(dir, 'node_modules/dsh-manual')
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(official, join(dir, 'node_modules/@deepseek-ai'), 'junction')
  await symlink(join(official, 'schemastery'), join(dir, 'node_modules/schemastery'), 'junction')
  await cp(resolve('plugins/dsh-manual'), plugin, { recursive: true })
  await mkdir(join(sourceRoot, 'docs/00-交接入口'), { recursive: true })
  await writeFile(join(sourceRoot, 'docs/00-交接入口/07-功能清单.md'), '# 功能清单\n\nRuntime integration source.\n')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'manual-test', private: true, dependencies: { 'dsh-manual': 'link:./node_modules/dsh-manual' }, dsh: { profile: { bundles: ['dsh-manual'] } } }))
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([{ id: 'dsh-manual', name: 'dsh-manual', config: { sourceRoot: sourceMode === 'explicit' ? sourceRoot : 'auto', manualDirectory: 'manual', allowModelEdits, syncIntervalSeconds: 3600 } }]))
  const profileContext = { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, installAnchor: join(official, 'dsh/package.json'), cwd: dir, startedBundles: ['dsh-manual'], overlays: [], telemetryDisabledEnv: undefined }
  const rows = [
    ['dsh-system-prompt', {}], ['dsh-tools', { mode: 'native' }], ['dsh-host-webserver', { host: '127.0.0.1', port: 0 }],
  ].map(([name, config]) => ({ id: String(name), name: pathToFileURL(join(official, String(name), 'lib/index.js')).href, config }))
  const rootConfig = join(dir, 'base.json')
  await writeFile(rootConfig, JSON.stringify(rows))
  const app = await load('dsh-app-boot')
  let authObserver = () => {}
  const connection = {
    requestRejection(req: any): 401 | 403 | undefined {
      authObserver()
      if (req.headers['x-test-forbid'] === '1') return 403
      return req.headers.authorization === 'Bearer manual-fixture' ? undefined : 401
    },
  }
  const previousPortableRoot = process.env.DSH_PORTABLE_ROOT
  if (sourceMode === 'missing-auto') delete process.env.DSH_PORTABLE_ROOT
  else process.env.DSH_PORTABLE_ROOT = portableRoot
  let ctx: any
  try {
    ctx = await app.boot('manual-test', rootConfig, app.readProfilePatches('manual-test', profileContext), (host: any) => {
      host.provide('profileContext', profileContext)
      host.provide('webRuntime', { trustedHosts: [] })
      host.provide('connection', connection)
    })
  } finally {
    if (previousPortableRoot === undefined) delete process.env.DSH_PORTABLE_ROOT
    else process.env.DSH_PORTABLE_ROOT = previousPortableRoot
  }
  t.after(async () => { await ctx.fiber.dispose() })
  const entry = [...ctx.loader.entries()].find((item: any) => item.options.id === 'dsh-manual') as any
  assert.equal(entry?.fiber.state, 2, 'manual bundle must load ACTIVE through real Profile + Loader')
  const url = `http://127.0.0.1:${ctx.webServer.port}/dsh-manual/api`
  const request = async (args: unknown, headers: Record<string, string> = {}, method = 'POST') => {
    const response = await fetch(url, {
      method, headers: { authorization: 'Bearer manual-fixture', 'content-type': 'application/json', 'x-dsh-manual': '1', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(args) }), signal: AbortSignal.timeout(5000),
    })
    const raw = await response.text()
    return { status: response.status, headers: response.headers, value: raw ? JSON.parse(raw) : undefined }
  }
  const execute = (args: unknown, signal = new AbortController().signal) => ctx.tools.execute({ callId: 'manual-test-call', name: 'dsh_manual', arguments: args, signal })
  return { home, sourceRoot, portableRoot, plugin, ctx, entry, url, request, execute, observeAuth: (callback: () => void) => { authObserver = callback } }
}

test('manual generation auto source loads through real Profile and keeps notes in its actual home', async t => {
  const f = await fixture(t, true, 'auto')
  if (!f) return
  const sync = await f.request({ operation: 'sync' })
  assert.equal(sync.status, 200)
  assert.ok(sync.value.value.unchanged.length >= 1)
  const found = await f.request({ operation: 'search', query: 'Runtime integration source' })
  assert.equal(found.value.value.total, 1)
  assert.equal(found.value.value.items[0].freshness, 'current')
  const note = await f.request({ operation: 'edit', id: 'notes/actual-home', content: '# Actual home\n', expectedRevision: null })
  assert.equal(note.status, 200)
  assert.match(await readFile(join(f.home, 'manual/notes/actual-home.md'), 'utf8'), /Actual home/)
  assert.equal(existsSync(join(f.portableRoot, 'Data/DSH/manual')), false)
})

test('manual missing auto environment reports partial sync but retains real tool and authenticated notes API', async t => {
  const f = await fixture(t, true, 'missing-auto')
  if (!f) return
  const created = await f.request({ operation: 'edit', id: 'notes/environment-missing', content: '# Still editable\n', expectedRevision: null })
  assert.equal(created.status, 200)
  const sync = await f.request({ operation: 'sync' })
  assert.ok(sync.value.value.failed.some((item: any) => item.source === 'project-root' && item.code === 'INVALID_SOURCE'))
  const status = await f.request({ operation: 'status' })
  assert.equal(status.value.value.lastSync.status, 'partial')
  const read = await f.execute({ operation: 'read', id: created.value.value.id })
  assert.equal(read.isError, false)
  assert.equal(read.value.revision, created.value.value.revision)
})

test('manual real HTTP preserves authentication rejection, blocks foreign origins and offers read/sync', async t => {
  const f = await fixture(t)
  if (!f) return
  assert.equal((await f.request({ operation: 'list' }, { authorization: '' })).status, 401)
  assert.equal((await f.request({ operation: 'list' }, { 'x-test-forbid': '1' })).status, 403)
  assert.equal((await f.request({ operation: 'list' }, { origin: 'https://other.invalid' })).status, 403)
  assert.equal((await f.request({ operation: 'list' }, { 'x-dsh-manual': '' })).status, 403)
  assert.equal((await f.request(undefined, {}, 'GET')).status, 405)
  assert.equal((await f.request({ operation: 'list' }, { 'content-type': 'text/plain' })).status, 415)
  const listed = await f.request({ operation: 'list' })
  assert.equal(listed.status, 200)
  assert.ok(listed.value.value.items.length > 0)
  assert.equal(listed.headers.get('cache-control'), 'no-store')
  assert.equal(listed.headers.get('access-control-allow-origin'), null)
  const doc = await f.request({ operation: 'read', id: listed.value.value.items[0].id })
  assert.equal(doc.status, 200)
  assert.equal(typeof doc.value.value.content, 'string')
  const sync = await f.request({ operation: 'sync' })
  assert.equal(sync.status, 200)
  assert.ok(sync.value.value.unchanged.length >= 1)
  assert.ok(sync.value.value.failed.length > 0, 'missing configured docs are reported individually')
  const status = await f.request({ operation: 'status' })
  assert.equal(status.status, 200)
  assert.notEqual(status.value.value.lastSync.status, 'ready', 'partial source failures must not become an all-ready status')
})

test('manual real HTTP creates drafts, detects revision races, restores history and refuses path traversal', async t => {
  const f = await fixture(t)
  if (!f) return
  const created = await f.request({ operation: 'edit', id: 'notes/http-draft', expectedRevision: null, title: 'HTTP draft', content: '# One', reason: 'create', author: 'admin', status: 'verified' })
  assert.equal(created.status, 200)
  const first = created.value.value
  assert.equal(first.kind, 'note')
  assert.equal(first.status, 'draft')
  assert.equal(first.author, 'user')
  const changed = await f.request({ operation: 'edit', id: first.id, expectedRevision: first.revision, title: first.title, content: '# Two', reason: 'edit' })
  assert.equal(changed.status, 200)
  const conflict = await f.request({ operation: 'edit', id: first.id, expectedRevision: first.revision, content: '# Lost update' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.value.error.code, 'REVISION_CONFLICT')
  assert.equal(conflict.value.error.currentRevision, changed.value.value.revision)
  const history = await f.request({ operation: 'history', id: first.id })
  assert.equal(history.status, 200)
  assert.ok(history.value.value.items.some((item: any) => item.revision === first.revision))
  const restored = await f.request({ operation: 'restore', id: first.id, expectedRevision: changed.value.value.revision, revision: first.revision, reason: 'restore original' })
  assert.equal(restored.status, 200)
  assert.equal(restored.value.value.content, '# One')
  assert.notEqual(restored.value.value.revision, first.revision)
  const listed = await f.request({ operation: 'list', kind: 'note' })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.value.value.items.map((item: any) => item.id), [first.id])
  for (const id of ['../secrets', 'notes/../../secrets', 'notes/con', 'notes/x:ads']) {
    const denied = await f.request({ operation: 'read', id })
    assert.equal(denied.status, 400, id)
    assert.doesNotMatch(JSON.stringify(denied.value), /[A-Z]:\\/)
  }
})

test('manual canonical tool output is accepted by installed registry and model write policy leaves user editor usable', async t => {
  const f = await fixture(t, false)
  if (!f) return
  const schema = f.ctx.tools.schemas().find((tool: any) => tool.name === 'dsh_manual')
  assert.deepEqual(schema.parameters.properties.kind.enum, ['generated', 'note'])
  const listed = await f.execute({ operation: 'list' })
  assert.equal(listed.isError, false, JSON.stringify(listed))
  assert.ok(Array.isArray(listed.value.items))
  assert.deepEqual(JSON.parse(listed.content[0].text), listed.value)
  const denied = await f.execute({ operation: 'edit', id: 'notes/model-draft', expectedRevision: null, content: 'write disabled' })
  assert.equal(denied.isError, true)
  const userEdit = await f.request({ operation: 'edit', id: 'notes/user-draft', expectedRevision: null, content: 'user remains allowed' })
  assert.equal(userEdit.status, 200)
  const controller = new AbortController()
  controller.abort()
  assert.equal((await f.execute({ operation: 'list' }, controller.signal)).isError, true)
})

test('manual unload drains an accepted write and removes tools/routes without abandoning disk state', async t => {
  const f = await fixture(t)
  if (!f) return
  const lockPath = join(f.home, 'manual/state/write.lock')
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'test-blocker', createdAt: new Date().toISOString() }))
  const writing = f.execute({ operation: 'edit', id: 'notes/drain', expectedRevision: null, content: 'must settle before disposal' })
  await delay(80)
  let disposed = false
  const disposing = f.entry.fiber.dispose().then(() => { disposed = true })
  await delay(40)
  assert.equal(disposed, false, 'fiber disposal waits for accepted writes')
  await unlink(lockPath)
  const result = await writing
  await disposing
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.match(await readFile(join(f.home, 'manual/notes/drain.md'), 'utf8'), /must settle before disposal/)
  assert.ok(!f.ctx.tools.schemas().some((tool: any) => tool.name === 'dsh_manual'))
  const response = await fetch(f.url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 404)
})

test('manual unload closes an unfinished HTTP body rather than keeping the route alive', async t => {
  const f = await fixture(t)
  if (!f) return
  let accepted!: () => void
  const entered = new Promise<void>(resolve => { accepted = resolve })
  f.observeAuth(accepted)
  const finished = new Promise<string>(resolve => {
    const request = httpRequest(f.url, { method: 'POST', headers: { authorization: 'Bearer manual-fixture', 'content-type': 'application/json', 'x-dsh-manual': '1', 'content-length': '1000' } }, response => { response.resume(); response.on('end', () => resolve('response')) })
    request.on('error', () => resolve('closed'))
    request.write('{')
  })
  await entered
  await f.entry.fiber.dispose()
  assert.equal(await finished, 'closed')
})
