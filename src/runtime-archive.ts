import { spawn, spawnSync } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, writeFileSync } from 'node:fs'
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

/** 解压前先读条目清单：既做安全校验，也充当下一步的进度分母。 */
function readArchiveEntries(archivePath: string): string[] {
  if (!existsSync(archivePath)) throw new Error(`压缩包不存在：${archivePath}`)
  const listed = spawnSync('tar', [...tarForceLocalPrefix(), '-tzf', archivePath.replace(/\\/g, '/')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (listed.status !== 0) {
    throw new Error(`无法读取压缩包目录：${(listed.error?.message || listed.stderr || archivePath).trim()}`)
  }
  const entries = listed.stdout.split(/\r?\n/).filter(entry => entry !== '')
  validateArchiveEntries(entries)
  return entries
}

/** 首启把随包压缩包解到可写目录。 */
export function extractTarGz(archivePath: string, destDir: string): void {
  readArchiveEntries(archivePath)
  mkdirSync(destDir, { recursive: true })
  const result = spawnSync('tar', [...tarForceLocalPrefix(), '-xzf', archivePath.replace(/\\/g, '/'), '-C', destDir.replace(/\\/g, '/')], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`解压失败：${(result.stderr || result.stdout || archivePath).trim()}`)
  }
}

/** 与 extractTarGz 同语义，但改异步并逐条目上报进度，让启动窗口能显示真实计数。
 *  条目输出两种形态都要认：GNU tar 把路径写 stdout，Windows 内置 bsdtar 把 `x <路径>` 写 stderr。 */
export async function extractTarGzWithProgress(
  archivePath: string,
  destDir: string,
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  const entries = readArchiveEntries(archivePath)
  const expected = new Set(entries)
  const seen = new Set<string>()
  mkdirSync(destDir, { recursive: true })
  onProgress(0, expected.size)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('tar', [...tarForceLocalPrefix(), '-xvzf', archivePath.replace(/\\/g, '/'), '-C', destDir.replace(/\\/g, '/')], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let lastReport = 0
    const consume = (line: string): void => {
      const entry = expected.has(line) ? line : line.startsWith('x ') ? line.slice(2) : ''
      if (!expected.has(entry) || seen.has(entry)) return
      seen.add(entry)
      if (Date.now() - lastReport >= 100) {
        // 部分 tar 在写文件之前就输出路径，因此只计入前一个已处理的条目，避免虚报完成。
        onProgress(Math.max(0, seen.size - 1), expected.size)
        lastReport = Date.now()
      }
    }
    for (const stream of [child.stdout, child.stderr]) {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        output = (output + chunk).slice(-8_000)
        const lines = (pending + chunk).split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) consume(line)
      })
      stream.on('end', () => { if (pending !== '') consume(pending) })
    }
    child.once('error', error => reject(new Error(`无法启动解压命令：${error.message}`)))
    child.once('close', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`解压失败：${output.trim() || code}`))
    })
  })
  onProgress(expected.size, expected.size)
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

export function verifyFileSha256(path: string, onProgress?: (completed: number, total: number) => void): void {
  const checksumPath = `${path}.sha256`
  if (!existsSync(checksumPath)) throw new Error(`缺少 SHA256 校验文件：${checksumPath}`)
  const expected = readFileSync(checksumPath, 'utf8').trim().toLowerCase()
  const actual = fileSha256(path, onProgress)
  if (!/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
    throw new Error(`SHA256 校验失败：${path}`)
  }
}

/** 4 MB 分块流式摘要：随包运行时压缩包有数百 MB，整文件读入会在首启瞬间顶出内存峰值。 */
function fileSha256(path: string, onProgress?: (completed: number, total: number) => void): string {
  const handle = openSync(path, 'r')
  try {
    const total = fstatSync(handle).size
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
    const hash = createHash('sha256')
    let completed = 0
    let lastReport = 0
    onProgress?.(0, total)
    for (;;) {
      const size = readSync(handle, buffer, 0, buffer.length, null)
      if (size === 0) break
      hash.update(buffer.subarray(0, size))
      completed += size
      if (Date.now() - lastReport >= 100) {
        onProgress?.(completed, total)
        lastReport = Date.now()
      }
    }
    onProgress?.(completed, total)
    return hash.digest('hex')
  } finally {
    closeSync(handle)
  }
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
