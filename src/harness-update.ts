import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeTextFileAtomic } from './atomic-file.js'
import { compareReleaseVersions } from './bundled-plugins.js'

export type HarnessUpdateMode = 'manual' | 'notify' | 'safe-auto' | 'maintenance-auto'

export interface HarnessUpdatePolicy {
  readonly channel: 'alpha'
  readonly mode: HarnessUpdateMode
  readonly checkIntervalHours: number
  readonly idleQuietSeconds: number
  readonly shadowStartupTimeoutSeconds: number
  readonly liveStartupTimeoutSeconds: number
  readonly observationMinutes: number
  readonly rollbackTimeoutSeconds: number
  readonly maxDownloadRetries: number
  readonly keepGoodSlots: number
  readonly skipVersions: readonly string[]
}

export interface TrustedHarnessRelease {
  readonly version: string
  readonly npmIntegrity: string
  readonly githubCommit: string
}

export interface HarnessReleaseCandidate {
  readonly version: string
  readonly npmIntegrity: string
  readonly npmTarball: string
  readonly npmSignatureKeyIds: readonly string[]
  readonly githubTag: string
  readonly githubCommit: string
  readonly automaticEligible: boolean
  readonly automaticBlockReason?: string
}

export interface HarnessUpdateCheckResult {
  readonly checkedAt: string
  readonly currentVersion: string
  readonly updateAvailable: boolean
  readonly candidate?: HarnessReleaseCandidate
}

export interface HarnessUpdateEvent {
  readonly transactionId: string
  readonly phase: string
  readonly outcome: 'start' | 'success' | 'failure' | 'blocked' | 'info'
  readonly timestamp: string
  readonly currentVersion?: string
  readonly targetVersion?: string
  readonly detail?: string
  readonly durationMs?: number
}

export type HarnessUpdatePhase = 'idle' | 'checking' | 'available' | 'building' | 'shadow-validating' | 'waiting-idle' | 'switching' | 'observing' | 'succeeded' | 'rolled-back' | 'blocked' | 'failed'

export interface HarnessUpdateState {
  readonly schema: 1
  readonly phase: HarnessUpdatePhase
  readonly currentVersion: string
  readonly updatedAt: string
  readonly targetVersion?: string
  readonly transactionId?: string
  readonly lastCheckedAt?: string
  readonly lastSucceededAt?: string
  readonly detail?: string
}

export const DEFAULT_HARNESS_UPDATE_POLICY: HarnessUpdatePolicy = {
  channel: 'alpha',
  mode: 'safe-auto',
  checkIntervalHours: 6,
  idleQuietSeconds: 30,
  shadowStartupTimeoutSeconds: 60,
  liveStartupTimeoutSeconds: 60,
  observationMinutes: 5,
  rollbackTimeoutSeconds: 90,
  maxDownloadRetries: 3,
  keepGoodSlots: 3,
  skipVersions: [],
}

/**
 * 受信清单由桌面发布流程固定；未知新版本仍会被发现，但只能通知，不能静默切换。
 * 后续 CI 应把该数据替换为 Ed25519 签名的外部运行时清单。
 */
export const BUILTIN_TRUSTED_HARNESS_RELEASES: readonly TrustedHarnessRelease[] = [{
  version: '0.1.2-alpha.3',
  npmIntegrity: 'sha512-VvATzYmQ4LMJREJ9e2POKksSHRfqP3y9pghplLBaQBuw2BqfbC0mQUVsaPwxe4wlcpj+riEgn8OJB01YnpF+3A==',
  githubCommit: 'dd6322d604e00eec1ba5e0c8541159906a21094a',
}, {
  // 2026-09-02：npm registry 签名、GitHub 不可变标签、223 包候选闭包、
  // 隔离影子启动及现有社区插件 Profile 兼容启动均已通过。
  version: '0.1.2-alpha.5',
  npmIntegrity: 'sha512-MrD2rPhmjz+8Phs+d9lD9xL1qswCYjcSHMd96fF8NTdDm7FRRsU5QhLDR0x6U4JwGxEvee1pccuvbZY6NyEQhA==',
  githubCommit: 'db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5',
}, {
  // 2026-09-09：按用户要求升级到 rc.1；npm integrity、GitHub 标签 commit 已核对。
  version: '0.1.2-rc.1',
  npmIntegrity: 'sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA==',
  githubCommit: 'a66e4702047846cdaa10c66c9d3df3951f5ea70d',
}]

// 2026-09-09 曾短暂受信 0.1.5-alpha.1（npm integrity sha512-AUjywjrPnhXcAdAjRNgyQa1QCnplFTNYZ+XpR9uCZdbg2FiCb06pHyoDUB2Wxuddzid9D7pVwEiU1OTl4Oshsg==，
// GitHub commit 5dda764ed3aa172535a7967b06ff95d9cbfe536a）后除名：影子验证可通过，但真实
// Profile 启动时 MichengAI 插件族（dsh-automation 0.1.35 最新版）抛
// "cannot get property webServer without inject"，生态尚未适配。重新受信前必须先过实机 Profile 验证。

export function harnessUpdateRoot(portableRoot: string): string {
  return join(portableRoot, 'Data', 'Updates', 'Harness')
}

export function harnessUpdatePolicyPath(updateRoot: string): string {
  return join(updateRoot, 'policy.json')
}

export function harnessUpdateAuditPath(updateRoot: string): string {
  return join(updateRoot, 'logs', 'update-events.jsonl')
}

export function harnessUpdateStatePath(updateRoot: string): string {
  return join(updateRoot, 'state.json')
}

export async function loadHarnessUpdateState(path: string, currentVersion: string): Promise<HarnessUpdateState> {
  try {
    return sanitizeHarnessUpdateState(JSON.parse(await readFile(path, 'utf8')), currentVersion)
  } catch {
    return { schema: 1, phase: 'idle', currentVersion, updatedAt: new Date().toISOString() }
  }
}

export async function saveHarnessUpdateState(path: string, value: unknown, currentVersion: string): Promise<HarnessUpdateState> {
  const state = sanitizeHarnessUpdateState(value, currentVersion)
  await mkdir(dirname(path), { recursive: true })
  await writeTextFileAtomic(path, `${JSON.stringify(state, undefined, 2)}\n`)
  return state
}

export function sanitizeHarnessUpdateState(value: unknown, currentVersion: string): HarnessUpdateState {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<HarnessUpdateState> : {}
  const phases: readonly HarnessUpdatePhase[] = ['idle', 'checking', 'available', 'building', 'shadow-validating', 'waiting-idle', 'switching', 'observing', 'succeeded', 'rolled-back', 'blocked', 'failed']
  const phase = phases.includes(candidate.phase as HarnessUpdatePhase) ? candidate.phase as HarnessUpdatePhase : 'idle'
  const exact = (input: unknown): string | undefined => typeof input === 'string' && isExactVersion(input) ? input : undefined
  const iso = (input: unknown): string | undefined => typeof input === 'string' && !Number.isNaN(Date.parse(input)) ? new Date(input).toISOString() : undefined
  const transactionId = typeof candidate.transactionId === 'string' && /^[a-f0-9-]{8,64}$/i.test(candidate.transactionId) ? candidate.transactionId : undefined
  const detail = typeof candidate.detail === 'string' ? candidate.detail.replace(/\s+/g, ' ').trim().slice(0, 2_000) : undefined
  return {
    schema: 1,
    phase,
    currentVersion: exact(candidate.currentVersion) ?? currentVersion,
    updatedAt: iso(candidate.updatedAt) ?? new Date().toISOString(),
    ...(exact(candidate.targetVersion) === undefined ? {} : { targetVersion: exact(candidate.targetVersion) }),
    ...(transactionId === undefined ? {} : { transactionId }),
    ...(iso(candidate.lastCheckedAt) === undefined ? {} : { lastCheckedAt: iso(candidate.lastCheckedAt) }),
    ...(iso(candidate.lastSucceededAt) === undefined ? {} : { lastSucceededAt: iso(candidate.lastSucceededAt) }),
    ...(detail === undefined || detail === '' ? {} : { detail }),
  }
}

export async function loadHarnessUpdatePolicy(path: string): Promise<HarnessUpdatePolicy> {
  try {
    return sanitizeHarnessUpdatePolicy(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return DEFAULT_HARNESS_UPDATE_POLICY
  }
}

export async function saveHarnessUpdatePolicy(path: string, value: unknown): Promise<HarnessUpdatePolicy> {
  const policy = sanitizeHarnessUpdatePolicy(value)
  await mkdir(dirname(path), { recursive: true })
  await writeTextFileAtomic(path, `${JSON.stringify(policy, undefined, 2)}\n`)
  return policy
}

export function sanitizeHarnessUpdatePolicy(value: unknown): HarnessUpdatePolicy {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<HarnessUpdatePolicy> : {}
  const mode = candidate.mode === 'manual' || candidate.mode === 'notify' || candidate.mode === 'safe-auto' || candidate.mode === 'maintenance-auto'
    ? candidate.mode
    : DEFAULT_HARNESS_UPDATE_POLICY.mode
  const numbers = DEFAULT_HARNESS_UPDATE_POLICY
  return {
    channel: 'alpha',
    mode,
    checkIntervalHours: bounded(candidate.checkIntervalHours, 1, 168, numbers.checkIntervalHours),
    idleQuietSeconds: bounded(candidate.idleQuietSeconds, 10, 600, numbers.idleQuietSeconds),
    shadowStartupTimeoutSeconds: bounded(candidate.shadowStartupTimeoutSeconds, 15, 300, numbers.shadowStartupTimeoutSeconds),
    liveStartupTimeoutSeconds: bounded(candidate.liveStartupTimeoutSeconds, 15, 300, numbers.liveStartupTimeoutSeconds),
    observationMinutes: bounded(candidate.observationMinutes, 1, 60, numbers.observationMinutes),
    rollbackTimeoutSeconds: bounded(candidate.rollbackTimeoutSeconds, 30, 300, numbers.rollbackTimeoutSeconds),
    maxDownloadRetries: bounded(candidate.maxDownloadRetries, 0, 10, numbers.maxDownloadRetries),
    keepGoodSlots: bounded(candidate.keepGoodSlots, 2, 10, numbers.keepGoodSlots),
    skipVersions: Array.isArray(candidate.skipVersions)
      ? [...new Set(candidate.skipVersions.filter((item): item is string => typeof item === 'string' && isExactVersion(item)))].slice(0, 100)
      : [],
  }
}

export async function checkHarnessUpdate(options: {
  currentVersion: string
  fetch?: typeof fetch
  now?: string
  policy?: HarnessUpdatePolicy
  trusted?: readonly TrustedHarnessRelease[]
}): Promise<HarnessUpdateCheckResult> {
  const fetchImpl = options.fetch ?? fetch
  const policy = options.policy ?? DEFAULT_HARNESS_UPDATE_POLICY
  const checkedAt = options.now ?? new Date().toISOString()
  const registryUrl = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'
  const registryResponse = await fetchImpl(registryUrl, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!registryResponse.ok) throw new Error(`npm 官方 registry 返回 HTTP ${registryResponse.status}。`)
  const registry = await registryResponse.json() as {
    'dist-tags'?: Record<string, unknown>
    versions?: Record<string, { dist?: { integrity?: unknown; tarball?: unknown; signatures?: Array<{ keyid?: unknown }> } }>
  }
  const distTags = registry['dist-tags'] ?? {}
  // 发现通道取 policy.channel（alpha 预览线）加 latest 稳定线；能否自动切换只由受信清单决定。
  // alpha 候选未受信时回退稳定线，避免预览版生态未适配时整体卡死在旧运行时。
  const discovered = [...new Set([distTags[policy.channel], distTags.latest])]
    .filter((tag): tag is string => typeof tag === 'string' && isExactVersion(tag))
    .sort((a, b) => compareReleaseVersions(b, a))
  if (discovered.length === 0) throw new Error('npm dist-tags 没有返回合法的精确版本。')
  let notifyOnly: {
    version: string
    npmIntegrity: string
    npmTarball: string
    npmSignatureKeyIds: readonly string[]
    githubTag: string
    githubCommit: string
    automaticBlockReason: string
  } | undefined
  let tagError: Error | undefined
  for (const target of discovered) {
    if (policy.skipVersions.includes(target) || compareReleaseVersions(target, options.currentVersion) <= 0) continue
    const dist = registry.versions?.[target]?.dist
    if (dist === undefined || typeof dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity)) {
      throw new Error('npm 候选版本缺少合法的 SHA512 integrity。')
    }
    if (typeof dist.tarball !== 'string' || !isAllowedNpmTarball(dist.tarball, target)) {
      throw new Error('npm 候选版本 tarball 来源不在允许列表。')
    }
    const signatureKeyIds = (dist.signatures ?? []).flatMap(signature => typeof signature.keyid === 'string' ? [signature.keyid] : [])
    if (signatureKeyIds.length === 0) throw new Error('npm 候选版本缺少 registry 签名声明。')

    const githubTag = `dsh-v${target}`
    let githubCommit: string | undefined
    try {
      const tagResponse = await fetchImpl(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/${githubTag}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DSH-Codex-Desktop-Harness-Updater' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!tagResponse.ok) throw new Error(`GitHub 不可变标签核对失败（HTTP ${tagResponse.status}）。`)
      const tag = await tagResponse.json() as { object?: { sha?: unknown } }
      const sha = tag.object?.sha
      if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error('GitHub 标签没有返回合法 commit。')
      githubCommit = sha
    } catch (error) {
      // 单个候选的标签核对失败不终止整个检查；无任何可用候选时再上抛。
      tagError = error instanceof Error ? error : new Error(String(error))
      continue
    }

    const trusted = (options.trusted ?? BUILTIN_TRUSTED_HARNESS_RELEASES).find(item => item.version === target)
    const automaticEligible = trusted !== undefined
      && trusted.npmIntegrity === dist.integrity
      && trusted.githubCommit.toLowerCase() === githubCommit.toLowerCase()
    if (automaticEligible && trusted !== undefined) {
      return {
        checkedAt,
        currentVersion: options.currentVersion,
        updateAvailable: true,
        candidate: {
          version: target,
          npmIntegrity: dist.integrity,
          npmTarball: dist.tarball,
          npmSignatureKeyIds: signatureKeyIds,
          githubTag,
          githubCommit: githubCommit.toLowerCase(),
          automaticEligible: true,
        },
      }
    }
    if (notifyOnly === undefined) {
      notifyOnly = {
        version: target,
        npmIntegrity: dist.integrity,
        npmTarball: dist.tarball,
        npmSignatureKeyIds: signatureKeyIds,
        githubTag,
        githubCommit: githubCommit.toLowerCase(),
        automaticBlockReason: trusted === undefined
          ? '候选版本尚未进入桌面端受信发布清单。'
          : '候选版本的 commit 或 npm integrity 与受信清单不一致。',
      }
    }
  }
  if (notifyOnly !== undefined) {
    return { checkedAt, currentVersion: options.currentVersion, updateAvailable: true, candidate: { ...notifyOnly, automaticEligible: false } }
  }
  if (tagError !== undefined) throw tagError
  return { checkedAt, currentVersion: options.currentVersion, updateAvailable: false }
}

export async function appendHarnessUpdateEvent(updateRoot: string, event: HarnessUpdateEvent): Promise<void> {
  await mkdir(join(updateRoot, 'logs'), { recursive: true })
  const sanitized: HarnessUpdateEvent = {
    ...event,
    ...(event.detail === undefined ? {} : { detail: event.detail.replace(/\s+/g, ' ').slice(0, 2_000) }),
  }
  await appendFile(harnessUpdateAuditPath(updateRoot), `${JSON.stringify(sanitized)}\n`, 'utf8')
}

export async function acquireHarnessUpdateLock(updateRoot: string, options: {
  nowMs?: number
  staleMs?: number
} = {}): Promise<{ transactionId: string; release: () => Promise<void> }> {
  const locks = join(updateRoot, 'locks')
  const lockPath = join(locks, 'update.lock')
  await mkdir(locks, { recursive: true })
  const nowMs = options.nowMs ?? Date.now()
  const staleMs = options.staleMs ?? 30 * 60_000
  if (existsSync(lockPath)) {
    try {
      const previous = JSON.parse(await readFile(lockPath, 'utf8')) as { createdAtMs?: unknown }
      if (typeof previous.createdAtMs !== 'number' || nowMs - previous.createdAtMs <= staleMs) {
        throw new Error('已有 DSH 运行时更新事务正在执行。')
      }
      await rm(lockPath, { force: true })
    } catch (error) {
      if (error instanceof Error && error.message.includes('正在执行')) throw error
      throw new Error('无法验证现有 DSH 运行时更新锁。')
    }
  }
  const transactionId = randomUUID()
  const handle = await open(lockPath, 'wx')
  await handle.writeFile(`${JSON.stringify({ transactionId, pid: process.pid, createdAtMs: nowMs })}\n`, 'utf8')
  await handle.close()
  return {
    transactionId,
    release: async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as { transactionId?: unknown }
        if (current.transactionId === transactionId) await rm(lockPath, { force: true })
      } catch {
        // 锁已被清理或损坏时，不删除未知文件。
      }
    },
  }
}

function isAllowedNpmTarball(value: string, version: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname === 'registry.npmjs.org'
      && url.pathname === `/@deepseek-ai/dsh/-/dsh-${version}.tgz`
  } catch {
    return false
  }
}

function isExactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
}

function bounded(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback
}
