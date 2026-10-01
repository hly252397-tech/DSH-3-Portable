/** 桌面端随包 npm 目录。全部写入用户 profile，便于官方包和社区包在线升级。 */

export const SUITE_PACKAGE = '@michengai/dsh-codex-suite'

export interface BundledPlugin {
  packageName: string
  version: string
}

/** 官方 DSH 家族统一锁死的版本。打包和在线升级都按这一个号对齐。 */
export const OFFICIAL_DSH_VERSION = '0.2.0-rc.2'
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
  { packageName: '@deepseek-ai/cordis-plugin-group', version: '1.0.4' },
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
 * 本地定制与版本例外：
 * - `dsh-better-sidebar`：本仓库把它作为**本地定制 link** 分发（`link:local/dsh-better-sidebar`），
 *   下表 0.21.1 是 npm 离线仓库/全新安装基线，不是本地定制件的版本。
 *   已有 link:/file:/portal: 声明由 plugin-seed 的 localLinkPackages 排除，不参与版本升级；
 *   本地定制件自报 0.18.0-alpha.0 不需改号，更不能用 npm 包替换。详见 UI 定制维护契约。
 * - `@michengai/dsh-automation`：I023/31 已退役旧工作台注入，保留原生定时任务页；
 *   旧插桩锚点不能继续作为锁旧版本的理由。更新后仍须验证原生入口及原有数据。
 */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  // 2026-09-29 吸收上游 v1.0.77：该版同时把下列 12 个社区插件各升了一档，并删掉了
  // `dsh-mcp-connector`。**本次刻意不跟**：① 用户 2026-09-29 的方针是内核与插件各自独立更新，
  // 插件不是这次要拉的东西；② 下列版本号是"离线仓库/全新安装基线"，改了会让全新安装拿到
  // 本机从未实测过的组合，而本机 profile 的实际版本并不由本清单决定；③ codex-ui 已有用户批准的
  // 暂留版本（见下）。插件升级另开一轮，逐个实测后再改这里。
  // 2026-09-28 用户批准暂留已验证版本；1.1.20 被 rc.2 的 peer 兼容门禁拒绝，禁止自动豁免。
  { packageName: '@michengai/dsh-codex-ui', version: '1.1.18' },
  { packageName: '@michengai/dsh-im-connect', version: '0.1.55' },
  { packageName: '@michengai/dsh-automation', version: '0.1.51' },
  { packageName: '@michengai/dsh-skills-manager', version: '1.1.4' },
  { packageName: '@michengai/dsh-archive-manager', version: '1.0.5' },
  { packageName: '@michengai/dsh-agency-agents', version: '1.0.5' },
  { packageName: '@michengai/dsh-codex-pet', version: '0.1.10' },
  { packageName: '@michengai/dsh-btw', version: '0.1.13' },
  { packageName: '@michengai/dsh-simplify', version: '0.1.10' },
  { packageName: '@michengai/dsh-code-review', version: '0.1.7' },
  { packageName: '@michengai/dsh-pua', version: '0.3.18' },
  { packageName: 'dsh-better-sidebar', version: '0.21.1' },
  // 0.2.59 两个刷新模块与已审阅 0.2.58 字节一致；补丁版本门已同步审查。
  { packageName: 'dsh-mcp-connector', version: '0.2.59' },
  { packageName: 'dshmarket', version: '1.66.2' },
]

/** 离线 store 只放社区插件，官方运行时单独预装，避免安装包把同一份依赖打两遍。
 * 上游 v1.0.76 起退役插件不再进离线仓库（dsh-context、usage-billing 不随包），
 * 旧 Profile lockfile 的引用由在线回退通道兜底。 */
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
      // 打包链路写不了 4 段版本（electron-builder 把 1.0.65.1 写成 ProductVersion 1.0.6.0，暂存校验拒收），
      // 实际发布用 +build.N 构建元数据后缀，故 + 后缀在此有意忽略（1.0.65+build.1 与 1.0.65 同版）。
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

export function pnpmAllowBuildsManifest(): { onlyBuiltDependencies: string[]; allowBuilds: Record<string, true> } {
  return { onlyBuiltDependencies: [...ALLOWED_BUILD_PACKAGES], allowBuilds: Object.fromEntries(ALLOWED_BUILD_PACKAGES.map(name => [name, true])) }
}

export function officialRuntimePnpmConfig(version = OFFICIAL_DSH_VERSION): {
  onlyBuiltDependencies: string[]
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

/** 按发布时间解析会撞上 pnpm 的成熟期门槛：同一个 rc 版本内各包发布时间并不一致，
 * 比 cutoff 晚发布的那一个（0.2.0-rc.2 是 `dsh-client-ui-settings-account`，晚约 20 分钟）
 * 会被判 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，整次候选装配直接失败。
 * `--config.minimumReleaseAge=0` 救不了它（真实参数下实测仍然失败），pnpm 给的出口就是
 * `minimumReleaseAgeExclude`。
 *
 * 按命名空间整体豁免而不是逐包列举：家族包随版本增删，硬编码清单下个版本就得改代码，
 * 与「新版本自动拉取升级」的要求直接冲突。官方家族本身已由受信版本表 + npm integrity
 * + 家族对齐门禁把住，成熟期门槛在这里是纯粹的误伤。 */
export const OFFICIAL_RUNTIME_MINIMUM_RELEASE_AGE_EXCLUDE: readonly string[] = ['@deepseek-ai/*']

/** 官方运行时工作区的解析策略。生成与「补齐既有目录」两条路径共用同一份，
 * 避免出现「新建的槽有豁免、历史槽没有」这种只在升级时才暴露的分裂。 */
export const OFFICIAL_RUNTIME_RESOLUTION_POLICY = {
  resolutionMode: OFFICIAL_RUNTIME_RESOLUTION_MODE,
  minimumReleaseAgeExclude: OFFICIAL_RUNTIME_MINIMUM_RELEASE_AGE_EXCLUDE,
} as const

export function pnpmWorkspaceYaml(
  autoInstallPeers = true,
  options: { resolutionMode?: string; minimumReleaseAgeExclude?: readonly string[] } = {},
): string {
  const onlyBuilt = ALLOWED_BUILD_PACKAGES.map(name => `  - ${JSON.stringify(name)}`).join('\n')
  const allow = ALLOWED_BUILD_PACKAGES.map(name => `  ${JSON.stringify(name)}: true`).join('\n')
  return [
    'packages:', '  - .', '',
    'nodeLinker: hoisted',
    'autoInstallPeers: ' + (autoInstallPeers ? 'true' : 'false'),
    ...(options.resolutionMode === undefined ? [] : ['resolutionMode: ' + options.resolutionMode]),
    // 必须排在 allowBuilds 之前：ensurePnpm11BuildPolicy 用正则从本函数的输出里抠 allowBuilds
    // 块贴回既有文件，块后再挂键会让那份正则的边界依赖插入位置。
    ...(options.minimumReleaseAgeExclude === undefined || options.minimumReleaseAgeExclude.length === 0
      ? []
      : ['minimumReleaseAgeExclude:', ...options.minimumReleaseAgeExclude.map(v => '  - ' + JSON.stringify(v)), '']),
    'onlyBuiltDependencies:', onlyBuilt,
    'allowBuilds:', allow, '',
  ].join('\n')
}
