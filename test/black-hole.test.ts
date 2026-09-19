import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

type Core = {
  addEntry: (state: any, blackHoleId: string, value: any) => any
  analyzeContent: (body: string, options?: any) => any
  createDefaultState: () => any
  normalizeState: (value: any) => any
  searchEntries: (state: any, query: string, options?: any) => any[]
}
type Store = {
  transactStore: (directory: string, request: any) => any
  storageDirectory: (config?: any, env?: any) => string | undefined
}

const root = process.cwd()
const core = await import(pathToFileURL(join(root, 'customizations/black-hole/lib/core.js')).href) as Core
const store = await import(pathToFileURL(join(root, 'customizations/black-hole/lib/portable-store.js')).href) as Store

async function temporary(t: { after(fn: () => Promise<void>): void }) {
  mkdirSync(join(root, 'artifacts'), { recursive: true })
  const directory = await mkdtemp(join(root, 'artifacts', 'black-hole-tests-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('black hole core absorbs, classifies, scores and recalls knowledge', () => {
  const state = core.createDefaultState()
  const analysis = core.analyzeContent('# 采购规则\n报价高于历史均价 5% 时必须二次确认。', {})
  assert.equal(analysis.title, '采购规则')
  assert.equal(analysis.type, '规则')
  assert.ok(analysis.tags.includes('采购'))
  const first = core.addEntry(state, state.blackHoles[0].id, {
    body: '# 采购规则\n报价高于历史均价 5% 时必须二次确认。',
    title: '采购规则',
    status: 'confirmed',
    source: { kind: 'conversation', sessionId: 'session-1', label: 'DSH 对话' },
  })
  assert.equal(first.duplicate, false)
  assert.equal(state.blackHoles[0].entries[0].source.sessionId, 'session-1')
  assert.equal(state.blackHoles[0].entries[0].status, 'confirmed')
  assert.ok(state.blackHoles[0].growth.score > 0)
  const duplicate = core.addEntry(state, state.blackHoles[0].id, { body: '# 采购规则\n报价高于历史均价 5% 时必须二次确认。' })
  assert.equal(duplicate.duplicate, true)
  assert.equal(state.blackHoles[0].entries.length, 1)
  const results = core.searchEntries(state, '历史均价 5%', { blackHoleId: state.blackHoles[0].id })
  assert.equal(results.length, 1)
  assert.equal(results[0].entry.title, '采购规则')
})

test('black hole store is durable and rejects stale writers', async (t) => {
  const directory = await temporary(t)
  assert.equal(store.storageDirectory({}, { DSH_HOME: 'G:\\Data\\DSH' }), 'G:\\Data\\DSH\\workbench\\black-hole')
  const initial = store.transactStore(directory, { action: 'migrate' })
  assert.equal(initial.revision, 1)
  assert.equal(initial.data.blackHoles.length, 1)
  const changed = structuredClone(initial.data)
  changed.blackHoles[0].name = '产品研发黑洞'
  const saved = store.transactStore(directory, { action: 'save', revision: 1, data: changed })
  assert.equal(saved.revision, 2)
  assert.equal(store.transactStore(directory, { action: 'load' }).data.blackHoles[0].name, '产品研发黑洞')
  assert.throws(() => store.transactStore(directory, { action: 'save', revision: 1, data: changed }), /revision-conflict/)
  const normalized = core.normalizeState(saved.data)
  assert.equal(normalized.blackHoles[0].name, '产品研发黑洞')
})

test('black hole storage route enforces origin, header and session authorization', async (t) => {
  const installed = join(root, 'Data/DSH/profiles/web/local/dsh-black-hole/lib/index.js')
  if (!existsSync(installed)) return t.skip('Installed DSH Profile required for host integration; core/client tests are source-only')
  const plugin = await import(pathToFileURL(installed).href)
  const directory = await temporary(t)
  const routes = new Map<string, (req: any, res: any) => unknown>()
  const disposers: Array<() => Promise<void> | void> = []
  let authorizationAvailable = true
  plugin.apply({
    get: () => authorizationAvailable ? ({ requestRejection: (req: any) => req.headers.cookie === 'dsh-test=1' ? undefined : 401 }) : undefined,
    effect: (factory: () => () => Promise<void> | void) => { disposers.push(factory()) },
    webRuntime: { trustedHosts: [] },
    webServer: { register: (route: any) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  }, { dataDirectory: directory })
  const server = createServer((req, res) => { void routes.get('/black-hole/api/store')?.(req, res) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const dispose of disposers) await dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  const send = (headers: Record<string, string>, body = { action: 'load' }) => fetch(origin + '/black-hole/api/store', { method: 'POST', headers, body: JSON.stringify(body) })
  const base = { 'content-type': 'application/json', 'x-dsh-black-hole': '1', cookie: 'dsh-test=1' }
  assert.equal((await send({ 'content-type': 'application/json', 'x-dsh-black-hole': '1' })).status, 403)
  assert.equal((await send({ ...base, origin: 'http://127.0.0.1:1' })).status, 403)
  assert.equal((await send({ ...base, 'content-type': 'text/plain' })).status, 415)
  const response = await send({ ...base, origin })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
  authorizationAvailable = false
  assert.equal((await send({ ...base, origin })).status, 503)
})

test('black hole client is a discoverable DSH module-loader plugin', async () => {
  const source = await readFile(join(root, 'customizations/black-hole/lib/client.js'), 'utf8')
  let registration: any
  runInNewContext(source, {
    console,
    setTimeout,
    clearTimeout,
    window: { __ModuleLoader__: { load(value: any) { registration = value } } },
  })
  assert.equal(registration.id, 'dsh-black-hole')
  const React = {
    Fragment: Symbol('Fragment'),
    createElement() { return null },
    useEffect() {}, useMemo(fn: () => unknown) { return fn() }, useRef() { return { current: null } },
    useState() { return [null, () => {}] }, useSyncExternalStore() { return { revision: 0, data: null } },
  }
  const client = registration.factory((id: string) => id === 'react' ? React : {})
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'sessions'])
})

async function loadClient() {
  let registration: any
  const source = await readFile(join(root, 'customizations/black-hole/lib/client.js'), 'utf8')
  runInNewContext(source, { TextEncoder, document: { documentElement: { lang: 'zh' } }, window: { __ModuleLoader__: { load(value: any) { registration = value } } } })
  return registration.factory(() => ({ createElement(type: any, props: any, ...children: any[]) { return { type, props, children } } })).testing
}

test('black hole reader formats basic Markdown without executing stored HTML or fetching images', async () => {
  const client = await loadClient()
  const tree = client.MemoryBody({ body: '# 标题\n\n- **重点**\n- `代码`\n\n<script>alert(1)</script>\n![tracking](https://example.test/pixel)\n```html\n<img onerror=alert(1)>\n```' })
  const nodes: any[] = []
  const visit = (value: any): void => { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') { nodes.push(value); visit(value.children) } }
  visit(tree)
  for (const tag of ['h2', 'ul', 'li', 'strong', 'code', 'pre']) assert.ok(nodes.some(n => n.type === tag), tag)
  assert.ok(nodes.every(n => !['script', 'img', 'iframe', 'a'].includes(n.type)))
  assert.ok(nodes.every(n => !n.props?.dangerouslySetInnerHTML))
  assert.ok(JSON.stringify(tree).includes('<script>alert(1)</script>'))
  assert.equal(client.memoryPreview({ summary: '**重点** 与 `代码`' }), '重点 与 代码')
  assert.equal(client.memoryPreview({ body: 'a'.repeat(300) }).length, 200)
})

test('black hole UI keeps offline artwork and composer alignment while providing responsive reader', async () => {
  const source = await readFile(join(root, 'customizations/black-hole/lib/client.js'), 'utf8')
  const asset = await readFile(join(root, 'customizations/black-hole/assets/black-hole-banner.webp'))
  assert.ok(asset.length < 100_000)
  assert.ok(source.includes(`data:image/webp;base64,${asset.toString('base64')}`))
  assert.match(source, /--dsh-composer-card-max-width/)
  assert.match(source, /--dsh-composer-side-clearance/)
  assert.match(source, /observeHomeDockPlacement/)
  assert.match(source, /dbh-home-dock-host/)
  assert.match(source, /data-dbh-dock-placement=inline/)
  assert.match(source, /data-dbh-dock-placement=stacked/)
  assert.match(source, /@container blackhole \(max-width:640px\)/)
  assert.match(source, /prefers-reduced-motion:reduce/)
  assert.match(source, /className: 'dbh-list-item', 'aria-pressed'/)
  assert.match(source, /actionLock\.current/)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
})

test('black hole recall recognizes Chinese topic phrases such as UI design guidance', async () => {
  const client = await loadClient()
  const entry = {
    id: 'memory-design-system',
    title: '界面设计规范',
    summary: '统一字体、颜色、间距和组件语言。',
    body: '黑洞空间的 UI 应遵循统一的界面设计规范，保持高级感和品牌一致性。',
    tags: ['UI', '界面优化', '设计系统'],
    status: 'confirmed',
    updatedAt: '2026-09-13T00:00:00.000Z',
  }
  const results = client.searchAll({ blackHoles: [{ id: 'hole-design', name: '黑洞空间', entries: [entry] }] }, '我想继续做界面设计规范和界面优化，提升 UI 质感。', undefined, 3)
  assert.equal(results[0].entry.id, entry.id)
  assert.ok(results[0].score >= 22)
})

test('black hole recall surfaces a related memory from the current Chinese conversation', async () => {
  const client = await loadClient()
  const entry = {
    id: 'memory-design-system',
    title: '界面设计规范',
    summary: '统一字体、颜色、间距和组件语言。',
    body: '黑洞空间的 UI 应遵循统一的界面设计规范。',
    tags: ['UI', '界面优化'],
    status: 'confirmed',
    updatedAt: '2026-09-13T00:00:00.000Z',
  }
  client.runtime.snapshot = { revision: 1, data: { settings: { suggestions: 'balanced' }, blackHoles: [{ id: 'hole-design', name: '黑洞空间', entries: [entry] }] } }
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ current: 'session-design' }), subscribe: () => () => {} } },
    get: () => ({
      binding: () => ({
        target: () => ({
          getSnapshot: () => chat([{ kind: 'user', data: { content: [{ type: 'text', text: '我想继续做界面设计规范和界面优化，提升 UI 质感。' }] } }]),
          subscribe: () => () => {},
        }),
      }),
    }),
  }
  const dispose = client.startRecallMonitor(ctx)
  assert.equal(client.runtime.recall.entry.title, '界面设计规范')
  assert.equal(client.runtime.recall.blackHoleName, '黑洞空间')
  dispose()
  assert.equal(client.runtime.recall, null)
})

function chat(nodes: any[]) {
  return { order: nodes.map((_, i) => String(i)), nodes: { get: (key: string) => nodes[Number(key)] } }
}

test('black hole reads current public Chat target, excluding reasoning, hidden and tool content', async () => {
  const client = await loadClient()
  const snapshot = chat([
    { kind: 'user', data: { content: [{ type: 'text', text: '可见问题' }] } },
    { kind: 'assistant-step', data: { status: 'settled', blocks: [{ kind: 'text', text: '可见回答' }, { kind: 'reasoning', text: '秘密思考' }, { kind: 'tool-call', text: '工具参数' }] } },
    { kind: 'user', visibility: 'hidden', data: { content: [{ type: 'text', text: '隐藏内容' }] } },
    { kind: 'assistant-step', data: { status: 'running', blocks: [{ kind: 'text', text: '未完成回答' }] } },
  ])
  assert.equal(client.snapshotText(snapshot), '用户：可见问题\n\nAI：可见回答')
  assert.equal(client.snapshotText({ nodes: [] }), '')
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: 'session-a' }) } }, get: (service: string) => {
    assert.equal(service, 'uiConversation')
    return { binding: (id: string) => { assert.equal(id, 'session-a'); return { target: (target: string) => { assert.equal(target, 'chat'); return { getSnapshot: () => snapshot } } } } }
  } }
  assert.equal(client.conversationText(ctx), client.snapshotText(snapshot))
})

test('black hole quotation appends to draft and never submits or overwrites busy input', async () => {
  const client = await loadClient()
  let draft = '用户尚未发送的问题', phase = 'plain'
  const scope = {}
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: 'a' }) }, binding: () => ({ ctx: scope }) }, get: () => ({ input: { for: (given: any) => {
    assert.equal(given, scope)
    return { state: { getSnapshot: () => ({ draft, phase }) }, setDraft: (value: string) => { draft = value } }
  } } }) }
  const entry = { id: 'memory-a', title: '规则', body: '参考正文' }
  assert.equal(await client.quoteInCurrentConversation(ctx, entry), 'draft')
  assert.ok(draft.startsWith('用户尚未发送的问题\n\n'))
  assert.ok(draft.includes('memory-a'))
  const saved = draft
  phase = 'submitting'
  await assert.rejects(client.quoteInCurrentConversation(ctx, entry), /稍后引用/)
  assert.equal(draft, saved)
})

test('black hole rejects oversize data without truncating existing entries', () => {
  const state = core.createDefaultState()
  state.blackHoles = Array.from({ length: 65 }, (_, i) => ({ ...state.blackHoles[0], id: String(i) }))
  assert.throws(() => core.normalizeState(state), /too-many-black-holes/)
  const large = core.createDefaultState()
  large.blackHoles[0].entries = [{ id: 'a', body: '中'.repeat(360000) }]
  assert.throws(() => core.normalizeState(large), /entry-too-large/)
})

test('black hole recall follows only current session and disposes subscriptions', async () => {
  const client = await loadClient()
  let current = 'a', listener: () => void = () => {}, off = 0
  const requested: string[] = []
  const ctx = { sessions: { list: { getSnapshot: () => ({ current, ids: ['a', 'b'] }), subscribe: (fn: () => void) => { listener = fn; return () => { off++ } } } }, get: () => ({ binding: (id: string) => {
    requested.push(id)
    return { target: () => ({ getSnapshot: () => chat([]), subscribe: () => () => { off++ } }) }
  } }) }
  const dispose = client.startRecallMonitor(ctx)
  assert.deepEqual(requested, ['a'])
  current = 'b'; listener()
  assert.deepEqual(requested, ['a', 'b'])
  dispose()
  assert.equal(off, 3)
  assert.equal(client.runtime.listeners.size, 0)
})
