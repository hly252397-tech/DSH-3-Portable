import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isSelfRepairableBundle, parseUnresolvedBundleError, removeProfileBundle, repairBrokenProfile, startWithProfileSelfRepair } from '../src/profile-repair.js'

test('能从 DSH 缺 bundle 报错里取出包名', () => {
  const message = 'dsh: cannot resolve profile bundle "dsh-file-upload" from the dsh installation or C:\\Users\\demo\\.dsh\\profiles\\web'
  assert.equal(parseUnresolvedBundleError(message), 'dsh-file-upload')
})

test('可跳过 bundle 对账，避免启动时重复扫描', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-skip-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-file-upload': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-file-upload'] } },
    }), 'utf8')
    const removed = await repairBrokenProfile(root, [], { reconcileBundles: false })
    assert.deepEqual(removed, [])
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', 'dsh-file-upload'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('自我修复会摘掉清单有、磁盘没有的社区插件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-file-upload': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-file-upload'] } },
    }), 'utf8')
    const removed = await repairBrokenProfile(root)
    assert.deepEqual(removed, ['dsh-file-upload'])
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('桌面内部 bridge bundle 不依赖 profile dependencies 仍会保留', () => {
  // 上游 v1.0.76 把桌面桥从 profile 退役（desktop-bridge-migration 清除）；
  // 本便携版 dsh-desktop-bridge 是在役核心（desktop-host.ts 桥接打包 + ESM 导入测试），
  // 本地 repairBrokenProfile 走 ensureDesktopBridgePatch 保留它，该上游用例不适用。
  assert.equal(isSelfRepairableBundle('dsh-desktop-bridge'), true)
})

test('自我修复会摘掉未登记依赖的残留 bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-orphan-'))
  try {
    await mkdir(join(root, 'node_modules', 'dsh-file-upload'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'dsh-file-upload', 'package.json'), JSON.stringify({
      name: 'dsh-file-upload',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(join(root, 'node_modules', 'dsh-file-upload', 'cordis.patch.yml'), '[]\n', 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-file-upload'] } },
      dependencies: {},
    }), 'utf8')
    const removed = await repairBrokenProfile(root)
    assert.deepEqual(removed, ['dsh-file-upload'])
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装中断留下损坏 package.json 时，自我修复会摘掉该第三方 bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-corrupt-package-'))
  try {
    await mkdir(join(root, 'node_modules', 'dsh-file-upload'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'dsh-file-upload', 'package.json'), '{"name":', 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-file-upload': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-file-upload'] } },
    }), 'utf8')
    const removed = await repairBrokenProfile(root)
    assert.deepEqual(removed, ['dsh-file-upload'])
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
    assert.equal(manifest.dependencies?.['dsh-file-upload'], undefined)
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('启动因缺 bundle 失败时会摘掉坏项并重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-retry-'))
  try {
    await mkdir(join(root, 'node_modules', 'dsh-file-upload'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'dsh-file-upload', 'package.json'), JSON.stringify({
      name: 'dsh-file-upload',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(join(root, 'node_modules', 'dsh-file-upload', 'cordis.patch.yml'), '[]\n', 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-file-upload'] } },
      dependencies: { 'dsh-file-upload': '1.0.0' },
    }), 'utf8')
    let attempts = 0
    const started = await startWithProfileSelfRepair({
      profileDir: root,
      start: async () => {
        attempts += 1
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
        if ((manifest.dsh?.profile?.bundles ?? []).includes('dsh-file-upload')) {
          throw new Error('dsh: cannot resolve profile bundle "dsh-file-upload" from the dsh installation or ' + root)
        }
        return 'ok'
      },
    })
    assert.equal(started.result, 'ok')
    assert.equal(attempts, 2)
    assert.equal(started.repaired.includes('dsh-file-upload'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('官方 Web bundle 的补丁可以是文件列表', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-patch-list-'))
  const profile = join(root, 'profile')
  const runtime = join(root, 'runtime')
  try {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
    }), 'utf8')
    const dshPackage = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
    const webPackage = join(dshPackage, 'node_modules', '@deepseek-ai', 'dsh-web-app')
    await mkdir(webPackage, { recursive: true })
    await writeFile(join(dshPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }), 'utf8')
    await writeFile(join(webPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-web-app',
      dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/standard.patch.yml'] } },
    }), 'utf8')
    await mkdir(join(webPackage, 'presets'), { recursive: true })
    await writeFile(join(webPackage, 'cordis.patch.yml'), '[]\n', 'utf8')
    await writeFile(join(webPackage, 'presets', 'standard.patch.yml'), '[]\n', 'utf8')
    let attempts = 0
    const started = await startWithProfileSelfRepair({
      profileDir: profile,
      extraDirs: [runtime],
      start: async () => { attempts += 1; return 'ok' },
    })
    assert.equal(started.result, 'ok')
    assert.equal(attempts, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('只装在运行时安装目录里的官方实验性 bundle 不被预检误隔离（插件配置开关能保持）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-runtime-only-bundle-'))
  const profile = join(root, 'profile')
  const runtime = join(root, 'runtime')
  const name = '@deepseek-ai/dsh-experimental-auto-review'
  try {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', name] } },
      dependencies: { '@deepseek-ai/dsh-base': '0.1.7-rc.2' },
    }), 'utf8')
    // 官方实验性 bundle 的常态：只在运行时安装目录（= 插件管理器 selectBundle 的 installAnchor 回退位）里
    const bundleDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-experimental-auto-review')
    await mkdir(join(bundleDir, 'lib'), { recursive: true })
    await writeFile(join(bundleDir, 'package.json'), JSON.stringify({
      name,
      version: '0.1.7-rc.2',
      main: 'lib/index.js',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(join(bundleDir, 'lib', 'index.js'), 'export const apply = () => {}\n', 'utf8')
    await writeFile(join(bundleDir, 'cordis.patch.yml'), '[]\n', 'utf8')

    const removed = await repairBrokenProfile(profile, [runtime])
    assert.deepEqual(removed, [])

    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    assert.equal(manifest.dsh?.profile?.bundles?.includes(name), true)
    const journal = JSON.parse(await readFile(join(profile, '.dsh-recovery', 'quarantined-bundles.json'), 'utf8').catch(() => '{"records":[]}')) as { records: { packageName: string }[] }
    assert.equal(journal.records.some((record) => record.packageName === name), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('profile 与运行时安装目录都没有的官方实验性 bundle 仍被预检隔离（对照）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-runtime-missing-bundle-'))
  const profile = join(root, 'profile')
  const runtime = join(root, 'runtime')
  const name = '@deepseek-ai/dsh-experimental-auto-review'
  try {
    await mkdir(profile, { recursive: true })
    await mkdir(runtime, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', name] } },
      dependencies: { '@deepseek-ai/dsh-base': '0.1.7-rc.2' },
    }), 'utf8')

    const removed = await repairBrokenProfile(profile, [runtime])
    assert.deepEqual(removed, [name])
    const journal = JSON.parse(await readFile(join(profile, '.dsh-recovery', 'quarantined-bundles.json'), 'utf8')) as { records: { packageName: string; reason: string }[] }
    assert.equal(journal.records.some((record) => record.packageName === name && record.reason.includes('package.json 不存在')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('官方 Web bundle 缺失时在启动前报告安装损坏，不等待启动超时', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-official-bundle-'))
  const profile = join(root, 'profile')
  const runtime = join(root, 'runtime')
  try {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }), 'utf8')
    const dshPackage = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
    const basePackage = join(dshPackage, 'node_modules', '@deepseek-ai', 'dsh-base')
    await mkdir(basePackage, { recursive: true })
    await writeFile(join(dshPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }), 'utf8')
    await writeFile(join(basePackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-base',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(join(basePackage, 'cordis.patch.yml'), '[]\n', 'utf8')
    let attempts = 0
    await assert.rejects(startWithProfileSelfRepair({
      profileDir: profile,
      extraDirs: [runtime],
      start: async () => { attempts += 1; return 'unexpected' },
    }), /官方运行时安装不完整：缺少内置 bundle @deepseek-ai\/dsh-web-app/)
    assert.equal(attempts, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
