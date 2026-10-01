import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = process.cwd()
const clientPath = resolve(root, 'Data/DSH/profiles/web/local/dsh-custom-spaces/lib/client.js')
const pointerPath = resolve(root, 'Data/Runtime/Harness/current.json')
type Space = { name: string; url: string; enabled: boolean }
type View = { writable: boolean; namespaces: { ns: string; value: { spaces: Space[] }; revision: number; schema: object }[] }
type Element = { type: string; props: Record<string, any>; children: unknown[] }
const saved: Space[] = [
  { name: 'Saved space', url: 'https://example.invalid/one', enabled: true },
  { name: 'Hidden space', url: 'https://example.invalid/two', enabled: false },
]
const makeView = (writable = true, spaces = saved): View => ({
  writable, namespaces: [{ ns: 'custom-spaces', value: { spaces }, revision: 1, schema: {} }],
})

// Only the controller is extracted from the ACTIVE runtime. No host/bootstrap,
// network, real settings, DOM, UI refresh, or TypeScript compiler API is used.
function createRig(controllerSource: string, initial: View | null = makeView()) {
  let view: View | undefined = initial ?? undefined
  const mirrorListeners = new Set<() => void>()
  const storeListeners = new Set<() => void>()
  const writes: { namespace: string; ops: any[]; revision: number }[] = []
  const stats = { subscriptions: 0, unsubscriptions: 0 }
  const publish = (next: View | undefined) => {
    view = next
    for (const listener of mirrorListeners) listener()
  }
  const mirror = {
    getSnapshot: () => ({ view }),
    subscribe(listener: () => void) { mirrorListeners.add(listener); return () => mirrorListeners.delete(listener) },
    acceptView: publish,
    load: async () => { throw new Error('Unexpected recovery: no host access allowed') },
  }
  const context = vm.createContext({
    structuredClone,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    _deepseek_ai_dsh_client_store: {
      createSnapshotStore(initialSnapshot: any) {
        let snapshot = initialSnapshot
        return {
          getSnapshot: () => snapshot,
          subscribe(listener: () => void) {
            stats.subscriptions++
            storeListeners.add(listener)
            return () => { stats.unsubscriptions++; storeListeners.delete(listener) }
          },
          update(fn: (draft: any) => void) {
            snapshot = { ...snapshot }
            fn(snapshot)
            for (const listener of storeListeners) listener()
          },
        }
      },
    },
  })
  const Controller = vm.runInContext(`${controllerSource}\nSettingsScopeController`, context)
  const scope = new Controller({ remote: { settings: {
    async mutate(namespace: string, ops: any[], revision: number) {
      writes.push({ namespace, ops, revision })
      assert.equal(namespace, 'custom-spaces')
      assert.equal(ops[0].op, 'set')
      assert.equal(ops[0].path.join('.'), 'spaces')
      const next = makeView(true, ops[0].value)
      next.namespaces[0].revision = revision + 1
      return { ok: true, value: next }
    },
  } } }, { namespace: 'custom-spaces' }, mirror, 'host', { validate() {}, rehydrate: (x: unknown) => x })
  return { scope, writes, stats, publish, storeListeners, mirrorListeners }
}

// Minimal hook contract driver, not a substitute for the main agent's React UI
// acceptance. Functions are deliberately called unbound, as React calls them.
function mount(source: string, scope: any, slot: string) {
  let cursor = 0
  let notifications = 0
  const hooks: any[] = []
  const entries = new Map<string, { component: (props: any) => Element; options: any }>()
  const react = {
    createElement: (type: string, props: any, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    useCallback(fn: (...args: any[]) => any, deps: unknown[]) {
      const index = cursor++
      const old = hooks[index]
      if (!old || deps.some((dep, i) => dep !== old.deps[i])) hooks[index] = { fn, deps }
      return hooks[index].fn
    },
    useState(initial: unknown) {
      const index = cursor++
      hooks[index] ??= { value: initial }
      return [hooks[index].value, (value: unknown) => { hooks[index].value = value }]
    },
    useSyncExternalStore(subscribe: (fn: () => void) => () => void, getSnapshot: () => any) {
      const snapshot = getSnapshot()
      const index = cursor++
      if (hooks[index]?.subscribe !== subscribe) {
        hooks[index]?.off()
        hooks[index] = { subscribe, off: subscribe(() => { notifications++ }) }
      }
      return snapshot
    },
    useRef(initial: unknown) {
      const index = cursor++
      hooks[index] ??= { current: initial }
      return hooks[index]
    },
    useEffect(fn: () => (() => void) | undefined, _deps?: unknown[]) {
      const index = cursor++
      const old = hooks[index]
      if (old?.cleanup) old.cleanup()
      hooks[index] = { cleanup: fn() || null }
    },
  }
  const ctx = {
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    effect: (fn: () => unknown) => fn(),
    settingsScope: { bind: () => scope },
    inject() {},
    slots: {
      inject: (_name: string, fn: () => unknown) => fn(),
      register: (options: any, component: (props: any) => Element) => {
        entries.set(options.name, { options, component }); return () => {}
      },
    },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (definition: any) => definition.factory((name: string) => {
      assert.equal(name, 'react'); return react
    }).apply(ctx) } },
    document: { querySelector: () => ({}) },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
  const entry = entries.get(slot)
  assert.ok(entry, `Missing slot ${slot}`)
  return {
    render: () => { cursor = 0; return entry.component(entry.options.inject()) },
    unmount: () => { for (const hook of hooks) hook?.off?.() },
    notifications: () => notifications,
  }
}

function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object' || !('type' in tree)) return []
  const node = tree as Element
  return [node, ...node.children.flatMap(elements)]
}
function controls(tree: Element) {
  return elements(tree).filter(node => node.type === 'input' || node.type === 'button')
}
function invoke(node: Element) {
  if (node.props.onChange) node.props.onChange({ target: { value: 'Edited', checked: false } })
  else node.props.onClick()
}

test('custom spaces: actual active SettingsScopeController isolation', async t => {
  if (!existsSync(clientPath) || !existsSync(pointerPath)) return t.skip('实机 Data 产物缺失（CI 全新检出）')
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
  const runtimePath = resolve(root, 'Data/Runtime', pointer.current.relativePath,
    'node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js')
  if (!existsSync(runtimePath)) return t.skip('实机 settings runtime 缺失')
  const runtime = readFileSync(runtimePath, 'utf8').replace(/\r\n/g, '\n')
  const anchor = 'var SettingsScopeController = class {'
  assert.equal(runtime.split(anchor).length, 2, 'Controller extraction anchor must be unique')
  const start = runtime.indexOf(anchor)
  const end = runtime.indexOf('\n\t\t};', start)
  assert.ok(end > start, 'Controller end anchor must exist')
  const controller = runtime.slice(start, end + 6)
  const source = readFileSync(clientPath, 'utf8')
  const slots = ['sidebar.footer.action', 'settings.section']

  await t.test('negative control: old unbound hook reproduces store crash in both slots', async () => {
    assert.equal(source.split('const snapshot = useScopeSnapshot(scope);').length, 3)
    const beforePath = process.env.DSH_CUSTOM_SPACES_BEFORE_CLIENT
    const old = beforePath ? readFileSync(beforePath, 'utf8')
      : source.replaceAll('const snapshot = useScopeSnapshot(scope);',
        'const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot);')
    const rig = createRig(controller)
    try {
      for (const slot of slots) {
        const app = mount(old, rig.scope, slot)
        assert.throws(app.render, /Cannot read properties of undefined \(reading 'store'\)/)
        app.unmount()
      }
      assert.equal(rig.writes.length, 0)
    } finally { await rig.scope.dispose() }
  })

  await t.test('saved values render, hidden entries stay hidden, subscriptions are stable and cleaned', async () => {
    const rig = createRig(controller)
    const footer = mount(source, rig.scope, slots[0])
    const settings = mount(source, rig.scope, slots[1])
    try {
      assert.match(JSON.stringify(footer.render()), /Saved space/)
      assert.doesNotMatch(JSON.stringify(footer.render()), /Hidden space/)
      assert.deepEqual(controls(settings.render()).filter(n => n.props.placeholder === 'name').map(n => n.props.value), saved.map(s => s.name))
      settings.render()
      assert.equal(rig.stats.subscriptions, 2)
      rig.publish(makeView(true, [{ ...saved[0], name: 'Changed in mirror' }]))
      assert.equal(footer.notifications(), 1)
      assert.equal(settings.notifications(), 1)
      assert.match(JSON.stringify(footer.render()), /Changed in mirror/)
      assert.equal(rig.writes.length, 0)
    } finally {
      footer.unmount(); settings.unmount(); await rig.scope.dispose()
      assert.equal(rig.stats.unsubscriptions, 2)
      assert.equal(rig.storeListeners.size + rig.mirrorListeners.size, 0)
    }
  })

  for (const status of ['loading', 'unavailable', 'readonly']) {
    await t.test(`${status}: controls disabled and direct callbacks cannot write`, async () => {
      const active = createRig(controller, status === 'loading' ? null
        : status === 'readonly' ? makeView(false) : { writable: true, namespaces: [] })
      assert.equal(active.scope.getSnapshot().status, status === 'readonly' ? 'ready' : status)
      const app = mount(source, active.scope, slots[1])
      try {
        const nodes = controls(app.render())
        assert.ok(nodes.length > 0)
        for (const node of nodes) { assert.equal(node.props.disabled, true); invoke(node) }
        await new Promise(r => setTimeout(r, 500))
        await active.scope.tail
        assert.equal(active.writes.length, 0)
      } finally { app.unmount(); await active.scope.dispose() }
    })
  }

  await t.test('readonly transition blocks stale ready callbacks; ready edit preserves other spaces', async () => {
    const rig = createRig(controller)
    const app = mount(source, rig.scope, slots[1])
    try {
      const oldControls = controls(app.render())
      rig.publish(makeView(false))
      for (const node of oldControls) invoke(node)
      await new Promise(r => setTimeout(r, 500))
      await rig.scope.tail
      assert.equal(rig.writes.length, 0)
      rig.publish(makeView())
      const name = controls(app.render()).find(node => node.props.placeholder === 'name')!
      assert.equal(name.props.disabled, false)
      invoke(name)
      await new Promise(r => setTimeout(r, 500))
      await rig.scope.tail
      assert.equal(rig.writes.length, 1)
      assert.equal(rig.writes[0].revision, 1)
      assert.deepEqual(rig.writes[0].ops[0].value, [{ ...saved[0], name: 'Edited' }, saved[1]])
      assert.match(JSON.stringify(app.render()), /saved/)
    } finally { app.unmount(); await rig.scope.dispose() }
  })
})
