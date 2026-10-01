import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { STORE_PACKAGES } from '../src/bundled-plugins.js'
import { buildSeedPluginArgs, buildSeedRemoveArgs, ensureProfileScaffold, officialRuntimeInstallArgs } from '../src/plugin-seed.js'
import { pnpmStoreOptions } from '../src/plugin-toolchain.js'
import { assertPortablePluginLockfile, discardCachedPolicyVerdict, mirrorPnpmStoreMetadata, pnpmStagingRegistryKey, stageBundledPlugins, verifyPreparedPluginStore } from '../scripts/prepare-runtime.js'

test('构建和补种共用随包元数据缓存，版本化 store 不会多嵌套 v11', () => {
  const store = join(tmpdir(), 'store')
  assert.deepEqual(pnpmStoreOptions(), [])
  assert.deepEqual(pnpmStoreOptions(store), ['--store-dir=' + store, '--cache-dir=' + store])
  assert.deepEqual(pnpmStoreOptions(join(store, 'v11')), ['--store-dir=' + join(store, 'v11'), '--cache-dir=' + store])
  for (const args of [buildSeedPluginArgs([], store, { storeDir: store }), buildSeedRemoveArgs([], store, { storeDir: store }), officialRuntimeInstallArgs(store, store)]) {
    assert.ok(args.includes('--cache-dir=' + store))
    assert.ok(!args.some(arg => /trust-policy|ignore-scripts/.test(arg)))
  }
  assert.equal(buildSeedPluginArgs([], store, { storeDir: store, cacheDir: join(store, 'cache'), offline: true })
    .filter(arg => arg.startsWith('--cache-dir=')).at(-1), '--cache-dir=' + join(store, 'cache'))
})

test('制品生成顺序固定为联网解析、冻结锁文件策略验证、真实离线补种', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-store-build-sequence-'))
  const previousNoRecycle = process.env.DSH_PREPARE_NO_RECYCLE
  // 此用例只验装配顺序，临时制品同步清理；不借用运行器的临时根作为回收根。
  process.env.DSH_PREPARE_NO_RECYCLE = '1'
  try {
    const store = join(root, 'store')
    mkdirSync(store)
    const calls: string[][] = []
    await stageBundledPlugins(root, root, args => {
      calls.push([...args])
      // verifyPreparedPluginStore 的离线补种带 --cache-dir=<store>/cache，前缀匹配两种形态。
      assert.ok(args.some(arg => arg.startsWith('--cache-dir=' + store)))
      const dir = args.find(arg => arg.startsWith('--dir='))?.slice(6) ?? args[args.indexOf('--dir') + 1]!
      // store 装配含退役保留项（上游 v1.0.66：RETAINED_STORE_PACKAGES 仍在离线仓库），mock 必须铺全量
      for (const plugin of STORE_PACKAGES) {
        const path = join(dir, 'node_modules', ...plugin.packageName.split('/'))
        mkdirSync(path, { recursive: true })
        writeFileSync(join(path, 'package.json'), JSON.stringify({ version: plugin.version }))
      }
      writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
      // 上游 v1.0.76 起随包仓库带完整性门禁（v11/index.db、cache），mock 必须铺出合法仓库形态。
      mkdirSync(join(store, 'v11', 'files'), { recursive: true })
      writeFileSync(join(store, 'v11', 'index.db'), '')
      mkdirSync(join(store, 'cache'), { recursive: true })
      const metadata = join(store, 'cache', 'v11', 'metadata', 'http%3A+127.0.0.1+5555')
      mkdirSync(metadata, { recursive: true })
      writeFileSync(join(metadata, 'fixture.jsonl'), 'fixture')
      writeFileSync(join(store, 'lockfile-verified.jsonl'), 'transient verdict')
      writeFileSync(join(store, 'cache', 'lockfile-verified.jsonl'), 'transient verdict')
    }, 'http://127.0.0.1:5555/')
    assert.equal(calls.length, 5)
    assert.equal(calls[0]![0], 'install')
    assert.ok(calls[1]!.includes('--frozen-lockfile'))
    // 第三跳是打包门禁的离线补种：随包锁冻结安装（上游 v1.0.76 的 buildFrozenSeedInstallArgs 形态）。
    assert.equal(calls[2]![0], 'install')
    assert.ok(calls[2]!.includes('--frozen-lockfile'))
    assert.ok(calls[2]!.includes('--offline'))
    assert.ok(calls[2]!.some(arg => arg.startsWith('--cache-dir=' + store)))
    assert.equal(calls[3]![0], 'add')
    assert.ok(calls[3]!.includes('--offline'))
    assert.ok(calls[4]!.includes('--frozen-lockfile'))
    assert.ok(calls[4]!.includes('--offline'))
    assert.equal(existsSync(join(store, 'lockfile-verified.jsonl')), false)
    assert.equal(existsSync(join(store, 'cache', 'lockfile-verified.jsonl')), false)
    assert.equal(existsSync(join(store, 'bundled-lock.yaml')), true)
    assert.equal(existsSync(join(root, 'offline-verification')), false)
  } finally {
    if (previousNoRecycle === undefined) delete process.env.DSH_PREPARE_NO_RECYCLE
    else process.env.DSH_PREPARE_NO_RECYCLE = previousNoRecycle
    await rm(root, { recursive: true, force: true })
  }
})

test('打包门禁实际走空白 Profile 补种，失败不能通过联网重试放行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-store-gate-'))
  try {
    const store = join(root, 'store'), verify = join(root, 'verify')
    await mkdir(store)
    // 上游 v1.0.76 的随包仓库完整性门禁要求真实仓库形态（bundled-lock.yaml、v11/index.db、cache）。
    mkdirSync(join(store, 'v11', 'files'), { recursive: true })
    writeFileSync(join(store, 'v11', 'index.db'), '')
    mkdirSync(join(store, 'cache'), { recursive: true })
    writeFileSync(join(store, 'bundled-lock.yaml'), 'lockfileVersion: 9.0\n')
    await writeFile(join(store, 'lockfile-verified.jsonl'), 'cached success must not bypass verification')
    await writeFile(join(store, 'cache', 'lockfile-verified.jsonl'), 'pnpm12 cached success')
    let calls = 0
    await assert.rejects(verifyPreparedPluginStore(verify, store, root, args => {
      calls++
      assert.equal(existsSync(join(store, 'lockfile-verified.jsonl')), false)
      assert.equal(existsSync(join(store, 'cache', 'lockfile-verified.jsonl')), false)
      assert.ok(args.includes('--offline'))
      assert.ok(args.some(arg => arg.startsWith('--cache-dir=' + store)))
      throw new Error('fixture missing supply-chain metadata')
    }))
    assert.equal(calls, 1)
    await assert.rejects(verifyPreparedPluginStore(verify, store, root), { code: 'EEXIST' })
    const success = join(root, 'success')
    await verifyPreparedPluginStore(success, store, root, args => {
      assert.ok(['install', 'add'].includes(args[0]!))
      for (const plugin of STORE_PACKAGES) {
        const path = join(success, 'node_modules', ...plugin.packageName.split('/'))
        mkdirSync(path, { recursive: true })
        writeFileSync(join(path, 'package.json'), JSON.stringify({ version: plugin.version }))
      }
    })
    await assert.rejects(verifyPreparedPluginStore(join(root, 'incomplete'), store, root, () => {}), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('published plugin locks reject transient or untrusted tarball sources without changing integrity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-lock-origin-'))
  try {
    const file = join(root, 'pnpm-lock.yaml')
    for (const url of ['http://127.0.0.1:49695/pkg.tgz', 'https://registry.npmmirror.com/pkg.tgz', 'https://user:secret@registry.npmjs.org/pkg.tgz']) {
      const body = JSON.stringify({packages:{'pkg@1.0.0':{resolution:{tarball:url,integrity:'sha512-proof'}}}})
      await writeFile(file, body)
      await assert.rejects(assertPortablePluginLockfile(file), /不可发布/)
      assert.equal(await readFile(file, 'utf8'), body)
    }
    for (const resolution of [{integrity:'sha512-proof'}, {integrity:'sha512-proof',tarball:'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz'}]) {
      await writeFile(file, JSON.stringify({packages:{'pkg@1.0.0':{resolution}}}))
      await assertPortablePluginLockfile(file)
    }
  } finally { await rm(root, {recursive:true,force:true}) }
})

test('pnpm12 registry key includes scheme and port; unsupported registry shapes fail closed', () => {
  assert.equal(pnpmStagingRegistryKey('https://registry.npmjs.org:443/'), 'https%3A+registry.npmjs.org')
  assert.equal(pnpmStagingRegistryKey('http://127.0.0.1:5555'), 'http%3A+127.0.0.1+5555')
  for (const registry of ['https://host/team/', 'https://user:secret@host/', 'file:///cache', 'https://host/?token=secret']) {
    assert.throws(() => pnpmStagingRegistryKey(registry), /registry/)
  }
})

test('metadata mirroring uses the explicit pnpm12 staging namespace, never unrelated registries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pnpm12-meta-'))
  try {
    for (const kind of ['metadata', 'metadata-full']) {
      const base = join(root, 'cache', 'v11', kind)
      const source = join(base, 'http%3A+127.0.0.1+5555', '@scope')
      const unrelated = join(base, 'https%3A+private.example')
      const canonical = join(base, 'https%3A+registry.npmjs.org', '@scope')
      await mkdir(source, { recursive: true })
      await mkdir(unrelated, { recursive: true })
      await mkdir(canonical, { recursive: true })
      await writeFile(join(source, 'pkg.jsonl'), `unchanged-${kind}`)
      await writeFile(join(unrelated, 'private.jsonl'), 'must not ship as public metadata')
      await writeFile(join(canonical, 'official-only.jsonl'), `official-only-${kind}`)
      await writeFile(join(canonical, 'overlap.jsonl'), `official-${kind}`)
      await writeFile(join(source, 'overlap.jsonl'), `proxy-${kind}`)
    }
    await mirrorPnpmStoreMetadata(root, 'http://127.0.0.1:5555/')
    for (const kind of ['metadata', 'metadata-full']) {
      const target = join(root, 'cache', 'v11', kind, 'https%3A+registry.npmjs.org')
      assert.equal(await readFile(join(target, '@scope', 'pkg.jsonl'), 'utf8'), `unchanged-${kind}`)
      assert.equal(await readFile(join(target, '@scope', 'official-only.jsonl'), 'utf8'), `official-only-${kind}`)
      assert.equal(await readFile(join(target, '@scope', 'overlap.jsonl'), 'utf8'), `official-${kind}`)
      assert.equal(existsSync(join(target, 'private.jsonl')), false)
    }
    await assert.rejects(mirrorPnpmStoreMetadata(root, 'http://127.0.0.1:9999/'), /缺少/)
    await writeFile(join(root, 'cache', 'lockfile-verified.jsonl'), 'cached verdict')
    await discardCachedPolicyVerdict(root)
    assert.equal(existsSync(join(root, 'cache', 'lockfile-verified.jsonl')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
