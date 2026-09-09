import { spawnSync } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** Windows 内置 bsdtar 不支持 --force-local 且可直接处理盘符路径；仅 GNU tar 需要它，避免把 `G:/...` 当远程主机。 */
let forceLocalPrefix: string[] | undefined
function tarForceLocalPrefix(): string[] {
  if (forceLocalPrefix === undefined) {
    const probe = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
    forceLocalPrefix = /gnu/i.test(String(probe.stdout)) ? ['--force-local'] : []
  }
  return forceLocalPrefix
}

/** 把目录打成单个 tar.gz，避免安装器解压上万个小文件。 */
export function packDirectoryToTarGz(sourceDir: string, archivePath: string): void {
  if (!existsSync(sourceDir)) throw new Error(`压缩源目录不存在：${sourceDir}`)
  const result = spawnSync('tar', [...tarForceLocalPrefix(), '-czf', archivePath.replace(/\\/g, '/'), '-C', sourceDir.replace(/\\/g, '/'), '.'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`压缩失败：${(result.stderr || result.stdout || archivePath).trim()}`)
  }
}

/** 首启把随包压缩包解到可写目录。 */
export function extractTarGz(archivePath: string, destDir: string): void {
  if (!existsSync(archivePath)) throw new Error(`压缩包不存在：${archivePath}`)
  const listed = spawnSync('tar', [...tarForceLocalPrefix(), '-tzf', archivePath.replace(/\\/g, '/')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (listed.status !== 0) {
    throw new Error(`无法读取压缩包目录：${(listed.error?.message || listed.stderr || archivePath).trim()}`)
  }
  validateArchiveEntries(listed.stdout.split(/\r?\n/))
  mkdirSync(destDir, { recursive: true })
  const result = spawnSync('tar', [...tarForceLocalPrefix(), '-xzf', archivePath.replace(/\\/g, '/'), '-C', destDir.replace(/\\/g, '/')], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`解压失败：${(result.stderr || result.stdout || archivePath).trim()}`)
  }
}

export function writeFileSha256(path: string): void {
  writeFileSync(`${path}.sha256`, `${fileSha256(path)}\n`, 'utf8')
}

/**
 * 归档字节会受 tar/gzip 时间戳影响，不能用来判断两次构建的逻辑内容是否相同。
 * 此摘要只覆盖规范化相对路径、文件内容和符号链接目标，供便携盘缓存跨桌面版本复用。
 */
export function directoryContentSha256(sourceDir: string): string {
  return directoryContentSha256Filtered(sourceDir, () => false)
}

/**
 * pnpm v11 的 SQLite 索引会把每个包文件的本地 mtime 写入 data BLOB。
 * 这些时间戳每次装配都不同，但并不改变包身份或文件内容。插件仓库另外
 * 携带确定性的 dsh-store-lock.yaml，因此缓存身份可以安全忽略该易变数据库。
 */
export function pnpmStoreContentSha256(sourceDir: string): string {
  return directoryContentSha256Filtered(sourceDir, relativePath => /^v\d+\/index\.db(?:-(?:shm|wal))?$/.test(relativePath))
}

function directoryContentSha256Filtered(sourceDir: string, ignoreFile: (relativePath: string) => boolean): string {
  const root = resolve(sourceDir)
  if (!existsSync(root)) throw new Error(`内容摘要源目录不存在：${sourceDir}`)
  const hash = createHash('sha256')
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right, 'en'))) {
      const path = join(directory, name)
      const key = relative(root, path).replaceAll('\\', '/')
      const metadata = lstatSync(path)
      if (metadata.isDirectory()) {
        hash.update(`D\0${key}\0`)
        visit(path)
      } else if (metadata.isSymbolicLink()) {
        hash.update(`L\0${key}\0${readlinkSync(path)}\0`)
      } else if (metadata.isFile()) {
        if (ignoreFile(key)) continue
        hash.update(`F\0${key}\0${metadata.size}\0`)
        hash.update(readFileSync(path))
      } else {
        throw new Error(`内容摘要不支持此文件类型：${path}`)
      }
    }
  }
  visit(root)
  return hash.digest('hex')
}

export function writeDirectoryContentSha256(sourceDir: string, archivePath: string): void {
  writeFileSync(`${archivePath}.content-sha256`, `${directoryContentSha256(sourceDir)}\n`, 'utf8')
}

export function writePnpmStoreContentSha256(sourceDir: string, archivePath: string): void {
  writeFileSync(`${archivePath}.content-sha256`, `${pnpmStoreContentSha256(sourceDir)}\n`, 'utf8')
}

export function verifyFileSha256(path: string): void {
  const checksumPath = `${path}.sha256`
  if (!existsSync(checksumPath)) throw new Error(`缺少 SHA256 校验文件：${checksumPath}`)
  const expected = readFileSync(checksumPath, 'utf8').trim().toLowerCase()
  const actual = fileSha256(path)
  if (!/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
    throw new Error(`SHA256 校验失败：${path}`)
  }
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function validateArchiveEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    if (entry === '') continue
    const normalized = entry.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`压缩包包含不安全路径：${entry}`)
    }
  }
}
