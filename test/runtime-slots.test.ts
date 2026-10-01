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

/** 捕获 warn，避免依赖全局 stderr；返回的数组收集本次调用期间的所有告警。 */
function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  return { warnings, restore: () => { console.warn = original } }
}

test('槽全部不可启动时回退旧目录，且必须留下可观测告警（A1）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-a1-'))
  try {
    const legacy = join(root, 'dsh-runtime')
    const pointerPath = runtimePointerPath(legacy)
    await mkdir(dirname(pointerPath), { recursive: true })
    await writeFile(pointerPath, JSON.stringify({
      schema: 1,
      current: { relativePath: '../../outside', version: '0.1.2-rc.1', fingerprint: 'c'.repeat(64) },
      activatedAt: '2026-09-01T00:00:00.000Z',
    }), 'utf8')

    const { warnings, restore } = captureWarnings()
    try {
      // 行为不变：两个槽都不可启动时仍然回退 legacy 固定目录（下游依赖它启动）。
      assert.equal(resolveActiveRuntimeDir(legacy), legacy)
    } finally {
      restore()
    }
    assert.ok(warnings.length > 0, '回退 legacy 必须留下可观测信号，不能静默')
    assert.ok(warnings.some(w => w.includes('回退旧版固定目录')), `告警需说明回退动作：${warnings.join(' | ')}`)
    assert.ok(warnings.some(w => w.includes('两个槽都不可启动')), `告警需说明原因：${warnings.join(' | ')}`)
    assert.ok(warnings.some(w => w.includes('Data/DSH')), `告警需点明风险（会读写共享 Data/DSH）：${warnings.join(' | ')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('槽指纹缺失时按「无指纹」处理，不伪造全零指纹落盘，旧槽仍可加载（A2）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-a2-'))
  try {
    const legacy = join(root, 'dsh-runtime')
    await writeRuntime(legacy, '0.1.2-alpha.2')
    await rm(join(legacy, '.dsh-runtime-fingerprint'))
    const candidate = runtimeSlotDirectory(legacy, '0.1.2-rc.1', 'c'.repeat(64))
    await writeRuntime(candidate, '0.1.2-rc.1', 'c'.repeat(64))

    const { warnings, restore } = captureWarnings()
    let activated: ReturnType<typeof activateRuntimeSlot>
    try {
      activated = activateRuntimeSlot({
        legacyRuntimeDir: legacy,
        candidateDir: candidate,
        version: '0.1.2-rc.1',
        fingerprint: 'c'.repeat(64),
        transactionId: 'tx-a2',
        now: '2026-09-01T00:00:00.000Z',
      })
    } finally {
      restore()
    }

    assert.equal(activated.current.fingerprint, 'c'.repeat(64))
    assert.equal(activated.previous?.fingerprint, undefined, '无指纹必须是「缺省」，不能是全零')
    assert.notEqual(activated.previous?.fingerprint, '0'.repeat(64))
    assert.ok(warnings.some(w => w.includes('槽指纹文件缺失')), `marker 缺失必须告警：${warnings.join(' | ')}`)

    const stored = JSON.parse(await readFile(runtimePointerPath(legacy), 'utf8')) as {
      current: { fingerprint?: string }
      previous?: { fingerprint?: string }
    }
    assert.notEqual(stored.previous?.fingerprint, '0'.repeat(64), '全零指纹不得落盘')
    assert.equal(stored.previous?.fingerprint, undefined, '无指纹就不要写 fingerprint 字段')

    // 兼容：读得回来，回滚也还能用。
    const reloaded = readRuntimeSlotPointer(legacy)
    assert.equal(reloaded?.current.version, '0.1.2-rc.1')
    assert.equal(reloaded?.previous?.version, '0.1.2-alpha.2')
    const rolled = rollbackRuntimeSlot(legacy, 'tx-a2', 'A2 兼容自证')
    assert.equal(rolled.current.version, '0.1.2-alpha.2')
    assert.equal(readRuntimeSlotPointer(legacy)?.current.version, '0.1.2-alpha.2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('历史指针里的全零指纹仍可加载，但重写时一律不再落盘（A2 兼容）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-a2-zero-'))
  try {
    const legacy = join(root, 'dsh-runtime')
    await writeRuntime(legacy, '0.1.2-alpha.2')
    const pointerPath = runtimePointerPath(legacy)
    await mkdir(dirname(pointerPath), { recursive: true })
    await writeFile(pointerPath, `${JSON.stringify({
      schema: 1,
      current: { relativePath: 'slots/0.1.2-rc.1-deadbeef', version: '0.1.2-rc.1', fingerprint: '0'.repeat(64) },
      previous: { relativePath: 'dsh-runtime', version: '0.1.2-alpha.2', fingerprint: '0'.repeat(64) },
      activatedAt: '2026-09-01T00:00:00.000Z',
      pendingTransactionId: 'tx-zero',
    }, null, 2)}\n`, 'utf8')

    // 兼容底线：老指针带全零指纹也必须读得出来，否则历史槽直接失联。
    const reloaded = readRuntimeSlotPointer(legacy)
    assert.equal(reloaded?.current.version, '0.1.2-rc.1')
    assert.equal(reloaded?.previous?.fingerprint, '0'.repeat(64))

    const rolled = rollbackRuntimeSlot(legacy, 'tx-zero', '历史全零指纹回滚自证')
    assert.equal(rolled.current.version, '0.1.2-alpha.2')
    assert.equal(rolled.current.fingerprint, undefined, '重写返回值同样不得携带全零指纹')
    assert.equal(rolled.lastFailed?.fingerprint, undefined)

    const stored = JSON.parse(await readFile(pointerPath, 'utf8')) as {
      current: { fingerprint?: string }
      lastFailed?: { fingerprint?: string }
    }
    assert.equal(stored.current.fingerprint, undefined, '全零指纹必须被摘掉后再落盘')
    assert.equal(stored.lastFailed?.fingerprint, undefined, '全零指纹必须被摘掉后再落盘')
    assert.equal(readRuntimeSlotPointer(legacy)?.current.fingerprint, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('拒绝用全零指纹激活运行时槽（A2）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-a2-zero-activate-'))
  try {
    const legacy = join(root, 'dsh-runtime')
    await writeRuntime(legacy, '0.1.2-alpha.2')
    const zero = '0'.repeat(64)
    const candidate = runtimeSlotDirectory(legacy, '0.1.2-rc.1', zero)
    await writeRuntime(candidate, '0.1.2-rc.1', zero)

    await assert.rejects(
      async () => activateRuntimeSlot({
        legacyRuntimeDir: legacy,
        candidateDir: candidate,
        version: '0.1.2-rc.1',
        fingerprint: zero,
        transactionId: 'tx-zero-fp',
      }),
      /全零指纹/,
    )
    assert.equal(readRuntimeSlotPointer(legacy), undefined, '被拒绝的激活不得写出指针')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
