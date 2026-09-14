import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { writeTextFileAtomic, writeTextFileAtomicSync } from './atomic-file.js'
import {
  ALLOWED_BUILD_PACKAGES,
  BUNDLED_PLUGINS,
  compareReleaseVersions,
  OFFICIAL_DSH_VERSION,
  OFFICIAL_LAUNCH_PEERS,
  OFFICIAL_PROFILE_BUNDLES,
  OFFICIAL_RUNTIME,
  OFFICIAL_RUNTIME_RESOLUTION_MODE,
  officialRuntimeDependencies,
  officialRuntimePnpmConfig,
  pnpmWorkspaceYaml,
  SUITE_PACKAGE,
  isDeepSeekOfficialPackage,
  type BundledPlugin,
} from './bundled-plugins.js'
import { pnpmStoreOptions, prependPath } from './plugin-toolchain.js'
import { terminateProcessTree } from './process-control.js'
import { mergeProfileUpdates, officialRuntimeUpdateVersion, parsePendingUpdates, partitionPackageUpdates, resolvePendingUpdatesPath, type ProfilePackageUpdate } from './profile-updates.js'
import { copyPrebuiltOfficialRuntime } from './runtime-prebuilt.js'
import { activeQuarantinedProfileBundles } from './profile-quarantine.js'

export type SeedSkipReason = 'already-installed' | 'missing-store'

export type SeedPlan =
  | { action: 'skip'; reason: SeedSkipReason }
  | { action: 'add'; packages: readonly BundledPlugin[] }
  | { action: 'replace-suite'; packages: readonly BundledPlugin[] }

interface SeedPlanInput {
  catalog: readonly BundledPlugin[]
  declaredPackages: readonly string[]
  installedPackages: readonly string[]
  storeExists: boolean
}

interface SeedPnpmOptions {
  storeDir?: string
  offline?: boolean
  autoInstallPeers?: boolean
}

interface SeedOptions {
  nodeExecutable: string
  profileDir: string
  pluginStoreDir: string
  desktopRuntimeDir?: string
  prebuiltRuntimeDir?: string
  pathPrefix?: string
  pnpmEntry?: string
  catalog?: readonly BundledPlugin[]
  runner?: (args: readonly string[]) => Promise<void>
  timeoutMs?: number
  /**
   * 仅供旧版迁移/显式维修使用。正常桌面启动必须保持 false，官方运行时
   * 由 A/B 候选槽更新器处理，禁止在正在使用的目录中执行 pnpm install。
   */
  allowOfficialRuntimeUpdate?: boolean
}

export interface SeedResult {
  seeded: readonly string[]
  skipped?: SeedSkipReason
}

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

export function isOfficialProfileDependency(packageName: string): boolean {
  return isDeepSeekOfficialPackage(packageName)
}

export function communitySeedCatalog(catalog: readonly BundledPlugin[]): BundledPlugin[] {
  return catalog.filter((plugin) => !isOfficialProfileDependency(plugin.packageName))
}

/** 社区插件必须写进 profile dependencies 才能单独更新；套件改为拆成子插件。官方包不进 Web profile。 */
export function planBundledPluginSeed(input: SeedPlanInput): SeedPlan {
  if (!input.storeExists) return { action: 'skip', reason: 'missing-store' }
  const declared = new Set(input.declaredPackages)
  const community = communitySeedCatalog(input.catalog)
  const missing = community.filter((plugin) => !declared.has(plugin.packageName))
  const suitePresent = declared.has(SUITE_PACKAGE) || input.installedPackages.includes(SUITE_PACKAGE)
  if (suitePresent) return { action: 'replace-suite', packages: missing }
  if (missing.length === 0) return { action: 'skip', reason: 'already-installed' }
  return { action: 'add', packages: missing }
}

/** 已有 node_modules 的目录禁止改 store-dir，否则 pnpm 报 UNEXPECTED_STORE。 */
export function shouldUsePackagedStore(targetDir: string): boolean {
  return !existsSync(join(targetDir, 'node_modules'))
}

export function resolvePnpmStoreDir(targetDir: string, fallback?: string): string | undefined {
  try {
    const modulesStatePath = join(targetDir, 'node_modules', '.modules.yaml')
    let modulesState = readFileSync(modulesStatePath, 'utf8')
    let value = declaredPnpmStoreDir(modulesState)
    if (value) {
      const portableRoot = process.env.DSH_PORTABLE_ROOT
      if (portableRoot !== undefined && fallback !== undefined && isPathWithin(portableRoot, targetDir) && isPathWithin(portableRoot, fallback)) {
        const rebased = rebasePortablePnpmState(modulesState, portableRoot)
        if (rebased !== modulesState) {
          writeTextFileAtomicSync(modulesStatePath, rebased)
          modulesState = rebased
          value = declaredPnpmStoreDir(modulesState)
        }
      }
      return value
    }
  } catch {
    // 首次安装还没有 pnpm 状态文件。
  }
  return shouldUsePackagedStore(targetDir) && fallback ? fallback : undefined
}

/** pnpm 状态含绝对 store/virtualStore 路径，U 盘换盘符后统一重定位。 */
export function rebasePortablePnpmState(state: string, portableRoot: string): string {
  const declared = declaredPnpmStoreDir(state)
  if (declared === undefined) return state
  const normalizedDeclared = declared.replaceAll('\\', '/')
  const dataIndex = normalizedDeclared.toLocaleLowerCase().indexOf('/data/')
  const appIndex = normalizedDeclared.toLocaleLowerCase().indexOf('/app/')
  const layoutIndex = dataIndex >= 0 ? dataIndex : appIndex
  if (layoutIndex < 0) return state
  const oldRoot = normalizedDeclared.slice(0, layoutIndex).replace(/\/$/, '')
  const newRoot = portableRoot.replaceAll('\\', '/').replace(/\/$/, '')
  if (oldRoot.toLocaleLowerCase() === newRoot.toLocaleLowerCase()) return state
  try {
    const parsed = JSON.parse(state) as { storeDir?: unknown, virtualStoreDir?: unknown }
    for (const key of ['storeDir', 'virtualStoreDir'] as const) {
      const value = parsed[key]
      if (typeof value === 'string') parsed[key] = replacePathRoot(value, oldRoot, newRoot)
    }
    return JSON.stringify(parsed, undefined, 2) + '\n'
  } catch {
    // pnpm 旧版本写 YAML；保留原格式，仅替换绝对根目录。
  }
  const escaped = oldRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return state.replace(new RegExp(escaped, 'gi'), newRoot)
}

function declaredPnpmStoreDir(state: string): string | undefined {
  try {
    const value = (JSON.parse(state) as { storeDir?: unknown }).storeDir
    if (typeof value === 'string' && value !== '') return value
  } catch {
    // 兼容 pnpm 旧版 YAML 状态。
  }
  return /^storeDir:\s*(.+?)\s*$/m.exec(state)?.[1]?.replace(/^['"]|['"]$/g, '')
}

function replacePathRoot(value: string, oldRoot: string, newRoot: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized.toLocaleLowerCase().startsWith(oldRoot.toLocaleLowerCase() + '/')) return value
  const replaced = newRoot + normalized.slice(oldRoot.length)
  return value.includes('\\') ? replaced.replaceAll('/', '\\') : replaced
}

function isPathWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

export function isOfflineSeedRequested(environment: NodeJS.ProcessEnv = process.env): boolean {
  return [environment.DSH_DESKTOP_OFFLINE, environment.npm_config_offline, environment.NPM_CONFIG_OFFLINE]
    .some(value => /^(?:true|1)$/i.test(value?.trim() ?? ''))
}

export function buildSeedRemoveArgs(packageNames: readonly string[], targetDir: string, options: SeedPnpmOptions = {}): string[] {
  return [
    'remove',
    ...packageNames,
    `--dir=${targetDir}`,
    ...(options.offline === true || isOfflineSeedRequested() ? ['--offline'] : []),
    ...pnpmStoreOptions(options.storeDir),
    '--config.node-linker=hoisted',
    '--config.minimumReleaseAge=0',
    '--registry=https://registry.npmjs.org/',
  ]
}

export function buildSeedPluginArgs(packages: readonly BundledPlugin[], targetDir: string, options: SeedPnpmOptions = {}): string[] {
  return [
    'add',
    ...packages.map((plugin) => `${plugin.packageName}@${plugin.version}`),
    `--dir=${targetDir}`,
    ...pnpmStoreOptions(options.storeDir),
    ...(options.offline === true || isOfflineSeedRequested() ? ['--offline'] : []),
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=' + (options.autoInstallPeers === true ? 'true' : 'false'),
    '--config.minimumReleaseAge=0',
    '--registry=https://registry.npmjs.org/',
  ]
}

export function resolveWebProfileDir(home = process.env.DSH_HOME): string {
  return join(home ?? join(homedir(), '.dsh'), 'profiles', 'web')
}

export function ensureAutoInstallPeersEnabled(dir: string): void {
  const manifestPath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(manifestPath)) return
  const current = readFileSync(manifestPath, 'utf8')
  if (/\bautoInstallPeers:\s*true\b/.test(current)) return
  const next = current.includes('autoInstallPeers:')
    ? current.replace(/autoInstallPeers:\s*['"]?false['"]?/g, 'autoInstallPeers: true')
    : `autoInstallPeers: true\n${current}`
  writeFileSync(manifestPath, next, 'utf8')
}

/** Web profile 不能自动装官方 peer，否则会把官方 UI 包装进 profile 并盖掉运行时。 */
export function ensureAutoInstallPeersDisabled(dir: string): void {
  const manifestPath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(manifestPath)) return
  const current = readFileSync(manifestPath, 'utf8')
  if (/\bautoInstallPeers:\s*false\b/.test(current)) return
  const next = current.includes('autoInstallPeers:')
    ? current.replace(/autoInstallPeers:\s*['"]?true['"]?/g, 'autoInstallPeers: false')
    : `autoInstallPeers: false\n${current}`
  writeFileSync(manifestPath, next, 'utf8')
}

/** pnpm 11 removed onlyBuiltDependencies; keeping it beside allowBuilds makes
 * profile mutations fail before plugin activation. Migrate existing profiles
 * in place while preserving user-defined allowBuilds and other settings. */
export function ensurePnpm11BuildPolicy(dir: string): void {
  const manifestPath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(manifestPath)) return
  const current = readFileSync(manifestPath, 'utf8')
  let next = current.replace(/^onlyBuiltDependencies:\s*\r?\n(?:^[ \t]+-[^\r\n]*(?:\r?\n|$))*/m, '')
  const lines = next.split(/\r?\n/)
  const allowIndex = lines.findIndex(line => /^allowBuilds:\s*$/.test(line))
  if (allowIndex < 0) {
    const allowed = pnpmWorkspaceYaml().match(/^allowBuilds:\s*\n(?:^[ \t]+[^\r\n]+\r?\n?)*/m)?.[0]
    if (allowed !== undefined) next = `${next.trimEnd()}\n${allowed}`
  } else {
    let allowEnd = allowIndex + 1
    while (allowEnd < lines.length && (lines[allowEnd] === '' || /^[ \t]/.test(lines[allowEnd]))) allowEnd += 1
    const values = new Map<string, boolean>()
    for (const line of lines.slice(allowIndex + 1, allowEnd)) {
      const match = line.match(/^[ \t]+(.+?):\s*(true|false)\s*$/)
      if (!match) continue
      let key = match[1].trim()
      if (key.startsWith('"') && key.endsWith('"')) {
        try { key = JSON.parse(key) as string } catch {}
      } else if (key.startsWith("'") && key.endsWith("'")) {
        key = key.slice(1, -1).replace(/''/g, "'")
      }
      values.set(key, match[2] === 'true')
    }
    for (const packageName of ALLOWED_BUILD_PACKAGES) values.set(packageName, true)
    const normalized = [...values].map(([name, enabled]) => {
      const yamlName = /^[A-Za-z0-9_.-]+$/.test(name) ? name : JSON.stringify(name)
      return `  ${yamlName}: ${enabled ? 'true' : 'false'}`
    })
    lines.splice(allowIndex + 1, allowEnd - allowIndex - 1, ...normalized)
    next = lines.join('\n')
  }
  if (next !== current) writeFileSync(manifestPath, next, 'utf8')
}

export function resolveProfileDshEntry(dir: string): string {
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export function resolvePackageManifestPath(dir: string, packageName: string): string {
  return join(dir, 'node_modules', ...packageName.split('/'), 'package.json')
}

export function missingOfficialLaunchPeers(dir: string, peers = OFFICIAL_LAUNCH_PEERS): BundledPlugin[] {
  return peers.filter((plugin) => !existsSync(resolvePackageManifestPath(dir, plugin.packageName)))
}

/** 官方入口存在，且启动必需 peer 都已落地，才认为可以拉起 DSH。 */
export function isOfficialRuntimeLaunchable(dir: string): boolean {
  return existsSync(resolveProfileDshEntry(dir)) && missingOfficialLaunchPeers(dir).length === 0
}

export function readInstalledPackageVersion(dir: string, packageName: string): string | undefined {
  const manifestPath = resolvePackageManifestPath(dir, packageName)
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
  return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
}

export function officialRuntimeHasVersionLock(dir: string, version: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> }
    }
    const overrides = manifest.pnpm?.overrides ?? {}
    return overrides['@deepseek-ai/dsh'] === version && overrides['@deepseek-ai/dsh-*'] === version
  } catch {
    return false
  }
}

export function isOfficialRuntimeFamilyAligned(dir: string, version: string): boolean {
  if (!officialRuntimeHasVersionLock(dir, version)) return false
  if (readInstalledPackageVersion(dir, OFFICIAL_RUNTIME.packageName) !== version) return false
  const scopeRoot = join(dir, 'node_modules', '@deepseek-ai')
  try {
    const family = readdirSync(scopeRoot, { withFileTypes: true })
      .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith('dsh-'))
      .map(entry => `@deepseek-ai/${entry.name}`)
    return family.length > 0 && family.every(packageName => readInstalledPackageVersion(dir, packageName) === version)
  } catch {
    return false
  }
}

export function writeOfficialRuntimeManifest(runtimeDir: string, version = OFFICIAL_DSH_VERSION): void {
  const manifestPath = join(runtimeDir, 'package.json')
  let current: { name?: string; private?: boolean; dependencies?: Record<string, string>; pnpm?: Record<string, unknown> } = {}
  if (existsSync(manifestPath)) {
    current = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof current
  }
  const next = {
    name: current.name ?? 'dsh-desktop-runtime',
    private: true,
    pnpm: officialRuntimePnpmConfig(version),
    dependencies: {
      ...(current.dependencies ?? {}),
      ...officialRuntimeDependencies(version),
    },
  }
  writeTextFileAtomicSync(manifestPath, JSON.stringify(next, undefined, 2) + '\n')
}

/** 活动槽的描述性清单必须跟随实际安装的家族版本。历史缺陷：旧桥接在活动槽里原地
 * 写入新版本清单，留下「清单 0.1.5-rc.2 + node_modules 0.1.2-rc.1」的坏槽——启动检查
 * 只验证入口与 peer 存在，指纹只覆盖 lock 与家族清单，二者都发现不了它，槽会带着错误
 * 版本号一路用下去。家族版本单一且可读时把清单拉回实际版本（只改描述性清单，不动物化
 * 依赖，所以指纹语义不变）；家族本身混用时保持原样，交由 A/B 切换门禁拒绝。
 * 返回是否发生了修复。 */
export function reconcileOfficialRuntimeManifest(runtimeDir: string): boolean {
  const installed = installedOfficialRuntimeFamilyVersion(runtimeDir)
  if (installed === undefined) return false
  // 只改已存在的清单：指纹槽里凭空造文件会打破「槽是不可变制品」的既有约束。
  if (!existsSync(join(runtimeDir, 'package.json'))) return false
  // 家族解析模式是另一处「已存在的目录永远补不上」的地雷，一并幂等确保。
  ensureRuntimeResolutionMode(runtimeDir)
  if (officialRuntimeHasVersionLock(runtimeDir, installed)
    && readDeclaredOfficialRuntimeVersion(runtimeDir) === installed) {
    return false
  }
  writeOfficialRuntimeManifest(runtimeDir, installed)
  return true
}

/** 家族安装版本必须唯一：混用时无法判断该以谁为准，返回 undefined 让调用方跳过。 */
function installedOfficialRuntimeFamilyVersion(dir: string): string | undefined {
  const versions = new Set<string>()
  for (const packageName of [OFFICIAL_RUNTIME.packageName, ...installedOfficialFamilyNames(dir)]) {
    const version = readInstalledPackageVersion(dir, packageName)
    if (version === undefined || !isExactVersion(version)) return undefined
    versions.add(version)
  }
  return versions.size === 1 ? [...versions][0] : undefined
}

function installedOfficialFamilyNames(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'node_modules', '@deepseek-ai'), { withFileTypes: true })
      .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith('dsh-'))
      .map(entry => `@deepseek-ai/${entry.name}`)
  } catch {
    return []
  }
}

function readDeclaredOfficialRuntimeVersion(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return manifest.dependencies?.[OFFICIAL_RUNTIME.packageName]
  } catch {
    return undefined
  }
}

function isExactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
}

export function officialRuntimeInstallArgs(runtimeDir: string, storeDir?: string): string[] {
  return [
    'install',
    '--dir=' + runtimeDir,
    '--prod',
    '--no-frozen-lockfile',
    ...(isOfflineSeedRequested() ? ['--offline'] : []),
    ...pnpmStoreOptions(storeDir),
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=true',
    '--config.minimumReleaseAge=0',
    // 与 pnpm-workspace.yaml 的 resolutionMode 同一设置，双写保证任何入口都按发布时间解析。
    '--config.resolution-mode=' + OFFICIAL_RUNTIME_RESOLUTION_MODE,
    '--registry=https://registry.npmjs.org/',
  ]
}

/** 官方运行时工作区必须声明 resolutionMode，否则官方家族的同元组预发布会被最高版语义
 * 拆成混用（根包 rc.1 + 传递包 rc.2），候选槽会在家族对齐门禁处被判失败。
 * 已存在的文件只补/改这一行，不动用户或其他流程写入的内容。 */
export function ensureRuntimeResolutionMode(runtimeDir: string): void {
  const workspacePath = join(runtimeDir, 'pnpm-workspace.yaml')
  const desired = `resolutionMode: ${OFFICIAL_RUNTIME_RESOLUTION_MODE}`
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, pnpmWorkspaceYaml(true, { resolutionMode: OFFICIAL_RUNTIME_RESOLUTION_MODE }), 'utf8')
    return
  }
  const current = readFileSync(workspacePath, 'utf8')
  const next = /^resolutionMode:\s*/m.test(current)
    ? current.replace(/^resolutionMode:[^\r\n]*$/m, desired)
    : `${current.trimEnd()}\n${desired}\n`
  if (next !== current) writeFileSync(workspacePath, next, 'utf8')
}

export async function applyOfficialRuntimeVersion(options: SeedOptions, version: string): Promise<string> {
  const runtimeDir = options.desktopRuntimeDir
  if (runtimeDir === undefined) throw new Error('未配置官方运行时目录，无法在线升级官方包。')
  await mkdir(runtimeDir, { recursive: true })
  writeOfficialRuntimeManifest(runtimeDir, version)
  ensureRuntimeResolutionMode(runtimeDir)
  ensureAutoInstallPeersEnabled(runtimeDir)
  const runner = options.runner ?? ((pluginArgs) => runPnpm(options, pluginArgs))
  await runner(officialRuntimeInstallArgs(runtimeDir, resolvePnpmStoreDir(runtimeDir, options.pluginStoreDir)))
  if (!isOfficialRuntimeLaunchable(runtimeDir)) {
    throw new Error('官方运行时升级到 ' + version + ' 后仍无法启动。')
  }
  return version
}

export async function stripOfficialProfileDependencies(profileDir: string): Promise<string[]> {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const removed: string[] = []
  const nextDependencies = { ...(manifest.dependencies ?? {}) }
  for (const packageName of Object.keys(nextDependencies)) {
    if (!isOfficialProfileDependency(packageName)) continue
    delete nextDependencies[packageName]
    removed.push(packageName)
  }
  const nextBundles = [...(manifest.dsh?.profile?.bundles ?? [])].filter((name) => {
    if (name === SUITE_PACKAGE) return false
    if (!isOfficialProfileDependency(name)) return true
    return (OFFICIAL_PROFILE_BUNDLES as readonly string[]).includes(name)
  })
  const officialModules = join(profileDir, 'node_modules', '@deepseek-ai')
  if (existsSync(officialModules)) {
    for (const entry of await readdir(officialModules, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      await rm(join(officialModules, entry.name), { recursive: true, force: true })
    }
    if (!removed.includes('@deepseek-ai')) removed.push('@deepseek-ai')
  }
  if (removed.length === 0 && nextBundles.join('\0') === (manifest.dsh?.profile?.bundles ?? []).join('\0')) return []
  manifest.dependencies = nextDependencies
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: nextBundles } }
  await writeTextFileAtomic(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return removed
}

export async function applyPendingProfileUpdates(options: SeedOptions): Promise<readonly string[]> {
  const pendingPath = resolvePendingUpdatesPath(options.profileDir)
  let pending: ProfilePackageUpdate[] = []
  try {
    pending = parsePendingUpdates(await readFile(pendingPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const { community } = partitionPackageUpdates(pending)
  const declared = await readDeclaredPackageVersions(options.profileDir)
  const installed = await readInstalledPackageVersions(options.profileDir, [...new Set([
    ...declared.map((item) => item.packageName),
    ...community.map((item) => item.packageName),
  ])])
  // 旧客户端留下的待更新清单可能指向比磁盘上更旧的版本。直接合并会把已经装好的插件降级
  // （并连带把它的依赖一起降级），所以以「待更新目标」与「实际安装版本」中的较高者为准。
  // 刻意不用随包清单当版本地板：本仓库的随包插件矩阵滞后于实际部署矩阵（便携版运行时走
  // 自研 A/B 通道），拿它当基准会反过来覆盖用户与市场的显式升级选择。
  const installedVersions = new Map(installed.map((item) => [item.packageName, item.version]))
  const compatiblePending = community.map((plugin) => {
    const current = installedVersions.get(plugin.packageName)
    return current !== undefined && compareReleaseVersions(plugin.version, current) < 0
      ? { ...plugin, version: current }
      : plugin
  })
  const updates = mergeProfileUpdates({ pending: compatiblePending, declared, installed })
  const applied: string[] = []
  const runner = options.runner ?? ((args) => runPnpm(options, args))
  if (updates.length > 0) {
    const storeDir = resolvePnpmStoreDir(options.profileDir, options.pluginStoreDir)
    await runner(buildSeedPluginArgs(updates, options.profileDir, storeDir === undefined ? {} : { storeDir }))
    applied.push(...updates.map((item) => item.packageName))
  }
  const officialVersion = officialRuntimeUpdateVersion(pending)
  if (officialVersion !== undefined && options.desktopRuntimeDir !== undefined && options.allowOfficialRuntimeUpdate === true) {
    applied.push(await applyOfficialRuntimeVersion(options, officialVersion))
  }
  // 官方条目绝不回写：profile 安装路径明确拒绝官方包，官方运行时的唯一权威是桌面端
  // A/B 更新器（候选槽 + 影子验证 + 空闲切换 + 失败回滚）。旧版「关于」页会先写 pending
  // 再发起安装、失败时不回滚，回写就会把一次失败点击留成永远无法应用的幽灵待更新项，
  // 在之后的每次插件更新里被反复合并带回。这里直接丢弃，桌面更新器自行发现新版本。
  if (existsSync(pendingPath)) await rm(pendingPath, { force: true })
  return applied
}

async function readDeclaredPackageVersions(profileDir: string): Promise<ProfilePackageUpdate[]> {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return Object.entries(manifest.dependencies ?? {})
      .filter(([packageName, version]) => !isOfficialProfileDependency(packageName) && typeof version === 'string')
      .map(([packageName, version]) => ({ packageName, version }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function readInstalledPackageVersions(profileDir: string, names: readonly string[]): Promise<Array<{ packageName: string; version?: string }>> {
  const installed: Array<{ packageName: string; version?: string }> = []
  for (const packageName of names) {
    const manifestPath = resolvePackageManifestPath(profileDir, packageName)
    if (!existsSync(manifestPath)) {
      installed.push({ packageName })
      continue
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    installed.push({ packageName, version: typeof manifest.version === 'string' ? manifest.version : undefined })
  }
  return installed
}

export async function seedBundledPlugins(options: SeedOptions): Promise<SeedResult> {
  const seeded: string[] = []
  if (options.desktopRuntimeDir !== undefined) {
    const official = await seedOfficialRuntime(options)
    seeded.push(...official)
  }
  await stripOfficialProfileDependencies(options.profileDir)
  const community = await seedCommunityPlugins(options)
  seeded.push(...community.seeded)
  const extraDirs = options.desktopRuntimeDir === undefined ? [] : [options.desktopRuntimeDir]
  await finalizeProfileBundlesAfterInstall(options.profileDir, extraDirs)
  if (seeded.length === 0) return { seeded, skipped: community.skipped ?? 'already-installed' }
  return { seeded }
}

async function seedOfficialRuntime(options: SeedOptions): Promise<readonly string[]> {
  const runtimeDir = options.desktopRuntimeDir
  if (runtimeDir === undefined) return []
  // A/B 候选槽一旦通过校验就视为不可变制品。启动补种不得再修改它；
  // 损坏时由运行时指针回退到上一槽，而不是在故障槽内现场修包。
  if (existsSync(join(runtimeDir, '.dsh-runtime-fingerprint'))) {
    if (!isOfficialRuntimeLaunchable(runtimeDir)) throw new Error('不可变 DSH 运行时槽校验失败，拒绝原地维修。')
    // 指纹只覆盖 lock 与家族清单，入口存在也不代表清单写的版本是真的；把被历史缺陷
    // 半改写的描述性清单拉回实际安装版本，避免错误版本号一路传到「关于」页与更新器。
    reconcileOfficialRuntimeManifest(runtimeDir)
    return []
  }
  const seeded: string[] = []
  ensureAutoInstallPeersEnabled(runtimeDir)
  if (options.prebuiltRuntimeDir !== undefined && copyPrebuiltOfficialRuntime(options.prebuiltRuntimeDir, runtimeDir) === 'copied') {
    seeded.push(OFFICIAL_RUNTIME.packageName)
  }
  if (!existsSync(resolveProfileDshEntry(runtimeDir))) {
    await ensureRuntimeScaffold(runtimeDir)
    const storeDir = resolvePnpmStoreDir(runtimeDir, existsSync(options.pluginStoreDir) ? options.pluginStoreDir : undefined)
    const useStore = storeDir !== undefined
    const args = buildSeedPluginArgs([OFFICIAL_RUNTIME], runtimeDir, {
      autoInstallPeers: true,
      ...(useStore ? { storeDir, offline: true } : {}),
    })
    const runner = options.runner ?? ((pluginArgs) => runPnpm(options, pluginArgs))
    try {
      await runner(args)
    } catch (error) {
      if (useStore && !isOfflineSeedRequested()) {
        await runner(buildSeedPluginArgs([OFFICIAL_RUNTIME], runtimeDir, { autoInstallPeers: true }))
      } else {
        throw error
      }
    }
    if (!existsSync(resolveProfileDshEntry(runtimeDir))) throw new Error('官方 DSH 运行时补种后仍未找到入口。')
    seeded.push(OFFICIAL_RUNTIME.packageName)
  }
  seeded.push(...await ensureOfficialLaunchPeers(options, runtimeDir))
  return seeded
}

async function ensureOfficialLaunchPeers(options: SeedOptions, targetDir: string): Promise<readonly string[]> {
  ensureAutoInstallPeersEnabled(targetDir)
  const missing = missingOfficialLaunchPeers(targetDir)
  if (missing.length === 0) return []
  const storeDir = resolvePnpmStoreDir(targetDir, existsSync(options.pluginStoreDir) ? options.pluginStoreDir : undefined)
  const useStore = storeDir !== undefined
  const args = buildSeedPluginArgs([OFFICIAL_RUNTIME, ...missing], targetDir, {
    autoInstallPeers: true,
    ...(useStore ? { storeDir, offline: true } : {}),
  })
  const runner = options.runner ?? ((pluginArgs) => runPnpm(options, pluginArgs))
  try {
    await runner(args)
  } catch (error) {
    if (useStore && !isOfflineSeedRequested()) await runner(buildSeedPluginArgs([OFFICIAL_RUNTIME, ...missing], targetDir, { autoInstallPeers: true }))
    else throw error
  }
  const stillMissing = missingOfficialLaunchPeers(targetDir)
  if (stillMissing.length > 0) {
    throw new Error(`官方运行时缺少启动依赖：${stillMissing.map((plugin) => plugin.packageName).join('、')}`)
  }
  return missing.map((plugin) => plugin.packageName)
}

/** pnpm 会把被 allowBuilds 拦下的构建脚本记进 `node_modules/.modules.yaml` 的 `ignoredBuilds`。
 *  历史 profile 一旦记下「忽略 node-pty / protobufjs 构建」，此后即使清单补上 allowBuilds，
 *  补种计划也会因为「版本齐全」判定为 already-installed：包装得上，原生构建却永远缺。
 *  只认随包 pnpm 11 写出的 JSON 状态；旧版 YAML 不属于这种残留状态。 */
export function needsIgnoredBuildRepair(modulesState: string): boolean {
  if (!modulesState.trimStart().startsWith('{')) return false
  let state: unknown
  try {
    state = JSON.parse(modulesState) as unknown
  } catch {
    return false
  }
  if (state === null || typeof state !== 'object' || !('ignoredBuilds' in state)) return false
  const ignored = (state as { ignoredBuilds?: unknown }).ignoredBuilds
  if (!Array.isArray(ignored)) return false
  return ignored.some((entry) => typeof entry === 'string'
    && ALLOWED_BUILD_PACKAGES.some((name) => entry.startsWith(`${name}@`)))
}

/** 让被历史拦下的随包构建真正跑一遍：沿用 profile 已记录的仓库重装同版本包。
 *  与上游实现的有意差异：失败只告警不抛出。进入这条分支说明 profile 本身已可启动，
 *  一次机会性的构建恢复不该把它变成启动失败。 */
async function repairIgnoredBundledBuilds(
  options: SeedOptions,
  catalog: readonly BundledPlugin[],
  runner: (args: readonly string[]) => Promise<void>,
): Promise<void> {
  const statePath = join(options.profileDir, 'node_modules', '.modules.yaml')
  if (catalog.length === 0 || !existsSync(statePath)) return
  if (!needsIgnoredBuildRepair(await readFile(statePath, 'utf8'))) return
  try {
    // 已有 node_modules 的目录禁止改用安装包 store（pnpm 会报 UNEXPECTED_STORE），只沿用
    // profile 自己记录的仓库；显式离线请求由 buildSeedPluginArgs 统一附加 --offline。
    const storeDir = resolvePnpmStoreDir(options.profileDir)
    const installed = await readInstalledPackageVersions(options.profileDir, catalog.map((plugin) => plugin.packageName))
    const packages = catalog.map((plugin) => ({
      ...plugin,
      version: installed.find((item) => item.packageName === plugin.packageName)?.version ?? plugin.version,
    }))
    await runner(buildSeedPluginArgs(packages, options.profileDir, storeDir === undefined ? {} : { storeDir }))
  } catch (error) {
    console.warn('内置插件构建许可恢复失败，保持现有 profile。', error)
  }
}

async function seedCommunityPlugins(options: SeedOptions): Promise<SeedResult> {
  await ensureProfileScaffold(options.profileDir)
  const { declared, installed } = await readProfilePluginNames(options.profileDir)
  const catalog = options.catalog ?? BUNDLED_PLUGINS
  const plan = planBundledPluginSeed({
    catalog,
    declaredPackages: declared,
    installedPackages: installed,
    storeExists: existsSync(options.pluginStoreDir),
  })
  const runner = options.runner ?? ((pluginArgs) => runPnpm(options, pluginArgs))
  if (plan.action === 'skip') {
    await repairIgnoredBundledBuilds(options, communitySeedCatalog(catalog), runner)
    return { seeded: [], skipped: plan.reason }
  }
  const storeDir = resolvePnpmStoreDir(options.profileDir, existsSync(options.pluginStoreDir) ? options.pluginStoreDir : undefined)
  const useStore = storeDir !== undefined
  const storeOptions = useStore ? { storeDir, offline: true } : {}
  if (plan.packages.length > 0) {
    if (useStore) await seedPackagedPluginLockfile(options.profileDir, storeDir)
    const args = buildSeedPluginArgs(plan.packages, options.profileDir, storeOptions)
    try {
      await runner(args)
    } catch (error) {
      if (useStore && !isOfflineSeedRequested()) await runner(buildSeedPluginArgs(plan.packages, options.profileDir, {}))
      else throw error
    }
  }
  if (plan.action === 'replace-suite') {
    try {
      await runner(buildSeedRemoveArgs([SUITE_PACKAGE], options.profileDir, storeOptions))
    } catch (error) {
      if (useStore && !isOfflineSeedRequested()) await runner(buildSeedRemoveArgs([SUITE_PACKAGE], options.profileDir, {}))
      else throw error
    }
  }
  await reconcileProfileBundles(options.profileDir)
  return { seeded: plan.packages.map((plugin) => plugin.packageName) }
}

/** Use the build's resolution only for pristine profiles; never replace user locks. */
export async function seedPackagedPluginLockfile(profileDir: string, storeDir: string): Promise<boolean> {
  const target = join(profileDir, 'pnpm-lock.yaml')
  if (existsSync(target) || existsSync(join(profileDir, 'node_modules'))) return false
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  if (['dependencies', 'devDependencies', 'optionalDependencies'].some(key => Object.keys(manifest[key] ?? {}).length > 0)) return false
  const source = join(storeDir, 'dsh-store-lock.yaml')
  let metadata
  try { metadata = await lstat(source) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false // legacy package
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024) throw new Error('内置插件锁文件不合法。')
  const staging = await mkdtemp(join(profileDir, '.seed-lock-'))
  const temporary = join(staging, 'pnpm-lock.yaml')
  try {
    await writeFile(temporary, await readFile(source), { flag: 'wx' })
    // Atomic exclusive publication: a concurrent/user-created lock always wins.
    try { await link(temporary, target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    return true
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    await rmdir(staging)
  }
}

export async function ensureProfileScaffold(profileDir: string): Promise<void> {
  await mkdir(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    await writeTextFileAtomic(manifestPath, `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...OFFICIAL_PROFILE_BUNDLES] } },
    }, undefined, 2)}\n`)
  }
  if (!existsSync(join(profileDir, 'cordis.patch.yml'))) {
    await writeFile(join(profileDir, 'cordis.patch.yml'), PROFILE_PATCH_TEMPLATE, 'utf8')
  }
  if (!existsSync(join(profileDir, 'pnpm-workspace.yaml'))) {
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), pnpmWorkspaceYaml(false), 'utf8')
  }
  ensurePnpm11BuildPolicy(profileDir)
  ensureAutoInstallPeersDisabled(profileDir)
}

async function ensureRuntimeScaffold(runtimeDir: string): Promise<void> {
  await mkdir(runtimeDir, { recursive: true })
  if (!existsSync(join(runtimeDir, 'package.json'))) {
    writeOfficialRuntimeManifest(runtimeDir)
  }
  if (!existsSync(join(runtimeDir, 'pnpm-workspace.yaml'))) {
    await writeFile(
      join(runtimeDir, 'pnpm-workspace.yaml'),
      pnpmWorkspaceYaml(true, { resolutionMode: OFFICIAL_RUNTIME_RESOLUTION_MODE }),
      'utf8',
    )
  } else {
    ensureRuntimeResolutionMode(runtimeDir)
  }
  ensurePnpm11BuildPolicy(runtimeDir)
}

export async function reconcileProfileBundles(profileDir: string, packageNames?: readonly string[]): Promise<string[]> {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [...OFFICIAL_PROFILE_BUNDLES])].filter((name) => {
    if (name === SUITE_PACKAGE) return false
    if (!isOfficialProfileDependency(name)) return true
    return (OFFICIAL_PROFILE_BUNDLES as readonly string[]).includes(name)
  })
  const marketDisabled = readMarketDisabledPackages(profileDir)
  const quarantined = await activeQuarantinedProfileBundles(profileDir)
  let changed = false
  const allowed = packageNames === undefined ? undefined : new Set(packageNames)
  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    if (allowed !== undefined && !allowed.has(packageName)) continue
    if (isOfficialProfileDependency(packageName) || packageName === SUITE_PACKAGE) continue
    if (marketDisabled.has(packageName)) continue
    if (quarantined.has(packageName)) continue
    if (!hasBundleManifest(profileDir, packageName) || bundles.includes(packageName)) continue
    bundles.push(packageName)
    changed = true
  }
  if (changed) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    await writeTextFileAtomic(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  }
  return bundles
}

/** 插件市场已禁用的 bundle 不能在桌面启动补种时被重新激活。 */
function readMarketDisabledPackages(profileDir: string): ReadonlySet<string> {
  try {
    const state = JSON.parse(readFileSync(join(profileDir, '.dsh-market', 'state.json'), 'utf8')) as { disabled?: unknown }
    return new Set(Array.isArray(state.disabled) ? state.disabled.filter((name): name is string => typeof name === 'string') : [])
  } catch {
    return new Set()
  }
}

/** 未声明或缺包的社区 bundle 会让 DSH 直接退出；启动前摘掉，官方 bundle 仍由运行时解析。 */
export async function pruneMissingProfileBundles(profileDir: string, extraDirs: readonly string[] = []): Promise<string[]> {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const current = manifest.dsh?.profile?.bundles ?? []
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  const next = current.filter((packageName) => (OFFICIAL_PROFILE_BUNDLES as readonly string[]).includes(packageName)
    // Internal package name: keep synchronized with DESKTOP_BRIDGE_PACKAGE in desktop-host.ts.
    || (packageName === 'dsh-desktop-bridge' && isResolvableProfileBundle(profileDir, packageName, extraDirs))
    || (dependencies.has(packageName) && isResolvableProfileBundle(profileDir, packageName, extraDirs)))
  const removed = current.filter((packageName) => !next.includes(packageName))
  if (removed.length === 0) return []
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
  await writeTextFileAtomic(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return removed
}

/** 先认磁盘上的包，再改 bundle 列表：缺包的先摘掉，装上的再补进清单。 */
export async function finalizeProfileBundlesAfterInstall(profileDir: string, extraDirs: readonly string[] = [], packageNames?: readonly string[]): Promise<{ removed: string[]; bundles: string[] }> {
  const removed = await pruneMissingProfileBundles(profileDir, extraDirs)
  const bundles = await reconcileProfileBundles(profileDir, packageNames)
  return { removed, bundles }
}

export function isResolvableProfileBundle(profileDir: string, packageName: string, extraDirs: readonly string[] = []): boolean {
  if ((OFFICIAL_PROFILE_BUNDLES as readonly string[]).includes(packageName)) return true
  return [profileDir, ...extraDirs].some((dir) => existsSync(join(dir, 'node_modules', ...packageName.split('/'), 'package.json')))
}

function hasBundleManifest(profileDir: string, packageName: string): boolean {
  const manifestPath = join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(manifestPath)) return false
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
  return typeof manifest.dsh?.bundle?.patch === 'string'
}

async function readProfilePluginNames(profileDir: string): Promise<{ declared: string[]; installed: string[] }> {
  const declared = await readDeclaredPackages(profileDir)
  const names = [...declared, ...BUNDLED_PLUGINS.map((plugin) => plugin.packageName), SUITE_PACKAGE]
  return { declared, installed: await readInstalledPackages(profileDir, names) }
}

async function readDeclaredPackages(profileDir: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    return [...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...(manifest.dsh?.profile?.bundles ?? []),
    ])]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function readInstalledPackages(profileDir: string, names: readonly string[]): Promise<string[]> {
  const installed: string[] = []
  for (const name of new Set(names)) {
    if (existsSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))) installed.push(name)
  }
  return installed
}

function runPnpm(options: SeedOptions, args: readonly string[]): Promise<void> {
  const pnpmEntry = options.pnpmEntry ?? (options.pathPrefix === undefined ? undefined : join(options.pathPrefix, 'pnpm-package', 'bin', 'pnpm.cjs'))
  if (pnpmEntry === undefined) throw new Error('未找到随包 pnpm，无法补种官方运行时和社区插件。')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.nodeExecutable, [pnpmEntry, ...args], {
      cwd: dirname(pnpmEntry),
      env: {
        ...process.env,
        CI: 'true',
        DSH_HOME: resolve(options.profileDir, '..', '..'),
        ...(options.pathPrefix === undefined ? {} : { PATH: prependPath(process.env.PATH, options.pathPrefix) }),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    let timeoutError: Error | undefined
    let killDeadline: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killDeadline)
      if (error === undefined) resolvePromise()
      else reject(error)
    }
    const timeout = setTimeout(() => {
      timeoutError = new Error('pnpm 操作超时，已终止子进程。')
      terminateProcessTree(child)
      killDeadline = setTimeout(() => finish(timeoutError), 2_000)
    }, options.timeoutMs ?? 300_000)
    timeout.unref?.()
    const collect = (chunk: Buffer): void => { output = (output + String(chunk)).slice(-8_000) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => { finish(new Error('无法启动随包 pnpm 补种命令。')) })
    child.once('exit', code => {
      if (timeoutError !== undefined) {
        finish(timeoutError)
        return
      }
      if (code === 0) {
        finish()
        return
      }
      finish(new Error(output.replace(/\s+/g, ' ').trim() || '内置插件补种失败。'))
    })
  })
}
