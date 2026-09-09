import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSeedPluginArgs, buildSeedRemoveArgs, isOfflineSeedRequested, officialRuntimeInstallArgs, seedBundledPlugins } from '../src/plugin-seed.js'

test('离线意图转为 pnpm 显式参数，不依赖 npm 环境变量兼容性', () => {
  assert.equal(isOfflineSeedRequested({ npm_config_offline: 'true' }), true)
  assert.equal(isOfflineSeedRequested({ DSH_DESKTOP_OFFLINE: '1' }), true)
  assert.equal(isOfflineSeedRequested({ npm_config_offline: 'false' }), false)
  const previous = process.env.DSH_DESKTOP_OFFLINE
  process.env.DSH_DESKTOP_OFFLINE = 'true'
  try {
    assert.ok(buildSeedPluginArgs([{ packageName: 'fixture', version: '1.0.0' }], tmpdir()).includes('--offline'))
    assert.ok(buildSeedRemoveArgs(['fixture'], tmpdir()).includes('--offline'))
    assert.ok(officialRuntimeInstallArgs(tmpdir()).includes('--offline'))
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_OFFLINE
    else process.env.DSH_DESKTOP_OFFLINE = previous
  }
})

test('明确离线时补种失败只尝试一次，禁止退回联网安装', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-seed-stability-'))
  const previous = process.env.DSH_DESKTOP_OFFLINE
  process.env.DSH_DESKTOP_OFFLINE = 'true'
  try {
    const store = join(root, 'store')
    await mkdir(store)
    const calls: string[][] = []
    await assert.rejects(seedBundledPlugins({
      nodeExecutable: process.execPath,
      profileDir: join(root, 'profile'),
      desktopRuntimeDir: join(root, 'runtime'),
      pluginStoreDir: store,
      runner: async args => { calls.push([...args]); throw new Error('fixture offline cache missing') },
    }), /fixture offline cache missing/)
    assert.equal(calls.length, 1)
    assert.ok(calls[0]!.includes('--offline'))
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_OFFLINE
    else process.env.DSH_DESKTOP_OFFLINE = previous
    await rm(root, { recursive: true, force: true })
  }
})
