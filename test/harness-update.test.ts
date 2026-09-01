import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  acquireHarnessUpdateLock,
  appendHarnessUpdateEvent,
  checkHarnessUpdate,
  harnessUpdateAuditPath,
  harnessUpdateStatePath,
  loadHarnessUpdateState,
  saveHarnessUpdateState,
  sanitizeHarnessUpdatePolicy,
} from '../src/harness-update.js'

const alpha3Integrity = 'sha512-VvATzYmQ4LMJREJ9e2POKksSHRfqP3y9pghplLBaQBuw2BqfbC0mQUVsaPwxe4wlcpj+riEgn8OJB01YnpF+3A=='
const alpha3Commit = 'dd6322d604e00eec1ba5e0c8541159906a21094a'

function releaseFetch(options: { tarball?: string; commit?: string; version?: string } = {}): typeof fetch {
  const version = options.version ?? '0.1.2-alpha.3'
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('registry.npmjs.org')) {
      return new Response(JSON.stringify({
        'dist-tags': { alpha: version, latest: '0.1.1-rc.2' },
        versions: {
          [version]: {
            dist: {
              integrity: alpha3Integrity,
              tarball: options.tarball ?? `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`,
              signatures: [{ keyid: 'SHA256:test' }],
            },
          },
        },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ object: { sha: options.commit ?? alpha3Commit } }), { status: 200 })
  }) as typeof fetch
}

test('同时匹配 npm alpha、不可变标签和受信清单才允许自动更新', async () => {
  const result = await checkHarnessUpdate({ currentVersion: '0.1.2-alpha.2', fetch: releaseFetch(), now: '2026-09-01T00:00:00.000Z' })
  assert.equal(result.updateAvailable, true)
  assert.equal(result.candidate?.version, '0.1.2-alpha.3')
  assert.equal(result.candidate?.githubCommit, alpha3Commit)
  assert.equal(result.candidate?.automaticEligible, true)
})

test('更新状态原子持久化并过滤非法阶段、路径和错误内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-'))
  try {
    const path = harnessUpdateStatePath(root)
    const saved = await saveHarnessUpdateState(path, {
      phase: 'observing',
      currentVersion: '0.1.2-alpha.2',
      targetVersion: '0.1.2-alpha.3',
      transactionId: '12345678-abcd',
      updatedAt: '2026-09-01T00:00:00.000Z',
      detail: 'line 1\nline 2',
    }, '0.1.2-alpha.2')
    assert.equal(saved.phase, 'observing')
    assert.equal(saved.detail, 'line 1 line 2')
    assert.deepEqual(await loadHarnessUpdateState(path, '0.1.2-alpha.2'), saved)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('未知新版本只报告，不允许静默自动切换', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.2-alpha.3',
    fetch: releaseFetch({ version: '0.1.2-alpha.4', commit: 'e'.repeat(40) }),
  })
  assert.equal(result.updateAvailable, true)
  assert.equal(result.candidate?.automaticEligible, false)
  assert.match(result.candidate?.automaticBlockReason ?? '', /受信发布清单/)
})

test('拒绝镜像站、HTTP 或与版本不一致的 npm tarball', async () => {
  await assert.rejects(checkHarnessUpdate({
    currentVersion: '0.1.2-alpha.2',
    fetch: releaseFetch({ tarball: 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.2-alpha.3.tgz' }),
  }), /允许列表/)
})

test('更新策略边界校验，预发布安全自动模式为默认值', () => {
  const policy = sanitizeHarnessUpdatePolicy({ checkIntervalHours: 0, observationMinutes: 999, keepGoodSlots: 1, skipVersions: ['bad', '0.1.2-alpha.3'] })
  assert.equal(policy.mode, 'safe-auto')
  assert.equal(policy.checkIntervalHours, 6)
  assert.equal(policy.observationMinutes, 5)
  assert.equal(policy.keepGoodSlots, 3)
  assert.deepEqual(policy.skipVersions, ['0.1.2-alpha.3'])
})

test('更新锁拒绝并发、允许清理过期事务且只由持有者释放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-harness-lock-'))
  try {
    const first = await acquireHarnessUpdateLock(root, { nowMs: 1_000, staleMs: 10_000 })
    await assert.rejects(acquireHarnessUpdateLock(root, { nowMs: 2_000, staleMs: 10_000 }), /正在执行/)
    const second = await acquireHarnessUpdateLock(root, { nowMs: 20_000, staleMs: 10_000 })
    await first.release()
    await assert.rejects(acquireHarnessUpdateLock(root, { nowMs: 21_000, staleMs: 10_000 }), /正在执行/)
    await second.release()
    const third = await acquireHarnessUpdateLock(root)
    await third.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('审计事件以 JSONL 写入便携更新目录并裁剪多行错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-harness-audit-'))
  try {
    await appendHarnessUpdateEvent(root, {
      transactionId: 'tx',
      phase: 'verify',
      outcome: 'failure',
      timestamp: '2026-09-01T00:00:00.000Z',
      detail: 'line 1\nline 2',
    })
    const event = JSON.parse((await readFile(harnessUpdateAuditPath(root), 'utf8')).trim()) as { detail?: string }
    assert.equal(event.detail, 'line 1 line 2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
