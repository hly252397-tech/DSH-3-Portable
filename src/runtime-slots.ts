import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { writeTextFileAtomicSync } from './atomic-file.js'
import { isOfficialRuntimeLaunchable, readInstalledPackageVersion } from './plugin-seed.js'

export interface RuntimeSlotReference {
  readonly relativePath: string
  readonly version: string
  /**
   * 槽指纹（`.dsh-runtime-fingerprint` 的内容）。
   * 缺省表示「该目录没有指纹」——迁移前的旧固定运行时就是这种，**不是**全零指纹。
   */
  readonly fingerprint?: string
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

/**
 * 指针损坏或候选不完整时优先退回 previous，最后退回旧版固定目录。
 *
 * 为什么保留最后这条 legacy 回退：老安装（还没有 `Harness/current.json`，或槽全部损坏）
 * 仍要靠固定目录才能启动，下游把它当作「当前运行时目录」直接用，删掉这条分支等于让
 * 这类实例起不来——所以这里只补可观测信号，不改行为。
 *
 * 风险（必须留痕）：legacy 固定目录**没有槽（家园）绑定**，它读写的仍是共享的 `Data/DSH`
 * 那份运行时；一旦走到这条分支，A/B、回滚和「槽不可变」保护全部失效，而且下次启动还会
 * 继续落到这里。没有这条 warn，「槽全坏了」和「一切正常」在日志上完全无法区分。
 */
export function resolveActiveRuntimeDir(legacyRuntimeDir: string): string {
  const runtimeRoot = dirname(resolve(legacyRuntimeDir))
  const pointer = readRuntimeSlotPointer(legacyRuntimeDir)
  for (const reference of [pointer?.current, pointer?.previous]) {
    const candidate = reference === undefined ? undefined : resolveSlotReference(runtimeRoot, reference)
    if (candidate !== undefined && isOfficialRuntimeLaunchable(candidate)) return candidate
  }
  const fallback = resolve(legacyRuntimeDir)
  const reason = pointer === undefined ? '运行时指针缺失或损坏' : 'current/previous 两个槽都不可启动'
  console.warn(
    `[runtime-slots] ${reason}，回退旧版固定目录（该目录无槽绑定，会直接读写共享 Data/DSH，A/B 与回滚保护失效）：${fallback}`,
  )
  return fallback
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
  if (isAllZeroFingerprint(options.fingerprint)) {
    throw new Error('拒绝用全零指纹激活 DSH 运行时槽：指纹缺失/损坏时不得冒充合法值落盘。')
  }
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
  return writePointer(options.legacyRuntimeDir, pointer)
}

export function commitRuntimeSlot(legacyRuntimeDir: string, transactionId: string, now = new Date().toISOString()): RuntimeSlotPointer {
  const pointer = requirePendingPointer(legacyRuntimeDir, transactionId)
  const committed: RuntimeSlotPointer = {
    ...pointer,
    committedAt: now,
    pendingTransactionId: undefined,
  }
  return writePointer(legacyRuntimeDir, committed)
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
  return writePointer(legacyRuntimeDir, rolledBack)
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

function writePointer(legacyRuntimeDir: string, pointer: RuntimeSlotPointer): RuntimeSlotPointer {
  //落盘前的最后一道闸：历史指针里可能带着老版本伪造的全零指纹，读的时候放行（否则旧槽
  //读不回来），写的时候一律摘掉——全零指纹只允许存在于磁盘上的旧数据，不允许被再次落盘。
  const withoutFabricated = <T extends RuntimeSlotReference>(reference: T): T => {
    if (reference.fingerprint === undefined || !isAllZeroFingerprint(reference.fingerprint)) return reference
    console.warn(`[runtime-slots] 指针携带全零指纹，已拒绝写回（视为「无指纹」）：${reference.relativePath}`)
    const clone: T = { ...reference }
    delete (clone as { fingerprint?: string }).fingerprint
    return clone
  }
  const previous = pointer.previous === undefined ? undefined : withoutFabricated(pointer.previous)
  const lastFailed = pointer.lastFailed === undefined ? undefined : withoutFabricated(pointer.lastFailed)
  const cleaned: RuntimeSlotPointer = {
    ...pointer,
    current: withoutFabricated(pointer.current),
    ...(previous === undefined ? {} : { previous }),
    ...(lastFailed === undefined ? {} : { lastFailed }),
  }
  mkdirSync(harnessRuntimeRoot(legacyRuntimeDir), { recursive: true })
  writeTextFileAtomicSync(runtimePointerPath(legacyRuntimeDir), `${JSON.stringify(cleaned, undefined, 2)}\n`)
  return cleaned
}

function slotReference(runtimeRoot: string, directory: string): RuntimeSlotReference {
  const version = runtimeSlotVersion(directory)
  if (version === undefined) throw new Error(`无法读取 DSH 运行时版本：${directory}`)
  const fingerprint = directoryFingerprint(directory)
  // 无指纹就诚实地不写 fingerprint 字段，不为了让 isSlotReference 通过而伪造全零值。
  return {
    relativePath: portableRelativePath(runtimeRoot, directory),
    version,
    ...(fingerprint === undefined ? {} : { fingerprint }),
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

/**
 * 读槽指纹；marker 缺失/损坏时返回 `undefined`（「无指纹」）并打一条 warn。
 *
 * 旧行为返回 `'0'.repeat(64)`：它能通过 `isSlotReference` 的 64 位十六进制校验，于是被当成
 * 真指纹写进 `current.json` / `lastFailed`，之后再也分不清「真指纹」和「根本没有指纹」。
 * `undefined` 是显式的「无指纹」，调用方自行决定怎么处置（`slotReference` 决定不写这个字段）。
 */
function directoryFingerprint(directory: string): string | undefined {
  const marker = join(directory, '.dsh-runtime-fingerprint')
  let raw: string
  try {
    raw = readFileSync(marker, 'utf8')
  } catch {
    // 迁移前的旧固定运行时根本没有 marker：属于「无指纹」，不是全零指纹。
    console.warn(`[runtime-slots] 槽指纹文件缺失，按「无指纹」处理：${marker}`)
    return undefined
  }
  const value = raw.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(value)) {
    console.warn(`[runtime-slots] 槽指纹文件内容非法，按「无指纹」处理：${marker}`)
    return undefined
  }
  return value
}

function isAllZeroFingerprint(value: string): boolean {
  return /^0{64}$/i.test(value)
}

function isSlotReference(value: unknown): value is RuntimeSlotReference {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RuntimeSlotReference>
  return typeof candidate.relativePath === 'string'
    && candidate.relativePath !== ''
    && typeof candidate.version === 'string'
    && isExactVersion(candidate.version)
    // 指纹可缺省（= 无指纹）；旧指针里已经落盘的全零指纹必须继续放行，否则历史槽读不回来。
    && (candidate.fingerprint === undefined
      || (typeof candidate.fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(candidate.fingerprint)))
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
