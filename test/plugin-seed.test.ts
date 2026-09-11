import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OFFICIAL_DSH_VERSION, OFFICIAL_LAUNCH_PEERS, OFFICIAL_RUNTIME, OFFICIAL_RUNTIME_RESOLUTION_MODE, SUITE_PACKAGE, officialDshVersionOverrides } from '../src/bundled-plugins.js'
import { applyPendingProfileUpdates, buildSeedPluginArgs, ensureAutoInstallPeersEnabled, ensurePnpm11BuildPolicy, ensureRuntimeResolutionMode, isOfficialRuntimeLaunchable, missingOfficialLaunchPeers, officialRuntimeInstallArgs, planBundledPluginSeed, finalizeProfileBundlesAfterInstall, pruneMissingProfileBundles, rebasePortablePnpmState, reconcileOfficialRuntimeManifest, resolvePnpmStoreDir, seedBundledPlugins, shouldUsePackagedStore, stripOfficialProfileDependencies, writeOfficialRuntimeManifest } from '../src/plugin-seed.js'

const catalog = [
  { packageName: '@michengai/dsh-codex-ui', version: '0.2.58' },
  { packageName: '@michengai/dsh-im-connect', version: '0.1.10' },
] as const

test('已安装套件时拆成单独插件，便于各自更新', () => {
  const plan = planBundledPluginSeed({
    catalog,
    declaredPackages: [SUITE_PACKAGE],
    installedPackages: [SUITE_PACKAGE],
    storeExists: true,
  })
  assert.deepEqual(plan, { action: 'replace-suite', packages: [...catalog] })
})

test('官方运行时不会写进 Web profile 补种计划', () => {
  const plan = planBundledPluginSeed({
    catalog: [OFFICIAL_RUNTIME, ...catalog],
    declaredPackages: [],
    installedPackages: [],
    storeExists: true,
  })
  assert.deepEqual(plan, { action: 'add', packages: [...catalog] })
})

test('目录插件都已在 profile 中时跳过补种', () => {
  const plan = planBundledPluginSeed({
    catalog,
    declaredPackages: catalog.map(item => item.packageName),
    installedPackages: catalog.map(item => item.packageName),
    storeExists: true,
  })
  assert.deepEqual(plan, { action: 'skip', reason: 'already-installed' })
})

test('缺少离线仓库时跳过，不阻断桌面启动', () => {
  const plan = planBundledPluginSeed({
    catalog,
    declaredPackages: [],
    installedPackages: [],
    storeExists: false,
  })
  assert.deepEqual(plan, { action: 'skip', reason: 'missing-store' })
})

test('只补种缺失插件，并走 profile 内的 pnpm add', () => {
  const plan = planBundledPluginSeed({
    catalog,
    declaredPackages: ['@michengai/dsh-codex-ui'],
    installedPackages: ['@michengai/dsh-codex-ui'],
    storeExists: true,
  })
  assert.deepEqual(plan, {
    action: 'add',
    packages: [{ packageName: '@michengai/dsh-im-connect', version: '0.1.10' }],
  })
  const args = buildSeedPluginArgs(plan.packages, 'D:\\profile\\web', { storeDir: 'D:\\plugins\\store', offline: true })
  assert.deepEqual(args, [
    'add',
    '@michengai/dsh-im-connect@0.1.10',
    '--dir=D:\\profile\\web',
    '--store-dir=D:\\plugins\\store',
    '--cache-dir=D:\\plugins\\store',
    '--offline',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.minimumReleaseAge=0',
    '--registry=https://registry.npmjs.org/',
  ])
})

test('node_modules 已有插件但未写入 dependencies 时仍要补进 dependencies', () => {
  const plan = planBundledPluginSeed({
    catalog,
    declaredPackages: [],
    installedPackages: ['@michengai/dsh-codex-ui', '@michengai/dsh-im-connect'],
    storeExists: true,
  })
  assert.deepEqual(plan, { action: 'add', packages: [...catalog] })
})

test('seedBundledPlugins 只调用一次 pnpm add，且写入用户 profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-seed-'))
  try {
    const store = join(root, 'store')
    const profile = join(root, 'profile')
    await mkdir(store)
    await mkdir(profile)
    const calls: string[][] = []
    const result = await seedBundledPlugins({
      nodeExecutable: 'node',
      profileDir: profile,
      pluginStoreDir: store,
      catalog,
      runner: async args => { calls.push([...args]) },
    })
    assert.deepEqual(result.seeded, ['@michengai/dsh-codex-ui', '@michengai/dsh-im-connect'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.[0], 'add')
    assert.equal(calls[0]?.includes(`--dir=${profile}`), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('已有 node_modules 时不得改用安装包 store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-store-check-'))
  try {
    assert.equal(shouldUsePackagedStore(root), true)
    await mkdir(join(root, 'node_modules'))
    assert.equal(shouldUsePackagedStore(root), false)
    const args = buildSeedPluginArgs(catalog, root, {})
    assert.equal(args.some(item => item.startsWith('--store-dir=')), false)
    assert.equal(args.includes('--offline'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('后续 pnpm 操作沿用 node_modules 记录的 store 目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-store-state-'))
  try {
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', '.modules.yaml'), 'storeDir: D:\\persistent-store\n', 'utf8')
    assert.equal(resolvePnpmStoreDir(root, 'D:\\fallback-store'), 'D:\\persistent-store')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('便携盘换盘符后重定位 pnpm store 和 virtual store', () => {
  const state = JSON.stringify({
    storeDir: 'G:\\DSH-3-Portable\\Data\\Runtime\\plugins\\store\\v11',
    virtualStoreDir: 'G:\\DSH-3-Portable\\Data\\DSH\\profiles\\web\\node_modules\\.pnpm',
  }, undefined, 2) + '\n'
  assert.equal(
    rebasePortablePnpmState(state, 'P:\\DSH-3-Portable'),
    JSON.stringify({
      storeDir: 'P:\\DSH-3-Portable\\Data\\Runtime\\plugins\\store\\v11',
      virtualStoreDir: 'P:\\DSH-3-Portable\\Data\\DSH\\profiles\\web\\node_modules\\.pnpm',
    }, undefined, 2) + '\n',
  )
})

test('替换旧套件时先安装子插件，安装失败不会先卸载套件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-suite-rollback-'))
  try {
    const store = join(root, 'store')
    const profile = join(root, 'profile')
    await mkdir(store)
    await mkdir(profile)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { [SUITE_PACKAGE]: '1.0.0' } }), 'utf8')
    const calls: string[][] = []
    await assert.rejects(seedBundledPlugins({
      nodeExecutable: 'node',
      profileDir: profile,
      pluginStoreDir: store,
      catalog,
      runner: async args => {
        calls.push([...args])
        if (args[0] === 'add') throw new Error('模拟安装失败')
      },
    }), /模拟安装失败/)
    assert.equal(calls[0]?.[0], 'add')
    assert.equal(calls.some(args => args[0] === 'remove'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('官方运行时缺启动 peer 时判定为不可启动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-peer-'))
  try {
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
    assert.equal(isOfficialRuntimeLaunchable(root), false)
    assert.equal(missingOfficialLaunchPeers(root)[0]?.packageName, '@deepseek-ai/cordis-plugin-group')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('官方运行时已装但缺少启动 peer 时会补齐', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-'))
  try {
    const store = join(root, 'store')
    const profile = join(root, 'profile')
    const runtime = join(root, 'runtime')
    await mkdir(store)
    await mkdir(profile)
    await mkdir(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
    await writeFile(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{}', 'utf8')
    const calls: string[][] = []
    await seedBundledPlugins({
      nodeExecutable: 'node',
      profileDir: profile,
      desktopRuntimeDir: runtime,
      pluginStoreDir: store,
      catalog: [],
      runner: async args => {
        calls.push([...args])
        for (const arg of args) {
          const matched = /^(@[^@]+\/[^@]+)@/.exec(arg)
          if (matched === null) continue
          const packageDir = join(runtime, 'node_modules', ...matched[1].split('/'))
          await mkdir(packageDir, { recursive: true })
          await writeFile(join(packageDir, 'package.json'), '{}', 'utf8')
        }
      },
    })
    assert.equal(calls.some(item => item.some(arg => arg.includes('@deepseek-ai/cordis-plugin-group@1.0.2'))), true)
    assert.equal(isOfficialRuntimeLaunchable(runtime), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('会把已有 workspace 的 autoInstallPeers 打开', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-peers-yaml-'))
  try {
    await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:`n  - .`nautoInstallPeers: false`n", 'utf8')
    ensureAutoInstallPeersEnabled(root)
    assert.match(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), /autoInstallPeers:\s*true/)
    await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - .\nautoInstallPeers: 'false'\n", 'utf8')
    ensureAutoInstallPeersEnabled(root)
    assert.doesNotMatch(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), /['"]false['"]/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('会从 Web profile 依赖里清掉官方包', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-strip-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@deepseek-ai/dsh': '0.1.0-rc.7',
        '@michengai/dsh-codex-ui': '0.2.58',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@michengai/dsh-codex-suite'] } },
    }), 'utf8')
    const removed = await stripOfficialProfileDependencies(root)
    assert.deepEqual(removed, ['@deepseek-ai/dsh'])
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    assert.equal(manifest.dependencies?.['@michengai/dsh-codex-ui'], '0.2.58')
    assert.equal(manifest.dependencies?.['@deepseek-ai/dsh'], undefined)
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('会清掉 Web profile 里的官方 node_modules，避免盖掉运行时', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-strip-modules-'))
  try {
    const official = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives')
    await mkdir(official, { recursive: true })
    await writeFile(join(official, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-primitives' }), 'utf8')
    await writeFile(join(root, 'node_modules', '@deepseek-ai', '.keep'), 'keep', 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { '@michengai/dsh-codex-ui': '0.2.61' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }), 'utf8')
    const removed = await stripOfficialProfileDependencies(root)
    assert.equal(removed.includes('@deepseek-ai'), true)
    assert.equal(existsSync(official), false)
    assert.equal(existsSync(join(root, 'node_modules', '@deepseek-ai', '.keep')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('启动前会按 pending 清单升级社区插件，官方残留条目被清掉而不是留成幽灵', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pending-'))
  try {
    const profile = join(root, 'profile')
    await mkdir(profile)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dependencies: { '@michengai/dsh-codex-ui': '0.2.60' },
    }), 'utf8')
    await writeFile(join(profile, '.dsh-pending-updates.json'), JSON.stringify({
      packages: [
        { packageName: '@michengai/dsh-codex-ui', version: '0.2.60' },
        { packageName: '@deepseek-ai/dsh', version: '0.1.0-rc.8' },
      ],
    }), 'utf8')
    const calls: string[][] = []
    const updated = await applyPendingProfileUpdates({
      nodeExecutable: 'node',
      profileDir: profile,
      pluginStoreDir: join(root, 'store'),
      runner: async args => { calls.push([...args]) },
    })
    assert.deepEqual(updated, ['@michengai/dsh-codex-ui'])
    assert.equal(calls[0]?.includes('@michengai/dsh-codex-ui@0.2.60'), true)
    assert.equal(calls[0]?.some(item => item.includes('@deepseek-ai/dsh')), false)
    // 官方运行时不走 profile 安装路径，登记条目必须清掉：回写会变成永远无法应用的幽灵
    // 待更新项，并在之后每次插件更新时被重新合并带回。
    assert.equal(existsSync(join(profile, '.dsh-pending-updates.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('只剩官方条目的 pending 文件会被删除，不再反复提示待更新', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pending-official-only-'))
  try {
    const profile = join(root, 'profile')
    await mkdir(profile)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
    await writeFile(join(profile, '.dsh-pending-updates.json'), JSON.stringify({
      packages: [{ packageName: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }],
    }), 'utf8')
    const updated = await applyPendingProfileUpdates({
      nodeExecutable: 'node',
      profileDir: profile,
      pluginStoreDir: join(root, 'store'),
      runner: async () => { throw new Error('官方条目不应触发 profile 安装') },
    })
    assert.deepEqual(updated, [])
    assert.equal(existsSync(join(profile, '.dsh-pending-updates.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('复制预装官方运行时成功后不再现场 pnpm add', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prebuilt-seed-'))
  try {
    const store = join(root, 'store')
    const profile = join(root, 'profile')
    const runtime = join(root, 'runtime')
    const prebuilt = join(root, 'prebuilt')
    await mkdir(store)
    await mkdir(profile)
    await mkdir(join(prebuilt, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(prebuilt, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
    await writeFile(join(prebuilt, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: OFFICIAL_DSH_VERSION }), 'utf8')
    for (const plugin of OFFICIAL_LAUNCH_PEERS) {
      const packageDir = join(prebuilt, 'node_modules', ...plugin.packageName.split('/'))
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: plugin.version }), 'utf8')
    }
    for (const name of ['dsh-attachment-local', 'dsh-host-apiproxy']) {
      const packageDir = join(prebuilt, 'node_modules', '@deepseek-ai', name)
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: OFFICIAL_DSH_VERSION }), 'utf8')
    }
    writeOfficialRuntimeManifest(prebuilt, OFFICIAL_DSH_VERSION)
    const calls: string[][] = []
    const result = await seedBundledPlugins({
      nodeExecutable: 'node',
      profileDir: profile,
      desktopRuntimeDir: runtime,
      prebuiltRuntimeDir: prebuilt,
      pluginStoreDir: store,
      catalog: [],
      runner: async args => { calls.push([...args]) },
    })
    assert.deepEqual(result.seeded, [OFFICIAL_RUNTIME.packageName])
    assert.equal(calls.length, 0)
    assert.equal(existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('启动前会摘掉磁盘上已经不存在的社区 bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prune-bundle-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-file-upload'] } },
    }), 'utf8')
    const removed = await pruneMissingProfileBundles(root)
    assert.deepEqual(removed, ['dsh-file-upload'])
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('桌面内部 bridge bundle 不依赖 profile dependencies 仍会保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keep-desktop-bridge-'))
  try {
    await mkdir(join(root, 'node_modules', 'dsh-desktop-bridge'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'dsh-desktop-bridge', 'package.json'), '{}', 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-desktop-bridge'] } } }), 'utf8')
    assert.deepEqual(await pruneMissingProfileBundles(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('先认磁盘上的包，再更新 bundle 列表', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-finalize-bundle-'))
  try {
    await mkdir(join(root, 'node_modules', 'ready-plugin'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'ready-plugin', 'package.json'), JSON.stringify({
      name: 'ready-plugin',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { 'ready-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-file-upload'] } },
    }), 'utf8')
    const result = await finalizeProfileBundlesAfterInstall(root)
    assert.deepEqual(result.removed, ['dsh-file-upload'])
    assert.equal(result.bundles.includes('ready-plugin'), true)
    assert.equal(result.bundles.includes('dsh-file-upload'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('插件市场禁用 bundle 插件后，启动补种不得把它重新加入清单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-disabled-bundle-'))
  try {
    await mkdir(join(root, 'node_modules', 'ready-plugin'), { recursive: true })
    await mkdir(join(root, '.dsh-market'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'ready-plugin', 'package.json'), JSON.stringify({
      name: 'ready-plugin',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(join(root, '.dsh-market', 'state.json'), JSON.stringify({
      disabled: ['ready-plugin'], groups: {}, groupOrder: [],
    }), 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { 'ready-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }), 'utf8')
    const result = await finalizeProfileBundlesAfterInstall(root)
    assert.equal(result.bundles.includes('ready-plugin'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('启动补种 pnpm 超时后会终止并返回明确错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-seed-timeout-'))
  try {
    const store = join(root, 'store')
    const profile = join(root, 'profile')
    const pnpmEntry = join(root, 'hanging-pnpm.cjs')
    await mkdir(store)
    await mkdir(profile)
    await writeFile(pnpmEntry, 'setInterval(() => undefined, 1000)\n', 'utf8')
    await assert.rejects(seedBundledPlugins({
      nodeExecutable: process.execPath,
      profileDir: profile,
      pluginStoreDir: store,
      catalog: [catalog[0]],
      pnpmEntry,
      timeoutMs: 30,
    }), /pnpm.*超时/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('官方 pending 会改运行时目录，不写进 Web profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-official-pending-'))
  try {
    const profile = join(root, 'profile')
    const runtime = join(root, 'runtime')
    await mkdir(profile)
    await mkdir(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
    await writeFile(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.1.0-rc.7' }), 'utf8')
    for (const plugin of OFFICIAL_LAUNCH_PEERS) {
      const packageDir = join(runtime, 'node_modules', ...plugin.packageName.split('/'))
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: plugin.version }), 'utf8')
    }
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
    await writeFile(join(profile, '.dsh-pending-updates.json'), JSON.stringify({
      packages: [{ packageName: '@deepseek-ai/dsh', version: OFFICIAL_DSH_VERSION }],
    }), 'utf8')
    const calls: string[][] = []
    const updated = await applyPendingProfileUpdates({
      nodeExecutable: 'node',
      profileDir: profile,
      desktopRuntimeDir: runtime,
      pluginStoreDir: join(root, 'store'),
      allowOfficialRuntimeUpdate: true,
      runner: async args => { calls.push([...args]) },
    })
    assert.deepEqual(updated, [OFFICIAL_DSH_VERSION])
    assert.equal(calls[0]?.[0], 'install')
    assert.equal(calls[0]?.includes('--dir=' + runtime), true)
    const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')) as { pnpm?: { overrides?: Record<string, string> } }
    assert.deepEqual(manifest.pnpm?.overrides, officialDshVersionOverrides())
    const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    assert.equal(profileManifest.dependencies?.['@deepseek-ai/dsh'], undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('官方运行时更新会同步锁文件，避免 CI 冻结锁文件阻断启动', () => {
  const args = officialRuntimeInstallArgs('D:\\runtime')
  assert.equal(args.includes('--no-frozen-lockfile'), true)
})

test('官方运行时安装按发布时间解析，避免家族被拉成混用预发布', () => {
  const args = officialRuntimeInstallArgs('D:\\runtime')
  assert.equal(args.includes(`--config.resolution-mode=${OFFICIAL_RUNTIME_RESOLUTION_MODE}`), true)
})

test('运行时工作区补齐 resolutionMode 且不改动已有内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-resolution-'))
  try {
    const workspacePath = join(root, 'pnpm-workspace.yaml')
    await writeFile(workspacePath, ['packages:', '  - .', '', 'nodeLinker: hoisted', ''].join('\n'), 'utf8')
    ensureRuntimeResolutionMode(root)
    const patched = await readFile(workspacePath, 'utf8')
    assert.match(patched, new RegExp(`^resolutionMode: ${OFFICIAL_RUNTIME_RESOLUTION_MODE}\$`, 'm'))
    assert.match(patched, /nodeLinker: hoisted/)
    // 幂等：重复调用既不新增重复行，也不覆盖用户的其他设置。
    ensureRuntimeResolutionMode(root)
    assert.equal(await readFile(workspacePath, 'utf8'), patched)
    // 旧值被替换，不会留下两行互相矛盾的解析模式。
    await writeFile(workspacePath, 'packages:\n  - .\nresolutionMode: highest\n', 'utf8')
    ensureRuntimeResolutionMode(root)
    const replaced = await readFile(workspacePath, 'utf8')
    assert.equal(replaced.match(/^resolutionMode:/gm)?.length, 1)
    assert.match(replaced, new RegExp(`^resolutionMode: ${OFFICIAL_RUNTIME_RESOLUTION_MODE}\$`, 'm'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pnpm 11 工作区会移除旧构建白名单并保留新的 allowBuilds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pnpm11-policy-'))
  try {
    const manifest = join(root, 'pnpm-workspace.yaml')
    await writeFile(manifest, [
      'packages:',
      '  - .',
      'onlyBuiltDependencies:',
      '  - koffi',
      '  - node-pty',
      'allowBuilds:',
      '  koffi: false',
      '  "koffi": true',
      '  node-pty: true',
      '',
    ].join('\n'), 'utf8')
    ensurePnpm11BuildPolicy(root)
    const next = await readFile(manifest, 'utf8')
    assert.doesNotMatch(next, /onlyBuiltDependencies:/)
    assert.match(next, /allowBuilds:\s*\n\s+koffi: true\s*\n\s+node-pty: true/)
    assert.equal((next.match(/^\s+(?:"koffi"|koffi):/gm) ?? []).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('通过指纹封存的 A/B 运行时槽在启动补种时保持不可变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-immutable-slot-'))
  try {
    const profile = join(root, 'profile')
    const runtime = join(root, 'runtime')
    const store = join(root, 'store')
    await mkdir(profile, { recursive: true })
    await mkdir(store, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')
    await mkdir(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
    for (const plugin of OFFICIAL_LAUNCH_PEERS) {
      const packageDir = join(runtime, 'node_modules', ...plugin.packageName.split('/'))
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: plugin.packageName, version: plugin.version }), 'utf8')
    }
    await writeFile(join(runtime, '.dsh-runtime-fingerprint'), `${'a'.repeat(64)}\n`, 'utf8')
    let calls = 0
    await seedBundledPlugins({
      nodeExecutable: 'node',
      profileDir: profile,
      desktopRuntimeDir: runtime,
      pluginStoreDir: store,
      catalog: [],
      runner: async () => { calls += 1 },
    })
    assert.equal(calls, 0)
    assert.equal(existsSync(join(runtime, 'package.json')), false)
    assert.equal(existsSync(join(runtime, 'pnpm-workspace.yaml')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function writeInstalledFamily(runtime: string, version: string, options: { mixed?: boolean } = {}): Promise<void> {
  const dshDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(dshDir, 'lib'), { recursive: true })
  await writeFile(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
  await writeFile(join(dshDir, 'lib', 'bin.js'), '', 'utf8')
  let mixedDone = false
  for (const plugin of OFFICIAL_LAUNCH_PEERS) {
    const packageDir = join(runtime, 'node_modules', ...plugin.packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    // cordis-plugin-group 版本线独立，只有 dsh-* 参与家族一致性判断。
    const familyPeer = plugin.packageName.startsWith('@deepseek-ai/dsh-')
    let peerVersion = familyPeer ? version : plugin.version
    if (options.mixed === true && familyPeer && !mixedDone) {
      peerVersion = '0.1.6-rc.1'
      mixedDone = true
    }
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: plugin.packageName, version: peerVersion }), 'utf8')
  }
}

test('被半改写的活动运行时槽在启动时把描述性清单拉回实际安装版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-slot-manifest-heal-'))
  try {
    const runtime = join(root, 'runtime')
    await writeInstalledFamily(runtime, OFFICIAL_DSH_VERSION)
    // 复现历史缺陷：旧桥接原地把清单写成新版本，node_modules 其实还是旧版本。
    writeOfficialRuntimeManifest(runtime, '0.1.5-rc.2')
    await writeFile(join(runtime, '.dsh-runtime-fingerprint'), `${'b'.repeat(64)}\n`, 'utf8')
    assert.equal(reconcileOfficialRuntimeManifest(runtime), true)
    const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      pnpm?: { overrides?: Record<string, string> }
    }
    assert.equal(manifest.dependencies?.['@deepseek-ai/dsh'], OFFICIAL_DSH_VERSION)
    assert.equal(manifest.pnpm?.overrides?.['@deepseek-ai/dsh'], OFFICIAL_DSH_VERSION)
    assert.equal(manifest.pnpm?.overrides?.['@deepseek-ai/dsh-*'], OFFICIAL_DSH_VERSION)
    // 已存在的目录也要补上解析模式，否则候选装配的钉版语义与运行时不一致。
    const workspace = await readFile(join(runtime, 'pnpm-workspace.yaml'), 'utf8')
    assert.match(workspace, new RegExp(`^resolutionMode: ${OFFICIAL_RUNTIME_RESOLUTION_MODE}$`, 'm'))
    // 指纹封存标记不被改写（只改描述性清单，不动物化依赖），且修复幂等。
    assert.equal((await readFile(join(runtime, '.dsh-runtime-fingerprint'), 'utf8')).trim(), 'b'.repeat(64))
    assert.equal(reconcileOfficialRuntimeManifest(runtime), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('家族版本混用时不动活动运行时槽清单，交由 A/B 门禁拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-slot-mixed-family-'))
  try {
    const runtime = join(root, 'runtime')
    await writeInstalledFamily(runtime, OFFICIAL_DSH_VERSION, { mixed: true })
    writeOfficialRuntimeManifest(runtime, '0.1.5-rc.2')
    assert.equal(reconcileOfficialRuntimeManifest(runtime), false)
    const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    assert.equal(manifest.dependencies?.['@deepseek-ai/dsh'], '0.1.5-rc.2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
