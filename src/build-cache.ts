import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CACHE_SCHEMA = 1
const HEX = /^[a-f0-9]{64}$/

export interface BuildFileDigest {
  path: string
  size: number
  sha256: string
}

interface BuildCacheRecord {
  schema: number
  input: string
  completedAt: string
  artifacts: BuildFileDigest[]
}

export interface BuildCacheResult {
  hit: boolean
  reason: string
}

export function buildCacheDirectory(projectRoot: string): string {
  return join(projectRoot, 'Data', 'Development', 'build-cache')
}

function inside(root: string, path: string): string {
  const target = resolve(root, path)
  const local = relative(resolve(root), target)
  if (local === '' || isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) {
    throw new Error(`构建缓存路径越界：${path}`)
  }
  return target
}

export async function hashBuildFile(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

/** Optional files contribute an absence marker, so creating one invalidates the cache. */
export async function fingerprintBuildInputs(root: string, paths: readonly string[], values: unknown): Promise<string> {
  const digest = createHash('sha256').update(JSON.stringify({ schema: CACHE_SCHEMA, values }))
  for (const path of [...new Set(paths)].sort()) {
    const target = inside(root, path)
    digest.update('\0' + path.replaceAll('\\', '/') + '\0')
    try {
      digest.update(await hashBuildFile(target))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      digest.update('missing')
    }
  }
  return digest.digest('hex')
}

export async function collectBuildArtifacts(root: string, paths: readonly string[]): Promise<BuildFileDigest[]> {
  const files: BuildFileDigest[] = []
  const visited = new Set<string>()
  const visit = async (path: string): Promise<void> => {
    const target = inside(root, path)
    const actual = await realpath(target)
    inside(root, actual)
    const information = await stat(target)
    if (information.isDirectory()) {
      if (visited.has(actual)) throw new Error(`构建缓存目录链接循环：${path}`)
      visited.add(actual)
      for (const name of (await readdir(target)).sort()) await visit(join(path, name))
      visited.delete(actual)
    } else if (information.isFile()) {
      files.push({ path: path.replaceAll('\\', '/'), size: information.size, sha256: await hashBuildFile(target) })
    } else {
      throw new Error(`构建缓存不支持此文件类型：${path}`)
    }
  }
  for (const path of paths) await visit(path)
  if (files.length === 0) throw new Error('构建制品为空，禁止提交缓存。')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + process.pid + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value, undefined, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  // If rename fails, preserve the newly completed record for diagnosis.
  await rename(temporary, path)
}

export async function commitBuildArtifactCache(root: string, recordPath: string, input: string, paths: readonly string[]): Promise<void> {
  if (!HEX.test(input)) throw new Error('构建输入指纹无效。')
  const artifacts = await collectBuildArtifacts(root, paths)
  await atomicJson(recordPath, { schema: CACHE_SCHEMA, input, completedAt: new Date().toISOString(), artifacts })
}

export async function checkBuildArtifactCache(root: string, recordPath: string, input: string, paths: readonly string[]): Promise<BuildCacheResult> {
  try {
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Partial<BuildCacheRecord>
    if (record.schema !== CACHE_SCHEMA || record.input !== input || !Array.isArray(record.artifacts) || record.artifacts.length === 0) {
      return { hit: false, reason: '输入变化或没有完整的成功记录' }
    }
    if (!record.artifacts.every(file => file !== null && typeof file === 'object'
      && typeof file.path === 'string' && Number.isInteger(file.size) && file.size >= 0
      && typeof file.sha256 === 'string' && HEX.test(file.sha256))) {
      return { hit: false, reason: '缓存记录格式损坏' }
    }
    const actual = await collectBuildArtifacts(root, paths)
    if (actual.length !== record.artifacts.length || actual.some((file, index) => {
      const expected = record.artifacts![index]
      return expected === undefined || file.path !== expected.path || file.size !== expected.size || file.sha256 !== expected.sha256
    })) return { hit: false, reason: '制品缺失、增加或内容校验失败' }
    return { hit: true, reason: '输入与全部交付文件 SHA256 一致' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || error instanceof SyntaxError) {
      return { hit: false, reason: '缓存记录或制品不完整' }
    }
    throw error
  }
}

/** Locks only our assembly outputs, never running application slots or user data. */
export async function acquireBuildCacheLock(directory: string, options: {
  waitMs?: number
  pollMs?: number
  onWait?: () => void
} = {}): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'assembly.lock')
  const token = randomUUID()
  const started = Date.now()
  let reported = false
  for (;;) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }))
      } finally {
        await handle.close()
      }
      return async () => {
        // A stale owner's finalizer must never remove a successor's lock.
        const owner = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown }
        if (owner.token === token) await unlink(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const raw = await readFile(path, 'utf8')
        const owner = JSON.parse(raw) as { pid?: unknown }
        if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) {
          try { process.kill(Number(owner.pid), 0) } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === 'ESRCH' && await readFile(path, 'utf8') === raw) {
              await unlink(path)
              continue
            }
          }
        }
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'ENOENT') continue
        if (!(failure instanceof SyntaxError)) throw failure
        // A just-created lock may not have its owner JSON yet; leave it alone.
      }
      if (Date.now() - started >= (options.waitMs ?? 1_800_000)) throw new Error(`等待运行时装配锁超时：${path}`)
      if (!reported) { options.onWait?.(); reported = true }
      await new Promise<void>(done => setTimeout(done, options.pollMs ?? 1000))
    }
  }
}

async function sourceClosure(root: string, entry: string, collected: Set<string>): Promise<void> {
  if (collected.has(entry)) return
  collected.add(entry)
  const source = await readFile(inside(root, entry), 'utf8')
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    const local = relative(root, resolve(root, dirname(entry), match[1]!))
    const options = [local, local.replace(/\.js$/, '.ts'), local.replace(/\.mjs$/, '.mts'), local.replace(/\.cjs$/, '.cts')]
    const found = options.find(path => existsSync(inside(root, path)))
    if (found !== undefined) await sourceClosure(root, found, collected)
  }
}

async function pnpmSourceIdentity(entry: string, expected: string): Promise<unknown> {
  let directory = dirname(resolve(entry))
  for (let depth = 0; depth < 8; depth += 1) {
    const path = join(directory, 'package.json')
    if (existsSync(path)) {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === 'pnpm' || manifest.name === '@pnpm/exe') {
        if (manifest.version !== expected) throw new Error(`装配 pnpm 版本不一致：需要 ${expected}，实际 ${String(manifest.version)}`)
        const files: Record<string, string> = { manifest: await hashBuildFile(path), entry: await hashBuildFile(entry) }
        const native = join(directory, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
        if (existsSync(native)) files.native = await hashBuildFile(native)
        return { version: manifest.version, files }
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error('装配 pnpm 入口没有可验证的包身份。')
}

export async function runtimeAssemblyInput(root: string, node: { executable: string; sha256: string }, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    packageManager: string
    engines: unknown
    config: unknown
    devDependencies: unknown
  }
  const sources = new Set<string>()
  await sourceClosure(root, 'scripts/prepare-runtime.ts', sources)
  await sourceClosure(root, 'scripts/staging-registry-proxy.mjs', sources)
  const paths = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tsconfig.json', ...sources]
  for (const source of sources) {
    if (/\.(?:ts|mts|cts)$/.test(source)) {
      const compiled = join('dist', source.replace(/\.ts$/, '.js').replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs'))
      paths.push(compiled)
      const [sourceFile, outputFile] = await Promise.all([stat(inside(root, source)), stat(inside(root, compiled))])
      if (outputFile.mtimeMs < sourceFile.mtimeMs) throw new Error(`运行时装配代码尚未编译：${source}`)
    }
  }
  const registry = env.DSH_UPSTREAM_REGISTRY || env.DSH_STAGING_REGISTRY || 'https://registry.npmjs.org/'
  const pnpmSource = env.npm_execpath === undefined ? 'not-provided'
    : await pnpmSourceIdentity(env.npm_execpath, manifest.packageManager.split('@').at(-1)!)
  return fingerprintBuildInputs(root, paths, {
    kind: 'runtime-assembly', platform: process.platform, arch: process.arch,
    node: { version: process.version, sha256: node.sha256 },
    packageManager: manifest.packageManager, engines: manifest.engines,
    config: manifest.config, devDependencies: manifest.devDependencies, registry, pnpmSource,
  })
}

export function runtimeAssemblyArtifacts(): string[] {
  return [
    'runtime-node',
    'runtime-plugins/store.tgz', 'runtime-plugins/store.tgz.sha256', 'runtime-plugins/store.tgz.content-sha256',
    'runtime-dsh.tgz', 'runtime-dsh.tgz.sha256', 'runtime-dsh.tgz.content-sha256',
  ]
}

async function developmentDependencyState(root: string): Promise<{ input: string; artifacts: string[] }> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    packageManager: string
    engines: unknown
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    config?: { bundledNodeSha256?: Record<string, string> }
  }
  const nodeHash = await hashBuildFile(process.execPath)
  if (nodeHash.toUpperCase() !== manifest.config?.bundledNodeSha256?.[`${process.platform}-${process.arch}`]?.toUpperCase()) {
    throw new Error('开发依赖缓存必须由清单 SHA256 命中的 Node 执行。')
  }
  const input = await fingerprintBuildInputs(root, ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'], {
    kind: 'development-dependencies', platform: process.platform, arch: process.arch, nodeHash,
    packageManager: manifest.packageManager, engines: manifest.engines,
    dependencies: manifest.dependencies, devDependencies: manifest.devDependencies, optionalDependencies: manifest.optionalDependencies,
  })
  const artifacts = ['node_modules/.modules.yaml']
  const pnpmVersion = manifest.packageManager.split('@').at(-1)!
  const pnpmPackage = join('Tools', 'pnpm-v' + pnpmVersion, 'node_modules', 'pnpm')
  const pnpmManifest = join(pnpmPackage, 'package.json')
  const pnpm = JSON.parse(await readFile(inside(root, pnpmManifest), 'utf8')) as { name?: unknown; version?: unknown }
  if (pnpm.name !== 'pnpm' || pnpm.version !== pnpmVersion) throw new Error('便携 pnpm 包身份或版本不一致。')
  artifacts.push(pnpmManifest, join(pnpmPackage, 'bin', pnpmVersion.startsWith('12.') ? 'pnpm.mjs' : 'pnpm.cjs'))
  const nativePnpm = join(pnpmPackage, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
  if (existsSync(inside(root, nativePnpm))) artifacts.push(nativePnpm)
  for (const [name, expected] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const packageFile = join('node_modules', ...name.split('/'), 'package.json')
    const installed = JSON.parse(await readFile(inside(root, packageFile), 'utf8')) as { version?: unknown; bin?: string | Record<string, string> }
    if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(expected) && installed.version !== expected) {
      throw new Error(`开发依赖版本未对齐：${name}，需要 ${expected}，实际 ${String(installed.version)}`)
    }
    artifacts.push(packageFile)
    for (const bin of typeof installed.bin === 'string' ? [installed.bin] : Object.values(installed.bin ?? {})) {
      artifacts.push(join(dirname(packageFile), bin))
    }
  }
  artifacts.push(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe'
    : process.platform === 'darwin' ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      : 'node_modules/electron/dist/electron')
  return { input, artifacts }
}

async function dependencyCommand(command: string, root: string): Promise<void> {
  const record = join(buildCacheDirectory(root), 'development-dependencies.json')
  if (command === 'dependencies-check') {
    try {
      const state = await developmentDependencyState(root)
      const result = await checkBuildArtifactCache(root, record, state.input, state.artifacts)
      console.log(JSON.stringify(result))
      if (!result.hit) process.exitCode = 2
    } catch (error) {
      console.log(JSON.stringify({ hit: false, reason: error instanceof Error ? error.message : String(error) }))
      process.exitCode = 2
    }
  } else {
    const state = await developmentDependencyState(root)
    await commitBuildArtifactCache(root, record, state.input, state.artifacts)
    console.log('开发依赖成功状态已记录。')
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root] = process.argv.slice(2)
  if (!['dependencies-check', 'dependencies-commit'].includes(command ?? '') || root === undefined) {
    throw new Error('Usage: build-cache <dependencies-check|dependencies-commit> <project-root>')
  }
  await dependencyCommand(command!, resolve(root))
}
