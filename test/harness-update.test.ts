import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  acquireHarnessUpdateLock,
  appendHarnessUpdateEvent,
  checkHarnessUpdate,
  clearDeploymentFailure,
  evaluateDeploymentRetryGate,
  harnessUpdateAuditPath,
  harnessUpdateStatePath,
  loadHarnessUpdateState,
  recordDeploymentFailure,
  sanitizeHarnessUpdatePolicy,
  saveHarnessUpdateState,
} from '../src/harness-update.js'

const alpha3Integrity = 'sha512-VvATzYmQ4LMJREJ9e2POKksSHRfqP3y9pghplLBaQBuw2BqfbC0mQUVsaPwxe4wlcpj+riEgn8OJB01YnpF+3A=='
const alpha3Commit = 'dd6322d604e00eec1ba5e0c8541159906a21094a'
const alpha5Integrity = 'sha512-MrD2rPhmjz+8Phs+d9lD9xL1qswCYjcSHMd96fF8NTdDm7FRRsU5QhLDR0x6U4JwGxEvee1pccuvbZY6NyEQhA=='
const alpha5Commit = 'db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5'
const rc1Integrity = 'sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA=='
const rc1Commit = 'a66e4702047846cdaa10c66c9d3df3951f5ea70d'
const rc1_5Integrity = 'sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg=='
const rc1_5Commit = '183f08e9c6dde7e36cd2318eaee70b0da08fb35e'
const rc2_5Integrity = 'sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw=='
const rc2_5Commit = 'fb2c4b9e698e30edb738bca4cf0618587db7d203'
const alpha1_5Integrity = 'sha512-AUjywjrPnhXcAdAjRNgyQa1QCnplFTNYZ+XpR9uCZdbg2FiCb06pHyoDUB2Wxuddzid9D7pVwEiU1OTl4Oshsg=='
const alpha1_5Commit = '5dda764ed3aa172535a7967b06ff95d9cbfe536a'

function releaseFetch(options: {
  tarball?: string
  commit?: string
  integrity?: string
  version?: string
  latestVersion?: string
  latestIntegrity?: string
  latestCommit?: string
  nextVersion?: string
  nextIntegrity?: string
  nextCommit?: string
} = {}): typeof fetch {
  const version = options.version ?? '0.1.2-alpha.3'
  const latestVersion = options.latestVersion ?? '0.1.1-rc.2'
  const nextVersion = options.nextVersion
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('registry.npmjs.org')) {
      const dist = (integrity: string | undefined, target: string) => ({
        integrity: integrity ?? alpha3Integrity,
        tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${target}.tgz`,
        signatures: [{ keyid: 'SHA256:test' }],
      })
      return new Response(JSON.stringify({
        'dist-tags': {
          alpha: version,
          ...(nextVersion === undefined ? {} : { next: nextVersion }),
          latest: latestVersion,
        },
        versions: {
          [version]: {
            dist: {
              ...dist(options.integrity, version),
              ...(options.tarball === undefined ? {} : { tarball: options.tarball }),
            },
          },
          [latestVersion]: { dist: dist(options.latestIntegrity, latestVersion) },
          ...(nextVersion === undefined ? {} : { [nextVersion]: { dist: dist(options.nextIntegrity, nextVersion) } }),
        },
      }), { status: 200 })
    }
    const tagMatch = /dsh-v(.+)$/.exec(url)
    const target = tagMatch?.[1]
    const sha = target === latestVersion
      ? options.latestCommit ?? alpha3Commit
      : target !== undefined && target === nextVersion
        ? options.nextCommit ?? alpha3Commit
        : options.commit ?? alpha3Commit
    return new Response(JSON.stringify({ object: { sha } }), { status: 200 })
  }) as typeof fetch
}

test('同时匹配 npm alpha、不可变标签和受信清单才允许自动更新', async () => {
  const result = await checkHarnessUpdate({ currentVersion: '0.1.2-alpha.2', fetch: releaseFetch(), now: '2026-09-01T00:00:00.000Z' })
  assert.equal(result.updateAvailable, true)
  assert.equal(result.candidate?.version, '0.1.2-alpha.3')
  assert.equal(result.candidate?.githubCommit, alpha3Commit)
  assert.equal(result.candidate?.automaticEligible, true)
})

test('通过实机候选门禁的 alpha.5 已进入内置受信清单', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.2-alpha.3',
    fetch: releaseFetch({ version: '0.1.2-alpha.5', integrity: alpha5Integrity, commit: alpha5Commit }),
  })
  assert.equal(result.candidate?.automaticEligible, true)
  assert.equal(result.candidate?.githubCommit, alpha5Commit)
})

test('0.1.2-rc.1 已进入内置受信清单，满足用户升级请求', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.2-alpha.5',
    fetch: releaseFetch({ version: '0.1.2-rc.1', integrity: rc1Integrity, commit: rc1Commit }),
  })
  assert.equal(result.candidate?.automaticEligible, true)
  assert.equal(result.candidate?.githubCommit, rc1Commit)
})

test('0.1.5-rc.1 已重新受信：生态适配后允许自动切换', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.2-rc.1',
    fetch: releaseFetch({ version: '0.1.5-rc.1', integrity: rc1_5Integrity, commit: rc1_5Commit }),
  })
  assert.equal(result.candidate?.version, '0.1.5-rc.1')
  assert.equal(result.candidate?.automaticEligible, true)
  assert.equal(result.candidate?.githubCommit, rc1_5Commit)
})

test('0.1.5-rc.2（next 候选线 = 官方 HEAD）已受信：与「关于」页展示口径一致', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.5-rc.1',
    fetch: releaseFetch({
      version: '0.1.5-alpha.2',
      latestVersion: '0.1.5-rc.1',
      latestIntegrity: rc1_5Integrity,
      latestCommit: rc1_5Commit,
      nextVersion: '0.1.5-rc.2',
      nextIntegrity: rc2_5Integrity,
      nextCommit: rc2_5Commit,
    }),
  })
  assert.equal(result.candidate?.version, '0.1.5-rc.2')
  assert.equal(result.candidate?.automaticEligible, true)
  assert.equal(result.candidate?.githubCommit, rc2_5Commit)
})

test('next 线出现未受信新版本时只通知，并回退到受信版本', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.5-rc.1',
    fetch: releaseFetch({
      version: '0.1.5-alpha.2',
      latestVersion: '0.1.5-rc.2',
      latestIntegrity: rc2_5Integrity,
      latestCommit: rc2_5Commit,
      nextVersion: '0.1.5-rc.3',
      nextIntegrity: rc2_5Integrity,
      nextCommit: rc2_5Commit,
    }),
  })
  assert.equal(result.candidate?.version, '0.1.5-rc.2')
  assert.equal(result.candidate?.automaticEligible, true)
})

test('唯一可用的 next 候选未受信时给出受信清单原因，不静默切换', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.5-rc.2',
    fetch: releaseFetch({
      version: '0.1.5-alpha.2',
      latestVersion: '0.1.5-rc.1',
      latestIntegrity: rc1_5Integrity,
      latestCommit: rc1_5Commit,
      nextVersion: '0.1.5-rc.3',
      nextIntegrity: rc2_5Integrity,
      nextCommit: rc2_5Commit,
    }),
  })
  assert.equal(result.updateAvailable, true)
  assert.equal(result.candidate?.version, '0.1.5-rc.3')
  assert.equal(result.candidate?.automaticEligible, false)
  assert.match(result.candidate?.automaticBlockReason ?? '', /受信发布清单/)
})

test('0.1.5-alpha.1 已除名：仅通知，不自动切换', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.2-alpha.5',
    fetch: releaseFetch({ version: '0.1.5-alpha.1', integrity: alpha1_5Integrity, commit: alpha1_5Commit }),
  })
  assert.equal(result.candidate?.version, '0.1.5-alpha.1')
  assert.equal(result.candidate?.automaticEligible, false)
  assert.match(result.candidate?.automaticBlockReason ?? '', /受信发布清单/)
})

test('alpha 候选未受信时回退 latest 稳定线的受信版本', async () => {
  const result = await checkHarnessUpdate({
    currentVersion: '0.1.2-alpha.5',
    fetch: releaseFetch({
      version: '0.1.5-alpha.1',
      integrity: alpha1_5Integrity,
      commit: alpha1_5Commit,
      latestVersion: '0.1.2-rc.1',
      latestIntegrity: rc1Integrity,
      latestCommit: rc1Commit,
    }),
  })
  assert.equal(result.candidate?.version, '0.1.2-rc.1')
  assert.equal(result.candidate?.automaticEligible, true)
  assert.equal(result.candidate?.githubCommit, rc1Commit)
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
  assert.equal(policy.maxAutomaticDeployAttempts, 2)
  assert.equal(policy.deployRetryCooldownHours, 24)
  const clamped = sanitizeHarnessUpdatePolicy({ maxAutomaticDeployAttempts: 0, deployRetryCooldownHours: 10_000 })
  assert.equal(clamped.maxAutomaticDeployAttempts, 2)
  assert.equal(clamped.deployRetryCooldownHours, 24)
})

test('同一版本连续部署失败后暂停自动升级，手动重试与冷却结束仍可继续', () => {
  const now = '2026-09-11T14:00:00.000Z'
  const nowMs = Date.parse(now)
  let failures = recordDeploymentFailure({}, '0.1.5-rc.2', '候选 DSH 运行时核心包版本未对齐。', now)
  assert.equal(failures['0.1.5-rc.2']?.attempts, 1)
  assert.equal(evaluateDeploymentRetryGate({ version: '0.1.5-rc.2', failures, nowMs }).allowed, true)
  failures = recordDeploymentFailure({ deploymentFailures: failures }, '0.1.5-rc.2', '真实 Profile 启动失败：cannot get property webServer without inject', now)
  assert.equal(failures['0.1.5-rc.2']?.attempts, 2)
  const blocked = evaluateDeploymentRetryGate({ version: '0.1.5-rc.2', failures, nowMs: nowMs + 60_000 })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.attempts, 2)
  assert.match(blocked.reason ?? '', /0\.1\.5-rc\.2 已连续 2 次部署失败/)
  assert.match(blocked.reason ?? '', /webServer without inject/)
  assert.match(blocked.reason ?? '', /手动重试/)
  // 失败记忆按版本隔离：更新的候选与更旧的候选都不受影响。
  assert.equal(evaluateDeploymentRetryGate({ version: '0.1.6-rc.1', failures, nowMs }).allowed, true)
  assert.equal(evaluateDeploymentRetryGate({ version: '0.1.5-rc.1', failures, nowMs }).allowed, true)
  // 冷却期结束后恢复自动重试，用户手动重试则不受闸门限制（由调用方传 interactive）。
  assert.equal(evaluateDeploymentRetryGate({ version: '0.1.5-rc.2', failures, nowMs: nowMs + 24 * 3_600_000 }).allowed, true)
  assert.equal(evaluateDeploymentRetryGate({ version: '0.1.5-rc.2', failures, nowMs: nowMs + 23 * 3_600_000 }).allowed, false)
  assert.deepEqual(clearDeploymentFailure({ deploymentFailures: failures }, '0.1.5-rc.2'), {})
  assert.deepEqual(clearDeploymentFailure({}, '0.1.5-rc.2'), {})
})

test('失败记忆持久化时过滤非法版本键、非法字段与超量条目', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-harness-failures-'))
  try {
    const path = harnessUpdateStatePath(root)
    const saved = await saveHarnessUpdateState(path, {
      phase: 'blocked',
      currentVersion: '0.1.2-rc.1',
      deploymentFailures: {
        '0.1.5-rc.2': { attempts: 2, lastFailureAt: '2026-09-11T14:00:00.000Z', detail: '失败\n原因' },
        'not-a-version': { attempts: 1, lastFailureAt: '2026-09-11T14:00:00.000Z' },
        ['__proto__']: { attempts: 1, lastFailureAt: '2026-09-11T14:00:00.000Z' },
        '0.1.5-rc.1': { attempts: 0, lastFailureAt: 'not-a-date' },
      },
    }, '0.1.2-rc.1')
    assert.deepEqual(Object.keys(saved.deploymentFailures ?? {}), ['0.1.5-rc.2'])
    assert.equal(saved.deploymentFailures?.['0.1.5-rc.2']?.detail, '失败 原因')
    assert.equal(Object.getPrototypeOf(saved.deploymentFailures), Object.prototype)
    assert.deepEqual(await loadHarnessUpdateState(path, '0.1.2-rc.1'), saved)
    const capped = recordDeploymentFailure(
      { deploymentFailures: Object.fromEntries(Array.from({ length: 30 }, (_item, index) => [
        `0.1.${index + 1}`,
        { attempts: 1, lastFailureAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() },
      ])) },
      '0.9.9',
      '新增失败',
      '2026-09-11T23:00:00.000Z',
    )
    assert.equal(Object.keys(capped).length, 20)
    assert.equal(capped['0.9.9']?.attempts, 1)
    assert.equal(capped['0.1.12'] !== undefined, true)
    assert.equal(capped['0.1.11'], undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
