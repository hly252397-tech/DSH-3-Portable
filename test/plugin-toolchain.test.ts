import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { normalizePnpmNodeEntry, preparePnpmInvocation, prependPath, resolveBundledPluginStore, resolvePluginBinDir, resolvePnpmNodeEntry } from '../src/plugin-toolchain.js'

test('pnpm 12 cache transport uses child environment, preserving arg order and parent environment', () => {
  const env = { PATH: 'unchanged', PNPM_CONFIG_CACHE_DIR: 'old' }
  const invocation = preparePnpmInvocation(['install', '--cache-dir=first', '--offline', '--cache-dir', 'final path'], env)
  assert.deepEqual(invocation.args, ['install', '--offline'])
  assert.equal(invocation.env.PNPM_CONFIG_CACHE_DIR, 'final path')
  assert.equal(invocation.env.npm_config_cache_dir, 'final path')
  assert.equal(env.PNPM_CONFIG_CACHE_DIR, 'old')
  assert.equal(invocation.env.PATH, 'unchanged')
  assert.throws(() => preparePnpmInvocation(['install', '--cache-dir']), /Missing/)
  assert.throws(() => preparePnpmInvocation(['install', '--cache-dir', '--offline']), /Missing/)
  assert.deepEqual(preparePnpmInvocation(['--version'], env).args, ['--version'])
})

test('native npm_execpath is normalized for both nested and sibling pnpm payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'pnpm-entry-'))
  try {
    mkdirSync(join(root, 'pnpm/bin'), { recursive: true })
    writeFileSync(join(root, 'pnpm/package.json'), JSON.stringify({ name: 'pnpm' }))
    const wrapper = join(root, 'pnpm/bin/pnpm.mjs')
    writeFileSync(wrapper, '// fixture')
    assert.equal(normalizePnpmNodeEntry(join(root, 'pnpm/node_modules/@pnpm/exe.win32-x64/pnpm.exe')), wrapper)
    assert.equal(normalizePnpmNodeEntry(join(root, 'pnpm/pnpm.exe')), wrapper)
    assert.equal(normalizePnpmNodeEntry(wrapper), wrapper)
    assert.throws(() => normalizePnpmNodeEntry(join(root, 'unknown.exe')), /无法将 pnpm 原生入口/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Node bridge resolves pnpm 12 wrapper, preserves pnpm 11 and never selects native bin', () => {
  const root = join('fixture', 'pnpm-package')
  assert.equal(resolvePnpmNodeEntry(root, path => path === join(root, 'bin/pnpm.mjs') || path === join(root, 'pnpm')), join(root, 'bin/pnpm.mjs'))
  assert.equal(resolvePnpmNodeEntry(root, path => path === join(root, 'bin/pnpm.cjs')), join(root, 'bin/pnpm.cjs'))
  assert.throws(() => resolvePnpmNodeEntry(root, path => path === join(root, 'pnpm')), /Node 入口不存在/)
})

test('把随包 Node 目录插到 PATH 最前，供 dsh plugin 和 code-ui 找到 pnpm', () => {
  const merged = prependPath('C:\\Windows\\System32', 'D:\\app\\resources\\node', 'win32')
  assert.equal(merged, 'D:\\app\\resources\\node;C:\\Windows\\System32')
  assert.equal(prependPath('d:\\APP\\resources\\NODE;C:\\Windows', 'D:\\app\\resources\\node', 'win32'), 'D:\\app\\resources\\node;C:\\Windows')
})

test('打包态优先使用安装目录里解压后的离线仓库', () => {
  const store = resolveBundledPluginStore({
    isPackaged: true,
    resourcesPath: 'D:\\app\\resources',
    appPath: 'D:\\app',
    extractedStoreDir: 'D:\\app\\plugins\\store',
    exists: path => path === 'D:\\app\\plugins\\store',
  })
  assert.equal(store, 'D:\\app\\plugins\\store')
})

test('没有解压目录时回退 extraResources 里的离线仓库', () => {
  const store = resolveBundledPluginStore({
    isPackaged: true,
    resourcesPath: 'D:\\app\\resources',
    appPath: 'D:\\app',
    exists: path => path === join('D:\\app\\resources', 'plugins', 'store'),
  })
  assert.equal(store, join('D:\\app\\resources', 'plugins', 'store'))
})

test('开发态只在本地装配目录存在时启用补种', () => {
  const missing = resolveBundledPluginStore({
    isPackaged: false,
    resourcesPath: 'D:\\app\\resources',
    appPath: 'D:\\repo\\dsh-codex-desktop',
    exists: () => false,
  })
  assert.equal(missing, undefined)
})

test('显式空 envStore 不会被进程环境变量重新覆盖', () => {
  const previous = process.env.DSH_BUNDLED_PLUGIN_STORE
  process.env.DSH_BUNDLED_PLUGIN_STORE = 'D:\\unexpected-store'
  try {
    assert.equal(resolveBundledPluginStore({
      isPackaged: false,
      resourcesPath: 'D:\\app\\resources',
      appPath: 'D:\\repo',
      envStore: '',
      exists: path => path === 'D:\\unexpected-store',
    }), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_BUNDLED_PLUGIN_STORE
    else process.env.DSH_BUNDLED_PLUGIN_STORE = previous
  }
})

test('打包态的 pnpm 与 Node 放在同一目录', () => {
  assert.equal(
    resolvePluginBinDir({ isPackaged: true, resourcesPath: 'D:\\app\\resources' }),
    join('D:\\app\\resources', 'node'),
  )
  assert.equal(
    resolvePluginBinDir({ isPackaged: false, resourcesPath: 'D:\\app\\resources' }),
    undefined,
  )
})

test('pnpm12 preserves the explicit release-age policy without mutating the parent environment', () => {
  const parent = { PNPM_CONFIG_MINIMUM_RELEASE_AGE: '1440' }
  const invocation = preparePnpmInvocation(['install', '--config.minimumReleaseAge=0'], parent)
  assert.deepEqual(invocation.args, ['install'])
  assert.equal(invocation.env.PNPM_CONFIG_MINIMUM_RELEASE_AGE, '0')
  assert.equal(parent.PNPM_CONFIG_MINIMUM_RELEASE_AGE, '1440')
  assert.throws(() => preparePnpmInvocation(['--config.minimumReleaseAge=-1']), /Invalid/)
})

test('Web profile 跟随 DSH_HOME，避免写到错误用户目录', async () => {
  const { resolveWebProfileDir } = await import('../src/plugin-seed.js')
  assert.equal(resolveWebProfileDir('D:\\data\\dsh-home'), join('D:\\data\\dsh-home', 'profiles', 'web'))
})
