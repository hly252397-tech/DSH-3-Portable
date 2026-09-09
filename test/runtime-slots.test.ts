import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { OFFICIAL_LAUNCH_PEERS } from '../src/bundled-plugins.js'
import {
  activateRuntimeSlot,
  commitRuntimeSlot,
  readRuntimeSlotPointer,
  recoverInterruptedRuntimeSwitch,
  resolveActiveRuntimeDir,
  rollbackRuntimeSlot,
  runtimePointerPath,
  runtimeSlotDirectory,
} from '../src/runtime-slots.js'

async function writeRuntime(directory: string, version: string, fingerprint = 'a'.repeat(64)): Promise<void> {
  const dsh = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(dsh, 'lib'), { recursive: true })
  await writeFile(join(dsh, 'lib', 'bin.js'), '', 'utf8')
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
  for (const peer of OFFICIAL_LAUNCH_PEERS) {
    const peerRoot = join(directory, 'node_modules', ...peer.packageName.split('/'))
    await mkdir(peerRoot, { recursive: true })
    await writeFile(join(peerRoot, 'package.json'), JSON.stringify({ name: peer.packageName, version }), 'utf8')
  }
  await writeFile(join(directory, '.dsh-runtime-fingerprint'), `${fingerprint}\n`, 'utf8')
}

test('A/B 运行时使用相对指针切换、提交和回滚', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-slots-'))
  try {
    const legacy = join(root, 'dsh-runtime')
    await writeRuntime(legacy, '0.1.2-alpha.2', 'b'.repeat(64))
    const candidate = runtimeSlotDirectory(legacy, '0.1.2-rc.1', 'c'.repeat(64))
    await writeRuntime(candidate, '0.1.2-rc.1', 'c'.repeat(64))

    const activated = activateRuntimeSlot({
      legacyRuntimeDir: legacy,
      candidateDir: candidate,
      version: '0.1.2-rc.1',
      fingerprint: 'c'.repeat(64),
      transactionId: 'tx-1',
      now: '2026-09-01T00:00:00.000Z',
    })
    assert.equal(resolveActiveRuntimeDir(legacy), candidate)
    assert.equal(activated.current.relativePath.includes(root), false)
    assert.equal(activated.previous?.version, '0.1.2-alpha.2')

    const committed = commitRuntimeSlot(legacy, 'tx-1', '2026-09-01T00:05:00.000Z')
    assert.equal(committed.pendingTransactionId, undefined)
    assert.equal(committed.committedAt, '2026-09-01T00:05:00.000Z')

    activateRuntimeSlot({
      legacyRuntimeDir: legacy,
      candidateDir: candidate,
      version: '0.1.2-rc.1',
      fingerprint: 'c'.repeat(64),
      transactionId: 'tx-2',
    })
    // 同一候选重复激活是幂等的，不会把自己登记成 previous。
    assert.equal(readRuntimeSlotPointer(legacy)?.previous, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('候选启动失败时原子恢复上一已知可用运行时', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-rollback-'))
  try {
    const legacy = join(root, 'dsh-runtime')
    await writeRuntime(legacy, '0.1.2-alpha.2', 'b'.repeat(64))
    const candidate = runtimeSlotDirectory(legacy, '0.1.2-rc.1', 'c'.repeat(64))
    await writeRuntime(candidate, '0.1.2-rc.1', 'c'.repeat(64))
    activateRuntimeSlot({ legacyRuntimeDir: legacy, candidateDir: candidate, version: '0.1.2-rc.1', fingerprint: 'c'.repeat(64), transactionId: 'tx' })

    const rolledBack = rollbackRuntimeSlot(legacy, 'tx', '候选 readiness 超时')
    assert.equal(resolveActiveRuntimeDir(legacy), legacy)
    assert.equal(rolledBack.current.version, '0.1.2-alpha.2')
    assert.equal(rolledBack.lastFailed?.version, '0.1.2-rc.1')
    assert.match(rolledBack.lastFailed?.reason ?? '', /readiness/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('观察期进程中断后，下次启动自动恢复上一已知可用槽', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-recovery-'))
  try {
    const legacy = join(root, 'dsh-runtime')
    await writeRuntime(legacy, '0.1.2-alpha.2', 'b'.repeat(64))
    const candidate = runtimeSlotDirectory(legacy, '0.1.2-rc.1', 'c'.repeat(64))
    await writeRuntime(candidate, '0.1.2-rc.1', 'c'.repeat(64))
    activateRuntimeSlot({ legacyRuntimeDir: legacy, candidateDir: candidate, version: '0.1.2-rc.1', fingerprint: 'c'.repeat(64), transactionId: 'crashed-tx' })
    const recovered = recoverInterruptedRuntimeSwitch(legacy, '2026-09-01T00:10:00.000Z')
    assert.equal(recovered?.current.version, '0.1.2-alpha.2')
    assert.equal(recovered?.lastFailed?.version, '0.1.2-rc.1')
    assert.match(recovered?.lastFailed?.reason ?? '', /自动回滚/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('指针路径越界或当前槽损坏时安全回退旧运行时', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-invalid-pointer-'))
  try {
    const legacy = join(root, 'dsh-runtime')
    await writeRuntime(legacy, '0.1.2-alpha.2')
    const pointerPath = runtimePointerPath(legacy)
    await mkdir(dirname(pointerPath), { recursive: true })
    await writeFile(pointerPath, JSON.stringify({
      schema: 1,
      current: { relativePath: '../../outside', version: '0.1.2-rc.1', fingerprint: 'c'.repeat(64) },
      activatedAt: '2026-09-01T00:00:00.000Z',
    }), 'utf8')
    assert.equal(resolveActiveRuntimeDir(legacy), legacy)
    assert.equal(JSON.parse(await readFile(pointerPath, 'utf8')).current.relativePath, '../../outside')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
