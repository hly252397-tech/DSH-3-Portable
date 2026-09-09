import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

type SpacesModule = {
  apply(ctx: Record<string, unknown>, config?: { inventorExecutable: string }): void
  isTrustedRequest(req: { headers: Record<string, string> }, trustedHosts?: string[]): boolean
  name: string
  resolveInventorExecutable(path?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | undefined
  scrubChildEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
}

async function loadSpaces(): Promise<SpacesModule> {
  const source = join(process.cwd(), 'Data', 'DSH', 'profiles', 'web', 'local', 'dsh-sidebar-spaces', 'lib', 'index.js')
  return import(pathToFileURL(source).href) as Promise<SpacesModule>
}

function pluginPath(...parts: string[]): string {
  return join(process.cwd(), 'Data', 'DSH', 'profiles', 'web', 'local', 'dsh-sidebar-spaces', ...parts)
}

test('sidebar spaces host plugin exposes a named plugin and finds local Inventor 2027', async () => {
  const plugin = await loadSpaces()
  assert.equal(plugin.name, 'dsh-sidebar-spaces')
  assert.match(plugin.resolveInventorExecutable() ?? '', /Autodesk[\\/]Inventor 2027[\\/]Bin[\\/]Inventor\.exe$/i)
  assert.equal(plugin.resolveInventorExecutable('', {}, 'linux'), undefined)
})

test('Inventor routes accept same-origin loopback requests and reject cross-site requests', async () => {
  const plugin = await loadSpaces()
  assert.equal(plugin.isTrustedRequest({ headers: { host: '127.0.0.1:5174', origin: 'http://127.0.0.1:5174', 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(plugin.isTrustedRequest({ headers: { host: '127.0.0.1:5174', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(plugin.isTrustedRequest({ headers: { host: '192.168.1.4:5174', origin: 'http://192.168.1.4:5174' } }, ['192.168.1.4:5174']), true)
})

test('child environment scrub removes credential-shaped values', async () => {
  const plugin = await loadSpaces()
  const scrubbed = plugin.scrubChildEnvironment({ Path: 'C:\\Windows', API_TOKEN: 'secret', PASSWORD_FILE: 'secret', SAFE_VALUE: 'yes' })
  assert.equal(scrubbed.Path, 'C:\\Windows')
  assert.equal(scrubbed.SAFE_VALUE, 'yes')
  assert.equal(scrubbed.API_TOKEN, undefined)
  assert.equal(scrubbed.PASSWORD_FILE, undefined)
})

test('plugin registers status and launch routes through Cordis effects', async () => {
  const plugin = await loadSpaces()
  const paths: string[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register(route: { path: string }): () => void {
        paths.push(route.path)
        return () => {}
      },
    },
    effect(factory: () => () => void): void {
      disposers.push(factory())
    },
  }
  plugin.apply(ctx, { inventorExecutable: '' })
  assert.deepEqual(paths, ['/sidebar-spaces/api/store', '/sidebar-spaces/api/inventor/status', '/sidebar-spaces/api/inventor/launch'])
  assert.equal(disposers.length, 3)
})

test('published client bundle contains the Qoder workbench, global search, enhanced charts, and Inventor tab', async () => {
  const [source, bundle] = await Promise.all([
    readFile(pluginPath('lib', 'client.src.js'), 'utf8'),
    readFile(pluginPath('lib', 'client.js'), 'utf8'),
  ])
  assert.match(source, /全局搜索知识条目和数据库记录/)
  assert.match(source, /type: "scatter"/)
  assert.match(source, /id: "space-inventor-2027"/)
  assert.match(source, /mountHeroActivityGrid/)
  assert.match(source, /data-dss-activity-host/)
  assert.doesNotMatch(source, /id: "dsh-activity-grid"/)
  assert.match(source, /withBetterSidebar/)
  assert.match(source, /openStandaloneWorkbench/)
  assert.doesNotMatch(source, /id: "dsh-knowledge-center"/)
  assert.match(source, /id: "space-automation"/)
  assert.match(source, /IconCordisPluginOutline14/)
  assert.match(bundle, /mountHeroActivityGrid/)
  assert.doesNotMatch(bundle, /id: "dsh-activity-grid"/)
  assert.match(bundle, /const echarts = \(function \(\) \{/)
  assert.doesNotMatch(bundle, /__ECHARTS_VENDOR_ANCHOR__/)
})

async function clientModel(storage: Map<string, string>, fetchMock?: (...args: any[]) => Promise<any>) {
  let api: any
  const source = (await readFile(pluginPath('lib', 'client.src.js'), 'utf8'))
    .replace('exports.apply = apply;', 'exports.model = { readKnowledgeFile, normalizeKnowledge, activityDays, loadPortable, taskSearchResults, startTaskContentSearch }; exports.apply = apply;')
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(def: any) { api = def.factory(() => ({})).model } }, dispatchEvent() {} },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem() { throw new Error('must not overwrite legacy storage') } },
    fetch: fetchMock, CustomEvent: class {}, console: { error() {} }, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout,
  })
  return api
}

test('knowledge text import preserves long UTF-8 text and treats markup as source, not HTML', async () => {
  const api = await clientModel(new Map())
  const body = '# 工程手册\r\n' + '齿轮参数😀\n'.repeat(1500) + '<script>unsafe()</script>'
  const bytes = new TextEncoder().encode('\ufeff' + body)
  const result = await api.readKnowledgeFile({ name: '工程手册.MD', size: bytes.length, arrayBuffer: async () => bytes.buffer })
  assert.equal(result.body, body)
  assert.equal(result.title, '工程手册')
  assert.equal(result.source.format, 'markdown')
  assert.equal(result.source.originalBytes, bytes.length)
  assert.equal(result.source.filename, '工程手册.MD')
})

test('knowledge text import rejects unsupported, oversize, empty, invalid UTF-8 and binary files', async () => {
  const api = await clientModel(new Map())
  await assert.rejects(api.readKnowledgeFile({ name: 'file.pdf' }), /暂不支持/)
  await assert.rejects(api.readKnowledgeFile({ name: 'large.txt', size: 262145 }), /超过/)
  const file = (bytes: Uint8Array) => ({ name: 'test.txt', size: bytes.length, arrayBuffer: async () => bytes.buffer })
  await assert.rejects(api.readKnowledgeFile(file(new Uint8Array([0xff]))), /UTF-8/)
  await assert.rejects(api.readKnowledgeFile(file(new Uint8Array([65, 0]))), /UTF-8/)
  await assert.rejects(api.readKnowledgeFile(file(new Uint8Array([32, 10]))), /没有可导入/)
  await assert.rejects(api.readKnowledgeFile({ name: 'gone.txt', size: 10, arrayBuffer: async () => { throw new Error('denied') } }), /读取失败/)
  const exact = new Uint8Array(262144).fill(65)
  assert.equal((await api.readKnowledgeFile(file(exact))).body.length, 262144)
  await assert.rejects(api.readKnowledgeFile({ ...file(new Uint8Array(262145)), size: 1 }), /超过/)
})

test('legacy knowledge migration preserves entries and is idempotent with collection membership', async () => {
  const api = await clientModel(new Map())
  const old = { version: 1, entries: [{ id: 'kept', title: '用户原文', body: '不能丢', tags: ['机械'] }] }
  const migrated = api.normalizeKnowledge(old)
  assert.equal(migrated.entries[0].body, '不能丢')
  assert.equal(migrated.entries[0].collectionId, migrated.collections[0].id)
  assert.equal(old.entries[0].body, '不能丢')
  assert.equal(JSON.stringify(api.normalizeKnowledge(migrated)), JSON.stringify(migrated))
})

test('client migrates legacy data only after host reports absent and keeps the original', async () => {
  const key = 'dsh.spaceTabs.v1.knowledge'
  const raw = JSON.stringify({ version: 1, entries: [{ id: 'keep', title: '旧标题', body: '保留', tags: [] }] })
  const storage = new Map([[key, raw]])
  const calls: any[] = []
  const api = await clientModel(storage, async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body)
    return { ok: true, json: async () => ({ ok: true, value: body.action === 'load' ? { revision: 0, data: null } : { revision: 1, data: body.data } }) }
  })
  const result = await api.loadPortable(key)
  assert.deepEqual(calls.map(call => call.action), ['load', 'migrate'])
  assert.equal(result.data.entries[0].body, '保留')
  assert.equal(storage.get(key), raw)
})
test('existing host data wins over stale or corrupt browser copies', async () => {
  let calls = 0
  const key = 'dsh.spaceTabs.v1.knowledge'
  const saved = { revision: 8, data: { version: 1, collections: [], entries: [] } }
  const api = await clientModel(new Map([[key, 'invalid JSON']]), async () => {
    calls++; return { ok: true, json: async () => ({ ok: true, value: saved }) }
  })
  assert.equal((await api.loadPortable(key)).revision, 8)
  assert.equal(calls, 1)
})
test('corrupt legacy data or backend failure cannot seed over user data', async () => {
  const key = 'dsh.spaceTabs.v1.knowledge'
  let calls = 0
  const api = await clientModel(new Map([[key, 'broken']]), async () => {
    calls++; return { ok: true, json: async () => ({ ok: true, value: { revision: 0, data: null } }) }
  })
  await assert.rejects(api.loadPortable(key))
  assert.equal(calls, 1)
  const unavailable = await clientModel(new Map(), async () => ({ ok: false, json: async () => ({ ok: false, error: { code: 'storage-unavailable' } }) }))
  await assert.rejects(unavailable.loadPortable(key), /storage-unavailable/)
})

test('activity chart uses only nonblank session last-activity dates and never fabricates activity', async () => {
  const api = await clientModel(new Map())
  const now = new Date(2026, 8, 5, 12)
  const empty = api.activityDays({ ids: [], byId: {} }, now)
  assert.equal(empty.length, 364)
  assert.equal(empty.reduce((sum: number, day: any) => sum + day.count, 0), 0)
  const days = api.activityDays({ ids: ['a', 'blank', 'bad'], byId: {
    a: { updatedAt: now.getTime(), blank: false }, blank: { updatedAt: now.getTime(), blank: true }, bad: { updatedAt: 0, blank: false },
  } }, now)
  assert.equal(days.at(-1).day, '2026-09-05')
  assert.equal(days.at(-1).count, 1)
  assert.equal(days.reduce((sum: number, day: any) => sum + day.count, 0), 1)
})

test('task search merges title and content hits, deduplicates and excludes unknown or blank sessions', async () => {
  const api = await clientModel(new Map())
  const snapshot = { ids: ['a', 'b', 'blank'], byId: {
    a: { displayTitle: 'Inventor 齿轮设计', updatedAt: 20, blank: false },
    b: { displayTitle: '工程讨论', updatedAt: 30, blank: false },
    blank: { displayTitle: 'Inventor', updatedAt: 40, blank: true },
  } }
  const hits = [{ sessionId: 'a', snippet: '参数' }, { sessionId: 'b', snippet: 'Inventor 装配' }, { sessionId: 'unknown', snippet: 'private' }]
  const results = api.taskSearchResults(snapshot, hits, 'INVENTOR', null)
  assert.equal(results.length, 2)
  assert.equal(results[0].id, 'a')
  assert.equal(results[0].bodyHit, true)
  assert.equal(results[0].titleHit, true)
  assert.equal(api.taskSearchResults(snapshot, hits, 'Inventor', new Set(['b']))[0].id, 'b')
  assert.equal(api.taskSearchResults(snapshot, hits, '   ', null).length, 0)
})

test('cancelled task search aborts transport and cannot publish late results', async () => {
  const api = await clientModel(new Map())
  const states: any[] = []
  let resolveSearch!: (value: unknown) => void
  let signal!: AbortSignal
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const service = { search(_query: string, requestSignal: AbortSignal) {
    signal = requestSignal
    started()
    return new Promise(resolve => { resolveSearch = resolve })
  } }
  const cancel = api.startTaskContentSearch(service, 'old query', (state: any) => states.push(state), 0)
  await startedPromise
  cancel()
  resolveSearch({ ok: true, value: { items: [{ sessionId: 'late', snippet: 'stale' }], hasMore: false } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(signal.aborted, true)
  assert.equal(states.length, 1)
  assert.equal(states[0].status, 'loading')
})

test('task search distinguishes backend failure from successful empty search and retains truncation', async () => {
  const api = await clientModel(new Map())
  const settled = (response: unknown) => new Promise<any>(resolve => {
    api.startTaskContentSearch({ search: async () => response }, 'needle', (state: any) => { if (state.status !== 'loading') resolve(state) }, 0)
  })
  assert.equal((await settled({ ok: false, error: { code: 'offline' } })).status, 'error')
  const empty = await settled({ ok: true, value: { items: [], hasMore: false } })
  assert.equal(empty.status, 'ready')
  assert.equal(empty.items.length, 0)
  assert.equal((await settled({ ok: true, value: { items: [], hasMore: true } })).hasMore, true)
})
