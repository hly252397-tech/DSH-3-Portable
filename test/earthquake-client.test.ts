import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

// Execute the actual ModuleLoader factory, registered components and handlers.
// All clocks, reads, writes and audio are fake; no upstream or production Data writes.
const SOURCE = readFileSync(resolve('plugins/dsh-earthquake-alert/lib/client.js'), 'utf8')
const { registerEarthquakeUiTokenTests } = await import(pathToFileURL(resolve('plugins/dsh-earthquake-alert/test/ui-tokens.test.mjs')).href) as {
  registerEarthquakeUiTokenTests(root: string): void
}
registerEarthquakeUiTokenTests(resolve('.'))

type VNode = { type: unknown; props: Record<string, any>; children: unknown[] }
type Request = { url: string; options: Record<string, any> }
type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown> }
type HookInstance = { values: any[]; effects: Map<number, { deps: any[]; dispose?: () => void }>; dirty: boolean }
type Prefs = { sites: { name: string; latitude: number; longitude: number }[]; radiusKm: number; minMagnitude: number; alertWindowSeconds: number; sound: boolean }
const DEFAULT: Prefs = { sites: [], radiusKm: 300, minMagnitude: 4, alertWindowSeconds: 180, sound: false }
const NOW = Date.parse('2026-10-01T12:00:10+08:00')
const REVISION = 'a'.repeat(64)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const reply = (value: unknown, status = 200, code = 'FAILED'): FakeResponse => ({ ok: status < 400, status,
  async json() { return status < 400 ? { ok: true, value } : { ok: false, error: { code } } } })
const preferences = (prefs: Prefs = clone(DEFAULT), persisted = true, revision = REVISION) => ({ prefs, persisted, revision })
const event = (overrides: Record<string, unknown> = {}) => ({ eventId: 'event-1', reportNum: 1,
  originTime: '2026-10-01 12:00:00', reportTime: '2026-10-01 12:00:05', magnitude: 5,
  latitude: 30, longitude: 100, depth: 10, maxIntensity: 6, place: '合成测试事件', ...overrides })
const snapshot = (overrides: Record<string, any> = {}) => ({ eew: event(), list: [],
  source: { pollSeconds: 5, timeoutSeconds: 12 }, health: { eewLastOkAt: NOW, listLastOkAt: NOW, eewError: null, listError: null }, ...overrides })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve() }

function nodes(root: unknown): VNode[] {
  if (!root || typeof root !== 'object') return []
  if (Array.isArray(root)) return root.flatMap(nodes)
  const node = root as VNode
  return node.props && Array.isArray(node.children) ? [node, ...node.children.flatMap(nodes)] : []
}
const find = (root: unknown, name: string, value: unknown) => nodes(root).find(node => node.props[name] === value)
const text = (root: unknown): string => typeof root === 'string' || typeof root === 'number' ? String(root)
  : Array.isArray(root) ? root.map(text).join(' ') : root && typeof root === 'object' ? ((root as VNode).children || []).map(text).join(' ') : ''

function runtime(options: {
  prefs?: Prefs; persisted?: boolean; legacy?: string | 'throw'; snapshot?: Record<string, any>; language?: 'zh' | 'en';
  fetch?: (request: Request) => FakeResponse | Promise<FakeResponse>; audio?: 'fail' | 'resume-hang' | 'close-hang'
} = {}) {
  let now = NOW, id = 0, current: HookInstance | null = null, hookIndex = 0, rendering = false, updates = 0
  let saved = preferences(clone(options.prefs || DEFAULT), options.persisted ?? true)
  let snap = clone(options.snapshot || snapshot())
  const requests: Request[] = [], disposers: (() => unknown)[] = [], components = new Map<string, () => unknown>()
  const instances = new Map<() => unknown, HookInstance>(), styles: any[] = []
  const timers = new Map<number, { at: number; period: number; callback: () => void }>()
  const audio = { constructors: 0, resumes: 0, starts: 0, stops: 0, disconnects: 0, closes: 0 }
  const dictionaries: Record<string, Record<string, string>> = {}
  const react = {
    createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): VNode { return { type, props: props || {}, children: children.flat(Infinity) } },
    useState(initial: any) {
      assert.ok(current, 'Hook used outside the actual component')
      const instance = current, index = hookIndex++
      if (!(index in instance.values)) instance.values[index] = typeof initial === 'function' ? initial() : initial
      return [instance.values[index], (next: any) => {
        instance.values[index] = typeof next === 'function' ? next(instance.values[index]) : next; instance.dirty = true; updates++
      }]
    },
    useRef(initial: unknown) {
      assert.ok(current); const index = hookIndex++
      return current.values[index] ||= { current: initial }
    },
    useEffect(effect: () => (() => void) | void, deps: any[]) {
      assert.ok(current); const instance = current, index = hookIndex++, previous = instance.effects.get(index)
      if (!previous || deps.length !== previous.deps.length || deps.some((value, position) => !Object.is(value, previous.deps[position]))) {
        previous?.dispose?.(); const dispose = effect(); instance.effects.set(index, { deps, dispose: dispose || undefined })
      }
    },
  }
  function schedule(callback: () => void, delay: number, period: number) {
    const token = ++id; timers.set(token, { at: now + delay, period, callback }); return token
  }
  class Clock extends Date { constructor(value?: string | number) { super(value === undefined ? now : value) } static override now() { return now } }
  class Audio {
    state = 'suspended'; currentTime = 0; destination = {}
    constructor() { audio.constructors++ }
    async resume() {
      audio.resumes++
      if (options.audio === 'fail') throw new Error('AUDIO_DENIED')
      if (options.audio === 'resume-hang') return new Promise<void>(() => {})
      this.state = 'running'
    }
    async close() { audio.closes++; if (options.audio === 'close-hang') return new Promise<void>(() => {}); this.state = 'closed' }
    createOscillator() { return { type: '', frequency: { value: 0 }, onended: null,
      connect(gain: unknown) { return gain }, disconnect() { audio.disconnects++ }, start() { audio.starts++ }, stop() { audio.stops++ } } }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this }, disconnect() { audio.disconnects++ } } }
  }
  let module!: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }
  const fakeFetch = (url: string, requestOptions: Record<string, any>) => {
    const request = { url, options: requestOptions }; requests.push(request)
    if (options.fetch) return Promise.resolve(options.fetch(request))
    if (url.includes('/preferences')) {
      if (requestOptions.method === 'POST') { const body = JSON.parse(requestOptions.body); saved = { ...saved, prefs: body.prefs, persisted: true } }
      return Promise.resolve(reply(clone(saved)))
    }
    return Promise.resolve(reply(clone(snap)))
  }
  runInNewContext(SOURCE, {
    window: { __ModuleLoader__: { load(value: typeof module) { module = value } }, AudioContext: Audio,
      localStorage: { getItem() { if (options.legacy === 'throw') throw new Error('QUOTA'); return options.legacy || null },
        setItem() { throw new Error('Origin-local writes are forbidden') }, removeItem() { throw new Error('Do not destroy legacy evidence') } } },
    document: { createElement() { const style: any = { dataset: {}, textContent: '', remove() { const index = styles.indexOf(style); if (index >= 0) styles.splice(index, 1) } }; return style },
      head: { appendChild(style: unknown) { styles.push(style) } } },
    Date: Clock, AbortController, fetch: fakeFetch, setInterval: (callback: () => void, delay: number) => schedule(callback, delay, delay),
    clearInterval: (token: number) => timers.delete(token), setTimeout: (callback: () => void, delay: number) => schedule(callback, delay, 0), clearTimeout: (token: number) => timers.delete(token),
  }, { filename: 'actual-earthquake-client.js' })
  const plugin = module.factory(name => { assert.equal(name, 'react', 'No additional imports are authorized'); return react })
  plugin.apply({
    effect(effect: () => unknown) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose as () => unknown) },
    locale: { register(_id: string, value: typeof dictionaries) { Object.assign(dictionaries, value); return () => {} },
      bind() { return (key: string) => { const value = dictionaries[options.language || 'zh']?.[key]; assert.equal(typeof value, 'string', `Missing localized message: ${key}`); return value } } },
    slots: { inject(_name: string, inject: () => unknown) { inject() }, register(config: { name: string }, component: () => unknown) { components.set(config.name, component); return () => {} } },
  })
  function render(slot: string) {
    const component = components.get(slot); assert.ok(component)
    const instance = instances.get(component) || { values: [], effects: new Map(), dirty: false }; instances.set(component, instance)
    assert.ok(!rendering); rendering = true
    let result: unknown
    try { for (let turn = 0; turn < 5; turn++) { current = instance; hookIndex = 0; instance.dirty = false; result = component(); if (!instance.dirty) break } }
    finally { rendering = false; current = null }
    return result
  }
  let disposal: Promise<void> | null = null
  return {
    requests, audio, dictionaries, styles, timers, panel: () => render('main'), banner: () => render('shell.overlay'), icon: () => render('sidebar.panellist'),
    currentUpdates: () => updates, clock: () => now, setSnapshot(value: Record<string, any>) { snap = clone(value) },
    async ready() { await flush(); this.panel(); await flush() },
    async advance(milliseconds: number) {
      now += milliseconds
      for (const [token, pending] of [...timers]) if (pending.at <= now && timers.has(token)) {
        if (pending.period) pending.at = now + pending.period; else timers.delete(token)
        pending.callback()
      }
      await flush()
    },
    async refresh() { find(this.panel(), 'data-dshea-action', 'refresh')!.props.onClick(); await flush() },
    change(input: string, value: string) { find(this.panel(), 'id', input)!.props.onChange({ target: { value } }) },
    action(action: string, argument?: any) { const button = find(this.panel(), 'data-dshea-action', action); assert.ok(button, `Missing actual action: ${action}`); return button.props.onClick(argument) as Promise<unknown> | void },
    dispose() {
      if (disposal) return disposal
      for (const instance of instances.values()) for (const effect of instance.effects.values()) effect.dispose?.()
      disposal = (async () => { for (const dispose of [...disposers].reverse()) await dispose() })()
      return disposal
    },
  }
}

test('earthquake client: real slots, scoped style, labels, dictionaries and local request contract', async context => {
  const run = runtime(); context.after(() => run.dispose()); await run.ready()
  assert.equal(find(run.panel(), 'data-dshea-panel', true)?.type, 'section')
  assert.equal(run.icon() && (run.icon() as VNode).type, 'svg')
  assert.equal(nodes(run.panel()).filter(node => node.props['data-dshea-status']).length, 1)
  for (const id of ['dshea-site-name', 'dshea-latitude', 'dshea-longitude']) assert.ok(find(run.panel(), 'htmlFor', id))
  assert.deepEqual(Object.keys(run.dictionaries.zh).sort(), Object.keys(run.dictionaries.en).sort())
  assert.equal(run.styles.length, 1)
  for (const request of run.requests) {
    assert.match(request.url, /^\/dsh-earthquake-alert\/api(?:\?|\/preferences)/)
    assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.headers['x-dsh-earthquake-alert'], '1')
    assert.ok(request.options.signal instanceof AbortSignal)
  }
  const banner = run.banner(); assert.equal(find(banner, 'data-dshea-banner', 'live')?.type, 'section')
  assert.equal(find(banner, 'className', 'dshea-banner-body')?.props['aria-live'], 'off')
  assert.equal(find(banner, 'className', 'dshea-banner-head')?.props.role, 'alert')
  assert.equal(run.audio.constructors, 0)
})

test('earthquake client: preferences pending and 503 never activate default alerts or sound', async context => {
  const held = deferred<FakeResponse>()
  const run = runtime({ fetch: request => request.url.includes('/preferences') ? held.promise : reply(snapshot()) }); context.after(() => run.dispose())
  await flush(); assert.equal(run.banner(), null); assert.equal(find(run.panel(), 'id', 'dshea-radius')?.props.disabled, true)
  run.action('load-preferences'); await flush()
  assert.equal(run.requests.filter(request => request.url.includes('/preferences')).length, 1)
  held.resolve(reply(null, 503)); await flush()
  assert.equal(run.banner(), null); assert.equal(find(run.panel(), 'data-dshea-notice', 'prefsUnavailable')?.props.role, 'alert')
  assert.equal(run.audio.constructors, 0)
})

test('earthquake client: snapshot read failure suppresses a formerly healthy live alert but retains history', async context => {
  let offline = false
  const run = runtime({ fetch: request => reply(request.url.includes('/preferences') ? preferences() : offline ? null : snapshot(), offline && !request.url.includes('/preferences') ? 503 : 200) })
  context.after(() => run.dispose()); await run.ready(); assert.ok(run.banner())
  offline = true; await run.refresh()
  assert.equal(run.banner(), null); assert.match(text(run.panel()), /M5/)
  assert.ok(find(run.panel(), 'data-dshea-status', 'unavailable'))
  assert.ok(find(run.panel(), 'data-dshea-notice', 'refreshFailed'))
})

test('earthquake client: waiting or a missing event with failed/not-ready feed never claims there is no warning', async () => {
  const held = deferred<FakeResponse>()
  const initial = runtime({ fetch: request => request.url.includes('/preferences') ? reply(preferences()) : held.promise })
  await initial.ready(); assert.ok(find(initial.panel(), 'data-dshea-status', 'waiting')); assert.equal(initial.banner(), null)
  assert.doesNotMatch(text(initial.panel()), /本次成功读取未返回预警事件|当前没有正在发布/); await initial.dispose()
  for (const health of [{ eewLastOkAt: null, eewError: { code: 'NETWORK' } }, { eewLastOkAt: null, eewError: { code: 'FUTURE_REPORT' } },
    { eewLastOkAt: null, eewError: null }]) {
    const run = runtime({ snapshot: snapshot({ eew: null, health }) }); await run.ready()
    assert.ok(find(run.panel(), 'data-dshea-status', 'unavailable')); assert.equal(run.banner(), null)
    assert.match(text(run.panel()), /暂不能确认预警状态/); assert.doesNotMatch(text(run.panel()), /本次成功读取未返回预警事件|当前没有正在发布/)
    await run.dispose()
  }
  const healthy = runtime({ snapshot: snapshot({ eew: null }) }); await healthy.ready()
  assert.ok(find(healthy.panel(), 'data-dshea-status', 'none')); assert.match(text(healthy.panel()), /本次成功读取未返回预警事件/); await healthy.dispose()
})

test('earthquake client: strict complete CN calendar, future and report ordering are checked', async context => {
  // Old prefix/suffix Date parsing accepted this invalid calendar day by normalization.
  assert.equal(new Date('2026-02-30T12:00:00+08:00').getUTCMonth(), 2)
  for (const eew of [event({ originTime: '12:00:00' }), event({ originTime: '2026-02-30 12:00:00', reportTime: '2026-02-30 12:00:01' }),
    event({ originTime: '2026-10-01 12:00:00Z' }), event({ originTime: '2026-10-01 12:00:00 trailing' }),
    event({ originTime: '2026-10-01 12:00:11', reportTime: '2026-10-01 12:00:12' }), event({ reportTime: '2026-10-01 11:59:59' })]) {
    const run = runtime({ snapshot: snapshot({ eew }) }); await run.ready()
    assert.equal(run.banner(), null); assert.ok(find(run.panel(), 'data-dshea-status', 'invalid')); await run.dispose()
  }
  const run = runtime({ snapshot: snapshot({ eew: event({ originTime: '2026-10-01T12:00:00.123', reportTime: '2026-10-01 12:00:05.5' }) }) })
  context.after(() => run.dispose()); await run.ready(); assert.ok(run.banner())
})

test('earthquake client: minimum magnitude AND watched radius apply; negative magnitude remains historical', async context => {
  const near = { name: '关注点', latitude: 30, longitude: 100 }
  // Frozen old counterexample: sites present => only radius was consulted.
  const legacyRelevant = (withinRadius: boolean) => withinRadius
  assert.equal(legacyRelevant(true), true)
  for (const [magnitude, site, expected] of [[0.1, near, false], [-1, near, false], [5, { ...near, longitude: 140 }, false], [5, near, true]] as const) {
    const run = runtime({ prefs: { ...clone(DEFAULT), sites: [site] }, snapshot: snapshot({ eew: event({ magnitude }) }) }); await run.ready()
    assert.equal(Boolean(run.banner()), expected)
    if (magnitude < 0) { assert.match(text(run.panel()), /M-1/); assert.ok(find(run.panel(), 'data-dshea-status', 'active')) }
    await run.dispose()
  }
  const run = runtime(); context.after(() => run.dispose()); await run.ready(); assert.ok(run.banner(), 'No-site fallback still uses magnitude threshold')
})

test('earthquake client: wave time is remaining travel time and eventually reads arrived', async context => {
  const run = runtime({ prefs: { ...clone(DEFAULT), sites: [{ name: '距离约111km', latitude: 31, longitude: 100 }] } }); context.after(() => run.dispose()); await run.ready()
  const first = Number(find(run.panel(), 'data-dshea-countdown', 's')?.props['data-dshea-seconds'])
  const oldOriginTravel = Math.hypot(111.2, 10) / 3.5
  assert.ok(first < oldOriginTravel - 8, 'Old estimate forgot elapsed age')
  await run.advance(10_000)
  const second = Number(find(run.panel(), 'data-dshea-countdown', 's')?.props['data-dshea-seconds'])
  assert.equal(first - second, 10)
  await run.advance(30_000); assert.match(text(find(run.panel(), 'data-dshea-countdown', 's')), /预计已到达/)
})

test('earthquake client: unchanged snapshots expire and stale/error/future freshness cannot alert', async context => {
  const run = runtime({ fetch: request => reply(request.url.includes('/preferences') ? preferences() : snapshot({ health: { eewLastOkAt: run.clock(), eewError: null } })) })
  context.after(() => run.dispose()); await run.ready(); assert.ok(run.banner())
  // Old banner useMemo depended on a stable setter: time alone never re-evaluated it.
  const legacyMemoActive = true
  await run.advance(181_000); assert.equal(legacyMemoActive, true); assert.equal(run.banner(), null)
  assert.ok(find(run.panel(), 'data-dshea-status', 'expired'))
  for (const health of [{ eewLastOkAt: NOW - 25_000 }, { eewLastOkAt: NOW + 1 }, { eewLastOkAt: NOW, eewError: { code: 'NETWORK' } }]) {
    const isolated = runtime({ snapshot: snapshot({ health }) }); await isolated.ready(); assert.equal(isolated.banner(), null); await isolated.dispose()
  }
  const compatible = runtime({ snapshot: snapshot({ eew: event({ receivedAt: NOW }), health: {} }) }); await compatible.ready(); assert.ok(compatible.banner()); await compatible.dispose()
})

test('earthquake client: report 0 is distinct from 1 for dismiss and report display', async context => {
  const run = runtime({ snapshot: snapshot({ eew: event({ reportNum: 0 }) }) }); context.after(() => run.dispose()); await run.ready()
  assert.match(text(run.banner()), /第 0 报/)
  find(run.banner(), 'data-dshea-action', 'dismiss-banner')!.props.onClick(); assert.equal(run.banner(), null)
  run.setSnapshot(snapshot({ eew: event({ reportNum: 1 }) })); await run.refresh(); assert.ok(run.banner()); assert.match(text(run.banner()), /第 1 报/)
})

test('earthquake client: demo is independent from historical facts, silent, dismissible and 15-second bounded', async context => {
  const run = runtime({ snapshot: snapshot({ eew: event({ magnitude: 9, place: '不可出现在演示中', originTime: '2026-09-30 12:00:00', reportTime: '2026-09-30 12:00:05' }) }) })
  context.after(() => run.dispose()); await run.ready(); assert.equal(run.banner(), null)
  run.action('test-banner'); assert.ok(find(run.banner(), 'data-dshea-banner', 'test')); assert.doesNotMatch(text(run.banner()), /M9|不可出现在演示中|100/)
  const demoHeader = find(run.banner(), 'className', 'dshea-banner-head')
  assert.equal((text(demoHeader).match(/测试横幅/g) || []).length, 1, 'Test title must not be repeated as a badge')
  assert.equal(text(find(demoHeader, 'className', 'dshea-pill dshea-pill-test')), '演示')
  assert.match(text(run.banner()), /演示/); await run.advance(15_000); assert.equal(run.banner(), null)
  run.action('test-banner'); find(run.banner(), 'data-dshea-action', 'dismiss-banner')!.props.onClick(); assert.equal(run.banner(), null)
  assert.equal(run.audio.constructors, 0); assert.equal(run.audio.starts, 0)
})

test('earthquake client: blank/out-of-range coordinates keep input and never POST', async context => {
  const run = runtime(); context.after(() => run.dispose()); await run.ready()
  run.change('dshea-site-name', '保存我的输入'); run.change('dshea-longitude', '100')
  await run.action('add-site'); assert.ok(find(run.panel(), 'data-dshea-form-error', 'coordinateInvalid'))
  assert.equal(find(run.panel(), 'id', 'dshea-site-name')?.props.value, '保存我的输入')
  run.change('dshea-latitude', '91'); await run.action('add-site'); assert.ok(find(run.panel(), 'data-dshea-form-error', 'coordinateInvalid'))
  assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 0)
  run.change('dshea-latitude', '30'); await run.action('add-site'); await flush()
  assert.equal(find(run.panel(), 'id', 'dshea-site-name')?.props.value, '')
  assert.match(text(run.panel()), /保存我的输入/)
})

test('earthquake client: NFC/case name duplicates, +/-180 duplicate coordinates and 20-site maximum match host', async () => {
  for (const candidate of [{ name: 'cAFE\u0301', latitude: 5, longitude: 6 }, { name: '另一个名字', latitude: 30, longitude: -180 }]) {
    const run = runtime({ prefs: { ...clone(DEFAULT), sites: [{ name: 'Café', latitude: 30, longitude: 180 }] } }); await run.ready()
    run.change('dshea-site-name', candidate.name); run.change('dshea-latitude', String(candidate.latitude)); run.change('dshea-longitude', String(candidate.longitude))
    await run.action('add-site'); assert.ok(find(run.panel(), 'data-dshea-form-error', 'duplicateSite'))
    assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 0); await run.dispose()
  }
  const run = runtime({ prefs: { ...clone(DEFAULT), sites: Array.from({ length: 20 }, (_, index) => ({ name: `地点${index}`, latitude: index, longitude: index })) } }); await run.ready()
  run.change('dshea-site-name', '第21个'); run.change('dshea-latitude', '40'); run.change('dshea-longitude', '110'); await run.action('add-site')
  assert.ok(find(run.panel(), 'data-dshea-form-error', 'siteLimit')); assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 0); await run.dispose()
})

test('earthquake client: controlled settings change is only a draft until successful explicit revision commit', async context => {
  const run = runtime(); context.after(() => run.dispose()); await run.ready(); run.change('dshea-radius', '444')
  assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 0)
  await run.action('save-settings'); await flush(); assert.ok(find(run.panel(), 'data-dshea-notice', 'saved'))
  const post = run.requests.find(request => request.options.method === 'POST')!
  assert.equal(post.options.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(post.options.body), { revision: REVISION, prefs: { ...DEFAULT, radiusKm: 444 } })
  run.change('dshea-radius', ''); await run.action('save-settings'); assert.ok(find(run.panel(), 'data-dshea-form-error', 'settingsInvalid'))
  assert.equal(find(run.panel(), 'id', 'dshea-radius')?.props.value, '')
  assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 1)
})

test('earthquake client: host write/QUOTA failure retains draft and never publishes saved success', async context => {
  const run = runtime({ fetch: request => request.options.method === 'POST' ? reply(null, 500, 'QUOTA') : reply(request.url.includes('/preferences') ? preferences() : snapshot()) })
  context.after(() => run.dispose()); await run.ready(); run.change('dshea-radius', '444'); await run.action('save-settings')
  assert.equal(find(run.panel(), 'id', 'dshea-radius')?.props.value, '444'); assert.ok(find(run.panel(), 'data-dshea-notice', 'saveFailed'))
  assert.equal(find(run.panel(), 'data-dshea-notice', 'saved'), undefined)
  run.change('dshea-site-name', '失败不清空'); run.change('dshea-latitude', '30'); run.change('dshea-longitude', '100'); await run.action('add-site')
  assert.equal(find(run.panel(), 'id', 'dshea-site-name')?.props.value, '失败不清空')
})

test('earthquake client: conflict reloads authority, keeps dirty draft and requires explicit reset or retry', async context => {
  let changed = false
  const run = runtime({ fetch: request => {
    if (request.options.method === 'POST') { changed = true; return reply(null, 409, 'REVISION_CONFLICT') }
    return reply(request.url.includes('/preferences') ? preferences({ ...clone(DEFAULT), radiusKm: changed ? 333 : 300 }, true, changed ? 'b'.repeat(64) : REVISION) : snapshot())
  } }); context.after(() => run.dispose()); await run.ready(); run.change('dshea-radius', '444'); await run.action('save-settings')
  assert.equal(find(run.panel(), 'id', 'dshea-radius')?.props.value, '444'); assert.ok(find(run.panel(), 'data-dshea-notice', 'conflict'))
  assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 1)
  assert.equal(run.requests.filter(request => request.url.includes('/preferences') && request.options.method !== 'POST').length, 2)
  run.action('reset-draft'); assert.equal(find(run.panel(), 'id', 'dshea-radius')?.props.value, '333')
  assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 1)
})

test('earthquake client: invalid host preferences do not unlock editing or activate alerts', async () => {
  for (const value of [preferences({ ...clone(DEFAULT), radiusKm: '300' } as unknown as Prefs), { ...preferences(), revision: 'invalid' },
    preferences({ ...clone(DEFAULT), unknown: true } as Prefs), preferences({ ...clone(DEFAULT), sites: [{ name: '\nBad', latitude: 30, longitude: 100 }] }),
    preferences({ ...clone(DEFAULT), sites: [{ name: 'Same', latitude: 30, longitude: 100 }, { name: 'same', latitude: 40, longitude: 110 }] })]) {
    const run = runtime({ fetch: request => reply(request.url.includes('/preferences') ? value : snapshot()) }); await run.ready()
    assert.equal(run.banner(), null); assert.equal(find(run.panel(), 'id', 'dshea-radius')?.props.disabled, true)
    assert.ok(find(run.panel(), 'data-dshea-notice', 'prefsInvalid')); await run.dispose()
  }
})

test('earthquake client: legacy settings are explicit candidates, never automatic overwrite or origin-local persistence', async () => {
  const legacy = JSON.stringify({ ...DEFAULT, radiusKm: 555 })
  const run = runtime({ persisted: false, legacy }); await run.ready(); assert.ok(find(run.panel(), 'data-dshea-action', 'migrate'))
  assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 0)
  assert.equal(find(run.panel(), 'id', 'dshea-radius')?.props.value, '300')
  await run.action('migrate'); await flush(); assert.equal(find(run.panel(), 'data-dshea-action', 'migrate'), undefined)
  assert.equal(find(run.panel(), 'id', 'dshea-radius')?.props.value, '555'); await run.dispose()
  const existing = runtime({ legacy }); await existing.ready(); assert.equal(find(existing.panel(), 'data-dshea-action', 'migrate'), undefined)
  assert.equal(existing.requests.filter(request => request.options.method === 'POST').length, 0); await existing.dispose()
  const failed = runtime({ persisted: false, legacy: 'throw' }); await failed.ready(); assert.match(text(failed.panel()), /旧设置/)
  assert.equal(find(failed.panel(), 'data-dshea-action', 'migrate'), undefined); await failed.dispose()
})

test('earthquake client: snapshot reads are singleflight and bounded even if fetch ignores AbortSignal', async context => {
  const pending = deferred<FakeResponse>()
  const run = runtime({ fetch: request => request.url.includes('/preferences') ? reply(preferences()) : pending.promise }); context.after(() => run.dispose())
  await run.ready(); run.action('refresh'); run.action('refresh'); await run.advance(2000)
  assert.equal(run.requests.filter(request => !request.url.includes('/preferences')).length, 1)
  assert.equal(find(run.panel(), 'data-dshea-action', 'refresh')?.props.disabled, true)
  await run.advance(3001); assert.equal(find(run.panel(), 'data-dshea-action', 'refresh')?.props.disabled, false)
  assert.equal(run.requests[0]!.options.signal.aborted, true); assert.equal(run.banner(), null)
})

test('earthquake client: unload aborts pending writes, awaits owned work and rejects late UI publication', async () => {
  const pending = deferred<FakeResponse>()
  const run = runtime({ fetch: request => request.options.method === 'POST' ? pending.promise : reply(request.url.includes('/preferences') ? preferences() : snapshot()) })
  await run.ready(); run.change('dshea-site-name', '仍然保存草稿'); run.change('dshea-latitude', '30'); run.change('dshea-longitude', '100')
  const save = run.action('add-site'); await flush(); const post = run.requests.find(request => request.options.method === 'POST')!
  const before = run.currentUpdates(); await run.dispose(); await save
  assert.equal(post.options.signal.aborted, true); assert.equal(run.styles.length, 0); assert.equal(run.timers.size, 0)
  pending.resolve(reply(preferences({ ...clone(DEFAULT), sites: [{ name: '仍然保存草稿', latitude: 30, longitude: 100 }] })))
  await flush(); assert.equal(run.currentUpdates(), before, 'No bus emission or setState after disposal')
})

test('earthquake client: saved sound requires trusted gesture, initial snapshot is silent and event/report sound is deduplicated', async () => {
  const run = runtime({ prefs: { ...clone(DEFAULT), sound: true } }); await run.ready()
  assert.equal(run.audio.constructors, 0); assert.equal(run.audio.starts, 0)
  await run.action('enable-sound', { isTrusted: false }); assert.equal(run.audio.constructors, 0)
  await run.action('enable-sound', { nativeEvent: { isTrusted: true } }); assert.equal(run.audio.resumes, 1); assert.equal(run.audio.starts, 0)
  assert.equal(run.requests.filter(request => request.options.method === 'POST').length, 0, 'Saved preference does not need another write')
  await run.advance(10_000)
  run.setSnapshot(snapshot({ eew: event({ reportNum: 2 }), health: { eewLastOkAt: run.clock() } })); await run.refresh()
  assert.equal(run.audio.starts, 3); await run.refresh(); assert.equal(run.audio.starts, 3)
  run.action('test-banner'); assert.equal(run.audio.starts, 3)
  await run.dispose(); assert.equal(run.audio.closes, 1); assert.equal(run.audio.disconnects, 6)
})

test('earthquake client: enabling sound persists only after resume; audio failure never reports ready', async () => {
  const run = runtime(); await run.ready()
  const checkbox = nodes(run.panel()).find(node => node.type === 'input' && node.props.type === 'checkbox')!
  await checkbox.props.onChange({ isTrusted: true, target: { checked: true } }); await flush()
  const post = run.requests.find(request => request.options.method === 'POST')!
  assert.equal(JSON.parse(post.options.body).prefs.sound, true); assert.equal(run.audio.starts, 0); await run.dispose()
  const failed = runtime({ prefs: { ...clone(DEFAULT), sound: true }, audio: 'fail' }); await failed.ready()
  await failed.action('enable-sound', { isTrusted: true }); await flush()
  assert.ok(find(failed.panel(), 'data-dshea-notice', 'soundFailed')); assert.ok(find(failed.panel(), 'data-dshea-action', 'enable-sound'))
  assert.equal(failed.audio.starts, 0); assert.equal(failed.audio.closes, 1); await failed.dispose()
})

test('earthquake client: native audio resume/close hangs have finite deadlines and quiet async disposal', async () => {
  const resume = runtime({ prefs: { ...clone(DEFAULT), sound: true }, audio: 'resume-hang' }); await resume.ready()
  const enabling = resume.action('enable-sound', { isTrusted: true }); await flush(); await resume.advance(5001); await enabling; await flush()
  assert.ok(find(resume.panel(), 'data-dshea-notice', 'soundFailed')); assert.equal(resume.audio.starts, 0); await resume.dispose()
  const close = runtime({ prefs: { ...clone(DEFAULT), sound: true }, audio: 'close-hang' }); await close.ready()
  await close.action('enable-sound', { isTrusted: true }); const before = close.currentUpdates(), disposed = close.dispose()
  await flush(); await close.advance(1001); await disposed
  assert.equal(close.audio.closes, 1); assert.equal(close.timers.size, 0); assert.equal(close.currentUpdates(), before)
})
