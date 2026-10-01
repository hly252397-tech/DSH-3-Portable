import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import { DESKTOP_SETTINGS_METHODS, embeddedDesktopSettingsDocument, mayUseEmbeddedDesktopSettings, parseDesktopSettingsRequest } from '../src/embedded-desktop-settings.js'
import { desktopBridgeClientBundle } from '../src/desktop-bridge-client-source.js'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

const document = (): string => embeddedDesktopSettingsDocument(...(['settings.html', 'theme.css', 'theme.js', 'shell-icons/chevron-down.svg'].map(name => readFileSync(`assets/${name}`, 'utf8')) as [string, string, string, string]))

test('embedded settings require active DSH main frame and exact origin', () => {
  assert.equal(mayUseEmbeddedDesktopSettings('dsh', true, 'http://127.0.0.1:51022/path', 'http://127.0.0.1:51022'), true)
  for (const [kind, mainFrame, url, origin] of [
    ['unknown', true, 'http://127.0.0.1:51022', 'http://127.0.0.1:51022'],
    ['dsh', false, 'http://127.0.0.1:51022', 'http://127.0.0.1:51022'],
    ['dsh', true, 'http://evil.test', 'http://127.0.0.1:51022'],
    ['dsh', true, 'http://127.0.0.1:51023', 'http://127.0.0.1:51022'],
    ['dsh', true, 'file:///startup.html', undefined], ['dsh', true, 'invalid', 'http://127.0.0.1:51022'],
  ] as const) assert.equal(mayUseEmbeddedDesktopSettings(kind, mainFrame, url, origin), false)
})

test('embedded bridge exposes only settings methods, rejects malformed and arbitrary capabilities', () => {
  for (const method of DESKTOP_SETTINGS_METHODS) assert.equal(parseDesktopSettingsRequest({ method }).method, method)
  for (const value of [null, [], 'getBootstrap', {}, { method: 'action' }, { method: '__proto__' }, { method: 'constructor' },
    { method: 'browserPanelExecuteJs' }, { method: 'getBootstrap', path: 'G:/' }]) assert.throws(() => parseDesktopSettingsRequest(value))
})

test('embedded document reuses original business script and has no external assets', () => {
  const html = document()
  const original = readFileSync('assets/settings.html', 'utf8')
  const businessScript = [...original.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!
  assert.ok(html.includes(businessScript))
  assert.doesNotMatch(html, /(?:src|href)="(?:theme|shell-icons)/)
  assert.doesNotMatch(html, /<(?:img|script)\b[^>]*\ssrc="(?!data:)/)
  assert.match(html, /default-src 'none'/)
  assert.match(html, /event.source!==parent/)
  assert.match(html, /themePreset/)
  assert.match(html, /body\{display:flex;flex-direction:column\}/)
  assert.match(html, /aside \.nav-item\{width:auto;flex:0 1 auto\}/, 'Override the original class width at desktop sizes too')
  const apiMethods = [...original.matchAll(/api\.([A-Za-z]+)\(/g)].map(m => m[1])
  for (const method of apiMethods) assert.ok([...DESKTOP_SETTINGS_METHODS, 'closeDesktopSettings', 'onBootstrap', 'onDesktopUpdateState', 'onHarnessUpdateState', 'onSettingsSection'].includes(method! as any), method)
})

test('runtime settings describe the actual activation safety gate without promising hot rollback', () => {
  const html = document()
  assert.match(html, /data-value="safe-auto"/)
  assert.match(html, /自动下载并验证/)
  assert.match(html, /正式激活仍受安全门禁保护/)
  assert.match(html, /Activation remains safety-gated/)
  assert.match(html, /检查并验证候选/)
  assert.match(html, /安全激活尚未完成/)
  assert.doesNotMatch(html, /仅在任务空闲时切换；失败自动回滚|switched only while idle, and rolled back automatically/)
})

interface SettingsSlotRegistry {
  register(options: any, component: any): () => void
  entries(name: string): any[]
  entriesOfSlot(name: string): any[]
}

function clientRig(fail = false, options: { bundle?: string; slots?: SettingsSlotRegistry } = {}) {
  const hooks: any[] = [], effects: (() => () => void)[] = [], requests: any[] = [], registrations: any[] = [], replies: any[] = []
  const effectDependencies: unknown[][] = [], injectedDisposers: (() => void)[] = []
  const listeners = new Map<string, any>()
  let cursor = 0, stopped = 0, dictionariesStopped = 0, broadcast: any, plugin: any
  const react = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }),
    useState: (initial: any) => { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (value: any) => { hooks[i] = value }] },
    useRef: (initial: any) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i] },
    useEffect: (effect: any, dependencies: unknown[]) => {
      const i = cursor++, previous = effectDependencies[i]
      if (previous === undefined || previous.length !== dependencies.length || dependencies.some((value, index) => value !== previous[index])) {
        effectDependencies[i] = dependencies
        effects.push(effect)
      }
    },
  }
  const frameWindow = { postMessage: (value: any) => replies.push(value) }
  const timers = new Map<number, () => void>()
  let timerSequence = 0
  vm.runInNewContext(options.bundle ?? desktopBridgeClientBundle(), {
    setTimeout: (fn: () => void) => { const id = ++timerSequence; timers.set(id, fn); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
    window: {
      __ModuleLoader__: { load: (spec: any) => { plugin = spec.factory(() => react) } },
      addEventListener: (name: string, fn: any) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
      dshDesktopShell: { desktopSettings: {
        document: async () => { if (fail) throw new Error('missing document'); return document() },
        request: async (value: any) => { requests.push(value); return { ok: true } },
        onEvent: (fn: any) => { broadcast = fn; return () => { stopped++ } },
      } },
    },
  })
  plugin.apply({
    effect: (fn: any, label: string) => {
      if (label === 'desktop settings dictionary') injectedDisposers.push(fn())
    },
    locale: { register: () => () => { dictionariesStopped++ }, bind: () => (key: string) => key },
    slots: {
      inject: (_: any, fn: any) => { const dispose = fn(); if (typeof dispose === 'function') injectedDisposers.push(dispose) },
      register: (slotOptions: any, component: any) => {
        const dispose = options.slots?.register(slotOptions, component)
        const registration = { options: slotOptions, component }
        registrations.push(registration)
        return () => {
          dispose?.()
          const index = registrations.indexOf(registration)
          if (index !== -1) registrations.splice(index, 1)
        }
      },
    },
  })
  let closed = 0
  const close = () => { closed++ }
  return {
    registrations, requests, replies, effects, listeners, frameWindow,
    render: (index = 0) => { cursor = 0; return registrations[index].component({ close }) },
    renderGeneralItem: () => { cursor = 0; return registrations[2].component({}) },
    fireTimers: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()) },
    activeTimers: () => timers.size,
    event: (overrides: any = {}) => listeners.get('message')?.({ source: frameWindow, origin: 'null', data: { channel: 'dsh-desktop-settings-v1', id: 1, method: 'getBootstrap' }, ...overrides }),
    broadcast: (value: any) => broadcast(value), stopped: () => stopped, closed: () => closed,
    disposeRegistrations: () => { injectedDisposers.splice(0).reverse().forEach(dispose => dispose()) },
    dictionariesStopped: () => dictionariesStopped,
  }
}

const flatten = (node: any): any[] => node && typeof node === 'object'
  ? [node, ...(node.children ?? []).flatMap(flatten)] : []

function installedSlotCoreFile(): string | undefined {
  const directories = [resolve('node_modules'), resolve('runtime-dsh/node_modules')]
  if (existsSync(resolve('Data/Runtime/Harness/current.json'))) {
    directories.push(resolve(resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime')), 'node_modules'))
  }
  return directories.map(directory => resolve(directory, '@deepseek-ai/dsh-client-ui-slots/lib/index.js'))
    .find(file => existsSync(file))
}

async function settingsSlotCore(file: string): Promise<{ core: SettingsSlotRegistry; dispose: () => void; officialAppearance: () => unknown }> {
  const { SlotCore } = await import(pathToFileURL(file).href)
  const core: SettingsSlotRegistry = new SlotCore()
  const dispose = core.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'global' },
    'settings.general.item': { kind: 'list', scope: 'global' },
  } }, () => null)
  // ui-theme owns these rc.2 registrations (client.js); exercise the installed registry, not a duplicate-check mock.
  const officialAppearance = () => ({ type: 'official-appearance' })
  core.register({ name: 'settings.general.item', id: 'appearance', order: 10 }, officialAppearance)
  core.register({ name: 'settings.general.item', id: 'font-size', order: 11 }, () => ({ type: 'official-font-size' }))
  return { core, dispose, officialAppearance }
}

test('installed SlotCore combines split settings with official appearance and preserves official entries on disposal', async t => {
  const file = installedSlotCoreFile()
  if (file === undefined) return t.skip('Installed official SlotCore absent; pure client contract tests remain mandatory')
  const { core, dispose, officialAppearance } = await settingsSlotCore(file)
  try {
    const r = clientRig(false, { slots: core })
    assert.deepEqual(core.entriesOfSlot('settings.section').map(entry => entry.options.id), ['desktop-notifications', 'desktop-updates'])
    const rows = core.entriesOfSlot('settings.general.item')
    assert.deepEqual(rows.map(entry => entry.options.id), ['appearance', 'desktop-appearance', 'font-size'])
    assert.equal(rows[0].component, officialAppearance)
    assert.equal(rows[1].options.order, 10.5)
    assert.equal(rows[0].options.priority ?? 0, rows[1].options.priority ?? 0)
    assert.equal(rows[1].component, r.registrations[2].component)
    r.disposeRegistrations()
    assert.equal(core.entries('settings.section').length, 0)
    assert.deepEqual(core.entriesOfSlot('settings.general.item').map(entry => entry.options.id), ['appearance', 'font-size'])
    assert.equal(core.entriesOfSlot('settings.general.item')[0].component, officialAppearance)
    assert.equal(r.registrations.length, 0)
    assert.equal(r.dictionariesStopped(), 1)
    const reloaded = clientRig(false, { slots: core })
    assert.equal(core.entriesOfSlot('settings.general.item').length, 3)
    reloaded.disposeRegistrations()
  } finally { dispose() }
})

test('installed SlotCore rejects the former appearance ID collision at the same priority', async t => {
  const file = installedSlotCoreFile()
  if (file === undefined) return t.skip('Installed official SlotCore absent; pure client contract tests remain mandatory')
  const { core, dispose } = await settingsSlotCore(file)
  const accepted = desktopBridgeClientBundle()
  const before = accepted.replace(/\bid:\s*(['"])desktop-appearance\1/, "id: 'appearance'")
  assert.notEqual(before, accepted, 'The negative control must actually restore the former colliding ID')
  try {
    assert.throws(() => clientRig(false, { slots: core, bundle: before }), /already has an entry with id "appearance".*priority 0/)
    assert.deepEqual(core.entriesOfSlot('settings.general.item').map(entry => entry.options.id), ['appearance', 'font-size'])
  } finally { dispose() }
})

test('client registers split settings surfaces; validates frame, handles result/event and cleans up on unmount', async () => {
  const r = clientRig()
  // 2026-09-30 拆分：通知/更新是两个独立 settings.section，外观经 settings.general.item 嵌常规页
  assert.equal(r.registrations.length, 3)
  assert.equal(r.registrations[0].options.name, 'settings.section')
  assert.equal(r.registrations[0].options.id, 'desktop-notifications')
  assert.equal(r.registrations[1].options.id, 'desktop-updates')
  assert.equal(r.registrations[2].options.name, 'settings.general.item')
  assert.equal(r.registrations[2].options.id, 'desktop-appearance')
  assert.equal(r.registrations[2].options.order, 10.5)
  assert.equal(r.render().props.role, 'status')
  const dispose = r.effects[0]!()
  await new Promise(done => setImmediate(done))
  const frame = r.render()
  assert.equal(frame.type, 'iframe'); assert.equal(frame.props.sandbox, 'allow-scripts')
  assert.equal(frame.props.title, 'notifications')
  frame.props.ref.current = { contentWindow: r.frameWindow }
  r.fireTimers()
  assert.equal(r.replies.at(-1)?.event, 'settingsSection')
  assert.equal(r.replies.at(-1)?.value, 'notifications')
  r.event({ source: {} }); r.event({ origin: 'http://foreign.test' }); r.event({ data: null })
  assert.equal(r.requests.length, 0)
  r.event({ data: { channel: 'dsh-desktop-settings-v1', id: 2, method: 'browserPanelExecuteJs' } })
  assert.equal(r.requests.length, 0); assert.match(r.replies.at(-1).error, /Unknown/)
  r.event(); await new Promise(done => setImmediate(done))
  assert.equal(r.requests[0].method, 'getBootstrap'); assert.equal(r.replies.at(-1).value.ok, true)
  r.broadcast({ event: 'desktopUpdateState', value: { status: { kind: 'ready' } } })
  assert.equal(r.replies.at(-1).event, 'desktopUpdateState')
  r.event({ data: { channel: 'dsh-desktop-settings-v1', id: 3, method: 'close' } })
  assert.equal(r.closed(), 1)
  dispose(); assert.equal(r.stopped(), 1); assert.equal(r.listeners.size, 0)
  const count = r.replies.length; r.broadcast({ event: 'bootstrap', value: {} }); assert.equal(r.replies.length, count)
})

for (const [index, section] of ['notifications', 'updates', 'appearance'].entries()) {
  test(`${section} mounts its own initial document, selects immediately and releases subscriptions and retry timers`, async () => {
    const r = clientRig()
    assert.ok(flatten(r.render(index)).some(node => node.props?.role === 'status'))
    const dispose = r.effects[0]!()
    await new Promise(done => setImmediate(done))
    const wrapper = r.render(index)
    const frame = flatten(wrapper).find(node => node.type === 'iframe')
    assert.ok(frame)
    assert.equal(frame.props.title, section)
    assert.equal(frame.props.sandbox, 'allow-scripts')
    assert.match(frame.props.srcDoc, new RegExp(`<html\\b[^>]*data-dsh-section="${section}"`))
    assert.equal(frame.props['data-dsh-desktop-settings'], 'true')
    if (section === 'appearance') {
      assert.equal(wrapper.props['data-dsh-desktop-appearance-panel'], 'true')
      assert.equal(frame.props.style.height, 440)
    }
    frame.props.ref.current = { contentWindow: r.frameWindow }
    frame.props.onLoad()
    assert.equal(r.replies.at(-1)?.event, 'settingsSection')
    assert.equal(r.replies.at(-1)?.value, section)
    r.fireTimers()
    assert.equal(r.replies.at(-1)?.value, section)
    assert.equal(r.activeTimers(), 1)
    if (section === 'updates') {
      for (const [id, method] of DESKTOP_SETTINGS_METHODS.entries()) {
        r.event({ data: { channel: 'dsh-desktop-settings-v1', id: id + 1, method } })
      }
      await new Promise(done => setImmediate(done))
      assert.deepEqual(r.requests.map(request => request.method), [...DESKTOP_SETTINGS_METHODS])
    }
    r.broadcast({ event: 'harnessUpdateState', value: { state: { phase: 'ready' } } })
    assert.equal(r.replies.at(-1)?.event, 'harnessUpdateState')
    dispose()
    assert.equal(r.stopped(), 1)
    assert.equal(r.listeners.size, 0)
    assert.equal(r.activeTimers(), 0)
    const replies = r.replies.length, requests = r.requests.length
    r.fireTimers()
    r.broadcast({ event: 'desktopUpdateState', value: {} })
    r.event()
    assert.equal(r.replies.length, replies)
    assert.equal(r.requests.length, requests)
    r.disposeRegistrations()
    assert.equal(r.registrations.length, 0)
  })
}

test('section-selection retry is bounded and unmount cancels the remaining delivery', async () => {
  const r = clientRig()
  r.render(1)
  const dispose = r.effects[0]!()
  await new Promise(done => setImmediate(done))
  const frame = r.render(1)
  frame.props.ref.current = { contentWindow: r.frameWindow }
  frame.props.onLoad()
  let ticks = 0
  while (r.activeTimers() !== 0 && ticks < 40) { r.fireTimers(); ticks++ }
  assert.equal(ticks, 25)
  assert.equal(r.activeTimers(), 0)
  assert.equal(r.replies.filter(reply => reply.event === 'settingsSection' && reply.value === 'updates').length, 26)
  dispose()
  assert.equal(r.stopped(), 1)
  r.disposeRegistrations()
})

test('document failure shows retry instead of a blank iframe; late completion is ignored', async () => {
  const r = clientRig(true); r.render(); const dispose = r.effects[0]!()
  await new Promise(done => setImmediate(done))
  const error = r.render(); assert.equal(error.props.role, 'alert'); assert.match(error.children[0], /missing document/)
  assert.equal(error.children[1].type, 'button'); dispose()
  const late = clientRig(); late.render(); late.effects[0]!()()
  await new Promise(done => setImmediate(done))
  assert.equal(late.render().props.role, 'status')
})
