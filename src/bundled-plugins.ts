/** 桌面端随包 npm 目录。全部写入用户 profile，便于官方包和社区包在线升级。 */

export const SUITE_PACKAGE = '@michengai/dsh-codex-suite'

export interface BundledPlugin {
  packageName: string
  version: string
}

/** 官方 DSH 家族统一锁死的版本。打包和在线升级都按这一个号对齐。 */
export const OFFICIAL_DSH_VERSION = '0.1.6-alpha.1'
export const APPLY_PLUGIN_UPDATES_IPC = 'apply-plugin-updates'
/** 插件（codex-ui「关于」页）请求升级官方运行时。官方运行时不能原地改写正在运行的活动槽，
 * 该请求只转交桌面端 A/B 更新器处理：候选槽 → 影子验证 → 空闲切换 → 观察 → 失败回滚。 */
export const REQUEST_HARNESS_UPDATE_IPC = 'request-harness-update'

/** 官方 DSH 运行时。从 npm 安装，不依赖本地 deepseek-harness 源码。 */
export const OFFICIAL_RUNTIME: BundledPlugin = {
  packageName: '@deepseek-ai/dsh',
  version: OFFICIAL_DSH_VERSION,
}

/** 官方运行时启动必需、但 DSH 只声明为 peer 的包。auto-install-peers=false 时不会自动装上。 */
export const OFFICIAL_LAUNCH_PEERS: readonly BundledPlugin[] = [
  { packageName: '@deepseek-ai/cordis-plugin-group', version: '1.0.2' },
  { packageName: '@deepseek-ai/dsh-scope', version: OFFICIAL_DSH_VERSION },
  { packageName: '@deepseek-ai/dsh-timeout', version: OFFICIAL_DSH_VERSION },
  { packageName: '@deepseek-ai/dsh-invariants', version: OFFICIAL_DSH_VERSION },
]
/** 随桌面端离线仓库分发的社区插件与插件市场组件。
 *
 * 2026-09-14 修正：本清单长期陈旧（Codex UI 曾记为 0.2.102，而实机实际已到 1.1.x），
 * 会使离线包与全新安装把插件装回老版本。现按上游 v1.0.60 的目标版本对齐实机实际，
 * 并补齐此前缺失的 codex-pet / btw / simplify / code-review / pua / usage-billing。
 *
 * 刻意保留的一处例外：
 * - `dsh-better-sidebar`：本仓库把它作为**本地定制 link** 分发（`link:local/dsh-better-sidebar`），
 *   版本仍锁 0.18.0；升到上游的 0.19.1 会让基线升级把本地定制件换成 npm 包，
 *   等于覆盖用户定制。详见 `docs/03-技术架构/UI定制维护契约.md`。
 * - `@michengai/dsh-automation`：**0.1.42（上游 v1.0.60 目标）**。用户侧的自动化工作台补丁
 *   （`Customize/Automation-Workbench/build.mjs`）原以 `upstreamHash` 钉死上游 0.1.40 的
 *   `lib/client.js`，升 0.1.42 后补丁会以「Unsupported automation client」拒绝生效、UI 基线
 *   也会因该文件漂移而失败（2026-09-14 实测 0.1.42 = b4839315…、0.1.40 = 9319c634…）。
 *   经用户明确授权，已逐项核对 0.1.42 的三锚点（apply / runtime / 原生页面返回行）各出现 1 次、
 *   `import_react11` 别名未漂移、退役标记零残留后，把 `upstreamHash` 重钉到 0.1.42 并记录在案。
 */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  { packageName: '@michengai/dsh-codex-ui', version: '1.1.11' },
  { packageName: '@michengai/dsh-im-connect', version: '0.1.50' },
  { packageName: '@michengai/dsh-automation', version: '0.1.44' },
  { packageName: '@michengai/dsh-skills-manager', version: '0.1.52' },
  { packageName: '@michengai/dsh-archive-manager', version: '0.1.43' },
  { packageName: '@michengai/dsh-agency-agents', version: '0.1.43' },
  { packageName: '@michengai/dsh-codex-pet', version: '0.1.6' },
  { packageName: '@michengai/dsh-btw', version: '0.1.8' },
  { packageName: '@michengai/dsh-simplify', version: '0.1.5' },
  { packageName: '@michengai/dsh-code-review', version: '0.1.2' },
  { packageName: '@michengai/dsh-pua', version: '0.3.13' },
  { packageName: 'dsh-context', version: '0.53.0' },
  { packageName: 'dsh-better-sidebar', version: '0.18.0' },
  { packageName: 'dsh-mcp-connector', version: '0.2.49' },
  { packageName: '@kenz1117/dsh-ui-usage-billing', version: '1.4.0' },
  { packageName: 'dshmarket', version: '1.47.0' },
]

/** 离线 store 只放社区插件，官方运行时单独预装，避免安装包把同一份依赖打两遍。 */
export const STORE_PACKAGES: readonly BundledPlugin[] = BUNDLED_PLUGINS

/** 首次补种的完整清单：官方运行时加全部社区插件/市场组件。 */
export const SEEDED_PACKAGES: readonly BundledPlugin[] = [OFFICIAL_RUNTIME, ...BUNDLED_PLUGINS]

export const OFFICIAL_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

export function bundledPluginNames(): readonly string[] {
  return BUNDLED_PLUGINS.map(plugin => plugin.packageName)
}

export function seededPackageNames(): readonly string[] {
  return SEEDED_PACKAGES.map(plugin => plugin.packageName)
}

export function isOfficialDshPackage(packageName: string): boolean {
  return packageName === '@deepseek-ai/dsh' || packageName.startsWith('@deepseek-ai/dsh-')
}

export function isDeepSeekOfficialPackage(packageName: string): boolean {
  return packageName.startsWith('@deepseek-ai/')
}

export function officialDshVersionOverrides(version = OFFICIAL_DSH_VERSION): Record<string, string> {
  return {
    '@deepseek-ai/dsh': version,
    '@deepseek-ai/dsh-*': version,
  }
}

export function officialRuntimeDependencies(version = OFFICIAL_DSH_VERSION): Record<string, string> {
  return Object.fromEntries([
    [OFFICIAL_RUNTIME.packageName, version],
    ...OFFICIAL_LAUNCH_PEERS.map((plugin) => [
      plugin.packageName,
      plugin.packageName.startsWith('@deepseek-ai/dsh-') ? version : plugin.version,
    ]),
  ])
}

/** 按 SemVer 比较正式版和 alpha/beta/rc 预发布号。 */
export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string): { major: number; minor: number; patch: number; portable: number; prerelease?: string[] } | undefined => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
    if (match === null) return undefined
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      // 第 4 段是便携迭代号：基础版本完全跟随上游（上游永远 3 段），同基座重建 .1/.2 递增，默认 0。
      portable: match[4] === undefined ? 0 : Number(match[4]),
      ...(match[5] === undefined ? {} : { prerelease: match[5].split('.') }),
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === undefined || b === undefined) return left.localeCompare(right)
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch || a.portable - b.portable
  if (core !== 0) return core
  if (a.prerelease === undefined) return b.prerelease === undefined ? 0 : 1
  if (b.prerelease === undefined) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

export function planOfficialRuntimeTarget(input: {
  installed?: string
  aligned: boolean
  baked: string
  published?: string
  pending?: string
}): string | undefined {
  if (input.pending !== undefined && input.pending !== '') return input.pending
  const baseline = input.published !== undefined && compareReleaseVersions(input.published, input.baked) >= 0
    ? input.published
    : input.baked
  if (input.installed === undefined || input.installed === '') return baseline
  if (!input.aligned) return compareReleaseVersions(baseline, input.installed) >= 0 ? baseline : input.installed
  if (compareReleaseVersions(baseline, input.installed) > 0) return baseline
  return undefined
}

/** pnpm 11 默认拦截构建脚本；这些原生/prepare 依赖必须放行，否则装配会以 ERR_PNPM_IGNORED_BUILDS 失败。 */
export const ALLOWED_BUILD_PACKAGES = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
] as const

export function pnpmAllowBuildsManifest(): { allowBuilds: Record<string, true> } {
  return { allowBuilds: Object.fromEntries(ALLOWED_BUILD_PACKAGES.map(name => [name, true])) }
}

export function officialRuntimePnpmConfig(version = OFFICIAL_DSH_VERSION): {
  allowBuilds: Record<string, true>
  overrides: Record<string, string>
} {
  return { ...pnpmAllowBuildsManifest(), overrides: officialDshVersionOverrides(version) }
}

/** pnpm 只认 pnpm-workspace.yaml 里的 overrides；package.json 的 pnpm.overrides
 * 在 pnpm 11 已被忽略，且 overrides 的通配选择器（`@deepseek-ai/dsh-*`）实测不命中。
 * 官方家族的发版包把传递依赖写成 `^<同元组预发布>`，最高版语义会把整族拉到更新的 rc 上
 * （0.1.5-rc.1 根包 + 0.1.5-rc.2 传递包），因此官方运行时改用按发布时间解析。 */
export const OFFICIAL_RUNTIME_RESOLUTION_MODE = 'time-based'

export function pnpmWorkspaceYaml(autoInstallPeers = true, options: { resolutionMode?: string } = {}): string {
  const allow = ALLOWED_BUILD_PACKAGES.map(name => `  ${JSON.stringify(name)}: true`).join('\n')
  return [
    'packages:', '  - .', '',
    'nodeLinker: hoisted',
    'autoInstallPeers: ' + (autoInstallPeers ? 'true' : 'false'),
    ...(options.resolutionMode === undefined ? [] : ['resolutionMode: ' + options.resolutionMode]),
    'allowBuilds:', allow, '',
  ].join('\n')
}
