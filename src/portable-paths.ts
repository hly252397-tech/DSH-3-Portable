import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { readRuntimeSlotPointer, resolveActiveRuntimeDir } from './runtime-slots.js'
import { isOfficialRuntimeLaunchable } from './plugin-seed.js'

export interface PortablePaths {
  readonly root: string
  readonly appData: string
  readonly cache: string
  readonly crashDumps: string
  readonly dshHome: string
  readonly home: string
  readonly logs: string
  readonly runtime: string
  readonly sessionData: string
  readonly temp: string
  readonly userData: string
  readonly workspace: string
}

/**
 * The launcher resolves this on every start, so a USB drive can change letters
 * without leaving an absolute path from the previous computer behind.
 */
export function resolvePortablePaths(root: string | undefined, executablePath = process.execPath, runtimeVersion?: string): PortablePaths | undefined {
  const trimmed = root?.trim() || discoverPortableRoot(executablePath)
  if (trimmed === undefined || trimmed === '') return undefined
  if (!isAbsolute(trimmed)) throw new Error('DSH_PORTABLE_ROOT must be an absolute path.')
  const portableRoot = resolve(trimmed)
  const data = join(portableRoot, 'Data')
  const homeBinding = runtimeVersion === undefined ? undefined : readRuntimeHomeBinding(portableRoot, runtimeVersion)
  const localizedWorkspace = join(portableRoot, '工作空间')
  return {
    root: portableRoot,
    appData: join(data, 'Windows', 'Roaming'),
    cache: join(data, 'Electron', 'Cache'),
    crashDumps: join(data, 'Electron', 'CrashDumps'),
    dshHome: homeBinding?.dshHome ?? join(data, 'DSH'),
    home: join(data, 'Home'),
    logs: join(data, 'Logs'),
    runtime: homeBinding?.runtime ?? join(data, 'Runtime', 'dsh-runtime'),
    sessionData: join(data, 'Electron', 'SessionData'),
    temp: join(data, 'Temp'),
    userData: join(data, 'Electron', 'UserData'),
    workspace: existsSync(localizedWorkspace) ? localizedWorkspace : join(portableRoot, 'Workspace'),
  }
}

export interface PortableRuntimeHomeBinding {
  readonly schema: 1 | 2
  readonly runtimeVersion: string
  readonly generation: string
  readonly runtimeRelativePath?: string
}

/** 读活动运行时槽里的官方运行时版本；槽缺失、清单损坏或版本异常时返回 undefined，
 *  调用方按无绑定布局启动（此时运行时本身也无法启动，不存在静默混用数据的路径）。 */
export function readRuntimePackageVersion(runtimeDir: string): string | undefined {
  const manifestPath = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    const manifest = JSON.parse(text) as { name?: unknown; version?: unknown }
    if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      return undefined
    }
    return manifest.version
  } catch {
    return undefined
  }
}

/** 启动流程入口：先按默认布局解析，再按 Harness 槽指针解析活动运行时（与 main.ts 同判定，
 *  legacy 位置可能指向已退役的槽），以活动槽版本重解析命中家园绑定。
 *  绑定校验失败直接抛错，绝不静默回落旧数据（新版会话写入后旧运行时无法读取，混用即不可逆污染）。 */
export function resolveActivePortablePaths(root: string | undefined, executablePath = process.execPath): PortablePaths | undefined {
  const base = resolvePortablePaths(root, executablePath)
  if (base === undefined) return undefined
  const pointer = readRuntimeSlotPointer(base.runtime)
  // 未提交观察事务先按 previous 选择家园；main 随后恢复同一个指针。
  // 若先按 pending 新版读家园、再回滚二进制，会使旧内核读到新格式会话。
  if (pointer?.pendingTransactionId !== undefined && pointer.previous === undefined) throw new Error('未完成的运行时事务没有可回滚家园，已安全停止。')
  let activeRuntimeDir = resolveActiveRuntimeDir(base.runtime)
  if (pointer?.pendingTransactionId !== undefined && pointer.previous !== undefined) {
    const runtimeRoot = dirname(base.runtime)
    const reference = pointer.previous
    if (isAbsolute(reference.relativePath) || reference.relativePath.includes('\0')) throw new Error('待回滚运行时路径非法，已安全停止。')
    activeRuntimeDir = resolve(runtimeRoot, reference.relativePath)
    const physicalRoot = realpathSync(runtimeRoot)
    const physicalChild = relative(physicalRoot, realpathSync(activeRuntimeDir))
    const logicalChild = relative(runtimeRoot, activeRuntimeDir)
    if (logicalChild === '..' || logicalChild.startsWith(`..${sep}`) || isAbsolute(logicalChild)
      || physicalChild === '..' || physicalChild.startsWith(`..${sep}`) || isAbsolute(physicalChild)
      || !isOfficialRuntimeLaunchable(activeRuntimeDir) || readRuntimePackageVersion(activeRuntimeDir) !== reference.version) {
      throw new Error('待回滚运行时身份、入口或物理路径无效，拒绝回落到共享旧数据。')
    }
  }
  // readRuntimePackageVersion 严格校验 name+版本格式且全容错（损坏清单按无绑定处理，
  // 此时运行时本身也无法启动，不存在静默混用数据的路径）。
  const runtimeVersion = readRuntimePackageVersion(activeRuntimeDir)
  if (runtimeVersion === undefined) {
    if (pointer !== undefined) throw new Error('活动槽版本无法读取，拒绝回落到共享旧数据。')
    return base
  }
  const binding = readRuntimeHomeBinding(base.root, runtimeVersion)
  if (binding?.schema === 2 && relative(realpathSync(activeRuntimeDir), realpathSync(binding.runtime)) !== '') {
    throw new Error('家园绑定与选定运行时槽身份不一致，拒绝读取另一槽的数据。')
  }
  return resolvePortablePaths(root, executablePath, runtimeVersion)
}

export function portableRuntimeHomeBindingPath(root: string, runtimeVersion: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(runtimeVersion)) {
    throw new Error('独立家园绑定的运行时版本无效。')
  }
  return join(root, 'Data', 'Updates', 'Harness', 'homes', `${runtimeVersion}.json`)
}

function readRuntimeHomeBinding(root: string, runtimeVersion: string): (Pick<PortablePaths, 'dshHome' | 'runtime'> & { readonly schema: 1 | 2 }) | undefined {
  const bindingPath = portableRuntimeHomeBindingPath(root, runtimeVersion)
  let text: string
  try {
    const bindingInfo = lstatSync(bindingPath)
    if (!bindingInfo.isFile() || bindingInfo.isSymbolicLink()
      || relative(join(realpathSync(root), 'Data', 'Updates', 'Harness', 'homes', `${runtimeVersion}.json`), realpathSync(bindingPath)) !== '') {
      throw new Error('独立家园绑定文件不能指向外部链接。')
    }
    text = readFileSync(bindingPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('无法读取独立家园绑定。', { cause: error })
  }
  try {
    const binding = JSON.parse(text) as Partial<PortableRuntimeHomeBinding> | null
    if ((binding?.schema !== 1 && binding?.schema !== 2) || binding.runtimeVersion !== runtimeVersion
      || typeof binding.generation !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(binding.generation)) {
      throw new Error('独立家园绑定内容无效。')
    }
    const generationRoot = join(root, 'Data', 'DSH-generations', binding.generation)
    const dshHome = join(generationRoot, 'home')
    const runtime = binding.schema === 1 ? join(generationRoot, 'runtime', 'dsh-runtime')
      : typeof binding.runtimeRelativePath === 'string' && /^Data\/Runtime\/Harness\/slots\/[^/\\]+$/.test(binding.runtimeRelativePath)
        ? resolve(root, binding.runtimeRelativePath) : undefined
    if (runtime === undefined) throw new Error('独立家园的运行时槽引用无效。')
    const realRoot = realpathSync(root)
    const expectedGeneration = join(realRoot, 'Data', 'DSH-generations', binding.generation)
    if (relative(expectedGeneration, realpathSync(generationRoot)) !== '') {
      throw new Error('独立家园绑定不能指向目录链接。')
    }
    if (relative(join(expectedGeneration, 'home'), realpathSync(dshHome)) !== '') throw new Error('独立家园 home 不能指向目录链接。')
    const expectedRuntime = binding.schema === 1 ? expectedGeneration : runtime
    if (binding.schema === 2 && relative(join(realRoot, binding.runtimeRelativePath!), realpathSync(runtime)) !== '') throw new Error('独立家园运行时槽不能指向目录链接。')
    const runtimePackage = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
    for (const [path, allowedRoot] of [
      [join(dshHome, 'profiles', 'web', 'package.json'), join(expectedGeneration, 'home')],
      [join(runtimePackage, 'package.json'), expectedRuntime], [join(runtimePackage, 'lib', 'bin.js'), expectedRuntime],
    ]) {
      const child = relative(allowedRoot!, realpathSync(path!))
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !lstatSync(path!).isFile()) {
        throw new Error('独立家园副本不完整或指向外部文件。')
      }
    }
    const installed = JSON.parse(readFileSync(join(runtimePackage, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (installed.name !== '@deepseek-ai/dsh' || installed.version !== runtimeVersion) {
      throw new Error('独立家园的运行时版本与绑定不一致。')
    }
    return { dshHome, runtime, schema: binding.schema }
  } catch (error) {
    throw new Error('独立家园绑定校验失败，拒绝回落到旧数据。', { cause: error })
  }
}

/** Only recognize our two shipped layouts; never infer from cwd or a random ancestor. */
function discoverPortableRoot(executablePath: string): string | undefined {
  if (basename(executablePath).toLowerCase() !== 'dsh codex desktop.exe') return undefined
  const directory = dirname(resolve(executablePath))
  let candidate: string | undefined
  if (basename(directory).toLowerCase() === 'app') candidate = dirname(directory)
  else if (basename(dirname(directory)).toLowerCase() === 'slots'
    && basename(resolve(directory, '../..')).toLowerCase() === 'desktop'
    && basename(resolve(directory, '../../..')).toLowerCase() === 'updates'
    && basename(resolve(directory, '../../../..')).toLowerCase() === 'data') {
    candidate = resolve(directory, '../../../../..')
  }
  if (candidate === undefined) return undefined
  const markers = ['Start-DSH-Portable.ps1', 'Portable-Environment.ps1'].map(name => join(candidate, name))
  if (!markers.some(marker => existsSync(marker))) {
    // App is also a valid ordinary installation folder. A slot layout is portable-only.
    if (basename(directory).toLowerCase() === 'app') return undefined
    throw new Error('便携启动文件缺失；请恢复便携目录，不能回退到系统用户目录。')
  }
  if (!markers.every(marker => existsSync(marker) && lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink())) {
    throw new Error('便携启动文件不完整或为链接；拒绝回退到系统用户目录。')
  }
  return candidate
}

export function ensurePortableDirectories(paths: PortablePaths): void {
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
}

/** Keep child processes and plugin tools from silently falling back to C:. */
export function applyPortableEnvironment(paths: PortablePaths, environment: NodeJS.ProcessEnv = process.env): void {
  const data = join(paths.root, 'Data')
  const development = join(data, 'Development')
  const values: Record<string, string> = {
    DSH_HOME: paths.dshHome,
    DSH_PORTABLE_ROOT: paths.root,
    DSH_DESKTOP_RUNTIME_DIR: paths.runtime,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: join(data, 'Windows', 'Local'),
    TEMP: paths.temp,
    TMP: paths.temp,
    XDG_CONFIG_HOME: join(data, 'XDG', 'Config'),
    XDG_CACHE_HOME: join(data, 'XDG', 'Cache'),
    XDG_DATA_HOME: join(data, 'XDG', 'Data'),
    npm_config_cache: join(development, 'npm-cache'),
    npm_config_prefix: join(development, 'npm-global'),
    npm_config_userconfig: join(development, 'npmrc'),
    PNPM_HOME: join(development, 'pnpm-home'),
    ELECTRON_CACHE: join(development, 'electron-cache'),
    ELECTRON_BUILDER_CACHE: join(development, 'electron-builder-cache'),
    PLAYWRIGHT_BROWSERS_PATH: join(development, 'playwright'),
    PIP_CACHE_DIR: join(development, 'pip-cache'),
    PYTHONUSERBASE: join(development, 'python-user'),
    CARGO_HOME: join(development, 'cargo'),
    RUSTUP_HOME: join(development, 'rustup'),
    GOPATH: join(development, 'go'),
    GOCACHE: join(development, 'go-cache'),
    DOTNET_CLI_HOME: join(development, 'dotnet'),
    NUGET_PACKAGES: join(development, 'nuget'),
    GIT_CONFIG_GLOBAL: join(development, 'gitconfig'),
  }
  for (const [name, value] of Object.entries(values)) environment[name] = value
}
