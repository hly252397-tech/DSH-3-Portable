import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const plugin = (...parts: string[]): string =>
  join(process.cwd(), 'Data', 'DSH', 'profiles', 'web', 'local', 'dsh-work-mode', ...parts)

/** 让串行化的 storage 写盘链（Promise 链）跑完，再断言最终落盘值。 */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 与 @deepseek-ai/dsh-storage 一致：存储域单元名只允许小写字母/数字/下划线。 */
const haveLiveWorkMode = existsSync(join(process.cwd(), 'Data', 'DSH', 'profiles', 'web', 'local', 'dsh-work-mode', 'lib', 'index.js'))

const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

// ---------------------------------------------------------------------------
// 宿主侧（lib/index.js）
// ---------------------------------------------------------------------------

type WorkModeHost = {
  name: string
  inject: string[]
  normalizeWorkMode(value: unknown): string
  apply(ctx: Record<string, unknown>, config?: { defaultMode?: string; recordSessionMode?: boolean }): Promise<void>
}

async function loadHost(): Promise<WorkModeHost> {
  return import(pathToFileURL(plugin('lib', 'index.js')).href) as Promise<WorkModeHost>
}

test('work-mode host plugin exposes the named plugin and only mounts declared services', async t => {
  if (!haveLiveWorkMode) return t.skip('实机 dsh-work-mode 插件缺失（CI 全新检出）')
  const host = await loadHost()
  assert.equal(host.name, 'dsh-work-mode')
  assert.deepEqual(host.inject, ['sessions', 'settings', 'storageDomain', 'webServer'])
})

test('normalizeWorkMode collapses unknown values to coding', async t => {
  if (!haveLiveWorkMode) return t.skip('实机 dsh-work-mode 插件缺失（CI 全新检出）')
  const host = await loadHost()
  assert.equal(host.normalizeWorkMode('coding'), 'coding')
  assert.equal(host.normalizeWorkMode('general'), 'general')
  assert.equal(host.normalizeWorkMode('bogus'), 'coding')
  assert.equal(host.normalizeWorkMode(undefined), 'coding')
})

type HostRecorder = {
  namespace: string
  base: Record<string, unknown>
  spec: { name: string; version: number; global?: { schema: unknown } }
  closed: boolean
  writes: Array<Record<string, unknown>>
  on: Record<string, (payload: unknown) => void>
  routes: Array<{ kind: string; path: string; handler: (req: any, res: any) => void }>
}

async function applyHost(config: { defaultMode: string; recordSessionMode?: boolean }, existing: Array<{ id: string }>) {
  const host = await loadHost()
  const recorder: HostRecorder = { namespace: '', base: {}, spec: { name: '', version: 0 }, closed: false, writes: [], on: {}, routes: [] }
  const domain = {
    global: {
      get: () => undefined,
      set: async (value: Record<string, unknown>) => { recorder.writes.push(value) },
    },
    close: () => { recorder.closed = true },
  }
  const disposers: Array<() => void> = []
  const ctx = {
    settings: {
      installSection(_owner: unknown, ns: string, _schema: unknown, base: Record<string, unknown>, hooks: { setSource: (v: unknown) => void; onChange: () => void }) {
        recorder.namespace = ns
        recorder.base = base
        hooks.setSource(() => config)
        hooks.onChange()
      },
    },
    storageDomain: { open: async (spec: { name: string; version: number; global?: { schema: unknown } }) => { recorder.spec = spec; return domain } },
    effect: (factory: () => () => void) => { disposers.push(factory()) },
    on: (event: string, handler: (payload: unknown) => void) => { recorder.on[event] = handler },
    sessions: { list: () => existing },
    webServer: { register: (entry: { kind: string; path: string; handler: (req: any, res: any) => void }) => { recorder.routes.push(entry); return () => {} } },
  }
  await host.apply(ctx, config)
  return { recorder, disposers }
}

test('apply installs the work-mode settings namespace and records session modes after commit', async t => {
  if (!haveLiveWorkMode) return t.skip('实机 dsh-work-mode 插件缺失（CI 全新检出）')
  const { recorder, disposers } = await applyHost({ defaultMode: 'general', recordSessionMode: true }, [{ id: 's0' }])
  assert.equal(recorder.namespace, 'work-mode')
  assert.equal(recorder.spec.name, 'work_mode')
  assert.ok(UNIT_NAME_RE.test(recorder.spec.name), 'storage domain name must match UNIT_NAME_RE (underscores, no hyphens)')
  assert.equal(recorder.spec.version, 1)
  assert.ok(recorder.spec.global?.schema, 'domain spec must carry a global schema')
  // 历史会话补种为编程档
  await drain()
  assert.deepEqual(recorder.writes.at(-1), { sessionModes: { s0: 'coding' } })
  // 新建会话按当前档位记录
  const created = recorder.on['session/created']
  assert.equal(typeof created, 'function')
  created({ id: 's1' })
  await drain()
  assert.deepEqual(recorder.writes.at(-1), { sessionModes: { s0: 'coding', s1: 'general' } })
  // 生命周期结束后关闭存储域
  for (const dispose of disposers) dispose()
  assert.equal(recorder.closed, true)
})

test('disabling recording only stops tagging new sessions, seeding still classifies existing ones', async t => {
  if (!haveLiveWorkMode) return t.skip('实机 dsh-work-mode 插件缺失（CI 全新检出）')
  const { recorder } = await applyHost({ defaultMode: 'coding', recordSessionMode: false }, [{ id: 's0' }])
  await drain()
  // 补种历史会话为编程档是「历史默认归入编程」的一部分，与开关无关
  assert.deepEqual(recorder.writes.at(-1), { sessionModes: { s0: 'coding' } })
  const created = recorder.on['session/created']
  created({ id: 's1' })
  await drain()
  assert.equal(recorder.writes.length, 1, 'recording off must not tag new sessions')
})

test('host exposes a read-only session-modes route gated by same-origin and method', async t => {
  if (!haveLiveWorkMode) return t.skip('实机 dsh-work-mode 插件缺失（CI 全新检出）')
  const { recorder, disposers } = await applyHost({ defaultMode: 'coding', recordSessionMode: true }, [{ id: 's0' }])
  const route = recorder.routes.find((r) => r.kind === 'exact' && r.path === '/work-mode/api/session-modes')
  assert.ok(route, 'session-modes route must be registered via webServer')
  const res = (): any => ({ statusCode: 0, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v }, end(payload: string) { this.body = payload } })
  // 可信同源 GET → 200 + 快照（含补种的历史会话 s0=coding）
  const trusted = res()
  route!.handler({ method: 'GET', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }, trusted)
  assert.equal(trusted.statusCode, 200)
  assert.equal(trusted.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(trusted.body), { ok: true, value: { sessionModes: { s0: 'coding' } } })
  // 不可信来源 → 403
  const foreign = res()
  route!.handler({ method: 'GET', headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } }, foreign)
  assert.equal(foreign.statusCode, 403)
  // 非 GET → 405
  const post = res()
  route!.handler({ method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }, post)
  assert.equal(post.statusCode, 405)
  // 只读：路由不改内存 Map，落盘写次数不受请求影响
  await drain()
  assert.equal(recorder.writes.length, 1, 'route must be read-only (no extra writes)')
  for (const dispose of disposers) dispose()
})

// ---------------------------------------------------------------------------
// 客户端侧（lib/client.js）
// ---------------------------------------------------------------------------

type ClientModule = {
  inject: string[]
  readWorkMode(snapshot: unknown): string
  isSwitchable(snapshot: unknown): boolean
  isRecording(snapshot: unknown): boolean
  apply(ctx: Record<string, unknown>): void
}

function element(tag: string): any {
  const node: any = {
    tag, children: [], style: {}, dataset: {}, listeners: {}, attrs: {},
    className: '', textContent: '', type: '', value: '', disabled: false, checked: false,
    isConnected: false, parentElement: null,
    setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); this[k] = String(v) },
    getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null },
    removeAttribute(k: string) { delete this.attrs[k]; delete this[k] },
    append(child: any) { this.children.push(child); child.parentElement = this; child.isConnected = true },
    prepend(child: any) { this.children.unshift(child); child.parentElement = this; child.isConnected = true },
    insertBefore(el: any, ref: any) {
      const i = ref ? this.children.indexOf(ref) : -1
      if (i < 0) this.children.push(el); else this.children.splice(i, 0, el)
      el.parentElement = this; el.isConnected = true
    },
    remove() {
      this.isConnected = false
      const parent = this.parentElement
      if (parent) {
        const i = parent.children.indexOf(this)
        if (i >= 0) parent.children.splice(i, 1)
        this.parentElement = null
      }
    },
    addEventListener(evt: string, fn: (...args: unknown[]) => void) { this.listeners[evt] = fn },
  }
  Object.defineProperty(node, 'previousElementSibling', {
    get() {
      const p = this.parentElement
      if (!p) return null
      const i = p.children.indexOf(this)
      return i > 0 ? p.children[i - 1] : null
    },
  })
  Object.defineProperty(node, 'nextSibling', {
    get() {
      const p = this.parentElement
      if (!p) return null
      const i = p.children.indexOf(this)
      return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null
    },
  })
  return node
}

async function clientModule() {
  const source = await readFile(plugin('lib', 'client.js'), 'utf8')
  let module: ClientModule | undefined
  const requireMock = (name: string) => {
    if (name === 'react') {
      return {
        createElement: (type: string, props: unknown, ...children: unknown[]) => ({ type, props, children }),
        useState: (initial: unknown) => [initial, () => {}],
        useSyncExternalStore: (_subscribe: () => void, getSnapshot: () => unknown) => getSnapshot(),
      }
    }
    throw new Error(`unexpected require: ${name}`)
  }
  runInNewContext(source, {
    window: {
      __ModuleLoader__: { load(def: { factory: (require: (n: string) => unknown) => ClientModule }) { module = def.factory(requireMock) } },
      localStorage: { getItem: () => null, setItem: () => {} },
    },
    document: {
      createElement: element,
      querySelector: () => null,
      querySelectorAll: () => [],
      head: { appendChild: () => {} },
      body: { setAttribute() {}, removeAttribute() {} },
    },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: () => Promise.reject(new Error('no network')),
    console, setTimeout, clearTimeout,
  })
  assert.ok(module, 'client factory must return a module')
  return module!
}

test('client injects only mounted services and owns dictionary and settings wiring', async t => {
  if (!haveLiveWorkMode) return t.skip('实机 dsh-work-mode 插件缺失（CI 全新检出）')
  const client = await clientModule()
  assert.deepEqual(Array.from(client.inject), ['locale', 'settingsScope', 'slots'])

  const registered: Record<string, Record<string, string>> = { zh: {}, en: {} }
  const bound: unknown[] = []
  const slots: Array<Record<string, unknown>> = []
  const scope = { getSnapshot: () => ({}), subscribe: () => () => {}, set: async () => {} }
  const ctx = {
    effect: (factory: () => () => void) => { factory() },
    locale: {
      register: (ns: string, d: Record<string, Record<string, string>>) => { registered.zh = d.zh; registered.en = d.en },
      bind: (ns: string) => { bound.push(ns); return (key: string) => key },
    },
    settingsScope: { bind: (opts: { namespace: string }) => { bound.push(opts); return scope } },
    slots: {
      inject: (slot: string, fn: () => unknown) => { bound.push(slot); bound.push(fn()) },
      register: (def: Record<string, unknown>) => { slots.push(def); return def },
    },
  }
  client.apply(ctx)

  const zh = registered.zh, en = registered.en
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'dictionaries must share keys')
  for (const key of Object.keys(zh)) assert.ok(zh[key] && en[key], `dictionary key ${key} must be non-empty in both locales`)

  const registration = slots[0]
  assert.equal(bound[0], 'work-mode')
  assert.equal((bound[1] as { namespace: string }).namespace, 'work-mode')
  assert.equal(bound[2], 'settings.section')
  assert.equal(bound[3], registration)
  assert.equal(registration.id, 'work-mode')
  assert.equal(registration.order, 18)
  assert.equal(registration.locale, 'work-mode')
  assert.equal(typeof registration.inject, 'function')
  const injected = (registration.inject as () => Record<string, unknown>)()
  assert.equal(injected.scope, scope)
  assert.equal(typeof injected.t, 'function', 'settings.section inject must pass locale translator t to WorkModeSection')
})

test('client pure helpers read mode and switchability without side effects', async t => {
  if (!haveLiveWorkMode) return t.skip('实机 dsh-work-mode 插件缺失（CI 全新检出）')
  const client = await clientModule()
  assert.equal(client.readWorkMode(undefined), 'coding')
  assert.equal(client.readWorkMode({ value: { defaultMode: 'general' } }), 'general')
  assert.equal(client.readWorkMode({ value: {} }), 'coding')
  assert.equal(client.isSwitchable({ status: 'ready', writable: true }), true)
  assert.equal(client.isSwitchable({ status: 'ready', writable: false }), false)
  assert.equal(client.isSwitchable(undefined), false)
  assert.equal(client.isRecording(undefined), true)
  assert.equal(client.isRecording({ value: { recordSessionMode: false } }), false)
})

test('retired sidebar controls clear stale filters without deleting sessions or changing settings', async t => {
  if (!haveLiveWorkMode) return t.skip('实机 dsh-work-mode 插件缺失（CI 全新检出）')
  const source = await readFile(plugin('lib', 'client.js'), 'utf8')
  const body = element('body')
  body.setAttribute('data-dsh-work-mode', 'general')
  body.setAttribute('data-dsh-work-mode-filter', 'general')
  const controls = [element('switch'), element('filter'), element('error')]
  controls.forEach(node => body.append(node))
  const rows = [element('coding-session'), element('general-session')]
  rows.forEach((node, i) => { node.setAttribute('data-session-mode', i ? 'general' : 'coding'); body.append(node) })
  const storage = new Map([['dsh-work-mode:filter', 'general'], ['unrelated', 'preserved']])
  const settings = { defaultMode: 'general', recordSessionMode: true }
  const registrations: string[] = []
  let client: ClientModule | undefined
  const styles: any[] = []
  runInNewContext(source, {
    window: {
      __ModuleLoader__: { load(def: any) { client = def.factory(() => ({ createElement() {} })) } },
      localStorage: { removeItem: (key: string) => storage.delete(key) },
    },
    document: {
      body, createElement: element,
      querySelector: () => styles[0] ?? null,
      querySelectorAll: (selector: string) => selector.includes('.dwm-switch')
        ? controls.filter(node => node.isConnected)
        : rows.filter(node => node.getAttribute('data-session-mode') !== null),
      head: { appendChild: (node: any) => styles.push(node) },
    },
    MutationObserver: class { constructor() { assert.fail('removed filters must not observe sessions') } },
    fetch: () => assert.fail('removed filters must not fetch session modes'),
  })
  const ctx = {
    effect: (factory: () => unknown) => factory(),
    locale: { register() {}, bind: () => (key: string) => key },
    settingsScope: { bind: () => ({ getSnapshot: () => ({ value: settings }), set: () => assert.fail('cleanup must not write settings') }) },
    slots: { inject: (name: string, factory: () => unknown) => { registrations.push(name); factory() }, register: (def: unknown) => def },
  }
  client!.apply(ctx)
  client!.apply(ctx)
  assert.deepEqual(body.children, rows, 'both session rows survive repeated cleanup')
  assert.equal(body.getAttribute('data-dsh-work-mode'), null)
  assert.equal(body.getAttribute('data-dsh-work-mode-filter'), null)
  assert.ok(rows.every(node => node.getAttribute('data-session-mode') === null))
  assert.equal(storage.has('dsh-work-mode:filter'), false)
  assert.equal(storage.get('unrelated'), 'preserved')
  assert.deepEqual(settings, { defaultMode: 'general', recordSessionMode: true })
  assert.deepEqual(registrations, ['settings.section', 'settings.section'])
  assert.equal(styles.length, 1)
  assert.doesNotMatch(styles[0].textContent, /data-dsh-work-mode-filter|\.dwm-switch|\.dwm-filter/)
})
