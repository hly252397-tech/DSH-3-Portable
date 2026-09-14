import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { directoryContentSha256, extractTarGzWithProgress, pnpmStoreContentSha256, verifyFileSha256 } from './runtime-archive.js'
import { terminateProcessTree } from './process-control.js'
import type { StartupProgress } from './startup-progress.js'

export const RUNTIME_EXTRACTION_PROGRESS_PREFIX = 'DSH_EXTRACT_PROGRESS '

export interface RuntimeExtractionProgress {
  phase: 'runtime' | 'plugins'
  state: 'start' | 'complete' | 'skip' | 'progress'
  /** 仅 state === 'progress' 时存在：当前子步骤的实测计量。 */
  progress?: StartupProgress
}

export interface RuntimeExtractionProcessOptions {
  nodeExecutable: string
  scriptPath: string
  installDir: string
  resourcesDir: string
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (progress: RuntimeExtractionProgress) => void
  skipOfficial?: boolean
}

export interface PackagedRuntimePreparationOptions {
  readonly resourcesDir: string
  readonly runtimeRoot: string
  readonly nodeExecutable: string
  readonly scriptPath: string
  readonly signal?: AbortSignal
  readonly skipOfficial?: boolean
  readonly onProgress?: (progress: RuntimeExtractionProgress) => void
}

export interface PackagedRuntimeCachePaths {
  readonly installDir: string
  readonly official: string
  readonly store: string
}

function officialEntry(dir: string): string {
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** 首启把随包压缩包原子解压到已选定的可写目录。 */
export async function extractPackagedRuntimes(
  resourcesDir: string,
  officialDest: string | undefined,
  storeDest: string,
  onProgress?: (progress: RuntimeExtractionProgress) => void,
): Promise<{ official: boolean; store: boolean }> {
  const officialArchive = join(resourcesDir, 'dsh-runtime.tgz')
  const storeArchive = join(resourcesDir, 'plugins-store.tgz')
  // 子步骤的实测计量统一挂在所属大阶段的 'progress' 事件上，父进程按阶段归属显示。
  const report = (phase: RuntimeExtractionProgress['phase']) =>
    (progress: StartupProgress): void => { onProgress?.({ phase, state: 'progress', progress }) }
  onProgress?.({ phase: 'runtime', state: 'start' })
  const official = officialDest === undefined
    ? false
    : await extractOnce(officialArchive, officialDest, officialEntry, 'runtime', report('runtime'))
  onProgress?.({ phase: 'runtime', state: official ? 'complete' : 'skip' })
  onProgress?.({ phase: 'plugins', state: 'start' })
  const store = await extractOnce(storeArchive, storeDest, dir => join(dir, 'v11'), 'pnpm-store', report('plugins'))
  onProgress?.({ phase: 'plugins', state: store ? 'complete' : 'skip' })
  return { official, store }
}

export function packagedRuntimesNeedExtraction(resourcesDir: string, officialDest: string | undefined, storeDest: string): boolean {
  return (officialDest !== undefined && needsExtraction(join(resourcesDir, 'dsh-runtime.tgz'), officialDest, officialEntry))
    || needsExtraction(join(resourcesDir, 'plugins-store.tgz'), storeDest, dir => join(dir, 'v11'))
}

/** Give each immutable pair of packaged archives its own cache so a candidate cannot modify the active runtime. */
export function resolvePackagedRuntimeCache(resourcesDir: string, runtimeRoot: string): PackagedRuntimeCachePaths {
  const officialDigest = readArchiveVersion(join(resourcesDir, 'dsh-runtime.tgz'))
  const storeDigest = readArchiveVersion(join(resourcesDir, 'plugins-store.tgz'))
  if (officialDigest === undefined || storeDigest === undefined) throw new Error('随包运行时缺少有效的内容摘要。')
  const installDir = join(resolve(runtimeRoot), 'Packaged', `${officialDigest.slice(0, 16)}-${storeDigest.slice(0, 16)}`)
  return {
    installDir,
    official: join(installDir, 'dsh-runtime'),
    store: join(installDir, 'plugins', 'store'),
  }
}

/**
 * 在桌面候选仍处于构建阶段时准备共享运行环境。正式切换只消费已经完成的
 * 内容寻址缓存，因此重启路径不再承担数万文件的解压工作；启动时保留同一
 * 检查作为断电或人工清理后的自愈兜底。
 */
export async function preparePackagedRuntimeCacheInChild(options: PackagedRuntimePreparationOptions): Promise<{ prepared: boolean; cache: PackagedRuntimeCachePaths }> {
  const cache = resolvePackagedRuntimeCache(options.resourcesDir, options.runtimeRoot)
  const official = options.skipOfficial === true ? undefined : cache.official
  if (!packagedRuntimesNeedExtraction(options.resourcesDir, official, cache.store)) {
    return { prepared: false, cache }
  }
  await extractPackagedRuntimesInChild({
    nodeExecutable: options.nodeExecutable,
    scriptPath: options.scriptPath,
    installDir: cache.installDir,
    resourcesDir: options.resourcesDir,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.skipOfficial === true ? { skipOfficial: true } : {}),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  })
  if (packagedRuntimesNeedExtraction(options.resourcesDir, official, cache.store)) {
    throw new Error('候选运行环境后台准备完成后仍未通过缓存门禁。')
  }
  return { prepared: true, cache }
}

/**
 * 便携版首启必须把重型校验、解压和数万文件复制放到独立 Node 进程，
 * 否则 Electron 主进程无法派发 Windows 消息，会被系统标记为“未响应”。
 */
export function extractPackagedRuntimesInChild(options: RuntimeExtractionProcessOptions): Promise<void> {
  if (options.signal?.aborted === true) return Promise.reject(new Error('随包运行时初始化已取消。'))
  // Node reports a missing cwd as a spawn ENOENT against the executable, which
  // is misleading and prevents a brand-new content-addressed cache from ever
  // being initialized. The immutable cache directory is safe to create before
  // starting the isolated extraction worker.
  mkdirSync(options.installDir, { recursive: true })
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.nodeExecutable, [
      options.scriptPath,
      options.installDir,
      options.resourcesDir,
      '--progress-json',
      ...(options.skipOfficial === true ? ['--skip-official'] : []),
    ], {
      cwd: options.installDir,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let pending = ''
    let settled = false
    let terminationError: Error | undefined
    let killDeadline: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killDeadline)
      options.signal?.removeEventListener('abort', abort)
      if (error === undefined) resolvePromise()
      else reject(error)
    }
    const terminate = (error: Error): void => {
      if (settled || terminationError !== undefined) return
      terminationError = error
      terminateProcessTree(child, { processGroup: process.platform !== 'win32' })
      killDeadline = setTimeout(() => {
        terminateProcessTree(child, { processGroup: process.platform !== 'win32' })
        finish(error)
      }, 2_000)
    }
    const abort = (): void => terminate(new Error('随包运行时初始化已取消。'))
    const consumeLine = (line: string): void => {
      if (!line.startsWith(RUNTIME_EXTRACTION_PROGRESS_PREFIX)) return
      try {
        const progress = JSON.parse(line.slice(RUNTIME_EXTRACTION_PROGRESS_PREFIX.length)) as RuntimeExtractionProgress
        if ((progress.phase === 'runtime' || progress.phase === 'plugins')
          && (progress.state === 'start' || progress.state === 'complete' || progress.state === 'skip' || progress.state === 'progress')) {
          options.onProgress?.(progress)
        }
      } catch {
        // 忽略非本协议输出，错误仍会由退出码和 stderr 报告。
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output = (output + chunk).slice(-8_000)
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { output = (output + chunk).slice(-8_000) })
    child.once('error', error => finish(new Error(`无法启动随包运行时初始化进程：${error.message}`)))
    child.once('close', code => {
      if (pending !== '') consumeLine(pending)
      if (terminationError !== undefined) finish(terminationError)
      else if (code === 0) finish()
      else finish(new Error(output.replace(/\s+/g, ' ').trim() || `随包运行时初始化失败，退出码：${code ?? 'unknown'}`))
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    timeout = setTimeout(() => terminate(new Error('随包运行时初始化超时，请重新启动应用后重试。')), options.timeoutMs ?? 15 * 60_000)
    timeout.unref?.()
    if (options.signal?.aborted === true) abort()
  })
}

async function extractOnce(
  archivePath: string,
  destDir: string,
  readyPath: (dir: string) => string,
  contentKind: 'runtime' | 'pnpm-store',
  onProgress?: (progress: StartupProgress) => void,
): Promise<boolean> {
  const completeMarker = join(destDir, '.dsh-extract-complete')
  if (!existsSync(archivePath)) return false
  if (isExtractionCurrent(archivePath, destDir, readyPath)) return false
  rmSync(completeMarker, { force: true })
  verifyFileSha256(archivePath, (completed, total) => onProgress?.({ phase: 'verify', completed, total, unit: 'bytes' }))
  const archiveVersion = readArchiveVersion(archivePath)
  if (archiveVersion === undefined) throw new Error(`无法读取压缩包 SHA256：${archivePath}`)
  mkdirSync(dirname(destDir), { recursive: true })
  const stagingDir = mkdtempSync(join(dirname(destDir), `.${basename(destDir)}-`))
  try {
    onProgress?.({ phase: 'extract' })
    await extractTarGzWithProgress(archivePath, stagingDir,
      (completed, total) => onProgress?.({ phase: 'extract', completed, total, unit: 'entries' }))
    if (!existsSync(readyPath(stagingDir))) throw new Error(`压缩包内容不完整：${archivePath}`)
    verifyExtractedContentVersion(archivePath, stagingDir, contentKind)
    if (isExtractionCurrent(archivePath, destDir, readyPath)) return false
    if (process.platform === 'win32') {
      mkdirSync(destDir, { recursive: true })
      copyRuntimeFiles(stagingDir, destDir, onProgress)
    } else {
      rmSync(destDir, { recursive: true, force: true })
      renameSync(stagingDir, destDir)
    }
    writeFileSync(completeMarker, `${archiveVersion}\n`, 'utf8')
    return true
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

/** 逐文件复制替代整目录 cpSync：数万文件时既能上报真实进度，也避免每个文件都重复走
 *  通用目录复制检查。本盘实测单文件操作成本高，这一阶段正是首启最长的等待。 */
function copyRuntimeFiles(source: string, destination: string, onProgress?: (progress: StartupProgress) => void): void {
  onProgress?.({ phase: 'scan' })
  const files: { path: string; regular: boolean }[] = []
  const collect = (directory: string): void => {
    mkdirSync(join(destination, directory), { recursive: true })
    for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
      const relativePath = join(directory, entry.name)
      if (entry.isDirectory()) collect(relativePath)
      else files.push({ path: relativePath, regular: entry.isFile() })
    }
  }
  collect('')
  let completed = 0
  let lastReport = 0
  onProgress?.({ phase: 'copy', completed, total: files.length })
  for (const { path, regular } of files) {
    const from = join(source, path)
    const to = join(destination, path)
    if (regular) {
      try {
        copyFileSync(from, to)
      } catch (error) {
        // 只读/权限位导致的直接复制失败退回通用路径；其它错误照常抛出。
        if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        cpSync(from, to, { force: true })
      }
    } else {
      cpSync(from, to, { force: true })
    }
    completed++
    if (Date.now() - lastReport >= 100 || completed === files.length) {
      onProgress?.({ phase: 'copy', completed, total: files.length })
      lastReport = Date.now()
    }
  }
}

function needsExtraction(archivePath: string, destDir: string, readyPath: (dir: string) => string): boolean {
  return existsSync(archivePath) && !isExtractionCurrent(archivePath, destDir, readyPath)
}

function isExtractionCurrent(archivePath: string, destDir: string, readyPath: (dir: string) => string): boolean {
  if (!existsSync(readyPath(destDir))) return false
  const archiveVersion = readArchiveVersion(archivePath)
  if (archiveVersion === undefined) return false
  try {
    return readFileSync(join(destDir, '.dsh-extract-complete'), 'utf8').trim().toLowerCase() === archiveVersion
  } catch {
    return false
  }
}

function readArchiveVersion(archivePath: string): string | undefined {
  const contentVersion = readDigestFile(`${archivePath}.content-sha256`)
  if (contentVersion !== undefined) return contentVersion
  return readDigestFile(`${archivePath}.sha256`)
}

function readDigestFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim().toLowerCase()
    return /^[a-f0-9]{64}$/.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

function verifyExtractedContentVersion(archivePath: string, directory: string, contentKind: 'runtime' | 'pnpm-store'): void {
  const expected = readDigestFile(`${archivePath}.content-sha256`)
  if (expected === undefined) return
  const actual = contentKind === 'pnpm-store' ? pnpmStoreContentSha256(directory) : directoryContentSha256(directory)
  if (actual !== expected) throw new Error(`解压内容 SHA256 校验失败：${archivePath}`)
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const installDir = process.argv[2] ?? dirname(dirname(self))
  const resourcesDir = process.argv[3] ?? join(installDir, 'resources')
  const progress = process.argv.includes('--progress-json')
    ? (event: RuntimeExtractionProgress): void => { console.log(RUNTIME_EXTRACTION_PROGRESS_PREFIX + JSON.stringify(event)) }
    : undefined
  // 解压改为异步后必须显式收口：未处理的 rejection 会让子进程静默卡住，父进程只能等到 15 分钟超时才报错。
  extractPackagedRuntimes(resourcesDir, process.argv.includes('--skip-official') ? undefined : join(installDir, 'dsh-runtime'), join(installDir, 'plugins', 'store'), progress)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
