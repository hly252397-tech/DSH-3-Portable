import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

test('spaces rc.2 real Profile/Loader exposes live Config and persists form edits', async t => {
  const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))
  if (!runtime) { t.skip('No installed runtime'); return }
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const load = (name: string) => import(pathToFileURL(join(official, name, 'lib/index.js')).href)
  const home = await mkdtemp(join(tmpdir(), 'spaces-rc2-'))
  const dir = join(home, 'profiles/test')
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(official, join(dir, 'node_modules/@deepseek-ai'), 'junction')
  await cp(resolve('customizations/custom-spaces'), join(dir, 'node_modules/dsh-custom-spaces'), { recursive: true, filter: path => !path.includes('evidence') })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'spaces-test', private: true, dsh: { profile: { bundles: ['dsh-custom-spaces'] } } }))
  const patchPath = join(dir, 'cordis.patch.yml')
  const initial = [{ name: 'Saved', url: 'https://example.invalid/', enabled: true }]
  await writeFile(patchPath, JSON.stringify([{ id: 'custom-spaces', name: 'dsh-custom-spaces', config: { spaces: initial } }]))
  const profileContext = { name: 'test', dir, patchPath, home, installAnchor: join(official, 'dsh/package.json'), cwd: dir, startedBundles: ['dsh-custom-spaces'], overlays: [], telemetryDisabledEnv: undefined }
  const rootConfig = join(dir, 'base.json')
  await writeFile(rootConfig, JSON.stringify(['dsh-config-editor', 'dsh-settings'].map(name => ({ id: name, name: pathToFileURL(join(official, name, 'lib/index.js')).href }))))
  const boot = await load('dsh-app-boot')
  const ctx = await boot.boot('spaces-test', rootConfig, boot.readProfilePatches('spaces-test', profileContext), (host: any) => host.provide('profileContext', profileContext))
  t.after(() => ctx.fiber.dispose())
  const entry = [...ctx.loader.entries()].find((e: any) => e.options.id === 'custom-spaces') as any
  assert.equal(entry?.fiber.state, 2)
  const section = () => ctx.settings.describe().find((s: any) => s.ns === 'custom-spaces')
  assert.deepEqual(section().value.spaces, initial)
  assert.equal(section().autoGenerate, false)
  const revision = section().revision
  const next = [{ ...initial[0], name: 'Renamed' }]
  await ctx.settings.mutate('custom-spaces', [{ op: 'set', path: ['spaces'], value: next }], revision)
  assert.deepEqual(section().value.spaces, next)
  assert.match(await readFile(patchPath, 'utf8'), /Renamed/)
  await assert.rejects(ctx.settings.mutate('custom-spaces', [{ op: 'set', path: ['spaces'], value: initial }], revision), /revision|changed|conflict/i)
  await assert.rejects(ctx.settings.mutate('custom-spaces', [{ op: 'set', path: ['spaces'], value: Array(6).fill(initial[0]) }]), /5|length|maximum|long/i)
  await entry.fiber.dispose()
  assert.equal(section(), undefined)
})

async function clientRig(sourcePath = 'customizations/custom-spaces/lib/client.js') {
  const source = await readFile(sourcePath, 'utf8')
  let cursor = 0
  const hooks: any[] = []
  const entries = new Map<string, any>()
  const pending: ((value: boolean) => void)[] = []
  const timers = new Map<number, () => void>()
  let tick = 0
  const state = { status: 'ready', writable: true, value: { spaces: [{ name: 'Saved', url: 'https://example.invalid/', enabled: true }] } }
  const scope = { getSnapshot: () => state, subscribe: () => () => {}, set: () => new Promise<boolean>(done => pending.push(done)) }
  const h = (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children: children.flat() })
  const react = {
    createElement: h,
    useCallback: (fn: any) => fn,
    useSyncExternalStore: (_sub: any, get: any) => get(),
    useState(initial: any) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (v: any) => { hooks[i] = v }] },
    useRef(initial: any) { const i = cursor++; return hooks[i] ??= { current: initial } },
    useEffect: () => {},
  }
  let plugin: any
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (spec: any) => { plugin = spec.factory(() => react) } } },
    document: { querySelector: () => ({}), head: { appendChild() {} } },
    setTimeout: (fn: () => void) => { timers.set(++tick, fn); return tick },
    clearTimeout: (id: number) => timers.delete(id), console,
  })
  const ctx = {
    effect: (fn: any) => fn(), inject: () => {},
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    configForms: { get: (id: string) => { assert.equal(id, 'custom-spaces'); return scope } },
    slots: { inject: (_name: any, fn: any) => fn(), register: (options: any, component: any) => { entries.set(options.id, { options, component }); return () => {} } },
  }
  plugin.apply(ctx)
  const render = () => { cursor = 0; const row = entries.get('custom-spaces'); return row.component({ ...row.options.inject(), renderSlot: (name: string) => { assert.equal(name, 'custom-spaces.services'); return null } }) }
  const flatten = (node: any): any[] => typeof node === 'object' && node !== null ? [node, ...(node.children ?? []).flatMap(flatten)] : []
  const editName = (name: string) => flatten(render()).find(x => x.type === 'input' && x.props.placeholder === 'name').props.onChange({ target: { value: name } })
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  return { plugin, state, pending, render, flatten, editName, flush }
}

test('spaces client uses current configForms API; archived legacy client fails without settingsScope', async () => {
  const rig = await clientRig()
  assert.ok(rig.plugin.inject.includes('configForms'))
  assert.equal(rig.plugin.inject.includes('settingsScope'), false)
  assert.ok(rig.flatten(rig.render()).some(x => x.type === 'button' && x.children.includes('add')))
  const before = 'Data/Temp/custom-spaces-rc2-before/client.js'
  if (existsSync(before)) await assert.rejects(clientRig(before), /bind|undefined/)
})

test('spaces rejected save retains draft and does not report saved', async () => {
  const rig = await clientRig()
  rig.editName('Unsaved'); rig.flush()
  rig.pending.shift()!(false)
  await new Promise(done => setImmediate(done))
  const nodes = rig.flatten(rig.render())
  assert.ok(nodes.some(x => x.props.value === 'Unsaved'))
  assert.ok(nodes.some(x => x.children.includes('saveRejected')))
  assert.equal(nodes.some(x => x.children.includes('saved')), false)
})

test('spaces late accepted save cannot discard a newer draft', async () => {
  const rig = await clientRig()
  rig.editName('First'); rig.flush()
  rig.editName('Second')
  rig.pending.shift()!(true)
  await new Promise(done => setImmediate(done))
  assert.ok(rig.flatten(rig.render()).some(x => x.props.value === 'Second'))
  rig.flush(); rig.state.value.spaces[0].name = 'Second'; rig.pending.shift()!(true)
  await new Promise(done => setImmediate(done))
  assert.ok(rig.flatten(rig.render()).some(x => x.children.includes('saved')))
})
