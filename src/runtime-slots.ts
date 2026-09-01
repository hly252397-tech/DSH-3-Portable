import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { writeTextFileAtomicSync } from './atomic-file.js'
import { isOfficialRuntimeLaunchable, readInstalledPackageVersion } from './plugin-seed.js'

export interface RuntimeSlotReference {
  readonly relativePath: string
  readonly version: string
  readonly fingerprint: string
}

export interface RuntimeSlotPointer {
  readonly schema: 1
  readonly current: RuntimeSlotReference
  readonly previous?: RuntimeSlotReference
  readonly activatedAt: string
  readonly committedAt?: string
  readonly pendingTransactionId?: string
  readonly lastFailed?: RuntimeSlotReference & { failedAt: string; reason: string }
}

export function harnessRuntimeRoot(legacyRuntimeDir: string): string {
  return join(dirname(resolve(legacyRuntimeDir)), 'Harness')
}

export function runtimePointerPath(legacyRuntimeDir: string): string {
  return join(harnessRuntimeRoot(legacyRuntimeDir), 'current.json')
}

export function runtimeSlotsRoot(legacyRuntimeDir: string): string {
  return join(harnessRuntimeRoot(legacyRuntimeDir), 'slots')
}

export function readRuntimeSlotPointer(legacyRuntimeDir: string): RuntimeSlotPointer | undefined {
  try {
    const parsed = JSON.parse(readFileSync(runtimePointerPath(legacyRuntimeDir), 'utf8')) as Partial<RuntimeSlotPointer>
    if (parsed.schema !== 1 || !isSlotReference(parsed.current)) return undefined
    return {
      schema: 1,
      current: parsed.current,
      ...(isSlotReference(parsed.previous) ? { previous: parsed.previous } : {}),
      activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : '',
      ...(typeof parsed.committedAt === 'string' ? { committedAt: parsed.committedAt } : {}),
      ...(typeof parsed.pendingTransactionId === 'string' ? { pendingTransactionId: parsed.pendingTransactionId } : {}),
      ...(isFailedReference(parsed.lastFailed) ? { lastFailed: parsed.lastFailed } : {}),
    }
  } catch {
    return undefined
  }
}

/** 指针损坏或候选不完整时优先退回 previous，最后退回旧版固定目录。 */
export function resolveActiveRuntimeDir(legacyRuntimeDir: string): string {
  const runtimeRoot = dirname(resolve(legacyRuntimeDir))
  const pointer = readRuntimeSlotPointer(legacyRuntimeDir)
  for (const reference of [pointer?.current, pointer?.previous]) {
    const candidate = reference === undefined ? undefined : resolveSlotReference(runtimeRoot, reference)
    if (candidate !== undefined && isOfficialRuntimeLaunchable(candidate)) return candidate
  }
  return resolve(legacyRuntimeDir)
}

export function runtimeSlotDirectory(legacyRuntimeDir: string, version: string, fingerprint: string): string {
  if (!isExactVersion(version)) throw new Error(`非法 DSH 运行时版本：${version}`)
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error('非法 DSH 运行时指纹。')
  return join(runtimeSlotsRoot(legacyRuntimeDir), `${version}-${fingerprint.slice(0, 16).toLowerCase()}`)
}

export function activateRuntimeSlot(options: {
  legacyRuntimeDir: string
  candidateDir: string
  version: string
  fingerprint: string
  transactionId: string
  now?: string
}): RuntimeSlotPointer {
  const runtimeRoot = dirname(resolve(options.legacyRuntimeDir))
  const candidateDir = resolve(options.candidateDir)
  if (!isPathWithin(runtimeRoot, candidateDir) || !isOfficialRuntimeLaunchable(candidateDir)) {
    throw new Error('候选 DSH 运行时不完整或位于运行时根目录之外。')
  }
  const previousDir = resolveActiveRuntimeDir(options.legacyRuntimeDir)
  const previous = slotReference(runtimeRoot, previousDir)
  const current: RuntimeSlotReference = {
    relativePath: portableRelativePath(runtimeRoot, candidateDir),
    version: options.version,
    fingerprint: options.fingerprint.toLowerCase(),
  }
  const pointer: RuntimeSlotPointer = {
    schema: 1,
    current,
    ...(sameReference(current, previous) ? {} : { previous }),
    activatedAt: options.now ?? new Date().toISOString(),
    pendingTransactionId: options.transactionId,
  }
  writePointer(options.legacyRuntimeDir, pointer)
  return pointer
}

export function commitRuntimeSlot(legacyRuntimeDir: string, transactionId: string, now = new Date().toISOString()): RuntimeSlotPointer {
  const pointer = requirePendingPointer(legacyRuntimeDir, transactionId)
  const committed: RuntimeSlotPointer = {
    ...pointer,
    committedAt: now,
    pendingTransactionId: undefined,
  }
  writePointer(legacyRuntimeDir, committed)
  return committed
}

export function rollbackRuntimeSlot(
  legacyRuntimeDir: string,
  transactionId: string,
  reason: string,
  now = new Date().toISOString(),
): RuntimeSlotPointer {
  const pointer = requirePendingPointer(legacyRuntimeDir, transactionId)
  if (pointer.previous === undefined) throw new Error('没有可回滚的上一版 DSH 运行时。')
  const rolledBack: RuntimeSlotPointer = {
    schema: 1,
    current: pointer.previous,
    activatedAt: now,
    committedAt: now,
    lastFailed: {
      ...pointer.current,
      failedAt: now,
      reason: reason.replace(/\s+/g, ' ').slice(0, 1_000),
    },
  }
  writePointer(legacyRuntimeDir, rolledBack)
  return rolledBack
}

/** 进程在切换观察期崩溃时，下一次启动先恢复上一已知可用槽。 */
export function recoverInterruptedRuntimeSwitch(legacyRuntimeDir: string, now = new Date().toISOString()): RuntimeSlotPointer | undefined {
  const pointer = readRuntimeSlotPointer(legacyRuntimeDir)
  if (pointer?.pendingTransactionId === undefined) return pointer
  if (pointer.previous === undefined) throw new Error('检测到未完成的 DSH 运行时切换，但没有可恢复的上一槽。')
  return rollbackRuntimeSlot(legacyRuntimeDir, pointer.pendingTransactionId, '上次运行时切换未完成，启动时自动回滚。', now)
}

export function runtimeSlotVersion(directory: string): string | undefined {
  return readInstalledPackageVersion(directory, '@deepseek-ai/dsh')
}

function requirePendingPointer(legacyRuntimeDir: string, transactionId: string): RuntimeSlotPointer {
  const pointer = readRuntimeSlotPointer(legacyRuntimeDir)
  if (pointer === undefined || pointer.pendingTransactionId !== transactionId) {
    throw new Error('DSH 运行时切换事务不存在或已结束。')
  }
  return pointer
}

function writePointer(legacyRuntimeDir: string, pointer: RuntimeSlotPointer): void {
  mkdirSync(harnessRuntimeRoot(legacyRuntimeDir), { recursive: true })
  writeTextFileAtomicSync(runtimePointerPath(legacyRuntimeDir), `${JSON.stringify(pointer, undefined, 2)}\n`)
}

function slotReference(runtimeRoot: string, directory: string): RuntimeSlotReference {
  const version = runtimeSlotVersion(directory)
  if (version === undefined) throw new Error(`无法读取 DSH 运行时版本：${directory}`)
  return {
    relativePath: portableRelativePath(runtimeRoot, directory),
    version,
    fingerprint: directoryFingerprint(directory),
  }
}

function portableRelativePath(runtimeRoot: string, directory: string): string {
  if (!isPathWithin(runtimeRoot, directory)) throw new Error('DSH 运行时路径越界。')
  return relative(runtimeRoot, directory).replaceAll('\\', '/')
}

function resolveSlotReference(runtimeRoot: string, reference: RuntimeSlotReference): string | undefined {
  if (isAbsolute(reference.relativePath)) return undefined
  const candidate = resolve(runtimeRoot, reference.relativePath)
  return isPathWithin(runtimeRoot, candidate) ? candidate : undefined
}

function directoryFingerprint(directory: string): string {
  const marker = join(directory, '.dsh-runtime-fingerprint')
  try {
    const value = readFileSync(marker, 'utf8').trim().toLowerCase()
    if (/^[a-f0-9]{64}$/.test(value)) return value
  } catch {
    // 兼容迁移前的旧固定运行时。
  }
  return '0'.repeat(64)
}

function isSlotReference(value: unknown): value is RuntimeSlotReference {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RuntimeSlotReference>
  return typeof candidate.relativePath === 'string'
    && candidate.relativePath !== ''
    && typeof candidate.version === 'string'
    && isExactVersion(candidate.version)
    && typeof candidate.fingerprint === 'string'
    && /^[a-f0-9]{64}$/i.test(candidate.fingerprint)
}

function isFailedReference(value: unknown): value is RuntimeSlotReference & { failedAt: string; reason: string } {
  return isSlotReference(value)
    && typeof (value as { failedAt?: unknown }).failedAt === 'string'
    && typeof (value as { reason?: unknown }).reason === 'string'
}

function isExactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
}

function sameReference(left: RuntimeSlotReference, right: RuntimeSlotReference): boolean {
  return left.relativePath.toLowerCase() === right.relativePath.toLowerCase() && left.version === right.version
}

function isPathWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path))
}
