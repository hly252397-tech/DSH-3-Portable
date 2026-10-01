import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

const script = resolve('scripts/install-dsh-awareness-manual.mjs')
const api = () => import(pathToFileURL(script).href)
const names = ['dsh-system-awareness', 'dsh-manual']
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'dsh-awareness-install-'))
  const profileDir = join(repositoryRoot, 'Data', 'DSH', 'profiles', 'web')
  const sourceRoot = join(repositoryRoot, 'plugins')
  await mkdir(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  const manifest = { name: 'isolated-fixture', private: true, dependencies: { existing: '1.0.0' }, dsh: { profile: { bundles: ['existing'], fixture: true } } }
  await writeFile(manifestPath, json(manifest))
  await writeFile(join(profileDir, 'cordis.patch.yml'), '# unchanged user patch\n[]\n')
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), '# unchanged dependency matrix\n')
  const manualPath = join(repositoryRoot, 'Data', 'DSH', 'manual', 'authored', 'user-note.md')
  await mkdir(dirname(manualPath), { recursive: true })
  await writeFile(manualPath, '# 用户知识，升级与回退都保留\n')
  for (const name of names) {
    const dir = join(sourceRoot, name)
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'package.json'), json({ name, version: '0.1.0', type: 'module', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(dir, 'cordis.patch.yml'), `- insert:\n  - id: ${name}\n    name: ${name}\n`)
    await writeFile(join(dir, 'lib', 'index.js'), `export const name = '${name}'\nexport function apply() {}\n`)
  }
  return { repositoryRoot, profileDir, sourceRoot, manifestPath, manifest, manualPath }
}

test('awareness installer dry-run is read-only and identifies only the two plugins', async () => {
  const { planInstall } = await api()
  const f = await fixture()
  const before = await readFile(f.manifestPath, 'utf8')
  const plan = await planInstall(f)
  assert.equal(plan.activation, 'not-performed')
  assert.deepEqual(plan.packages.map((item: { name: string }) => item.name), names)
  assert.equal(await readFile(f.manifestPath, 'utf8'), before)
  assert.equal(existsSync(join(f.profileDir, 'local')), false)
  assert.equal(existsSync(join(f.repositoryRoot, 'Data', 'Updates')), false)
})

test('awareness default deployment resolves schema1/schema2 active homes without changing explicit plugin source or Profile', async () => {
  const { planInstall } = await api()
  const f = await fixture()
  const active = join(f.repositoryRoot, 'Data/DSH-generations/active/home/profiles/web')
  const current = { version: '0.2.0-rc.2', relativePath: 'Harness/slots/rc2' }
  const put = async (relative: string, value: unknown): Promise<void> => {
    const file = join(f.repositoryRoot, relative)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, json(value))
  }
  await put('Data/Runtime/Harness/current.json', { schema: 1, current })
  await mkdir(join(f.repositoryRoot, 'Data/Runtime', current.relativePath), { recursive: true })
  await put('Data/DSH-generations/active/home/profiles/web/package.json', f.manifest)
  const before = await readFile(f.manifestPath, 'utf8')
  for (const schema of [1, 2]) {
    await put('Data/Updates/Harness/homes/0.2.0-rc.2.json', {
      schema, runtimeVersion: current.version, generation: 'active',
      ...(schema === 2 ? { runtimeRelativePath: `Data/Runtime/${current.relativePath}` } : {}),
    })
    const plan = await planInstall({ repositoryRoot: f.repositoryRoot, sourceRoot: f.sourceRoot })
    // Windows 大小写：tmpdir 环境变量是 C:WINDOWSTEMP，运行时解析返回 C:WindowsTemp——
    // 路径比较按平台大小写语义归一，别拿环境变量的大小写当判据。
    const samePath = process.platform === 'win32' ? plan.profileDir.toLowerCase() === active.toLowerCase() : plan.profileDir === active
    assert.ok(samePath, `profileDir 不一致: ${plan.profileDir} vs ${active}`)
    assert.equal(plan.sourceRoot, f.sourceRoot, 'installer source is still the plugin package root')
    // 同上：startsWith 也按平台大小写语义归一
    const localPrefix = join(active, 'local')
    assert.ok(plan.packages.every((item: { target: string }) => process.platform === 'win32' ? item.target.toLowerCase().startsWith(localPrefix.toLowerCase()) : item.target.startsWith(localPrefix)))
    assert.equal((await planInstall(f)).profileDir, f.profileDir, 'explicit --profile retains its target')
  }
  await put('Data/Updates/Harness/homes/0.2.0-rc.2.json', { schema: 2, runtimeVersion: current.version, generation: 'active', runtimeRelativePath: 'Data/Runtime/Harness/slots/other' })
  await assert.rejects(planInstall({ repositoryRoot: f.repositoryRoot, sourceRoot: f.sourceRoot }), /mapping/)
  assert.equal(await readFile(f.manifestPath, 'utf8'), before)
  assert.equal(existsSync(join(active, 'local')), false)
  assert.equal(existsSync(join(active, 'node_modules')), false)
})

test('awareness install and dry-run reject pending runtime transactions even with an explicit Profile', async () => {
  const { planInstall, install } = await api()
  const f = await fixture()
  const pointerPath = join(f.repositoryRoot, 'Data/Runtime/Harness/current.json')
  const current = { version: '0.2.0-rc.2', relativePath: 'Harness/slots/rc2' }
  await mkdir(dirname(pointerPath), { recursive: true })
  await mkdir(join(f.repositoryRoot, 'Data/Runtime', current.relativePath), { recursive: true })
  const before = await readFile(f.manifestPath, 'utf8')
  const noteBefore = await readFile(f.manualPath, 'utf8')
  for (const pendingTransactionId of ['11111111-1111-4111-8111-111111111111', '', null, 0, {}]) {
    const pointer = json({ schema: 1, current, pendingTransactionId })
    await writeFile(pointerPath, pointer)
    for (const profileDir of [undefined, f.profileDir]) {
      const options = { repositoryRoot: f.repositoryRoot, sourceRoot: f.sourceRoot, ...(profileDir === undefined ? {} : { profileDir }) }
      await assert.rejects(planInstall(options), (error: any) => error.code === 'RUNTIME_TRANSACTION_PENDING')
      await assert.rejects(install(options), (error: any) => error.code === 'RUNTIME_TRANSACTION_PENDING')
    }
    assert.equal(await readFile(pointerPath, 'utf8'), pointer)
  }
  assert.equal(await readFile(f.manifestPath, 'utf8'), before)
  assert.equal(await readFile(f.manualPath, 'utf8'), noteBefore)
  assert.equal(existsSync(join(f.profileDir, 'local')), false)
  assert.equal(existsSync(join(f.profileDir, 'node_modules')), false)
  assert.equal(existsSync(join(f.repositoryRoot, 'Data/Updates')), false)
  await writeFile(pointerPath, json({ schema: 1, current }))
  assert.equal((await planInstall(f)).profileDir, f.profileDir, 'explicit target works again after the transaction field is absent')
})

test('awareness install and field-scoped rollback preserve later unrelated edits and manual knowledge', async () => {
  const { install, rollback } = await api()
  const f = await fixture()
  const result = await install(f)
  const current = JSON.parse(await readFile(f.manifestPath, 'utf8'))
  for (const name of names) {
    assert.equal(current.dependencies[name], `link:./local/${name}`)
    assert.ok(current.dsh.profile.bundles.includes(name))
    assert.equal(await realpath(join(f.profileDir, 'node_modules', name)), await realpath(join(f.profileDir, 'local', name)))
  }
  current.dependencies['other-task'] = '2.0.0'
  current.dsh.profile.bundles.push('other-task')
  current.dsh.profile.displayPreference = 'unified'
  await writeFile(f.manifestPath, json(current))
  assert.equal((await rollback({ ...f, receiptPath: result.receiptPath, dryRun: true })).action, 'rollback-dry-run')
  assert.ok(existsSync(join(f.profileDir, 'local', names[0])))
  const rolled = await rollback({ ...f, receiptPath: result.receiptPath })
  assert.equal(rolled.activation, 'not-performed')
  const after = JSON.parse(await readFile(f.manifestPath, 'utf8'))
  assert.deepEqual(after.dependencies, { existing: '1.0.0', 'other-task': '2.0.0' })
  assert.deepEqual(after.dsh.profile.bundles, ['existing', 'other-task'])
  assert.equal(after.dsh.profile.displayPreference, 'unified')
  assert.equal(await readFile(f.manualPath, 'utf8'), '# 用户知识，升级与回退都保留\n')
  assert.equal(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8'), '# unchanged user patch\n[]\n')
  assert.equal(await readFile(join(f.profileDir, 'pnpm-lock.yaml'), 'utf8'), '# unchanged dependency matrix\n')
  for (const name of names) {
    assert.equal(existsSync(join(f.profileDir, 'local', name)), false)
    assert.equal(existsSync(join(f.profileDir, 'node_modules', name)), false)
    assert.ok(existsSync(join(dirname(result.receiptPath), 'rolled-back', name, 'lib', 'index.js')))
  }
  assert.equal(existsSync(join(f.profileDir, '.dsh-reload-request')), false)
})

test('awareness upgrade backs up owned deployment and rollback restores previous artifacts', async () => {
  const { install, rollback } = await api()
  const f = await fixture()
  await install(f)
  const deployed = join(f.profileDir, 'local', names[0], 'lib', 'index.js')
  const oldCode = await readFile(deployed, 'utf8')
  await writeFile(join(f.sourceRoot, names[0], 'lib', 'index.js'), `${oldCode}\nexport const changed = true\n`)
  const update = await install(f)
  assert.match(await readFile(deployed, 'utf8'), /changed = true/)
  assert.equal(await readFile(join(dirname(update.receiptPath), 'previous', names[0], 'lib', 'index.js'), 'utf8'), oldCode)
  await rollback({ ...f, receiptPath: update.receiptPath })
  assert.equal(await readFile(deployed, 'utf8'), oldCode)
  assert.equal(await realpath(join(f.profileDir, 'node_modules', names[0])), await realpath(join(f.profileDir, 'local', names[0])))
  const after = JSON.parse(await readFile(f.manifestPath, 'utf8'))
  assert.ok(after.dsh.profile.bundles.includes(names[0]))
})

test('awareness installer rejects foreign same-name deployments without touching their files', async () => {
  const { install } = await api()
  const f = await fixture()
  const foreign = join(f.profileDir, 'local', names[0])
  await mkdir(foreign, { recursive: true })
  await writeFile(join(foreign, 'keep.txt'), 'belongs to another task')
  await assert.rejects(install(f), { code: 'FOREIGN_DEPLOYMENT' })
  assert.equal(await readFile(join(foreign, 'keep.txt'), 'utf8'), 'belongs to another task')
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')), f.manifest)
})

test('awareness preflight hash and final manifest CAS reject stale snapshots', async () => {
  const { planInstall, install, commitManifestCas } = await api()
  const f = await fixture()
  const plan = await planInstall(f)
  const current = { ...f.manifest, changedByAnotherTask: true }
  await writeFile(f.manifestPath, json(current))
  await assert.rejects(install({ ...f, expectedManifestSha256: plan.manifestSha256 }), { code: 'MANIFEST_CONFLICT' })
  await assert.rejects(commitManifestCas(f.manifestPath, plan.manifestSha256, f.manifest), { code: 'MANIFEST_CONFLICT' })
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')), current)
  assert.equal(existsSync(join(f.profileDir, 'local')), false)
  assert.equal((await readdir(f.profileDir)).filter(file => file.endsWith('.tmp')).length, 0)
})

test('awareness rollback rejects newer edits to its own files or manifest fields', async () => {
  const { install, rollback } = await api()
  const f = await fixture()
  const result = await install(f)
  const current = await readFile(f.manifestPath, 'utf8')
  const deployed = join(f.profileDir, 'local', names[0], 'lib', 'index.js')
  const oldCode = await readFile(deployed, 'utf8')
  await writeFile(deployed, `${oldCode}\n// concurrent edit\n`)
  await assert.rejects(rollback({ ...f, receiptPath: result.receiptPath }), { code: 'ROLLBACK_CONFLICT' })
  assert.equal(await readFile(f.manifestPath, 'utf8'), current)
  await writeFile(deployed, oldCode)
  const edited = JSON.parse(current)
  edited.dependencies[names[0]] = 'different-source'
  await writeFile(f.manifestPath, json(edited))
  await assert.rejects(rollback({ ...f, receiptPath: result.receiptPath }), { code: 'ROLLBACK_CONFLICT' })
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')), edited)
  assert.ok(existsSync(deployed))
})

test('awareness installer rejects link escapes and leaves foreign linked targets intact', async () => {
  const { install } = await api()
  const f = await fixture()
  const foreign = await mkdtemp(join(tmpdir(), 'dsh-awareness-foreign-'))
  await writeFile(join(foreign, 'keep.txt'), 'never delete link target')
  await mkdir(join(f.profileDir, 'node_modules'), { recursive: true })
  await symlink(foreign, join(f.profileDir, 'node_modules', names[0]), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(install(f), { code: 'FOREIGN_DEPLOYMENT' })
  assert.equal(await readFile(join(foreign, 'keep.txt'), 'utf8'), 'never delete link target')
  await assert.rejects(install({ ...f, profileDir: foreign }), { code: 'UNSAFE_PATH' })
})

test('awareness installer refuses symlink-containing sources and a concurrent installer lock', async () => {
  const { install } = await api()
  const f = await fixture()
  const foreign = await mkdtemp(join(tmpdir(), 'dsh-awareness-source-link-'))
  await symlink(foreign, join(f.sourceRoot, names[0], 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(install(f), { code: 'UNSAFE_PATH' })
  const another = await fixture()
  const lock = join(another.profileDir, 'package.json.lock')
  await writeFile(lock, 'existing installer owns this')
  await assert.rejects(install(another), { code: 'INSTALL_BUSY' })
  assert.equal(await readFile(lock, 'utf8'), 'existing installer owns this')
  assert.equal(existsSync(join(another.profileDir, 'local')), false)
})

test('awareness rollback refuses stale receipts after a newer install', async () => {
  const { install, rollback } = await api()
  const f = await fixture()
  const older = await install(f)
  const newer = await install(f)
  await assert.rejects(rollback({ ...f, receiptPath: older.receiptPath }), { code: 'ROLLBACK_CONFLICT' })
  await rollback({ ...f, receiptPath: newer.receiptPath })
  await rollback({ ...f, receiptPath: older.receiptPath })
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')), f.manifest)
})

test('awareness rollback refuses missing links before changing the profile', async () => {
  const { install, rollback } = await api()
  const f = await fixture()
  const result = await install(f)
  const before = await readFile(f.manifestPath, 'utf8')
  await unlink(join(f.profileDir, 'node_modules', names[0]))
  await assert.rejects(rollback({ ...f, receiptPath: result.receiptPath }), { code: 'ROLLBACK_CONFLICT' })
  assert.equal(await readFile(f.manifestPath, 'utf8'), before)
  assert.ok(existsSync(join(f.profileDir, 'local', names[0])))
})

test('installed awareness and manual bundles compose through the real Profile and Loader and dispose cleanly', async t => {
  const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))
  const schemaDir = resolve('Data/DSH/profiles/web/node_modules/schemastery')
  if (!runtime || !existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')) || !existsSync(schemaDir)) {
    return t.skip('实机运行时/Schema 缺失（CI 全新检出）；纯安装器测试不依赖 Data')
  }
  const { install, rollback } = await api()
  const f = await fixture()
  for (const name of names) await cp(resolve('plugins', name), join(f.sourceRoot, name), { recursive: true, force: true })
  await writeFile(f.manifestPath, json({ name: 'real-loader-isolated', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
  const installed = await install(f)
  const official = join(runtime, 'node_modules/@deepseek-ai')
  await symlink(official, join(f.profileDir, 'node_modules/@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(schemaDir, join(f.profileDir, 'node_modules/schemastery'), process.platform === 'win32' ? 'junction' : 'dir')
  const appBoot = await import(pathToFileURL(join(official, 'dsh-app-boot/lib/index.js')).href)
  const installAnchor = join(official, 'dsh/package.json')
  const profile = appBoot.loadProfileDirectory('isolated-awareness-test', f.profileDir, installAnchor)
  assert.deepEqual(profile.layers.map((layer: { packageName: string }) => layer.packageName), names)
  const home = join(f.repositoryRoot, 'Data/DSH')
  const baseConfig = join(f.profileDir, 'fixture-base.yml')
  await writeFile(baseConfig, '[]\n')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let ctx: any
  try {
    ctx = await appBoot.boot('isolated-awareness-test', baseConfig, profile.layers.flatMap((layer: { patches: unknown[] }) => layer.patches), async (root: any) => {
      root.provide('profileContext', { name: 'isolated-awareness-test', dir: f.profileDir, patchPath: profile.patchPath, cwd: f.repositoryRoot, home, installAnchor, startedBundles: names, overlays: [] })
      for (const [name, config] of [
        ['dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: true }],
        ['dsh-tools', { mode: 'native' }],
      ] as const) {
        const plugin = await import(pathToFileURL(join(official, name, 'lib/index.js')).href)
        const fiber = root.plugin(plugin.default, config)
        await fiber
        assert.equal(fiber.state, 2, name + ' fixture service must activate')
      }
    }, pathToFileURL(f.manifestPath).href)
    const loader = ctx.get('loader')
    const entries = [...loader.entries()]
    for (const name of names) {
      const entry = entries.find((entry: any) => entry.options?.name === name || entry.options?.id === name)
      assert.ok(entry, `${name} must be present in the real composed loader tree`)
      assert.equal(entry.fiber?.state, 2, `${name} must be ACTIVE, not pending or failed`)
    }
    const tools = ctx.tools
    const prompt = ctx.systemPrompt
    const available = tools.schemas().map((tool: { name: string }) => tool.name)
    assert.ok(available.includes('dsh_capabilities'))
    assert.ok(available.includes('dsh_manual'))
    const assembly = await prompt.assemble({ signal: new AbortController().signal })
    assert.ok(assembly.contexts.some((item: { name: string; text: string }) => item.name === 'dsh:system-awareness' && item.text.includes('DSH')))
    assert.ok(existsSync(join(home, 'manual')), 'manual store must be inside fixture DSH home, not the production home')
    for (const name of [...names].reverse()) {
      const entry = entries.find((entry: any) => entry.options?.name === name || entry.options?.id === name)
      await entry.fiber.dispose()
    }
    assert.equal(tools.schemas().some((tool: { name: string }) => ['dsh_capabilities', 'dsh_manual'].includes(tool.name)), false)
    assert.equal((await prompt.assemble({ signal: new AbortController().signal })).contexts.some((item: { name: string }) => item.name === 'dsh:system-awareness'), false)
    await rollback({ ...f, receiptPath: installed.receiptPath })
    assert.equal(existsSync(join(home, 'manual')), true, 'plugin rollback must leave the handbook intact')
  } finally {
    await ctx?.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    // Only unlink fixture links; never recursively remove their real runtime targets.
    await unlink(join(f.profileDir, 'node_modules/@deepseek-ai'))
    await unlink(join(f.profileDir, 'node_modules/schemastery'))
  }
})
