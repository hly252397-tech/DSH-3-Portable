import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseUnresolvedBundleError, removeProfileBundle, repairBrokenProfile, startWithProfileSelfRepair } from '../src/profile-repair.js'
import { activeQuarantinedProfileBundles, profileQuarantineJournalPath, quarantineProfileBundle } from '../src/profile-quarantine.js'
import { writeTextFileAtomic } from '../src/atomic-file.js'

test('能从 DSH 缺 bundle 报错里取出包名', () => {
  const message = 'dsh: cannot resolve profile bundle "dsh-file-upload" from the dsh installation or C:\\Users\\demo\\.dsh\\profiles\\web'
  assert.equal(parseUnresolvedBundleError(message), 'dsh-file-upload')
})

test('能从 loader entry 启动报错里取出包名，并拒绝路径注入', () => {
  const screenshotError = 'failed to import loader entry sidebar-spaces (dsh-sidebar-spaces): Error: Cannot find module lib/index.js'
  assert.equal(parseUnresolvedBundleError(screenshotError), 'dsh-sidebar-spaces')
  assert.equal(parseUnresolvedBundleError('cannot resolve profile bundle "../../outside"'), undefined)
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

test('自我修复会摘掉未登记依赖的残留 bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-orphan-'))
  try {
    await mkdir(join(root, 'node_modules', 'dsh-file-upload'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'dsh-file-upload', 'package.json'), '{}', 'utf8')
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

test('启动因缺 bundle 失败时会摘掉坏项并重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-retry-'))
  try {
    await mkdir(join(root, 'node_modules', 'dsh-file-upload'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'dsh-file-upload', 'package.json'), '{}', 'utf8')
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

test('入口文件缺失时会在启动前事务隔离，保留依赖和文件并留下审计与备份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-entry-'))
  try {
    const packageRoot = join(root, 'node_modules', 'dsh-sidebar-spaces')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-sidebar-spaces', main: 'lib/index.js' }), 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-sidebar-spaces': 'file:./local/dsh-sidebar-spaces' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-sidebar-spaces'] } },
    }), 'utf8')

    const repaired = await repairBrokenProfile(root)
    assert.deepEqual(repaired, ['dsh-sidebar-spaces'])
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    assert.equal(manifest.dependencies?.['dsh-sidebar-spaces'], 'file:./local/dsh-sidebar-spaces')
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base'])
    assert.equal(await readFile(join(packageRoot, 'package.json'), 'utf8').then(() => true), true)

    const journal = JSON.parse(await readFile(profileQuarantineJournalPath(root), 'utf8')) as {
      records: Array<{ packageName: string; source: string; reason: string; manifestBackup: string }>
    }
    assert.equal(journal.records[0]?.packageName, 'dsh-sidebar-spaces')
    assert.equal(journal.records[0]?.source, 'preflight')
    assert.match(journal.records[0]?.reason ?? '', /主入口不存在/)
    assert.equal(await readFile(join(root, '.dsh-recovery', journal.records[0]!.manifestBackup), 'utf8').then(() => true), true)
    assert.equal((await activeQuarantinedProfileBundles(root)).has('dsh-sidebar-spaces'), true)

    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'lib', 'index.js'), 'export default {}\n', 'utf8')
    assert.equal((await activeQuarantinedProfileBundles(root)).has('dsh-sidebar-spaces'), false)
    const resolvedJournal = JSON.parse(await readFile(profileQuarantineJournalPath(root), 'utf8')) as { records: Array<{ resolvedAt?: string }> }
    assert.equal(typeof resolvedJournal.records[0]?.resolvedAt, 'string')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('隔离审计写入失败时回滚 profile 清单，不留下半提交状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-rollback-'))
  try {
    const original = `${JSON.stringify({
      dependencies: { 'broken-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['broken-plugin'] } },
    }, undefined, 2)}\n`
    await writeFile(join(root, 'package.json'), original, 'utf8')
    await assert.rejects(quarantineProfileBundle(root, 'broken-plugin', 'fault injection', 'startup', {
      writeAtomic: async (path, text) => {
        if (path === profileQuarantineJournalPath(root)) throw new Error('模拟磁盘审计写入失败')
        await writeTextFileAtomic(path, text)
      },
    }), /模拟磁盘审计写入失败/)
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
