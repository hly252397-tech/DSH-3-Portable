import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

function rig(path: string) {
  const registrations: any[] = [], requests: any[] = [], effects: (() => void)[] = [], opened: any[] = []
  const hooks: any[] = []
  let cursor = 0
  const react = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children: children.flat() }),
    useCallback: (fn: any) => fn,
    useState: (initial: any) => { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (v: any) => { hooks[i] = v }] },
    useRef: (initial: any) => ({ current: initial }),
    useEffect: (fn: any) => effects.push(fn),
    useSyncExternalStore: (_subscribe: any, get: any) => get(),
  }
  let plugin: any
  vm.runInNewContext(readFileSync(path, 'utf8'), {
    window: { __ModuleLoader__: { load: (spec: any) => { plugin = spec.factory(() => react) } }, open: (url: string) => opened.push(url) },
    document: { querySelector: () => ({}) }, console,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    fetch: async (url: any, options: any) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true, running: true, url: 'http://127.0.0.1:8975/index.html', dir: 'G:/site', port: 8975 }) } },
  })
  const scope = { getSnapshot: () => ({ status: 'ready', writable: true, value: { spaces: [] } }), subscribe: () => () => {} }
  plugin.apply({
    effect: (fn: any) => fn(), inject: () => {}, configForms: { get: () => scope },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: { inject: (name: string, fn: any) => { fn() }, register: (options: any, component: any) => { registrations.push({ options, component }); return () => {} } },
  })
  const render = (id: string, renderSlot = (_name: string, _owner: any): any => null) => {
    cursor = 0; const row = registrations.find(r => r.options.id === id)
    return row.component({ ...row.options.inject(), renderSlot })
  }
  return { registrations, requests, effects, opened, render }
}
const flatten = (node: any): any[] => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(flatten)] : []

test('workbench contributes its service card under spaces, not a second settings navigation entry', () => {
  const spaces = rig('customizations/custom-spaces/lib/client.js')
  const workbench = rig('customizations/hj-workbench/lib/client.js')
  const menu = [...spaces.registrations, ...workbench.registrations].filter(r => r.options.name === 'settings.section')
  assert.deepEqual(menu.map(r => r.options.id), ['custom-spaces'])
  const before = 'customizations/audit-fixes/20260927/spaces-service-merge/workbench-before.js'
  if (existsSync(before)) {
    const oldMenu = [...spaces.registrations, ...rig(before).registrations].filter(r => r.options.name === 'settings.section')
    assert.deepEqual(oldMenu.map(r => r.options.id), ['custom-spaces', 'hj-workbench'])
  }
  const service = workbench.registrations.find(r => r.options.id === 'hj-workbench')
  assert.equal(service.options.name, 'custom-spaces.services')
  const calls: string[] = []
  const nodes = flatten(spaces.render('custom-spaces', name => { calls.push(name); return workbench.render('hj-workbench') }))
  assert.deepEqual(calls, ['custom-spaces.services'])
  for (const key of ['add', 'wake', 'probe', 'open']) assert.ok(nodes.some(n => n.type === 'button' && n.children.includes(key)))
  assert.ok(flatten(spaces.render('custom-spaces')).some(n => n.type === 'button' && n.children.includes('add')))
})

test('moved service controls retain status GET and wake POST and opening behavior', async () => {
  const workbench = rig('customizations/hj-workbench/lib/client.js')
  let nodes = flatten(workbench.render('hj-workbench'))
  nodes.find(n => n.type === 'button' && n.children.includes('probe')).props.onClick()
  await new Promise(done => setImmediate(done))
  assert.equal(workbench.requests[0].url, '/api/dsh-hj-workbench/status')
  assert.equal(workbench.requests[0].options.method, 'GET')
  nodes = flatten(workbench.render('hj-workbench'))
  assert.equal(nodes.find(n => n.type === 'button' && n.children.includes('open')).props.disabled, false)
  await nodes.find(n => n.type === 'button' && n.children.includes('wake')).props.onClick()
  assert.equal(workbench.requests[1].url, '/api/dsh-hj-workbench/wake')
  assert.equal(workbench.requests[1].options.method, 'POST')
  assert.equal(workbench.opened.length, 1)
})

test('real SlotCore accepts child ownership and cascades cleanup without losing the parent form', async t => {
  const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))
  const file = runtime && resolve(runtime, 'node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js')
  if (!file || !existsSync(file)) return t.skip('Installed SlotCore absent')
  const { SlotCore } = await import(pathToFileURL(file).href)
  const core = new SlotCore()
  core.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'global' }, 'sidebar.footer.action': { kind: 'list', scope: 'global' } } }, () => null)
  const parent = rig('customizations/custom-spaces/lib/client.js').registrations.find(r => r.options.id === 'custom-spaces')
  const child = rig('customizations/hj-workbench/lib/client.js').registrations.find(r => r.options.id === 'hj-workbench')
  assert.throws(() => core.register(child.options, child.component), /declar|slot/i)
  const disposeParent = core.register(parent.options, parent.component)
  assert.equal(core.entries('custom-spaces.services').length, 0)
  const disposeChild = core.register(child.options, child.component)
  assert.equal(core.entries('settings.section').length, 1)
  assert.equal(core.entries('custom-spaces.services').length, 1)
  disposeChild()
  assert.equal(core.entries('settings.section').length, 1)
  core.register(child.options, child.component)
  disposeParent()
  assert.equal(core.entries('custom-spaces.services').length, 0)
  assert.equal(core.specDynamic('custom-spaces.services'), undefined)
  core.register(parent.options, parent.component)
  core.register(child.options, child.component)
  assert.equal(core.entries('custom-spaces.services').length, 1)
})
