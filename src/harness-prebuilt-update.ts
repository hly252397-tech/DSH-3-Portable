import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, statfs } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createGunzip } from 'node:zlib'

import { validateHarnessRuntimeCandidate, type HarnessRuntimeCandidate } from './harness-runtime-candidate.js'
import {
  fetchHarnessReleaseAsset, HarnessReleaseError, harnessReleaseNames, parseHarnessReleaseContract,
  trustedHarnessAssetUrl, type HarnessPrebuiltRelease,
} from './harness-release-catalog.js'
import { runtimeSlotDirectory, runtimeSlotsRoot } from './runtime-slots.js'
import { verifyRuntimePnpmLayout } from './runtime-pnpm-layout.js'
import { writeTextFileAtomic } from './atomic-file.js'

export interface HarnessPrebuiltProgress {
  readonly phase: 'downloading' | 'verifying' | 'extracting' | 'validating' | 'reusing'
  readonly completed: number
  readonly total: number
}

export interface PrepareHarnessPrebuiltOptions {
  readonly legacyRuntimeDir: string
  readonly updateRoot: string
  readonly release: HarnessPrebuiltRelease
  readonly nodeVersion: string
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly downloadTimeoutMs?: number
  readonly onProgress?: (progress: HarnessPrebuiltProgress) => void
}

/** Reuses the established content hash format, but streams file bytes off the main event loop. */
export async function harnessRuntimeContentSha256(directory: string): Promise<string> {
  const hash = createHash('sha256')
  const root = resolve(directory)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new HarnessReleaseError('RUNTIME_LINK', 'DSH 预构建运行时根目录不能是链接。')
  const visit = async (current: string): Promise<void> => {
    for (const name of (await readdir(current)).sort((a, b) => a.localeCompare(b, 'en'))) {
      const path = join(current, name)
      const key = relative(root, path).replaceAll('\\', '/')
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new HarnessReleaseError('RUNTIME_LINK', 'DSH 预构建运行时不能包含链接。')
      if (info.isDirectory()) { hash.update(`D\0${key}\0`); await visit(path) }
      else if (info.isFile()) {
        hash.update(`F\0${key}\0${info.size}\0`)
        for await (const chunk of createReadStream(path)) hash.update(chunk)
      } else throw new HarnessReleaseError('RUNTIME_TYPE', 'DSH 预构建运行时包含特殊文件。')
    }
  }
  await visit(root)
  return hash.digest('hex')
}

async function regularFileHash(path: string): Promise<{ size: number; sha256: string } | undefined> {
  let info
  try { info = await lstat(path) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new HarnessReleaseError('CACHE_TYPE', 'DSH 更新缓存不是普通文件。')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { size: info.size, sha256: hash.digest('hex') }
}

async function ensureDirectory(path: string): Promise<void> {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  // Recursive mkdir follows existing junctions. Check each component before creating children.
  if (parent !== absolute) await ensureDirectory(parent)
  let info
  try { info = await lstat(absolute) } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    try { await mkdir(absolute) } catch (created) {
      if (!(created instanceof Error && 'code' in created && created.code === 'EEXIST')) throw created
    }
    info = await lstat(absolute)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HarnessReleaseError('UPDATE_PATH', 'DSH 更新目录不是普通目录。')
}

async function verifyPublishedSlot(directory: string, release: HarnessPrebuiltRelease): Promise<HarnessRuntimeCandidate> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HarnessReleaseError('SLOT_TYPE', 'DSH 运行时槽不是普通目录。')
  const marker = (await readFile(join(directory, '.dsh-runtime-fingerprint'), 'utf8')).trim().toLowerCase()
  if (marker !== release.runtimeFingerprint) throw new HarnessReleaseError('SLOT_FINGERPRINT', '已有 DSH 槽的真实指纹与预构建发布不匹配。')
  const validation = await validateHarnessRuntimeCandidate(directory, release.version, release.npmIntegrity)
  await verifyRuntimePnpmLayout(directory)
  if (validation.fingerprint !== release.runtimeFingerprint) throw new HarnessReleaseError('SLOT_FINGERPRINT', 'DSH 槽依赖指纹与发布契约不匹配。')
  if (await harnessRuntimeContentSha256(directory) !== release.contentSha256) throw new HarnessReleaseError('CONTENT_HASH', 'DSH 槽文件内容与已验证的发布制品不匹配。')
  return { directory, version: release.version, fingerprint: validation.fingerprint, packageCount: validation.packageCount, reused: true }
}

/** Downloads a complete release package; no installation command is executed here. */
export async function prepareHarnessPrebuiltCandidate(options: PrepareHarnessPrebuiltOptions): Promise<HarnessRuntimeCandidate> {
  const release = options.release
  parseHarnessReleaseContract(release, release.version, options.nodeVersion)
  const names = harnessReleaseNames(release.version)
  if (release.releaseTag !== names.tag) throw new HarnessReleaseError('RELEASE_TAG', 'DSH 预构建发布标签不匹配。')
  trustedHarnessAssetUrl(release.assetUrl, release.source, release.releaseTag, release.artifact)
  options.signal?.throwIfAborted()
  const slotsRoot = runtimeSlotsRoot(options.legacyRuntimeDir)
  await ensureDirectory(slotsRoot)
  const destination = runtimeSlotDirectory(options.legacyRuntimeDir, release.version, release.runtimeFingerprint)
  try {
    await lstat(destination)
    options.onProgress?.({ phase: 'reusing', completed: 0, total: 1 })
    const existing = await verifyPublishedSlot(destination, release)
    options.onProgress?.({ phase: 'reusing', completed: 1, total: 1 })
    return existing
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    // ENOENT is only reusable absence when the slot itself is missing, not when its marker is missing.
    try { await lstat(destination); throw new HarnessReleaseError('SLOT_INCOMPLETE', '已有 DSH 槽缺少必要文件，禁止原地修补。') } catch (missing) {
      if (!(missing instanceof Error && 'code' in missing && missing.code === 'ENOENT')) throw missing
    }
  }
  const downloads = join(resolve(options.updateRoot), 'downloads')
  await ensureDirectory(resolve(options.updateRoot))
  await ensureDirectory(downloads)
  const versionDownloads = join(downloads, release.version)
  await ensureDirectory(versionDownloads)
  const space = await statfs(slotsRoot)
  if (space.bavail * space.bsize < release.size + release.unpackedSize + 64 * 1024 * 1024) {
    throw new HarnessReleaseError('DISK_SPACE', '便携盘剩余空间不足以准备 DSH 预构建候选。')
  }
  const archive = join(versionDownloads, release.artifact)
  const cached = await regularFileHash(archive)
  if (cached?.size !== release.size || cached.sha256 !== release.sha256) {
    await downloadArchive(options, archive)
  } else options.onProgress?.({ phase: 'verifying', completed: release.size, total: release.size })
  options.signal?.throwIfAborted()
  const staging = await mkdtemp(join(slotsRoot, '.prebuilt-staging-'))
  let moved = false
  try {
    await extractHarnessRuntimeArchive(archive, staging, release.unpackedSize, options.onProgress, options.signal)
    options.onProgress?.({ phase: 'validating', completed: 0, total: 1 })
    const candidate = await verifyPublishedSlot(staging, release)
    options.signal?.throwIfAborted()
    try {
      await rename(staging, destination)
      moved = true
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code)))) throw error
      // Another valid preparer may have won the same immutable slot; never overwrite it.
      return await verifyPublishedSlot(destination, release)
    }
    await ensureDirectory(join(resolve(options.updateRoot), 'prebuilt-receipts'))
    await writeTextFileAtomic(join(resolve(options.updateRoot), 'prebuilt-receipts', `${release.version}-${release.runtimeFingerprint.slice(0, 16)}.json`), `${JSON.stringify({
      schema: 1, version: release.version, artifact: release.artifact, sha256: release.sha256,
      npmIntegrity: release.npmIntegrity, officialCommit: release.officialCommit,
      runtimeFingerprint: release.runtimeFingerprint, preparedAt: new Date().toISOString(),
    }, undefined, 2)}\n`)
    options.onProgress?.({ phase: 'validating', completed: 1, total: 1 })
    return { ...candidate, directory: destination, reused: false }
  } finally {
    if (!moved) await rm(staging, { recursive: true, force: true })
  }
}

async function downloadArchive(options: PrepareHarnessPrebuiltOptions, archive: string): Promise<void> {
  const release = options.release
  const partial = `${archive}.${randomUUID()}.partial`
  const signal = AbortSignal.any([AbortSignal.timeout(options.downloadTimeoutMs ?? 15 * 60_000), ...(options.signal === undefined ? [] : [options.signal])])
  const response = await fetchHarnessReleaseAsset(release.assetUrl, release.source, release.releaseTag, release.artifact, { fetch: options.fetch, signal })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new HarnessReleaseError('DOWNLOAD_HTTP', `DSH 预构建包下载返回 HTTP ${response.status}。`)
  }
  const declaredSize = response.headers.get('content-length')
  if (declaredSize !== null && Number(declaredSize) !== release.size) {
    await response.body.cancel()
    throw new HarnessReleaseError('DOWNLOAD_SIZE', 'DSH 预构建包声明大小与发布契约不匹配。')
  }
  let completed = 0
  let lastReport = 0
  const hash = createHash('sha256')
  const handle = await open(partial, 'wx')
  try {
    options.onProgress?.({ phase: 'downloading', completed, total: release.size })
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      completed += chunk.length
      if (completed > release.size) throw new HarnessReleaseError('DOWNLOAD_SIZE', 'DSH 预构建包下载超过发布大小。')
      hash.update(chunk)
      await handle.writeFile(chunk)
      if (Date.now() - lastReport > 100) {
        options.onProgress?.({ phase: 'downloading', completed, total: release.size })
        lastReport = Date.now()
      }
    }
    options.onProgress?.({ phase: 'verifying', completed, total: release.size })
    if (completed !== release.size || hash.digest('hex') !== release.sha256) throw new HarnessReleaseError('DOWNLOAD_HASH', 'DSH 预构建包大小或完整 SHA256 校验失败。')
    await handle.sync()
    await handle.close()
    await rename(partial, archive)
  } finally {
    await handle.close()
    await rm(partial, { force: true })
  }
}

function tarString(bytes: Buffer): string {
  const zero = bytes.indexOf(0)
  try { return new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, zero < 0 ? bytes.length : zero)) } catch {
    throw new HarnessReleaseError('ARCHIVE_ENCODING', 'DSH 压缩包文件名不是有效 UTF-8。')
  }
}

function tarNumber(bytes: Buffer): number {
  const text = tarString(bytes).trim()
  if (!/^[0-7]*$/.test(text)) throw new HarnessReleaseError('ARCHIVE_HEADER', 'DSH 压缩包头包含不支持的数字编码。')
  const value = text === '' ? 0 : parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new HarnessReleaseError('ARCHIVE_SIZE', 'DSH 压缩包条目过大。')
  return value
}

/** The target is Windows even when a publisher/test runs elsewhere. */
export function validateHarnessArchivePath(path: string): string {
  if (path.includes('\\') || path.startsWith('/') || isAbsolute(path)) throw new HarnessReleaseError('ARCHIVE_PATH', 'DSH 压缩包包含绝对路径或反斜杠。')
  const segments = path.split('/').filter(part => part !== '' && part !== '.')
  if (path.length > 2_048 || segments.length > 64 || segments.some(part => part === '..' || /[\x00-\x1f\x7f<>:"|?*]/.test(part)
    || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new HarnessReleaseError('ARCHIVE_PATH', 'DSH 压缩包包含越界或 Windows 不安全路径。')
  }
  return segments.join('/')
}

function paxFields(bytes: Buffer): Record<string, string> {
  const fields: Record<string, string> = Object.create(null)
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset)
    if (space < 0) throw new HarnessReleaseError('ARCHIVE_HEADER', 'DSH PAX 压缩包头格式无效。')
    const length = Number(bytes.subarray(offset, space).toString('ascii'))
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) {
      throw new HarnessReleaseError('ARCHIVE_HEADER', 'DSH PAX 压缩包头长度无效。')
    }
    const field = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(space + 1, offset + length - 1))
    const equals = field.indexOf('=')
    if (equals < 1) throw new HarnessReleaseError('ARCHIVE_HEADER', 'DSH PAX 压缩包头字段无效。')
    const key = field.slice(0, equals)
    if (Object.hasOwn(fields, key)) throw new HarnessReleaseError('ARCHIVE_HEADER', 'DSH PAX 压缩包头字段重复。')
    if (/^(?:linkpath|GNU\.sparse\.|SCHILY\.dev)/.test(key)) throw new HarnessReleaseError('ARCHIVE_TYPE', 'DSH 压缩包不能包含链接、稀疏文件或设备。')
    fields[key] = field.slice(equals + 1)
    offset += length
  }
  return fields
}

/** Extract regular files directly, so tar links and platform extraction quirks cannot escape staging. */
export async function extractHarnessRuntimeArchive(
  archive: string, destination: string, expectedBytes: number,
  onProgress?: (progress: HarnessPrebuiltProgress) => void, signal?: AbortSignal,
): Promise<void> {
  const root = resolve(destination)
  signal?.throwIfAborted()
  await ensureDirectory(root)
  const compressed = createReadStream(archive)
  const stream = compressed.pipe(createGunzip())
  compressed.once('error', error => stream.destroy(error))
  const iterator = stream[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  const read = async (size: number, allowEnd = false): Promise<Buffer | undefined> => {
    const pieces: Buffer[] = []
    let remaining = size
    while (remaining > 0) {
      signal?.throwIfAborted()
      if (pending.length === 0) {
        const next = await iterator.next()
        if (next.done) {
          if (allowEnd && remaining === size) return undefined
          throw new HarnessReleaseError('ARCHIVE_TRUNCATED', 'DSH 压缩包被截断。')
        }
        pending = Buffer.from(next.value)
      }
      const count = Math.min(remaining, pending.length)
      pieces.push(pending.subarray(0, count))
      pending = pending.subarray(count)
      remaining -= count
    }
    return Buffer.concat(pieces, size)
  }
  const readExact = async (size: number): Promise<Buffer> => (await read(size))!
  let completed = 0, entries = 0, zeroBlocks = 0, metadataBytes = 0, lastReport = 0
  let pax: Record<string, string> | undefined
  let longName: string | undefined
  const seen = new Set<string>()
  try {
    for (;;) {
      const header = await read(512, true)
      if (header === undefined) break
      if (header.every(byte => byte === 0)) {
        zeroBlocks += 1
        if (zeroBlocks > 32_768) throw new HarnessReleaseError('ARCHIVE_SIZE', 'DSH 压缩包尾部过大。')
        continue
      }
      if (zeroBlocks > 0) throw new HarnessReleaseError('ARCHIVE_HEADER', 'DSH 压缩包结束标记后仍包含条目。')
      if (++entries > 500_000) throw new HarnessReleaseError('ARCHIVE_SIZE', 'DSH 压缩包文件数量超过上限。')
      const checksum = tarNumber(header.subarray(148, 156))
      const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
      if (checksum !== actual) throw new HarnessReleaseError('ARCHIVE_HEADER', 'DSH 压缩包头校验失败。')
      const type = String.fromCharCode(header[156]!)
      const prefix = tarString(header.subarray(345, 500))
      let name = tarString(header.subarray(0, 100))
      if (prefix !== '') name = `${prefix}/${name}`
      let size = tarNumber(header.subarray(124, 136))
      if (type === 'x' || type === 'L') {
        if (size > 64 * 1024 || (metadataBytes += size) > 64 * 1024 * 1024) throw new HarnessReleaseError('ARCHIVE_SIZE', 'DSH 压缩包扩展头过大。')
        const data = await readExact(size)
        if (type === 'x') pax = paxFields(data)
        else longName = tarString(data)
        await readExact((512 - size % 512) % 512)
        continue
      }
      if (!['0', '\0', '5'].includes(type) || tarString(header.subarray(157, 257)) !== '') {
        throw new HarnessReleaseError('ARCHIVE_TYPE', 'DSH 压缩包只能包含普通文件和目录，不能包含链接或设备。')
      }
      name = pax?.path ?? longName ?? name
      if (pax?.size !== undefined) {
        if (!/^\d+$/.test(pax.size)) throw new HarnessReleaseError('ARCHIVE_SIZE', 'DSH PAX 文件大小无效。')
        size = Number(pax.size)
      }
      pax = undefined; longName = undefined
      if (!Number.isSafeInteger(size) || size < 0 || size > expectedBytes - completed) throw new HarnessReleaseError('ARCHIVE_SIZE', 'DSH 压缩包解压大小超过发布契约。')
      const safeName = validateHarnessArchivePath(name)
      if (safeName === '' && type !== '5') throw new HarnessReleaseError('ARCHIVE_PATH', 'DSH 压缩包包含空文件路径。')
      const path = resolve(root, ...safeName.split('/'))
      const inside = relative(root, path)
      if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) throw new HarnessReleaseError('ARCHIVE_PATH', 'DSH 压缩包条目离开了暂存目录。')
      if (type === '5') {
        if (size !== 0) throw new HarnessReleaseError('ARCHIVE_TYPE', 'DSH 压缩包目录不能携带文件内容。')
        await mkdir(path, { recursive: true })
      } else {
        const key = safeName.toLowerCase()
        if (seen.has(key)) throw new HarnessReleaseError('ARCHIVE_PATH', 'DSH 压缩包包含重复文件路径。')
        seen.add(key)
        await mkdir(dirname(path), { recursive: true })
        const handle = await open(path, 'wx')
        try {
          let remaining = size
          while (remaining > 0) {
            const chunk = await readExact(Math.min(64 * 1024, remaining))
            await handle.writeFile(chunk)
            remaining -= chunk.length
            completed += chunk.length
            if (Date.now() - lastReport >= 100) { onProgress?.({ phase: 'extracting', completed, total: expectedBytes }); lastReport = Date.now() }
          }
        } finally { await handle.close() }
      }
      await readExact((512 - size % 512) % 512)
    }
    if (zeroBlocks < 2 || pax !== undefined || longName !== undefined || completed !== expectedBytes) {
      throw new HarnessReleaseError('ARCHIVE_TRUNCATED', 'DSH 压缩包结束标记或解压总大小不完整。')
    }
    onProgress?.({ phase: 'extracting', completed, total: expectedBytes })
  } finally {
    compressed.destroy()
    stream.destroy()
  }
}
