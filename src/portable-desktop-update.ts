import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, type Stats } from 'node:fs'
import { appendFile, cp, mkdir, open, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { writeTextFileAtomic } from './atomic-file.js'
import { compareReleaseVersions } from './bundled-plugins.js'
import type { RuntimeExtractionProgress } from './extract-runtime.js'

type ReadStreamFactory = typeof createReadStream
type PhysicalRemoveOptions = { readonly force?: boolean; readonly recursive?: boolean }
type OriginalFsModule = {
  readonly createReadStream?: ReadStreamFactory
  readonly stat?: (path: string, callback: (error: NodeJS.ErrnoException | null, value: Stats) => void) => void
  readonly rm?: (path: string, options: PhysicalRemoveOptions, callback: (error: NodeJS.ErrnoException | null) => void) => void
}

/**
 * Electron patches node:fs so a path ending in app.asar is treated as an ASAR
 * directory. Integrity verification needs the physical archive bytes instead.
 * original-fs is supplied by Electron; plain Node/tests safely use node:fs.
 */
function originalFsModule(): OriginalFsModule | undefined {
  try {
    return createRequire(import.meta.url)('original-fs') as OriginalFsModule
  } catch {
    // original-fs only exists in Electron.
  }
  return undefined
}

const originalFs = originalFsModule()
const createPhysicalReadStream = typeof originalFs?.createReadStream === 'function'
  ? originalFs.createReadStream.bind(originalFs)
  : createReadStream

async function physicalStat(path: string): Promise<Stats> {
  if (typeof originalFs?.stat !== 'function') return await stat(path)
  return await new Promise<Stats>((resolvePromise, reject) => {
    originalFs.stat!(path, (error, value) => error === null ? resolvePromise(value) : reject(error))
  })
}

async function removePhysicalPath(path: string, options: PhysicalRemoveOptions): Promise<void> {
  if (typeof originalFs?.rm !== 'function') {
    await rm(path, options)
    return
  }
  await new Promise<void>((resolvePromise, reject) => {
    originalFs.rm!(path, options, error => error === null ? resolvePromise() : reject(error))
  })
}

export type PortableDesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'none'
  | 'available'
  | 'incompatible'
  | 'downloading'
  | 'verifying'
  | 'building'
  | 'ready'
  | 'deploying'
  | 'validating'
  | 'completed'
  | 'rolled-back'
  | 'error'

/**
 * 受信桌面更新源在构建期固化进制品（编译期常量或启动参数），运行时不存在可变的
 * 用户可改下载地址，避免把更新器变成任意 URL 下载器。
 */
export interface PortableDesktopReleaseSource {
  readonly owner: string
  readonly repo: string
  readonly artifactBase: string
}

export const DEFAULT_DESKTOP_RELEASE_SOURCE: PortableDesktopReleaseSource = {
  owner: 'MichengAI',
  repo: 'dsh-codex-desktop',
  artifactBase: 'dsh-codex-desktop',
}

export interface PortableDesktopRelease {
  readonly version: string
  readonly tag: string
  readonly assetName: string
  readonly assetUrl: string
  readonly assetSize: number
  readonly sha256: string
  readonly releaseNotes?: string
}

export interface PortableDesktopUpdateState {
  readonly schema: 1
  readonly phase: PortableDesktopUpdatePhase
  readonly currentVersion: string
  readonly updatedAt: string
  readonly overallProgress: number
  readonly stageProgress: number
  readonly detail: string
  readonly lastCheckedAt?: string
  readonly transactionId?: string
  readonly targetVersion?: string
  readonly release?: PortableDesktopRelease
  readonly slotRelativePath?: string
  readonly errorCode?: string
}

export interface PortableDesktopSlotReference {
  readonly relativePath: string
  readonly version: string
  readonly sha256: string
}

export interface PortableDesktopPointer {
  readonly schema: 1
  readonly current: PortableDesktopSlotReference
  readonly previous?: PortableDesktopSlotReference
  readonly pending?: PortableDesktopSlotReference & { transactionId: string }
  readonly updatedAt: string
}

export interface PortableDesktopUpdaterOptions {
  readonly portableRoot: string
  readonly currentVersion: string
  readonly releaseSource?: PortableDesktopReleaseSource
  readonly fetch?: typeof fetch
  readonly onState?: (state: PortableDesktopUpdateState) => void
  readonly expandArchive?: (archive: string, destination: string) => Promise<void>
  readonly readProductVersion?: (executable: string) => Promise<string>
  readonly prepareCandidateRuntime?: (appDirectory: string, onProgress: (progress: RuntimeExtractionProgress) => void) => Promise<void>
}

export interface StagedLocalDesktopBuild {
  readonly transactionId: string
  readonly slotRelativePath: string
  readonly version: string
}

const ACTIVE_PHASES: readonly PortableDesktopUpdatePhase[] = [
  'checking', 'downloading', 'verifying', 'building', 'deploying', 'validating',
]

const REQUIRED_APP_FILES = [
  'DSH Codex Desktop.exe',
  'resources/app.asar',
  'resources/node/node.exe',
  'resources/dsh-runtime.tgz',
  'resources/dsh-runtime.tgz.sha256',
  'resources/dsh-runtime.tgz.content-sha256',
  'resources/plugins-store.tgz',
  'resources/plugins-store.tgz.sha256',
  'resources/plugins-store.tgz.content-sha256',
  'resources/desktop-bridge/dsh-process.js',
  'resources/desktop-bridge/profile-bundle-health.js',
  'resources/desktop-bridge/profile-quarantine.js',
  'resources/process-control.js',
] as const

interface PortableDesktopSlotManifest {
  readonly schema: 1
  readonly version: string
  readonly sourceArchiveSha256: string
  readonly files: Readonly<Record<string, string>>
}

interface PortableReleaseContract {
  readonly schema: 1
  readonly edition: 'dsh-3-portable'
  readonly version: string
  readonly artifact: string
  readonly sha256: string
  readonly capabilities: readonly string[]
}

const REQUIRED_PORTABLE_CAPABILITIES = [
  'portable-data-v1',
  'desktop-ab-v1',
  'desktop-update-state-v1',
  'embedded-browser-v1',
  'runtime-prewarm-v1',
] as const

export class PortableDesktopUpdater {
  private readonly root: string
  private readonly updateRoot: string
  private readonly fetchImpl: typeof fetch
  private readonly releaseSource: PortableDesktopReleaseSource
  private readonly expandArchiveImpl: (archive: string, destination: string) => Promise<void>
  private readonly readProductVersionImpl: (executable: string) => Promise<string>
  private stateValue: PortableDesktopUpdateState

  constructor(private readonly options: PortableDesktopUpdaterOptions) {
    this.root = resolve(options.portableRoot)
    this.updateRoot = portableDesktopUpdateRoot(this.root)
    this.fetchImpl = options.fetch ?? fetch
    this.releaseSource = sanitizeReleaseSource(options.releaseSource) ?? DEFAULT_DESKTOP_RELEASE_SOURCE
    this.expandArchiveImpl = options.expandArchive ?? expandArchiveWithPowerShell
    this.readProductVersionImpl = options.readProductVersion ?? readWindowsProductVersion
    this.stateValue = initialState(options.currentVersion)
  }

  get state(): PortableDesktopUpdateState {
    return this.stateValue
  }

  get running(): boolean {
    return ACTIVE_PHASES.includes(this.stateValue.phase)
  }

  async initialize(): Promise<PortableDesktopUpdateState> {
    await mkdir(this.updateRoot, { recursive: true })
    this.stateValue = await loadPortableDesktopUpdateState(portableDesktopStatePath(this.updateRoot), this.options.currentVersion, this.releaseSource)
    const activeTransaction = process.env.DSH_DESKTOP_UPDATE_TRANSACTION
    if (this.running && !(this.stateValue.phase === 'validating' && activeTransaction !== undefined && activeTransaction === this.stateValue.transactionId)) {
      return await this.transition('error', this.stateValue.overallProgress, 0, '检测到上次未完成的桌面更新；当前槽未改变，可安全重试。', {
        errorCode: 'INTERRUPTED_UPDATE',
      })
    }
    if (!this.running && compareReleaseVersions(this.options.currentVersion, this.stateValue.currentVersion) >= 0) {
      this.stateValue = { ...this.stateValue, currentVersion: this.options.currentVersion }
    }
    this.options.onState?.(this.stateValue)
    return this.stateValue
  }

  async check(): Promise<PortableDesktopUpdateState> {
    if (this.running) return this.stateValue
    await this.transition('checking', 2, 0, '正在核对 GitHub Release、版本和制品摘要。')
    try {
      const release = await fetchLatestRelease(this.fetchImpl, this.options.currentVersion, this.releaseSource)
      const checkedAt = new Date().toISOString()
      if (release === undefined) {
        return await this.transition('none', 100, 100, '当前桌面端已是最新版本。', {
          lastCheckedAt: checkedAt,
          targetVersion: undefined,
          release: undefined,
          transactionId: undefined,
          slotRelativePath: undefined,
          errorCode: undefined,
        })
      }
      return await this.transition('available', 8, 100, `发现桌面端 ${release.version}，等待开始更新。`, {
        lastCheckedAt: checkedAt,
        targetVersion: release.version,
        release,
        transactionId: undefined,
        slotRelativePath: undefined,
        errorCode: undefined,
      })
    } catch (error) {
      // 便携兼容契约门禁命中不是更新器故障：上游确有新版本，但原始包会覆盖
      // 便携定制能力。以独立的 incompatible 状态呈现，避免把设计内拒绝渲染成
      // 反复出现的红色"更新失败"。
      if (error instanceof UpdateError && error.code === 'INCOMPATIBLE_RELEASE') {
        return await this.transition('incompatible', 100, 100, publicUpdateError(error), {
          lastCheckedAt: new Date().toISOString(),
          ...(error.version === undefined ? {} : { targetVersion: error.version }),
          release: undefined,
          transactionId: undefined,
          slotRelativePath: undefined,
          errorCode: error.code,
        })
      }
      return await this.fail(error instanceof UpdateError ? error.code : 'CHECK_FAILED', error, { lastCheckedAt: new Date().toISOString() })
    }
  }

  async prepare(): Promise<PortableDesktopUpdateState> {
    if (this.running) return this.stateValue
    const release = this.stateValue.release
    if (this.stateValue.phase !== 'available' || release === undefined) throw new Error('没有可构建的桌面更新候选。')
    const transactionId = randomUUID()
    const transactionRoot = join(this.updateRoot, 'transactions', transactionId)
    const downloadsRoot = join(this.updateRoot, 'downloads', release.version)
    const partial = join(downloadsRoot, `${release.assetName}.partial`)
    const archive = join(downloadsRoot, release.assetName)
    const extracted = join(transactionRoot, 'extracted')
    assertWithin(this.updateRoot, transactionRoot)
    try {
      await ensureFreeSpace(this.updateRoot, Math.max(2 * 1024 ** 3, release.assetSize * 3))
      await mkdir(downloadsRoot, { recursive: true })
      await removePhysicalPath(partial, { force: true })
      await this.transition('downloading', 10, 0, `正在检查本地缓存并准备 ${release.assetName}。`, { transactionId })
      if (await isReusableReleaseArchive(archive, release)) {
        await this.transition('verifying', 58, 100, `已验证并复用便携盘中的 ${release.assetName}。`, { transactionId })
      } else {
        await this.transition('downloading', 10, 0, `正在下载 ${release.assetName}。`, { transactionId })
        const digest = await downloadReleaseAsset(this.fetchImpl, release, partial, async percent => {
          await this.transition('downloading', 10 + percent * 0.45, percent, `正在下载 ${release.assetName}：${Math.round(percent)}%。`, { transactionId })
        })
        await this.transition('verifying', 58, 10, '正在验证下载大小和 SHA256。', { transactionId })
        if (digest !== release.sha256) throw new UpdateError('HASH_MISMATCH', '桌面更新包 SHA256 与 GitHub 发布摘要不一致。')
        const downloaded = await physicalStat(partial)
        if (downloaded.size !== release.assetSize) throw new UpdateError('SIZE_MISMATCH', '桌面更新包大小与 GitHub 发布信息不一致。')
        await removePhysicalPath(archive, { force: true })
        await rename(partial, archive)
      }
      await this.transition('building', 65, 5, '正在解包并构建不可变桌面候选槽。', { transactionId })
      await mkdir(extracted, { recursive: true })
      await this.expandArchiveImpl(archive, extracted)
      await this.transition('building', 78, 55, '正在检查候选槽文件闭包、运行时归档和版本。', { transactionId })
      const appDirectory = await locatePackagedApp(extracted)
      await validatePackagedApp(appDirectory, release.version, this.readProductVersionImpl)
      await writeSlotManifest(appDirectory, release.version, release.sha256)
      const slotName = `${release.version}-${release.sha256.slice(0, 16)}`
      const slot = join(this.updateRoot, 'slots', slotName)
      assertWithin(this.updateRoot, slot)
      await mkdir(dirname(slot), { recursive: true })
      if (existsSync(slot)) {
        await validatePackagedApp(slot, release.version, this.readProductVersionImpl)
        await validateSlotManifest(slot, release.version, release.sha256)
      } else {
        await rename(appDirectory, slot)
      }
      if (this.options.prepareCandidateRuntime !== undefined) {
        await this.transition('building', 80, 65, '当前桌面保持运行，正在后台准备候选共享环境。', { transactionId })
        let progressWrites: Promise<void> = Promise.resolve()
        const report = (progress: RuntimeExtractionProgress): void => {
          const mapped = candidateRuntimePreparationProgress(progress)
          progressWrites = progressWrites.then(async () => {
            await this.transition('building', mapped.overallProgress, mapped.stageProgress, mapped.detail, { transactionId })
          })
        }
        await this.options.prepareCandidateRuntime(slot, report)
        await progressWrites
      }
      await removePhysicalPath(transactionRoot, { recursive: true, force: true })
      return await this.transition('ready', 90, 100, `桌面端 ${release.version} 已完成构建和验证，等待部署。`, {
        transactionId,
        slotRelativePath: portableRelative(this.root, slot),
      })
    } catch (error) {
      await removePhysicalPath(partial, { force: true }).catch(() => undefined)
      await removePhysicalPath(transactionRoot, { recursive: true, force: true }).catch(() => undefined)
      return await this.fail(error instanceof UpdateError ? error.code : 'PREPARE_FAILED', error, { transactionId })
    }
  }

  async stageActivation(): Promise<PortableDesktopUpdateState> {
    const state = this.stateValue
    if (state.phase !== 'ready' || state.release === undefined || state.transactionId === undefined || state.slotRelativePath === undefined) {
      throw new Error('桌面更新候选尚未准备完成。')
    }
    const slot = resolvePortableReference(this.root, state.slotRelativePath)
    await validatePackagedApp(slot, state.release.version, this.readProductVersionImpl)
    await validateSlotManifest(slot, state.release.version, state.release.sha256)
    const pointerPath = portableDesktopPointerPath(this.updateRoot)
    const existing = await loadPortableDesktopPointer(pointerPath, this.root)
    const current = existing?.current ?? {
      relativePath: 'App',
      version: this.options.currentVersion,
      sha256: await fileSha256(join(this.root, 'App', 'DSH Codex Desktop.exe')),
    }
    const pending = {
      relativePath: state.slotRelativePath,
      version: state.release.version,
      sha256: await fileSha256(join(slot, 'slot-manifest.json')),
      transactionId: state.transactionId,
    }
    await savePortableDesktopPointer(pointerPath, {
      schema: 1,
      current,
      ...(existing?.previous === undefined ? {} : { previous: existing.previous }),
      pending,
      updatedAt: new Date().toISOString(),
    })
    return await this.transition('deploying', 94, 15, '候选槽已就绪；桌面自然退出后将切换并重启验证。')
  }

  async confirmRunningCandidate(transactionId: string, executableDirectory: string, healthFile: string): Promise<PortableDesktopUpdateState> {
    const pointerPath = portableDesktopPointerPath(this.updateRoot)
    const pointer = await loadPortableDesktopPointer(pointerPath, this.root)
    if (pointer?.pending?.transactionId !== transactionId) throw new UpdateError('ACTIVATION_MISMATCH', '桌面更新事务与待部署指针不一致。')
    const expected = resolvePortableReference(this.root, pointer.pending.relativePath)
    if (!sameResolvedPath(executableDirectory, expected)) throw new UpdateError('ACTIVATION_PATH_MISMATCH', '实际启动目录不是待验证候选槽。')
    await validateSlotManifest(expected, pointer.pending.version, undefined, pointer.pending.sha256)
    await this.transition('validating', 97, 70, '候选桌面已启动，正在提交健康验证。', {
      transactionId,
      targetVersion: pointer.pending.version,
      slotRelativePath: pointer.pending.relativePath,
    })
    const committed: PortableDesktopPointer = {
      schema: 1,
      current: pointer.pending,
      ...(sameSlot(pointer.current, pointer.pending) ? {} : { previous: pointer.current }),
      updatedAt: new Date().toISOString(),
    }
    await savePortableDesktopPointer(pointerPath, committed)
    const completed = await this.transition('completed', 100, 100, `桌面端 ${pointer.pending.version} 已部署并通过启动验证。`, {
      currentVersion: pointer.pending.version,
      transactionId,
      targetVersion: pointer.pending.version,
      slotRelativePath: pointer.pending.relativePath,
      errorCode: undefined,
    })
    assertWithin(this.updateRoot, healthFile)
    await mkdir(dirname(healthFile), { recursive: true })
    await writeTextFileAtomic(healthFile, `${JSON.stringify({ transactionId, version: pointer.pending.version, completedAt: new Date().toISOString() })}\n`)
    // 健康提交之后是唯一安全的回收点之一：指针已定，当前/上一槽受保护。
    await prunePortableDesktopSlots({ portableRoot: this.root }).catch(() => undefined)
    return completed
  }

  private async transition(
    phase: PortableDesktopUpdatePhase,
    overallProgress: number,
    stageProgress: number,
    detail: string,
    patch: Partial<PortableDesktopUpdateState> = {},
  ): Promise<PortableDesktopUpdateState> {
    const next = sanitizePortableDesktopUpdateState({
      ...this.stateValue,
      ...patch,
      schema: 1,
      phase,
      currentVersion: patch.currentVersion ?? this.stateValue.currentVersion,
      updatedAt: new Date().toISOString(),
      overallProgress,
      stageProgress,
      detail,
    }, this.options.currentVersion, this.releaseSource)
    this.stateValue = next
    await mkdir(this.updateRoot, { recursive: true })
    await writeTextFileAtomic(portableDesktopStatePath(this.updateRoot), `${JSON.stringify(next, undefined, 2)}\n`)
    await appendFile(join(this.updateRoot, 'events.jsonl'), `${JSON.stringify({
      timestamp: next.updatedAt,
      phase: next.phase,
      overallProgress: next.overallProgress,
      stageProgress: next.stageProgress,
      detail: next.detail,
      ...(next.transactionId === undefined ? {} : { transactionId: next.transactionId }),
      ...(next.currentVersion === undefined ? {} : { currentVersion: next.currentVersion }),
      ...(next.targetVersion === undefined ? {} : { targetVersion: next.targetVersion }),
      ...(next.errorCode === undefined ? {} : { errorCode: next.errorCode }),
    })}\n`, 'utf8')
    this.options.onState?.(next)
    return next
  }

  private async fail(code: string, error: unknown, patch: Partial<PortableDesktopUpdateState> = {}): Promise<PortableDesktopUpdateState> {
    const detail = publicUpdateError(error)
    return await this.transition('error', this.stateValue.overallProgress, 0, detail, { ...patch, errorCode: code })
  }
}

function candidateRuntimePreparationProgress(progress: RuntimeExtractionProgress): { overallProgress: number; stageProgress: number; detail: string } {
  if (progress.phase === 'runtime') {
    return progress.state === 'start'
      ? { overallProgress: 81, stageProgress: 70, detail: '当前桌面保持运行，正在后台校验候选 DSH 环境。' }
      : { overallProgress: 84, stageProgress: 80, detail: '候选 DSH 环境已复用或准备完成。' }
  }
  return progress.state === 'start'
    ? { overallProgress: 86, stageProgress: 88, detail: '当前桌面保持运行，正在后台准备候选插件仓库。' }
    : { overallProgress: 89, stageProgress: 98, detail: '候选共享环境已准备完成；重启时不再解压。' }
}

/** Stage a source-built desktop through the same immutable slot and launcher contract. */
export async function stageLocalDesktopBuild(options: {
  portableRoot: string
  appDirectory: string
  version: string
  readProductVersion?: (executable: string) => Promise<string>
  replacePending?: boolean
}): Promise<StagedLocalDesktopBuild> {
  const root = resolve(options.portableRoot)
  const updateRoot = portableDesktopUpdateRoot(root)
  const source = resolve(options.appDirectory)
  assertWithin(root, updateRoot)
  await validatePackagedApp(source, options.version, options.readProductVersion ?? readWindowsProductVersion)
  const sourceSha256 = await localAppContentSha256(source)
  const transactionId = randomUUID()
  const transactionRoot = join(updateRoot, 'transactions', transactionId)
  const staging = join(transactionRoot, 'app')
  const slot = join(updateRoot, 'slots', `${options.version}-local-${sourceSha256.slice(0, 16)}`)
  assertWithin(updateRoot, staging)
  assertWithin(updateRoot, slot)
  const pointerPath = portableDesktopPointerPath(updateRoot)
  const existing = await loadPortableDesktopPointer(pointerPath, root)
  if (existing?.pending !== undefined && options.replacePending !== true) {
    throw new UpdateError('PENDING_ACTIVATION', '已有桌面候选等待启动验证，不能覆盖待部署事务。')
  }
  try {
    await mkdir(transactionRoot, { recursive: true })
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true })
    await writeSlotManifest(staging, options.version, sourceSha256)
    await validateSlotManifest(staging, options.version, sourceSha256)
    await mkdir(dirname(slot), { recursive: true })
    if (existsSync(slot)) {
      await validateSlotManifest(slot, options.version, sourceSha256)
      await removePhysicalPath(transactionRoot, { recursive: true, force: true })
    } else {
      await rename(staging, slot)
      await removePhysicalPath(transactionRoot, { recursive: true, force: true })
    }
    const current = existing?.current ?? {
      relativePath: 'App',
      version: options.version,
      sha256: await fileSha256(join(root, 'App', 'DSH Codex Desktop.exe')),
    }
    const pending = {
      relativePath: portableRelative(root, slot),
      version: options.version,
      sha256: await fileSha256(join(slot, 'slot-manifest.json')),
      transactionId,
    }
    await savePortableDesktopPointer(pointerPath, {
      schema: 1,
      current,
      ...(existing?.previous === undefined ? {} : { previous: existing.previous }),
      pending,
      updatedAt: new Date().toISOString(),
    })
    const state = sanitizePortableDesktopUpdateState({
      schema: 1,
      phase: 'deploying',
      currentVersion: current.version,
      targetVersion: options.version,
      transactionId,
      slotRelativePath: pending.relativePath,
      updatedAt: new Date().toISOString(),
      overallProgress: 94,
      stageProgress: 15,
      detail: '本地定制构建已进入不可变候选槽；当前桌面自然退出后将启动验证。',
    }, current.version)
    await writeTextFileAtomic(portableDesktopStatePath(updateRoot), `${JSON.stringify(state, undefined, 2)}\n`)
    await appendFile(join(updateRoot, 'events.jsonl'), `${JSON.stringify({
      timestamp: state.updatedAt,
      phase: state.phase,
      overallProgress: state.overallProgress,
      stageProgress: state.stageProgress,
      detail: state.detail,
      transactionId,
      currentVersion: current.version,
      targetVersion: options.version,
      source: 'local-build',
      ...(existing?.pending === undefined ? {} : { replacedTransactionId: existing.pending.transactionId }),
    })}\n`, 'utf8')
    // 本地构建是候选槽的主要来源；暂存完成后立即回收，指针引用之外只保留有限历史。
    await prunePortableDesktopSlots({ portableRoot: root }).catch(() => undefined)
    return { transactionId, slotRelativePath: pending.relativePath, version: options.version }
  } catch (error) {
    await removePhysicalPath(transactionRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export interface PrunePortableDesktopSlotsResult {
  readonly removedSlots: readonly string[]
  readonly removedDownloads: readonly string[]
}

/**
 * 回收历史候选槽和下载缓存。只在事务提交点之后调用：指针引用的
 * current/previous/pending 槽永远保留，未引用槽按修改时间保留最近
 * keepUnreferencedSlots 个，其余删除；下载缓存保留指针版本与最近一个目录。
 * transactions/ 不在此回收（各自流程负责清理），避免与进行中的事务竞争。
 */
export async function prunePortableDesktopSlots(options: {
  portableRoot: string
  keepUnreferencedSlots?: number
  now?: () => Date
}): Promise<PrunePortableDesktopSlotsResult> {
  const root = resolve(options.portableRoot)
  const updateRoot = portableDesktopUpdateRoot(root)
  const keepCount = Math.max(0, options.keepUnreferencedSlots ?? 3)
  const pointer = await loadPortableDesktopPointer(portableDesktopPointerPath(updateRoot), root)
  const protectedSlots = new Set<string>()
  const protectedVersions = new Set<string>()
  for (const reference of [pointer?.current, pointer?.previous, pointer?.pending]) {
    if (reference === undefined) continue
    protectedSlots.add(resolve(root, reference.relativePath).toLowerCase())
    protectedVersions.add(reference.version)
  }
  const removedSlots = await pruneDirectoryEntries(join(updateRoot, 'slots'), async path => protectedSlots.has(resolve(path).toLowerCase()), keepCount)
  const removedDownloads = await pruneDirectoryEntries(join(updateRoot, 'downloads'), async path => {
    if (protectedVersions.has(basename(path))) return true
    // 保留最新一个下载目录作为重复更新的复用缓存。
    return await isNewestEntry(join(updateRoot, 'downloads'), path)
  }, 0)
  if (removedSlots.length === 0 && removedDownloads.length === 0) return { removedSlots, removedDownloads }
  await mkdir(updateRoot, { recursive: true })
  const timestamp = (options.now ?? ((): Date => new Date()))().toISOString()
  await appendFile(join(updateRoot, 'events.jsonl'), `${JSON.stringify({
    timestamp,
    source: 'slot-gc',
    detail: `回收 ${removedSlots.length} 个历史候选槽和 ${removedDownloads.length} 个下载缓存目录；指针引用槽不受影响。`,
    removedSlots,
    removedDownloads,
  })}\n`, 'utf8')
  return { removedSlots, removedDownloads }
}

async function pruneDirectoryEntries(
  directory: string,
  isProtected: (path: string) => Promise<boolean>,
  keepCount: number,
): Promise<string[]> {
  type Entry = { name: string; path: string; mtimeMs: number }
  let entries: Entry[]
  try {
    const listed: Entry[] = []
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const path = join(directory, item.name)
      if (await isProtected(path)) continue
      listed.push({ name: item.name, path, mtimeMs: (await stat(path)).mtimeMs })
    }
    entries = listed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const removed: string[] = []
  for (const entry of entries.slice(keepCount)) {
    await removePhysicalPath(entry.path, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

async function isNewestEntry(directory: string, path: string): Promise<boolean> {
  let newest: { path: string; mtimeMs: number } | undefined
  try {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const current = join(directory, item.name)
      const mtimeMs = (await stat(current)).mtimeMs
      if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path: current, mtimeMs }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return newest !== undefined && sameResolvedPath(newest.path, path)
}

export function portableDesktopUpdateRoot(portableRoot: string): string {
  return join(resolve(portableRoot), 'Data', 'Updates', 'Desktop')
}

export function portableDesktopStatePath(updateRoot: string): string {
  return join(updateRoot, 'state.json')
}

export function portableDesktopPointerPath(updateRoot: string): string {
  return join(updateRoot, 'pointer.json')
}

export async function loadPortableDesktopUpdateState(path: string, currentVersion: string, releaseSource: PortableDesktopReleaseSource = DEFAULT_DESKTOP_RELEASE_SOURCE): Promise<PortableDesktopUpdateState> {
  try {
    return sanitizePortableDesktopUpdateState(JSON.parse(await readFile(path, 'utf8')), currentVersion, releaseSource)
  } catch {
    return initialState(currentVersion)
  }
}

export function sanitizeReleaseSource(value: unknown): PortableDesktopReleaseSource | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<PortableDesktopReleaseSource>
  const shape = (input: unknown): string | undefined =>
    typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input) ? input : undefined
  const owner = shape(candidate.owner)
  const repo = shape(candidate.repo)
  const artifactBase = shape(candidate.artifactBase)
  return owner === undefined || repo === undefined || artifactBase === undefined ? undefined : { owner, repo, artifactBase }
}

/** 便携盘机器本地覆盖：用户不重新打包就能改发布源。 */
export const PORTABLE_RELEASE_SOURCE_OVERRIDE_PATH = join('Data', 'config', 'desktop-release-source.json')

/** 桌面更新源解析：按传入顺序取第一个有效配置（机器本地 Data/config 覆盖优先于
 * 构建期烘焙进 resources 的清单），全部缺失或坏 JSON 时返回 undefined，由调用方
 * 回落内置默认（上游官方仓库——不带便携契约的 Release 会被安全门禁拦成「已阻止」）。 */
export function resolvePortableReleaseSource(candidatePaths: readonly (string | undefined)[]): PortableDesktopReleaseSource | undefined {
  for (const path of candidatePaths) {
    if (path === undefined) continue
    try {
      const source = sanitizeReleaseSource(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (source !== undefined) return source
    } catch { /* 缺文件或坏 JSON 都回落下一级 */ }
  }
  return undefined
}

export function sanitizePortableDesktopUpdateState(value: unknown, currentVersion: string, releaseSource: PortableDesktopReleaseSource = DEFAULT_DESKTOP_RELEASE_SOURCE): PortableDesktopUpdateState {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<PortableDesktopUpdateState> : {}
  const phases: readonly PortableDesktopUpdatePhase[] = ['idle', 'checking', 'none', 'available', 'incompatible', 'downloading', 'verifying', 'building', 'ready', 'deploying', 'validating', 'completed', 'rolled-back', 'error']
  const phase = phases.includes(candidate.phase as PortableDesktopUpdatePhase) ? candidate.phase as PortableDesktopUpdatePhase : 'idle'
  const release = sanitizeRelease(candidate.release, releaseSource)
  return {
    schema: 1,
    phase,
    currentVersion: exactVersion(candidate.currentVersion) ?? currentVersion,
    updatedAt: iso(candidate.updatedAt) ?? new Date().toISOString(),
    overallProgress: progress(candidate.overallProgress),
    stageProgress: progress(candidate.stageProgress),
    detail: safeText(candidate.detail, 2_000) ?? '',
    ...(iso(candidate.lastCheckedAt) === undefined ? {} : { lastCheckedAt: iso(candidate.lastCheckedAt) }),
    ...(uuid(candidate.transactionId) === undefined ? {} : { transactionId: uuid(candidate.transactionId) }),
    ...(exactVersion(candidate.targetVersion) === undefined ? {} : { targetVersion: exactVersion(candidate.targetVersion) }),
    ...(release === undefined ? {} : { release }),
    ...(safeRelative(candidate.slotRelativePath) === undefined ? {} : { slotRelativePath: safeRelative(candidate.slotRelativePath) }),
    ...(typeof candidate.errorCode !== 'string' || !/^[A-Z0-9_]{3,64}$/.test(candidate.errorCode) ? {} : { errorCode: candidate.errorCode }),
  }
}

export async function loadPortableDesktopPointer(path: string, portableRoot: string): Promise<PortableDesktopPointer | undefined> {
  try {
    const source = JSON.parse(await readFile(path, 'utf8')) as Partial<PortableDesktopPointer>
    if (source.schema !== 1 || !validSlot(source.current, portableRoot)) return undefined
    const pending = source.pending as (PortableDesktopSlotReference & { transactionId?: unknown }) | undefined
    return {
      schema: 1,
      current: source.current,
      ...(validSlot(source.previous, portableRoot) ? { previous: source.previous } : {}),
      ...(validSlot(pending, portableRoot) && uuid(pending?.transactionId) !== undefined ? { pending: { ...pending, transactionId: uuid(pending.transactionId)! } } : {}),
      updatedAt: iso(source.updatedAt) ?? '',
    }
  } catch {
    return undefined
  }
}

async function savePortableDesktopPointer(path: string, pointer: PortableDesktopPointer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeTextFileAtomic(path, `${JSON.stringify(pointer, undefined, 2)}\n`)
}

function initialState(currentVersion: string): PortableDesktopUpdateState {
  return {
    schema: 1,
    phase: 'idle',
    currentVersion,
    updatedAt: new Date().toISOString(),
    overallProgress: 0,
    stageProgress: 0,
    detail: '准备检查桌面更新。',
  }
}

async function fetchLatestRelease(fetchImpl: typeof fetch, currentVersion: string, source: PortableDesktopReleaseSource): Promise<PortableDesktopRelease | undefined> {
  const response = await fetchImpl(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DSH-3-Portable-Unified-Updater' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new UpdateError('RELEASE_HTTP', `GitHub Release 返回 HTTP ${response.status}。`)
  const release = await response.json() as {
    tag_name?: unknown
    body?: unknown
    draft?: unknown
    prerelease?: unknown
    assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }>
  }
  if (release.draft === true || release.prerelease === true) throw new UpdateError('UNTRUSTED_RELEASE', '最新发布不是正式稳定 Release。')
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  if (exactVersion(version) === undefined) throw new UpdateError('INVALID_VERSION', 'GitHub Release 版本格式无效。')
  // A locally built portable edition may have the same (or a newer) product
  // version as the public Release while carrying additional private
  // customizations. In that case no download will occur, so the Release's
  // artifact and portable-contract assets are irrelevant. Decide freshness
  // from the trusted tag before enforcing download-only supply-chain gates;
  // otherwise a harmless manual check paints a false red error state.
  if (compareReleaseVersions(version, currentVersion) <= 0) return undefined
  const expectedName = `${source.artifactBase}-${version}-win-x64.zip`
  const asset = release.assets?.find(item => item.name === expectedName)
  if (asset === undefined || typeof asset.browser_download_url !== 'string' || typeof asset.size !== 'number') {
    throw new UpdateError('ASSET_MISSING', `Release 缺少 ${expectedName}。`)
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 1_000_000 || asset.size > 1_500_000_000) throw new UpdateError('ASSET_SIZE', '桌面更新包大小超出安全范围。')
  const digest = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : undefined
  if (digest === undefined) throw new UpdateError('DIGEST_MISSING', 'GitHub Release 未提供强制 SHA256 摘要。')
  const url = trustedReleaseAssetUrl(asset.browser_download_url, source)
  const contractName = `dsh-portable-contract-${version}-win-x64.json`
  const contractAsset = release.assets?.find(item => item.name === contractName)
  if (contractAsset === undefined || typeof contractAsset.browser_download_url !== 'string' || typeof contractAsset.size !== 'number') {
    throw new UpdateError('INCOMPATIBLE_RELEASE', `桌面端 ${version} 没有 DSH 便携版 3 兼容契约，已阻止覆盖当前定制功能。`, version)
  }
  if (!Number.isSafeInteger(contractAsset.size) || contractAsset.size < 64 || contractAsset.size > 64 * 1024) {
    throw new UpdateError('CONTRACT_SIZE', '桌面更新兼容契约大小超出安全范围。')
  }
  const contractDigest = typeof contractAsset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(contractAsset.digest)
    ? contractAsset.digest.slice(7).toLowerCase()
    : undefined
  if (contractDigest === undefined) throw new UpdateError('CONTRACT_DIGEST_MISSING', 'GitHub Release 未提供兼容契约 SHA256。')
  const contractUrl = trustedReleaseAssetUrl(contractAsset.browser_download_url, source)
  const contractResponse = await fetchImpl(contractUrl.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': 'DSH-3-Portable-Unified-Updater' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!contractResponse.ok) throw new UpdateError('CONTRACT_HTTP', `兼容契约返回 HTTP ${contractResponse.status}。`)
  const contractBytes = Buffer.from(await contractResponse.arrayBuffer())
  if (contractBytes.length !== contractAsset.size || createHash('sha256').update(contractBytes).digest('hex') !== contractDigest) {
    throw new UpdateError('CONTRACT_HASH', '桌面更新兼容契约大小或 SHA256 不匹配。')
  }
  let contract: PortableReleaseContract
  try {
    contract = JSON.parse(contractBytes.toString('utf8')) as PortableReleaseContract
  } catch {
    throw new UpdateError('CONTRACT_INVALID', '桌面更新兼容契约不是有效 JSON。')
  }
  if (contract.schema !== 1 || contract.edition !== 'dsh-3-portable' || contract.version !== version
    || contract.artifact !== expectedName || contract.sha256.toLowerCase() !== digest
    || !Array.isArray(contract.capabilities)
    || REQUIRED_PORTABLE_CAPABILITIES.some(capability => !contract.capabilities.includes(capability))) {
    throw new UpdateError('INCOMPATIBLE_RELEASE', `桌面端 ${version} 不满足 DSH 便携版 3 的兼容能力门禁。`, version)
  }
  return {
    version,
    tag,
    assetName: expectedName,
    assetUrl: url.toString(),
    assetSize: asset.size,
    sha256: digest,
    ...(typeof release.body === 'string' && release.body.trim() !== '' ? { releaseNotes: release.body.slice(0, 20_000) } : {}),
  }
}

function trustedReleaseAssetUrl(value: string, source: PortableDesktopReleaseSource): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.includes(`/${source.owner}/${source.repo}/releases/download/`)) {
    throw new UpdateError('ASSET_SOURCE', '桌面更新资产来源不在允许列表。')
  }
  return url
}

async function downloadReleaseAsset(
  fetchImpl: typeof fetch,
  release: PortableDesktopRelease,
  destination: string,
  onProgress: (percent: number) => Promise<void>,
): Promise<string> {
  const response = await fetchImpl(release.assetUrl, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'DSH-3-Portable-Unified-Updater' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60_000),
  })
  if (!response.ok || response.body === null) throw new UpdateError('DOWNLOAD_HTTP', `下载更新包失败（HTTP ${response.status}）。`)
  const file = await open(destination, 'w')
  const digest = createHash('sha256')
  let bytes = 0
  let lastPercent = -1
  try {
    for await (const chunk of response.body) {
      const data = Buffer.from(chunk)
      bytes += data.length
      if (bytes > release.assetSize) throw new UpdateError('DOWNLOAD_OVERSIZE', '下载内容超过 Release 声明大小。')
      digest.update(data)
      await file.write(data)
      const percent = Math.min(100, bytes / release.assetSize * 100)
      if (Math.floor(percent) !== lastPercent) {
        lastPercent = Math.floor(percent)
        await onProgress(percent)
      }
    }
  } finally {
    await file.close()
  }
  await onProgress(100)
  return digest.digest('hex')
}

async function isReusableReleaseArchive(path: string, release: PortableDesktopRelease): Promise<boolean> {
  let information: Stats
  try {
    information = await physicalStat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!information.isFile() || information.size !== release.assetSize) {
    await removePhysicalPath(path, { force: true })
    return false
  }
  if (await physicalFileSha256(path) === release.sha256) return true
  await removePhysicalPath(path, { force: true })
  return false
}

async function locatePackagedApp(root: string): Promise<string> {
  const matches: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return
    if (existsSync(join(directory, 'DSH Codex Desktop.exe'))) matches.push(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(directory, entry.name), depth + 1)
    }
  }
  await visit(root, 0)
  if (matches.length !== 1) throw new UpdateError('PACKAGE_LAYOUT', `更新包应包含一个桌面应用目录，实际找到 ${matches.length} 个。`)
  return matches[0]
}

async function validatePackagedApp(directory: string, expectedVersion: string, readProductVersion: (path: string) => Promise<string>): Promise<void> {
  for (const required of REQUIRED_APP_FILES) {
    const path = join(directory, ...required.split('/'))
    if (!await physicalFileIsRegular(path)) throw new UpdateError('PACKAGE_INCOMPLETE', `候选槽缺少 ${required}。`)
  }
  const productVersion = (await readProductVersion(join(directory, 'DSH Codex Desktop.exe'))).replace(/\.0$/, '')
  if (productVersion !== expectedVersion) throw new UpdateError('PACKAGE_VERSION', `候选程序版本 ${productVersion} 与目标 ${expectedVersion} 不一致。`)
  await verifySidecar(join(directory, 'resources', 'dsh-runtime.tgz'))
  await verifySidecar(join(directory, 'resources', 'plugins-store.tgz'))
  await verifyContentSidecar(join(directory, 'resources', 'dsh-runtime.tgz'))
  await verifyContentSidecar(join(directory, 'resources', 'plugins-store.tgz'))
}

/** Local candidates include extraResources: an HTML/CSS-only fix must never reuse an older UI slot. */
async function localAppContentSha256(directory: string): Promise<string> {
  const digest = createHash('sha256')
  const visit = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(current, entry.name)
      assertWithin(directory, path)
      if (entry.isSymbolicLink()) throw new UpdateError('LOCAL_BUILD_LINK', '本地候选含符号链接，无法建立稳定内容摘要。')
      if (entry.isDirectory()) await visit(path)
      else if (await physicalFileIsRegular(path)) digest.update(`${portableRelative(directory, path)}\0${await fileSha256(path)}\n`)
      else throw new UpdateError('LOCAL_BUILD_FILE', '本地候选包含非普通文件。')
    }
  }
  await visit(directory)
  return digest.digest('hex')
}

async function writeSlotManifest(directory: string, version: string, sourceSha256: string): Promise<void> {
  const files: Record<string, string> = {}
  for (const name of REQUIRED_APP_FILES) files[name] = await fileSha256(join(directory, ...name.split('/')))
  const manifest: PortableDesktopSlotManifest = {
    schema: 1,
    version,
    sourceArchiveSha256: sourceSha256,
    files,
  }
  await writeTextFileAtomic(join(directory, 'slot-manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

async function validateSlotManifest(directory: string, expectedVersion: string, expectedSourceSha256?: string, expectedManifestSha256?: string): Promise<void> {
  const manifestPath = join(directory, 'slot-manifest.json')
  if (expectedManifestSha256 !== undefined && await fileSha256(manifestPath) !== expectedManifestSha256.toLowerCase()) {
    throw new UpdateError('SLOT_MANIFEST_HASH', '候选槽清单摘要与激活指针不一致。')
  }
  let manifest: PortableDesktopSlotManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PortableDesktopSlotManifest
  } catch (error) {
    throw new UpdateError('SLOT_MANIFEST_INVALID', `候选槽清单无法读取：${error instanceof Error ? error.message : '未知错误'}`)
  }
  if (manifest.schema !== 1 || manifest.version !== expectedVersion || !/^[a-f0-9]{64}$/i.test(manifest.sourceArchiveSha256)) {
    throw new UpdateError('SLOT_MANIFEST_INVALID', '候选槽清单版本或来源摘要无效。')
  }
  if (expectedSourceSha256 !== undefined && manifest.sourceArchiveSha256.toLowerCase() !== expectedSourceSha256.toLowerCase()) {
    throw new UpdateError('SLOT_SOURCE_HASH', '候选槽来源摘要与 Release 不一致。')
  }
  if (typeof manifest.files !== 'object' || manifest.files === null) throw new UpdateError('SLOT_MANIFEST_INVALID', '候选槽清单缺少文件摘要。')
  for (const name of REQUIRED_APP_FILES) {
    const expected = manifest.files[name]
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) throw new UpdateError('SLOT_MANIFEST_INVALID', `候选槽清单缺少 ${name} 摘要。`)
    if (await fileSha256(join(directory, ...name.split('/'))) !== expected.toLowerCase()) throw new UpdateError('SLOT_FILE_HASH', `候选槽文件摘要不匹配：${name}`)
  }
}

async function verifySidecar(archive: string): Promise<void> {
  const sidecar = `${archive}.sha256`
  const expected = (await readFile(sidecar, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new UpdateError('SIDECAR_INVALID', `归档摘要格式无效：${sidecar}`)
  if (await fileSha256(archive) !== expected) throw new UpdateError('SIDECAR_MISMATCH', `归档摘要不匹配：${archive}`)
}

async function verifyContentSidecar(archive: string): Promise<void> {
  const sidecar = `${archive}.content-sha256`
  const expected = (await readFile(sidecar, 'utf8')).trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new UpdateError('CONTENT_SIDECAR_INVALID', `归档逻辑内容摘要格式无效：${sidecar}`)
}

export async function physicalFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createPhysicalReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function physicalFileIsRegular(path: string): Promise<boolean> {
  try {
    return (await physicalStat(path)).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

const fileSha256 = physicalFileSha256

async function ensureFreeSpace(path: string, requiredBytes: number): Promise<void> {
  const information = await statfs(path)
  const available = Number(information.bavail) * Number(information.bsize)
  if (available < requiredBytes) throw new UpdateError('DISK_SPACE', `便携盘可用空间不足；至少需要 ${Math.ceil(requiredBytes / 1024 ** 3)} GiB。`)
}

function expandArchiveWithPowerShell(archive: string, destination: string): Promise<void> {
  return runHidden('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "Expand-Archive -LiteralPath $env:DSH_UPDATE_ARCHIVE -DestinationPath $env:DSH_UPDATE_DESTINATION -Force",
  ], { DSH_UPDATE_ARCHIVE: archive, DSH_UPDATE_DESTINATION: destination })
}

function readWindowsProductVersion(executable: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "[Console]::Out.Write((Get-Item -LiteralPath $env:DSH_UPDATE_EXE).VersionInfo.ProductVersion)",
    ], { env: { ...process.env, DSH_UPDATE_EXE: executable }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    child.stdout.on('data', chunk => { output += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { error += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise(output.trim()) : reject(new Error(error.trim() || '无法读取候选程序版本。')))
  })
}

function runHidden(command: string, args: readonly string[], extraEnvironment: Record<string, string>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...extraEnvironment },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let error = ''
    child.stderr.on('data', chunk => { error = (error + chunk.toString('utf8')).slice(-8_000) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(error.replace(/\s+/g, ' ').trim() || `${command} 返回退出码 ${code ?? '未知'}。`)))
  })
}

function sanitizeRelease(value: unknown, source: PortableDesktopReleaseSource = DEFAULT_DESKTOP_RELEASE_SOURCE): PortableDesktopRelease | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Partial<PortableDesktopRelease>
  const version = exactVersion(item.version)
  const tag = typeof item.tag === 'string' && item.tag === `v${version}` ? item.tag : undefined
  const assetName = typeof item.assetName === 'string' && item.assetName === `${source.artifactBase}-${version}-win-x64.zip` ? item.assetName : undefined
  let assetUrl: string | undefined
  try {
    if (typeof item.assetUrl === 'string') {
      const url = new URL(item.assetUrl)
      if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.includes(`/${source.owner}/${source.repo}/releases/download/`)) assetUrl = url.toString()
    }
  } catch {
    // 非法 URL 不进入持久状态。
  }
  if (version === undefined || tag === undefined || assetName === undefined || assetUrl === undefined) return undefined
  if (typeof item.assetSize !== 'number' || !Number.isSafeInteger(item.assetSize) || item.assetSize < 1_000_000 || item.assetSize > 1_500_000_000) return undefined
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) return undefined
  return {
    version,
    tag,
    assetName,
    assetUrl,
    assetSize: item.assetSize,
    sha256: item.sha256.toLowerCase(),
    ...(safeText(item.releaseNotes, 20_000) === undefined ? {} : { releaseNotes: safeText(item.releaseNotes, 20_000) }),
  }
}

function validSlot(value: unknown, portableRoot: string): value is PortableDesktopSlotReference {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<PortableDesktopSlotReference>
  const relativePath = safeRelative(item.relativePath)
  if (relativePath === undefined || exactVersion(item.version) === undefined || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) return false
  try {
    resolvePortableReference(portableRoot, relativePath)
    return true
  } catch {
    return false
  }
}

function sameSlot(left: PortableDesktopSlotReference, right: PortableDesktopSlotReference): boolean {
  return left.relativePath.toLowerCase() === right.relativePath.toLowerCase() && left.sha256.toLowerCase() === right.sha256.toLowerCase()
}

function sameResolvedPath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase() === resolvedRight.toLocaleLowerCase()
    : resolvedLeft === resolvedRight
}

function portableRelative(portableRoot: string, path: string): string {
  assertWithin(portableRoot, path)
  return relative(resolve(portableRoot), resolve(path)).replaceAll('\\', '/')
}

function resolvePortableReference(portableRoot: string, reference: string): string {
  if (isAbsolute(reference)) throw new Error('桌面槽引用不能是绝对路径。')
  const path = resolve(portableRoot, reference)
  assertWithin(portableRoot, path)
  return path
}

function assertWithin(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child))
  if (path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) throw new Error('更新路径越出便携盘允许范围。')
}

function safeRelative(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || isAbsolute(value) || value.includes('\0')) return undefined
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '..' || part === '')) return undefined
  return normalized
}

function exactVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) ? value : undefined
}

function uuid(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value) ? value : undefined
}

function iso(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

function progress(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
}

function safeText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, maximum) : undefined
}

function publicUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知桌面更新错误。'
  if (/ENOTFOUND|ECONN|ETIMEDOUT|fetch failed|HTTP 5\d\d/i.test(message)) return '无法连接桌面更新服务；当前版本保持不变。'
  if (/[A-Za-z]:\\|\\\\|\/Users\/|\/home\//.test(message)) return '桌面更新失败；详细信息已写入便携盘审计日志。'
  return message.replace(/\s+/g, ' ').slice(0, 500)
}

class UpdateError extends Error {
  constructor(readonly code: string, message: string, readonly version?: string) {
    super(message)
  }
}
