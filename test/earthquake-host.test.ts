import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { captureCustomizationState, checkPreservationManifest, verifyCustomizationPreserved, type PreservationManifest } from '../src/customization-preservation.js'

// Every CI runs canonical pure/storage/HTTP boundaries. No production Data, source peer installation,
// external network, sound or banner is required. Real Profile/Loader composition is verified separately.
const prefsModule: any = await import(pathToFileURL(resolve('plugins/dsh-earthquake-alert/lib/preferences.js')).href)
const hostSource = readFileSync(resolve('plugins/dsh-earthquake-alert/lib/index.js'), 'utf8')
const event = (patch: any = {}) => ({
  EventID: 'fixture-a', OriginTime: '2026-10-01 00:00:00', ReportTime: '2026-10-01 00:00:02', ReportNum: 1,
  HypoCenter: '隔离测试', Latitude: 30, Longitude: 103, Magnitude: 4.6, Depth: 10, MaxIntensity: 6,
  ...patch,
})
const listPayload = { No1: { time: '2026-10-01 00:00:00', location: '隔离测试', magnitude: '4.6', latitude: '30', longitude: '103', depth: '10' } }
const settle = () => new Promise<void>(done => setImmediate(done))

function moduleFixture(environment: any, options: any = {}) {
  let now = Date.parse('2026-10-01T00:00:10+08:00')
  const pending: any[] = [], intervals: any[] = [], timeouts: any[] = [], effects: (() => unknown)[] = [], logs: string[] = []
  const routes = new Map<string, any>()
  const schema: any = new Proxy(() => schema, { get: () => (..._args: any[]) => schema })
  class Clock extends Date { static override now() { return now } }
  const sandbox: any = {
    Schema: schema, Buffer, URL, AbortController, Date: Clock,
    createPreferencesStore: () => prefsModule.createPreferencesStore(environment),
    MAX_PREFERENCES_BYTES: prefsModule.MAX_PREFERENCES_BYTES, preferenceError: prefsModule.preferenceError,
    setTimeout(fn: () => void, ms: number) { const timer = { fn, ms, active: true }; timeouts.push(timer); return timer },
    clearTimeout(timer: any) { timer.active = false },
    setInterval(fn: () => void, ms: number) { const timer = { fn, ms, active: true, unref() {} }; intervals.push(timer); return timer },
    clearInterval(timer: any) { timer.active = false },
    fetch(url: URL, init: any) {
      return new Promise((resolveResponse, reject) => {
        const request = { url: String(url), init, reply: (value: any, headers: any = {}) => resolveResponse(new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200, headers })), reject }
        pending.push(request)
        if (!options.ignoreAbort) init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    },
  }
  vm.createContext(sandbox)
  const runnable = hostSource.replace(/^import .*;\r?\n/gmu, '').replace(/^export /gmu, '')
  vm.runInContext(runnable + '\nglobalThis.plugin={apply,normalizeEew,normalizeList,parseSourceTime,isOlderReport,isTrustedRequest,API_PATH,PREFERENCES_PATH,REQUEST_HEADER};', sandbox)
  const inner: any = {
    effect(fn: () => any) { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    webRuntime: { trustedHosts: [] }, connection: { requestRejection: (_req: any) => undefined },
    webServer: { register(route: any) { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } },
  }
  const ctx = { logger: () => ({ info: (value: string) => logs.push(value) }), effect: inner.effect, inject: (_names: string[], fn: (value: any) => void) => fn(inner) }
  async function request(path: string, options: any = {}, explicitHandler?: any) {
    const req: any = Readable.from(options.chunks ?? (options.body === undefined ? [] : [Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body))]))
    req.method = options.method ?? 'GET'
    req.headers = { host: options.host ?? 'localhost:8181', origin: options.origin ?? 'http://localhost:8181', 'x-dsh-earthquake-alert': '1', ...options.headers }
    const result: any = { status: 0, body: undefined }
    const res: any = { destroyed: false, writableEnded: false, writeHead(status: number) { result.status = status }, end(raw: string) { result.body = JSON.parse(raw); this.writableEnded = true } }
    await (explicitHandler ?? routes.get(path))(req, res)
    return result
  }
  const plugin: any = sandbox.plugin
  return { plugin, ctx, inner, routes, pending, intervals, timeouts, logs, request,
    start(config: any = {}) { plugin.apply(ctx, { eewUrl: 'http://localhost:9001/eew', listUrl: 'http://localhost:9001/list', ...config }) },
    async dispose() { await Promise.all(effects.map(fn => fn())) },
    setNow(value: number) { now = value },
  }
}

async function fixture(options: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'earthquake-host-'))
  return { root, ...moduleFixture({ DSH_PORTABLE_ROOT: root }, options) }
}

test('CENC time parsing is strict calendar-valid UTC+8 rather than machine timezone', () => {
  const { plugin } = moduleFixture({})
  assert.equal(plugin.parseSourceTime('2024-02-29 23:59:59.25').toISOString(), '2024-02-29T15:59:59.250Z')
  for (const time of ['2026-02-31 12:00:00', '2026-10-01 00:00:00tail', '2026-10-01T00:00:00Z', '2026-13-01 00:00:00', '2026-10-01 24:00:00', '2026-10-01 00:00']) assert.equal(plugin.parseSourceTime(time), null, time)
})

test('CENC core fields reject partial/boolean/nonfinite/out-of-range payloads without inventing data', () => {
  const { plugin } = moduleFixture({})
  assert.equal(plugin.normalizeEew(event({ Depth: null })).depth, undefined)
  assert.equal(plugin.normalizeEew(event({ Magnitude: -1, Depth: 0 })).magnitude, -1)
  assert.equal(plugin.normalizeEew({ EventID: 'bogus' }), null)
  for (const patch of [{ Magnitude: true }, { Magnitude: ' ' }, { Latitude: 999 }, { Longitude: -181 }, { ReportNum: -1 }, { ReportNum: 1.5 }, { OriginTime: '2026-02-31 12:00:00' }, { Depth: -1 }, { Depth: 801 }, { Depth: 'invalid' }, { Magnitude: 11 }, { MaxIntensity: 13 }, { ReportTime: '2026-09-30 23:59:59' }]) assert.equal(plugin.normalizeEew(event(patch)), null, JSON.stringify(patch))
})

test('reviewed/automatic list rows are validated and ordered by parsed source time', () => {
  const { plugin } = moduleFixture({})
  const result = plugin.normalizeList({ ...listPayload, No2: { ...listPayload.No1, time: '2026-10-01 00:01:00', type: 'reviewed' }, bad: { location: 'not an earthquake', magnitude: 999 } })
  assert.equal(result.length, 2)
  assert.equal(result[0].time, '2026-10-01 00:01:00')
  assert.equal(result[0].type, 'reviewed')
})

test('accepted reports cannot regress by serial/time or switch back to older events', () => {
  const { plugin } = moduleFixture({})
  const current = plugin.normalizeEew(event({ ReportNum: 3, ReportTime: '2026-10-01 00:00:05' }))
  assert.equal(plugin.isOlderReport(current, plugin.normalizeEew(event({ ReportNum: 2 }))), true)
  assert.equal(plugin.isOlderReport(current, plugin.normalizeEew(event({ ReportNum: 3, ReportTime: '2026-10-01 00:00:04' }))), true)
  assert.equal(plugin.isOlderReport(current, plugin.normalizeEew(event({ ReportNum: 4, ReportTime: '2026-10-01 00:00:04' }))), true)
  assert.equal(plugin.isOlderReport(current, plugin.normalizeEew(event({ EventID: 'old', OriginTime: '2026-09-30 23:59:00', ReportNum: 10 }))), true)
  assert.equal(plugin.isOlderReport(current, plugin.normalizeEew(event({ ReportNum: 3, ReportTime: '2026-10-01 00:00:05', Magnitude: 4.7 }))), false)
})

test('local API activates before initial source requests resolve; polling is single-flight', async () => {
  const f = await fixture(); f.start()
  try {
    assert.equal(f.pending.length, 2)
    const initial = await f.request(f.plugin.API_PATH)
    assert.equal(initial.status, 200); assert.equal(initial.body.value.eew, null)
    assert.equal(initial.body.value.source.timeoutSeconds, 12)
    f.intervals[0].fn(); f.intervals[0].fn(); f.intervals[1].fn()
    assert.equal(f.pending.length, 2)
    f.pending[0].reply(event({ ReportNum: 3 })); f.pending[1].reply(listPayload); await settle()
    f.setNow(Date.parse('2026-10-01T00:00:20+08:00')); f.intervals[0].fn(); f.pending[2].reply(event({ ReportNum: 2 })); await settle()
    const after = (await f.request(f.plugin.API_PATH)).body.value
    assert.equal(after.eew.reportNum, 3)
    assert.equal(after.health.eewError.code, 'STALE_REPORT')
    assert.equal(after.health.eewLastOkAt, initial.body.value.serverTime)
    assert.equal(after.eew.receivedAt, initial.body.value.serverTime)
  } finally { await f.dispose() }
})

test('EEW and directory failures are independent and one success cannot hide the other', async () => {
  const f = await fixture(); f.start()
  try {
    f.pending[0].reply(event()); f.pending[1].reject(new Error('directory fixture failed')); await settle()
    let value = (await f.request(f.plugin.API_PATH)).body.value
    assert.equal(value.health.listError.source, 'list'); assert.equal(value.health.eewError, null)
    f.intervals[0].fn(); f.pending[2].reply(event()); await settle()
    value = (await f.request(f.plugin.API_PATH)).body.value
    assert.equal(value.health.listError.source, 'list'); assert.equal(value.health.lastError.source, 'list')
    f.intervals[1].fn(); f.pending[3].reply(listPayload); await settle()
    value = (await f.request(f.plugin.API_PATH)).body.value
    assert.equal(value.health.listError, null); assert.equal(value.health.lastError, null)
    assert.equal(value.health.errors, 1)
  } finally { await f.dispose() }
})

test('future reports cannot poison selection and a subsequent valid event recovers', async () => {
  const f = await fixture(); f.start()
  try {
    f.pending[0].reply(event({ EventID: 'future', OriginTime: '2026-10-02 00:00:00', ReportTime: '2026-10-02 00:00:01' }))
    f.pending[1].reply(listPayload); await settle()
    let value = (await f.request(f.plugin.API_PATH)).body.value
    assert.equal(value.eew, null); assert.equal(value.health.eewError.code, 'FUTURE_REPORT'); assert.equal(value.health.eewLastOkAt, null)
    f.intervals[0].fn(); f.pending[2].reply(event()); await settle()
    value = (await f.request(f.plugin.API_PATH)).body.value
    assert.equal(value.eew.eventId, 'fixture-a'); assert.equal(value.health.eewError, null)
    f.intervals[0].fn(); f.pending[3].reply(event({ ReportTime: '2026-10-02 00:00:01', ReportNum: 2 })); await settle()
    value = (await f.request(f.plugin.API_PATH)).body.value
    assert.equal(value.eew.reportNum, 1); assert.equal(value.health.eewError.code, 'FUTURE_REPORT')
  } finally { await f.dispose() }
})

test('unloading aborts all source work, removes both routes and awaits late responses without publication', async () => {
  const f = await fixture({ ignoreAbort: true }); f.start()
  const oldHandler = f.routes.get(f.plugin.API_PATH)
  const disposing = f.dispose()
  assert.equal(f.pending.every(p => p.init.signal.aborted), true)
  assert.equal(f.intervals.every(i => !i.active), true)
  f.pending[0].reply(event({ ReportNum: 99 })); f.pending[1].reply(listPayload)
  await disposing
  assert.equal(f.logs.length, 0); assert.equal(f.routes.size, 0)
  assert.equal((await f.request(f.plugin.API_PATH, {}, oldHandler)).status, 503)
})

test('source body limits and deadline have stable errors while the local API stays available', async () => {
  const f = await fixture(); f.start({ maxResponseBytes: 1024 })
  try {
    f.pending[0].reply('x'.repeat(1025)); f.pending[1].reply(listPayload); await settle()
    assert.equal((await f.request(f.plugin.API_PATH)).body.value.health.eewError.code, 'PAYLOAD_TOO_LARGE')
    f.intervals[0].fn()
    const deadline = f.timeouts.filter(timer => timer.active && timer.ms === 12000).at(-1)
    assert.ok(deadline); deadline.fn(); await settle()
    const value = (await f.request(f.plugin.API_PATH)).body.value
    assert.equal(value.health.eewError.code, 'UPSTREAM_TIMEOUT'); assert.equal(value.health.listError, null)
  } finally { await f.dispose() }
})

test('authentication, origin, request headers, methods and bounded JSON guard every preferences request', async () => {
  const f = await fixture(); f.start()
  try {
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH, { headers: { 'x-dsh-earthquake-alert': '0' } })).status, 403)
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH, { origin: 'https://evil.test' })).status, 403)
    f.inner.connection.requestRejection = () => 401
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH)).status, 401)
    delete f.inner.connection.requestRejection
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH)).body.error.code, 'AUTH_UNAVAILABLE')
    f.inner.connection.requestRejection = () => undefined
    assert.equal((await f.request(f.plugin.API_PATH, { method: 'POST' })).status, 405)
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH, { method: 'DELETE' })).status, 405)
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH, { method: 'POST', body: {} })).status, 415)
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400)
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, chunks: [Buffer.alloc(32769)] })).status, 413)
    assert.equal((await f.request(f.plugin.PREFERENCES_PATH)).body.value.persisted, false)
  } finally { await f.dispose() }
})

test('preferences API commits once, retains a stable revision and rejects stale overwrites', async () => {
  const f = await fixture(); f.start()
  try {
    const initial = (await f.request(f.plugin.PREFERENCES_PATH)).body.value
    const changed = { ...initial.prefs, sites: [{ name: '隔离地点', latitude: 30, longitude: 103 }], sound: true }
    const saved = await f.request(f.plugin.PREFERENCES_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { revision: initial.revision, prefs: changed } })
    assert.equal(saved.status, 200); assert.equal(saved.body.value.persisted, true)
    assert.notEqual(saved.body.value.revision, initial.revision)
    const conflict = await f.request(f.plugin.PREFERENCES_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { revision: initial.revision, prefs: initial.prefs } })
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'REVISION_CONFLICT')
    assert.deepEqual((await f.request(f.plugin.PREFERENCES_PATH)).body.value, saved.body.value)
  } finally { await f.dispose() }
})

test('stable plugin-owned preferences survive different origins and do not create files just by reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earthquake-storage-'))
  const store = prefsModule.createPreferencesStore({ DSH_PORTABLE_ROOT: root })
  const first = await store.read()
  assert.equal(first.persisted, false)
  await assert.rejects(readFile(prefsModule.resolvePreferencesFile({ DSH_PORTABLE_ROOT: root })), { code: 'ENOENT' })
  const saved = await store.save({ revision: first.revision, prefs: { ...first.prefs, radiusKm: 111, sites: [{ name: '跨端口', latitude: 0, longitude: 0 }] } })
  await store.close()
  const reopened = prefsModule.createPreferencesStore({ DSH_PORTABLE_ROOT: root })
  assert.deepEqual(await reopened.read(), saved)
  await reopened.close()
  assert.throws(() => prefsModule.resolvePreferencesFile({}), { code: 'PREFERENCES_UNAVAILABLE' })
  assert.throws(() => prefsModule.resolvePreferencesFile({ DSH_HOME: 'relative' }), { code: 'PREFERENCES_UNAVAILABLE' })
  assert.match(prefsModule.resolvePreferencesFile({ DSH_HOME: root }), /plugins[/\\]dsh-earthquake-alert[/\\]preferences.json$/u)
})

test('preferences validation rejects blank/coerced/out-of-range/unknown fields and too many locations', () => {
  const baseline = prefsModule.validatePreferences(prefsModule.DEFAULT_PREFS)
  for (const patch of [{ radiusKm: 9 }, { radiusKm: '300' }, { minMagnitude: 11 }, { alertWindowSeconds: 3601 }, { sound: 1 }, { sites: [{ name: '', latitude: 0, longitude: 0 }] }, { sites: [{ name: 'bad', latitude: '', longitude: 0 }] }, { sites: [{ name: 'bad', latitude: 91, longitude: 0 }] }, { sites: [{ name: 'a\nb', latitude: 0, longitude: 0 }] }, { sites: [{ name: 'x'.repeat(41), latitude: 0, longitude: 0 }] }, { sites: [{ name: 'same', latitude: 0, longitude: 0 }, { name: 'same', latitude: 1, longitude: 1 }] }, { sites: [{ name: 'a', latitude: 0, longitude: 180 }, { name: 'b', latitude: 0, longitude: -180 }] }, { sites: Array.from({ length: 21 }, () => ({ name: 'many', latitude: 0, longitude: 0 })) }, { unknown: true }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => prefsModule.validatePreferences({ ...baseline, ...patch }), { code: 'INVALID_PREFERENCES' })
})

test('corrupt, oversized and linked preference files are not read as defaults or overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earthquake-corrupt-'))
  const file = prefsModule.resolvePreferencesFile({ DSH_PORTABLE_ROOT: root })
  await mkdir(join(root, 'Data', 'Plugins', 'dsh-earthquake-alert'), { recursive: true })
  const store = prefsModule.createPreferencesStore({ DSH_PORTABLE_ROOT: root })
  await writeFile(file, '{broken')
  await assert.rejects(store.read(), { code: 'INVALID_STORED_PREFERENCES' })
  await writeFile(file, 'x'.repeat(32769))
  await assert.rejects(store.read(), { code: 'PREFERENCES_TOO_LARGE' })
  await store.close()
  const linkedRoot = await mkdtemp(join(tmpdir(), 'earthquake-linked-'))
  const outside = await mkdtemp(join(tmpdir(), 'earthquake-outside-'))
  await symlink(outside, join(linkedRoot, 'Data'), process.platform === 'win32' ? 'junction' : 'dir')
  const linkedStore = prefsModule.createPreferencesStore({ DSH_PORTABLE_ROOT: linkedRoot })
  await assert.rejects(linkedStore.read(), { code: 'UNSAFE_PREFERENCES_PATH' })
  await linkedStore.close()
})

test('concurrent preference writers get finite busy/conflict responses and leave committed data recoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earthquake-concurrent-'))
  const store = prefsModule.createPreferencesStore({ DSH_PORTABLE_ROOT: root })
  const initial = await store.read()
  const saving = store.save({ revision: initial.revision, prefs: { ...initial.prefs, radiusKm: 222 } })
  assert.throws(() => store.save({ revision: initial.revision, prefs: initial.prefs }), { code: 'PREFERENCES_BUSY' })
  const saved = await saving
  await writeFile(prefsModule.resolvePreferencesFile({ DSH_PORTABLE_ROOT: root }) + '.lock', 'another-writer')
  await assert.rejects(store.save({ revision: saved.revision, prefs: initial.prefs }), { code: 'PREFERENCES_BUSY' })
  assert.deepEqual(await store.read(), saved)
  await store.close()
  assert.throws(() => store.save({ revision: saved.revision, prefs: initial.prefs }), { code: 'UNAVAILABLE' })
})

test('two independent stores sharing one stable file cannot overwrite a stale revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earthquake-two-stores-'))
  const a = prefsModule.createPreferencesStore({ DSH_PORTABLE_ROOT: root })
  const b = prefsModule.createPreferencesStore({ DSH_PORTABLE_ROOT: root })
  const old = await b.read()
  const saved = await a.save({ revision: old.revision, prefs: { ...old.prefs, radiusKm: 123 } })
  await assert.rejects(b.save({ revision: old.revision, prefs: { ...old.prefs, radiusKm: 321 } }), { code: 'REVISION_CONFLICT' })
  assert.deepEqual(await b.read(), saved)
  const reading = b.read()
  await b.close()
  assert.deepEqual(await reading, saved)
  assert.throws(() => b.read(), { code: 'UNAVAILABLE' })
  await a.close()
})

test('real customization guards capture the packaged new preference module and reject lost-module or reverted-client candidates', async () => {
  const canonical = resolve('plugins/dsh-earthquake-alert')
  const files = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/preferences.js']
  const payload = new Map<string, Buffer>()
  for (const file of files) payload.set(file, await readFile(join(canonical, file)))
  const packageManifest = JSON.parse(payload.get('package.json')!.toString('utf8'))
  assert.ok(packageManifest.files.includes('lib'), 'Published payload must include lib/preferences.js, not only old exports')
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/gu, '\n')).digest('hex')
  const root = await mkdtemp(join(tmpdir(), 'earthquake-preservation-'))
  const sourceRelative = 'plugins/dsh-earthquake-alert', source = join(root, sourceRelative)
  const current = join(root, 'Data/current/profiles/web'), candidate = join(root, 'Data/candidate/profiles/web')
  const put = async (file: string, bytes: Buffer | string) => {
    await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, bytes)
  }
  for (const [file, bytes] of payload) await put(join(source, file), bytes)
  // Fixture acceptance only. Never read/write the real accepted registry or waive a source drift.
  const manifest: PreservationManifest = {
    schema: 1, revision: 1, features: ['plugin.dsh-earthquake-alert', 'plugin.earthquake-stable-preferences'], requiredPlugins: ['dsh-earthquake-alert'],
    sources: [{ pluginName: 'dsh-earthquake-alert', sourceDir: sourceRelative, files: [...payload].map(([path, bytes]) => ({ path, sha256: hash(bytes) })) }],
  }
  for (const profile of [current, candidate]) {
    await put(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-earthquake-alert': 'link:./local/dsh-earthquake-alert' }, dsh: { profile: { bundles: ['dsh-earthquake-alert'] } } }))
    const local = join(profile, 'local/dsh-earthquake-alert')
    for (const [file, bytes] of payload) await put(join(local, file), bytes)
    await mkdir(join(profile, 'node_modules'))
    await symlink(local, join(profile, 'node_modules/dsh-earthquake-alert'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const unrelated = join(root, 'Data/Plugins/unrelated/keep.json'), unchanged = '{"fixture":"keep unchanged"}\n'
  await put(unrelated, unchanged)
  const options = (profileDir: string) => ({ portableRoot: root, profileDir, manifest })
  const snapshot = captureCustomizationState(options(current))
  assert.ok(snapshot.plugins[0].files.some(file => file.path === 'lib/preferences.js'), 'The real payload scanner must capture the new imported helper')
  assert.equal(verifyCustomizationPreserved(snapshot, options(candidate)).ok, true)
  const withoutHelper: PreservationManifest = { ...manifest, sources: manifest.sources.map(item => ({ ...item, files: item.files.filter(file => file.path !== 'lib/preferences.js') })) }
  assert.ok(checkPreservationManifest(withoutHelper, manifest).issues.some(issue => issue.code === 'SOURCE_HASH_CHANGED' && issue.path === 'lib/preferences.js'))
  const missing = join(candidate, 'local/dsh-earthquake-alert/lib/preferences.js')
  const stat = await lstat(missing)
  assert.ok(stat.isFile() && !stat.isSymbolicLink())
  assert.ok(missing.startsWith(root + (process.platform === 'win32' ? '\\' : '/')), 'Only the exact owned fixture file may be removed')
  await unlink(missing)
  const lost = verifyCustomizationPreserved(snapshot, options(candidate))
  assert.equal(lost.ok, false)
  assert.ok(lost.issues.some(issue => issue.code === 'SOURCE_RUNTIME_UNAVAILABLE' && issue.path === 'lib/preferences.js'))
  await put(missing, payload.get('lib/preferences.js')!)
  const candidateClient = join(candidate, 'local/dsh-earthquake-alert/lib/client.js')
  await put(candidateClient, 'window.__ModuleLoader__.load({id:"dsh-earthquake-alert",factory:()=>({apply(){}})});\n')
  const reverted = verifyCustomizationPreserved(snapshot, options(candidate))
  assert.equal(reverted.ok, false)
  assert.ok(reverted.issues.some(issue => issue.code === 'SOURCE_RUNTIME_DRIFT' && issue.path === 'lib/client.js'))
  await put(candidateClient, payload.get('lib/client.js')!)
  assert.equal(verifyCustomizationPreserved(snapshot, options(candidate)).ok, true)
  for (const [file, bytes] of payload) {
    assert.deepEqual(await readFile(join(canonical, file)), bytes, 'Real canonical source changed during the fixture test')
    assert.deepEqual(await readFile(join(source, file)), bytes)
    assert.deepEqual(await readFile(join(current, 'local/dsh-earthquake-alert', file)), bytes)
  }
  assert.equal(await readFile(unrelated, 'utf8'), unchanged)
})
