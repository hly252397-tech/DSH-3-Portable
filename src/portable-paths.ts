import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

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
export function resolvePortablePaths(root: string | undefined, executablePath = process.execPath): PortablePaths | undefined {
  const trimmed = root?.trim() || discoverPortableRoot(executablePath)
  if (trimmed === undefined || trimmed === '') return undefined
  if (!isAbsolute(trimmed)) throw new Error('DSH_PORTABLE_ROOT must be an absolute path.')
  const portableRoot = resolve(trimmed)
  const data = join(portableRoot, 'Data')
  const localizedWorkspace = join(portableRoot, '工作空间')
  return {
    root: portableRoot,
    appData: join(data, 'Windows', 'Roaming'),
    cache: join(data, 'Electron', 'Cache'),
    crashDumps: join(data, 'Electron', 'CrashDumps'),
    dshHome: join(data, 'DSH'),
    home: join(data, 'Home'),
    logs: join(data, 'Logs'),
    runtime: join(data, 'Runtime', 'dsh-runtime'),
    sessionData: join(data, 'Electron', 'SessionData'),
    temp: join(data, 'Temp'),
    userData: join(data, 'Electron', 'UserData'),
    workspace: existsSync(localizedWorkspace) ? localizedWorkspace : join(portableRoot, 'Workspace'),
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
