import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'

type Snapshot = { revision: number; data: any }
type Store = { transactStore(path: string | undefined, request: any): Snapshot; storageDirectory(config: any, env: any): string | undefined; MAX_STORE_BYTES: number }
// 用例针对实机 profile 里的 sidebar-spaces 插件产物；全新检出（如 CI）没有这些文件，
// 缺失时整组跳过而不是失败——本地实机仍然全量受保护。
const spacesLibPath = (name: string): string => join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib', name)
const haveLiveSpacesPlugin = existsSync(spacesLibPath('portable-store.js')) && existsSync(spacesLibPath('index.js'))
let storeModule: Promise<Store> | undefined
function loadStore(): Promise<Store> {
  storeModule ??= import(pathToFileURL(spacesLibPath('portable-store.js')).href) as Promise<Store>
  return storeModule
}
const knowledge = { version: 1, collections: [{ id: 'engineering', title: '工程手册', workspaceId: '' }], entries: [{ id: 'one', collectionId: 'engineering', title: '迁移验证', body: '中文正文', tags: ['知识'] }] }
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = join(process.cwd(), 'artifacts', 'portable-storage-tests')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'case-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
test('portable store remains outside versions/origins and refuses missing home', async t => {
  if (!haveLiveSpacesPlugin) return t.skip('实机 sidebar-spaces 插件缺失（CI 全新检出）')
  const store = await loadStore()
  assert.equal(store.storageDirectory({}, { DSH_HOME: 'G:\\Data\\DSH' }), 'G:\\Data\\DSH\\workbench\\sidebar-spaces')
  assert.equal(store.storageDirectory({}, {}), undefined)
  assert.throws(() => store.transactStore(undefined, { action: 'load', space: 'knowledge' }), /storage-unconfigured/)
})
test('migration is durable across connections, idempotent and cannot overwrite newer host data', async t => {
  if (!haveLiveSpacesPlugin) return t.skip('实机 sidebar-spaces 插件缺失（CI 全新检出）')
  const store = await loadStore()
  const dir = await temporary(t)
  const initial = store.transactStore(dir, { action: 'migrate', space: 'knowledge', data: knowledge })
  assert.equal(initial.revision, 1)
  const changed = { ...knowledge, entries: [{ ...knowledge.entries[0], body: '已更新' }] }
  store.transactStore(dir, { action: 'save', space: 'knowledge', revision: 1, data: changed })
  const migratedAgain = store.transactStore(dir, { action: 'migrate', space: 'knowledge', data: knowledge })
  assert.equal(migratedAgain.revision, 2)
  assert.deepEqual(migratedAgain.data, changed)
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'knowledge.previous.json'), 'utf8')).data, knowledge)
  const db = new DatabaseSync(join(dir, 'workbench.sqlite'))
  try {
    const row = db.prepare('SELECT previous, migrated FROM spaces').get()!
    assert.deepEqual(JSON.parse(row.previous as string), knowledge)
    assert.deepEqual(JSON.parse(row.migrated as string), knowledge)
  } finally { db.close() }
})
test('stale window receives conflict instead of replacing another writer', async t => {
  if (!haveLiveSpacesPlugin) return t.skip('实机 sidebar-spaces 插件缺失（CI 全新检出）')
  const store = await loadStore()
  const dir = await temporary(t)
  store.transactStore(dir, { action: 'migrate', space: 'knowledge', data: knowledge })
  const request = { action: 'save', space: 'knowledge', revision: 1, data: knowledge }
  store.transactStore(dir, request)
  assert.throws(() => store.transactStore(dir, request), /revision-conflict/)
  assert.equal(store.transactStore(dir, { action: 'load', space: 'knowledge' }).revision, 2)
})
test('SQLite commit failure rolls back both the data and backup revision', async t => {
  if (!haveLiveSpacesPlugin) return t.skip('实机 sidebar-spaces 插件缺失（CI 全新检出）')
  const store = await loadStore()
  const dir = await temporary(t)
  store.transactStore(dir, { action: 'migrate', space: 'knowledge', data: knowledge })
  const db = new DatabaseSync(join(dir, 'workbench.sqlite'))
  db.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT, 'simulated disk write failure'); END;")
  db.close()
  assert.throws(() => store.transactStore(dir, { action: 'save', space: 'knowledge', revision: 1, data: { ...knowledge, entries: [] } }), /simulated disk write failure/)
  assert.deepEqual(store.transactStore(dir, { action: 'load', space: 'knowledge' }), { revision: 1, data: knowledge })
})
test('independent backup failure prevents replacing authoritative data', async t => {
  if (!haveLiveSpacesPlugin) return t.skip('实机 sidebar-spaces 插件缺失（CI 全新检出）')
  const store = await loadStore()
  const dir = await temporary(t)
  store.transactStore(dir, { action: 'migrate', space: 'knowledge', data: knowledge })
  const target = join(dir, 'knowledge.previous.json')
  await rm(target)
  await mkdir(target)
  assert.throws(() => store.transactStore(dir, { action: 'save', space: 'knowledge', revision: 1, data: { ...knowledge, entries: [] } }))
  assert.deepEqual(store.transactStore(dir, { action: 'load', space: 'knowledge' }), { revision: 1, data: knowledge })
})
test('invalid references, duplicate IDs, unknown schemas and oversized UTF8 envelopes are rejected', async t => {
  if (!haveLiveSpacesPlugin) return t.skip('实机 sidebar-spaces 插件缺失（CI 全新检出）')
  const store = await loadStore()
  const dir = await temporary(t)
  const migrate = (data: any) => store.transactStore(dir, { action: 'migrate', space: 'knowledge', data })
  assert.throws(() => migrate({ ...knowledge, entries: [{ ...knowledge.entries[0], collectionId: 'missing' }] }), /invalid-data/)
  assert.throws(() => migrate({ ...knowledge, entries: [knowledge.entries[0], knowledge.entries[0]] }), /duplicate-id/)
  assert.throws(() => migrate({ ...knowledge, version: 2 }), /invalid-data/)
  const request = { action: 'migrate', space: 'knowledge', data: { ...knowledge, entries: [{ ...knowledge.entries[0], body: '' }] } }
  const overhead = Buffer.byteLength(JSON.stringify(request))
  request.data.entries[0].body = '中'.repeat(Math.floor((store.MAX_STORE_BYTES - overhead) / 3)) + 'x'.repeat((store.MAX_STORE_BYTES - overhead) % 3)
  assert.equal(Buffer.byteLength(JSON.stringify(request)), store.MAX_STORE_BYTES)
  store.transactStore(dir, request)
  request.data.entries[0].body += 'x'
  assert.throws(() => store.transactStore(dir, request), /payload-too-large/)
})
test('database cells persist without knowledge mutation and corrupt files are never replaced with seeds', async t => {
  if (!haveLiveSpacesPlugin) return t.skip('实机 sidebar-spaces 插件缺失（CI 全新检出）')
  const store = await loadStore()
  const dir = await temporary(t)
  const database = { version: 1, fields: [{ id: 'f', name: '数值', type: 'number' }], records: [{ id: 'r', cells: { f: 3.5 } }] }
  store.transactStore(dir, { action: 'migrate', space: 'database', data: database })
  assert.deepEqual(store.transactStore(dir, { action: 'load', space: 'database' }).data, database)
  assert.equal(store.transactStore(dir, { action: 'load', space: 'knowledge' }).data, null)
  const badDir = await temporary(t)
  const badFile = join(badDir, 'workbench.sqlite')
  await writeFile(badFile, 'corrupted database fixture')
  assert.throws(() => store.transactStore(badDir, { action: 'load', space: 'knowledge' }))
  assert.equal(await readFile(badFile, 'utf8'), 'corrupted database fixture')
})

test('storage HTTP boundary rejects unauthenticated/cross-origin writes and disposes registered resources', async t => {
  if (!haveLiveSpacesPlugin) return t.skip('实机 sidebar-spaces 插件缺失（CI 全新检出）')
  const store = await loadStore()
  const dir = await temporary(t)
  const plugin = await import(pathToFileURL(spacesLibPath('index.js')).href)
  const routes = new Map<string, any>()
  const disposers: Array<() => Promise<void> | void> = []
  plugin.apply({
    get: () => ({ requestRejection: (req: any) => req.headers.cookie === 'test-auth=1' ? undefined : 401 }),
    effect: (factory: () => () => Promise<void> | void) => disposers.push(factory()),
    webServer: { register: (route: any) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  }, { dataDirectory: dir })
  const route = '/sidebar-spaces/api/store'
  const server = createServer((req, res) => { void routes.get(route)?.(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const dispose of disposers) await dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  const request = { action: 'migrate', space: 'knowledge', data: knowledge }
  const send = (headers: Record<string, string>) => fetch(origin + route, { method: 'POST', headers, body: JSON.stringify(request) })
  assert.equal((await send({ 'content-type': 'application/json', 'x-dsh-spaces': '1' })).status, 401)
  const headers = { 'content-type': 'application/json', 'x-dsh-spaces': '1', cookie: 'test-auth=1' }
  assert.equal((await send({ ...headers, origin: 'http://127.0.0.1:1' })).status, 403)
  assert.equal((await send({ ...headers, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await send({ ...headers, origin })).status, 200)
  const hanging = httpRequest(origin + route, { method: 'POST', headers: { ...headers, 'content-length': '1000' } })
  hanging.on('error', () => {})
  const closed = new Promise<void>(resolve => hanging.on('close', resolve))
  hanging.write('{')
  // Allow the route to own this incoming body before disposing its fiber effect.
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  await disposers[0]()
  await closed
  assert.equal(routes.has(route), false)
  assert.deepEqual(store.transactStore(dir, { action: 'load', space: 'knowledge' }).data, knowledge)
})
