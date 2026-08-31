import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

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
export function resolvePortablePaths(root: string | undefined): PortablePaths | undefined {
  const trimmed = root?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  const portableRoot = resolve(trimmed)
  if (!isAbsolute(portableRoot)) throw new Error('DSH_PORTABLE_ROOT must be an absolute path.')
  const data = join(portableRoot, 'Data')
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
    workspace: join(portableRoot, 'Workspace'),
  }
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
    PNPM_STORE_DIR: join(development, 'pnpm-store'),
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
