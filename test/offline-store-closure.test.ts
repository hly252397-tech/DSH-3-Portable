import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BUNDLED_PLUGINS } from '../src/bundled-plugins.js'
import { buildSeedPluginArgs, buildSeedRemoveArgs, ensureProfileScaffold, officialRuntimeInstallArgs, seedPackagedPluginLockfile } from '../src/plugin-seed.js'
import { pnpmStoreOptions } from '../src/plugin-toolchain.js'
import { stageBundledPlugins, verifyPreparedPluginStore } from '../scripts/prepare-runtime.js'

test('构建和补种共用随包元数据缓存，版本化 store 不会多嵌套 v11', () => {
  const store = join(tmpdir(), 'store')
  assert.deepEqual(pnpmStoreOptions(), [])
  assert.deepEqual(pnpmStoreOptions(store), ['--store-dir=' + store, '--cache-dir=' + store])
  assert.deepEqual(pnpmStoreOptions(join(store, 'v11')), ['--store-dir=' + join(store, 'v11'), '--cache-dir=' + store])
  for (const args of [buildSeedPluginArgs([], store, { storeDir: store }), buildSeedRemoveArgs([], store, { storeDir: store }), officialRuntimeInstallArgs(store, store)]) {
    assert.ok(args.includes('--cache-dir=' + store))
    assert.ok(!args.some(arg => /trust-policy|ignore-scripts/.test(arg)))
  }
})

test('制品生成顺序固定为联网解析、冻结锁文件策略验证、真实离线补种', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-build-sequence-'))
  try {
    const store = join(root, 'store')
    mkdirSync(store)
    const calls: string[][] = []
    await stageBundledPlugins(root, root, args => {
      calls.push([...args])
      assert.ok(args.includes('--cache-dir=' + store))
      const dir = args.find(arg => arg.startsWith('--dir='))?.slice(6) ?? args[args.indexOf('--dir') + 1]!
      for (const plugin of BUNDLED_PLUGINS) {
        const path = join(dir, 'node_modules', ...plugin.packageName.split('/'))
        mkdirSync(path, { recursive: true })
        writeFileSync(join(path, 'package.json'), JSON.stringify({ version: plugin.version }))
      }
      writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
      writeFileSync(join(store, 'lockfile-verified.jsonl'), 'transient verdict')
    })
    assert.equal(calls.length, 3)
    assert.equal(calls[0]![0], 'install')
    assert.ok(calls[1]!.includes('--frozen-lockfile'))
    assert.equal(calls[2]![0], 'add')
    assert.ok(calls[2]!.includes('--offline'))
    assert.equal(existsSync(join(store, 'lockfile-verified.jsonl')), false)
    assert.equal(existsSync(join(store, 'dsh-store-lock.yaml')), true)
    assert.equal(existsSync(join(root, 'offline-verification')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('锁文件只原子补到全新 profile，保留已有锁、依赖和配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seed-lock-'))
  try {
    const profile = join(root, 'profile'), store = join(root, 'store')
    await mkdir(store)
    await ensureProfileScaffold(profile)
    const manifest = await readFile(join(profile, 'package.json'), 'utf8')
    assert.equal(await seedPackagedPluginLockfile(profile, store), false)
    await writeFile(join(store, 'dsh-store-lock.yaml'), "lockfileVersion: '9.0'\n")
    const results = await Promise.all([seedPackagedPluginLockfile(profile, store), seedPackagedPluginLockfile(profile, store)])
    assert.deepEqual(results.sort(), [false, true])
    assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), manifest)
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'user lock')
    assert.equal(await seedPackagedPluginLockfile(profile, store), false)
    assert.equal(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8'), 'user lock')
    assert.equal((await readdir(profile)).some(name => name.startsWith('.seed-lock-')), false)
    const existing = join(root, 'existing')
    await ensureProfileScaffold(existing)
    await writeFile(join(existing, 'package.json'), JSON.stringify({ devDependencies: { custom: '1.0.0' } }))
    assert.equal(await seedPackagedPluginLockfile(existing, store), false)
    assert.equal(existsSync(join(existing, 'pnpm-lock.yaml')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('打包门禁实际走空白 Profile 补种，失败不能通过联网重试放行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-store-gate-'))
  try {
    const store = join(root, 'store'), verify = join(root, 'verify')
    await mkdir(store)
    await writeFile(join(store, 'lockfile-verified.jsonl'), 'cached success must not bypass verification')
    let calls = 0
    await assert.rejects(verifyPreparedPluginStore(verify, store, root, args => {
      calls++
      assert.equal(existsSync(join(store, 'lockfile-verified.jsonl')), false)
      assert.ok(args.includes('--offline'))
      assert.ok(args.includes('--cache-dir=' + store))
      throw new Error('fixture missing supply-chain metadata')
    }))
    assert.equal(calls, 1)
    await assert.rejects(verifyPreparedPluginStore(verify, store, root), { code: 'EEXIST' })
    const success = join(root, 'success')
    await verifyPreparedPluginStore(success, store, root, args => {
      assert.equal(args[0], 'add')
      for (const plugin of BUNDLED_PLUGINS) {
        const path = join(success, 'node_modules', ...plugin.packageName.split('/'))
        mkdirSync(path, { recursive: true })
        writeFileSync(join(path, 'package.json'), JSON.stringify({ version: plugin.version }))
      }
    })
    await assert.rejects(verifyPreparedPluginStore(join(root, 'incomplete'), store, root, () => {}), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
