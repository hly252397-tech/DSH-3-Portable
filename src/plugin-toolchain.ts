import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** pnpm 12's manifest bin is native; DSH's Node-based bridge must use its JS wrapper. */
export function resolvePnpmNodeEntry(packageRoot: string, exists: (path: string) => boolean = existsSync): string {
  for (const entry of ['bin/pnpm.mjs', 'bin/pnpm.cjs', 'dist/pnpm.cjs', 'bin/pnpm.js']) {
    const candidate = join(packageRoot, entry)
    if (exists(candidate)) return candidate
  }
  throw new Error(`随包 pnpm 的 Node 入口不存在：${packageRoot}`)
}

/** npm_execpath from pnpm 12 points to a native binary even when invoked through its JS wrapper. */
export function normalizePnpmNodeEntry(entry: string): string {
  if (/\.(?:mjs|cjs|js)$/i.test(entry)) return entry
  let directory = dirname(resolve(entry))
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
      if (name === 'pnpm' || name === '@pnpm/exe') return resolvePnpmNodeEntry(directory)
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`无法将 pnpm 原生入口解析为 Node 入口：${entry}`)
}

/** pnpm records a versioned store in .modules.yaml, but cache-dir takes its root. */
export function pnpmStoreOptions(storeDir?: string): string[] {
  if (storeDir === undefined) return []
  const cacheDir = /^v\d+$/.test(basename(storeDir)) ? dirname(storeDir) : storeDir
  return [`--store-dir=${storeDir}`, `--cache-dir=${cacheDir}`]
}

/** pnpm 12 rejects --cache-dir, and --config.cacheDir is silently ignored.
 * Keep internal argument builders stable; translate at every process boundary.
 * The official PNPM_CONFIG_CACHE_DIR variable is verified with `pnpm cache path`. */
export function preparePnpmInvocation(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { args: string[]; env: NodeJS.ProcessEnv } {
  const effective: string[] = []
  let cacheDir: string | undefined
  let minimumReleaseAge: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--cache-dir') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error('Missing pnpm cache directory')
      cacheDir = value
    } else if (arg.startsWith('--cache-dir=')) {
      cacheDir = arg.slice('--cache-dir='.length)
      if (!cacheDir) throw new Error('Missing pnpm cache directory')
    } else if (arg.startsWith('--config.minimumReleaseAge=')) {
      minimumReleaseAge = arg.slice('--config.minimumReleaseAge='.length)
      if (!/^\d+$/.test(minimumReleaseAge)) throw new Error('Invalid pnpm minimum release age')
    } else effective.push(arg)
  }
  return { args: effective, env: {
    ...env,
    ...(cacheDir === undefined ? {} : { PNPM_CONFIG_CACHE_DIR: cacheDir, npm_config_cache_dir: cacheDir }),
    ...(minimumReleaseAge === undefined ? {} : { PNPM_CONFIG_MINIMUM_RELEASE_AGE: minimumReleaseAge, npm_config_minimum_release_age: minimumReleaseAge }),
  } }
}

interface PathLookup {
  exists?: (path: string) => boolean
}

interface PluginStoreOptions extends PathLookup {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  envStore?: string
  extractedStoreDir?: string
}

interface PluginBinOptions {
  isPackaged: boolean
  resourcesPath: string
}

/** 把随包工具目录放到 PATH 最前，供 `dsh plugin`、code-ui 和 dshmarket 复用。 */
export function prependPath(existing: string | undefined, prefix: string, platform = process.platform): string {
  const separator = platform === 'win32' ? ';' : ':'
  const parts = (existing ?? '').split(separator).filter(part => part !== '')
  const normalizedPrefix = platform === 'win32' ? prefix.toLowerCase() : prefix
  return [prefix, ...parts.filter(part => (platform === 'win32' ? part.toLowerCase() : part) !== normalizedPrefix)].join(separator)
}

/** 打包态使用 extraResources 中的离线仓库；开发态仅在本地装配目录存在时启用。 */
export function resolveBundledPluginStore(options: PluginStoreOptions): string | undefined {
  const exists = options.exists ?? existsSync
  const envStore = options.envStore !== undefined ? options.envStore : process.env.DSH_BUNDLED_PLUGIN_STORE
  const candidates = [
    envStore,
    options.extractedStoreDir,
    options.isPackaged ? join(options.resourcesPath, 'plugins', 'store') : undefined,
    options.isPackaged ? undefined : join(options.appPath, 'runtime-plugins', 'store'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find(candidate => exists(candidate))
}

/** 打包后 pnpm 与 node 同目录，开发态沿用系统 PATH。 */
export function resolvePluginBinDir(options: PluginBinOptions): string | undefined {
  if (!options.isPackaged) return undefined
  return join(options.resourcesPath, 'node')
}
