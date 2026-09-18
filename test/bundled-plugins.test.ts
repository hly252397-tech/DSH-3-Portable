import assert from 'node:assert/strict'
import test from 'node:test'

import { BUNDLED_PLUGINS, OFFICIAL_DSH_VERSION, OFFICIAL_LAUNCH_PEERS, OFFICIAL_RUNTIME, OFFICIAL_RUNTIME_RESOLUTION_MODE, compareReleaseVersions, isDeepSeekOfficialPackage, isOfficialDshPackage, officialDshVersionOverrides, officialRuntimeDependencies, officialRuntimePnpmConfig, planOfficialRuntimeTarget, pnpmAllowBuildsManifest, pnpmWorkspaceYaml, SUITE_PACKAGE, bundledPluginNames, seededPackageNames } from '../src/bundled-plugins.js'

test('内置目录包含全部随包社区插件和市场组件', () => {
  assert.deepEqual(bundledPluginNames(), [
    '@michengai/dsh-codex-ui',
    '@michengai/dsh-im-connect',
    '@michengai/dsh-automation',
    '@michengai/dsh-skills-manager',
    '@michengai/dsh-archive-manager',
    '@michengai/dsh-agency-agents',
    '@michengai/dsh-codex-pet',
    '@michengai/dsh-btw',
    '@michengai/dsh-simplify',
    '@michengai/dsh-code-review',
    '@michengai/dsh-pua',
    'dsh-context',
    'dsh-better-sidebar',
    'dsh-mcp-connector',
    '@kenz1117/dsh-ui-usage-billing',
    'dshmarket',
  ])
  assert.equal(BUNDLED_PLUGINS.length, 16)
  assert.equal(SUITE_PACKAGE, '@michengai/dsh-codex-suite')
})

test('所有 DeepSeek 官方作用域包使用同一套隔离判定', () => {
  assert.equal(isOfficialDshPackage('@deepseek-ai/dsh'), true)
  assert.equal(isOfficialDshPackage('@deepseek-ai/cordis-plugin-group'), false)
  assert.equal(isDeepSeekOfficialPackage('@deepseek-ai/cordis-plugin-group'), true)
  assert.equal(isDeepSeekOfficialPackage('@michengai/dsh-codex-ui'), false)
})

test('每个内置插件都钉死精确版本', () => {
  for (const plugin of BUNDLED_PLUGINS) {
    assert.match(plugin.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    assert.equal(
      plugin.packageName.startsWith('@michengai/')
        || plugin.packageName === '@kenz1117/dsh-ui-usage-billing'
        || ['dsh-context', 'dsh-better-sidebar', 'dsh-mcp-connector', 'dshmarket'].includes(plugin.packageName),
      true,
    )
  }
  assert.equal(BUNDLED_PLUGINS.find(plugin => plugin.packageName === 'dshmarket')?.version, '1.47.0')
  assert.deepEqual(Object.fromEntries(BUNDLED_PLUGINS.map(plugin => [plugin.packageName, plugin.version])), {
    '@michengai/dsh-codex-ui': '1.1.13',
    '@michengai/dsh-im-connect': '0.1.51',
    // 0.1.44（2026-09-16 用户授权接受 profile 批量升级）：自动化工作台补丁已按授权重钉到 0.1.44 的
    // 三锚点契约（apply / runtime / 原生页面返回行），详见 build.mjs 注释与 I030 记录。
    '@michengai/dsh-automation': '0.1.45',
    '@michengai/dsh-skills-manager': '0.1.53',
    '@michengai/dsh-archive-manager': '0.1.44',
    '@michengai/dsh-agency-agents': '0.1.44',
    '@michengai/dsh-codex-pet': '0.1.7',
    '@michengai/dsh-btw': '0.1.10',
    '@michengai/dsh-simplify': '0.1.7',
    '@michengai/dsh-code-review': '0.1.4',
    '@michengai/dsh-pua': '0.3.16',
    'dsh-context': '0.53.3',
    'dsh-better-sidebar': '0.19.1',
    'dsh-mcp-connector': '0.2.51',
    '@kenz1117/dsh-ui-usage-billing': '1.4.0',
    dshmarket: '1.47.0',
  })
})

test('官方 DSH 家族锁在同一个精确版本', () => {
  assert.equal(OFFICIAL_RUNTIME.packageName, '@deepseek-ai/dsh')
  assert.equal(OFFICIAL_RUNTIME.version, OFFICIAL_DSH_VERSION)
  assert.equal(OFFICIAL_DSH_VERSION, '0.1.6-alpha.2')
  assert.equal(seededPackageNames()[0], '@deepseek-ai/dsh')
  assert.equal(OFFICIAL_LAUNCH_PEERS[0]?.packageName, '@deepseek-ai/cordis-plugin-group')
  assert.equal(OFFICIAL_LAUNCH_PEERS[0]?.version, '1.0.2')
  assert.equal(officialRuntimeDependencies()['@deepseek-ai/dsh-invariants'], OFFICIAL_DSH_VERSION)
  assert.deepEqual(officialDshVersionOverrides(), {
    '@deepseek-ai/dsh': OFFICIAL_DSH_VERSION,
    '@deepseek-ai/dsh-*': OFFICIAL_DSH_VERSION,
  })
  assert.equal(officialRuntimePnpmConfig().overrides['@deepseek-ai/dsh-*'], OFFICIAL_DSH_VERSION)
})

test('版本号完全跟随上游：第 4 段便携迭代号的比较语义', () => {
  // 基础版本 = 上游 3 段；同基座重建用 .N 递增，上游新版本永远大于旧基座的任意 .N。
  assert.equal(compareReleaseVersions('1.0.64.1', '1.0.64'), 1)
  assert.equal(compareReleaseVersions('1.0.64.2', '1.0.64.1'), 1)
  assert.equal(compareReleaseVersions('1.0.64.10', '1.0.64.9'), 1)
  assert.equal(compareReleaseVersions('1.0.65', '1.0.64.9'), 1)
  assert.equal(compareReleaseVersions('1.0.64', '1.0.64.1'), -1)
  assert.equal(compareReleaseVersions('1.0.64.1', '1.0.64.1'), 0)
  // 预发布语义不破坏：rc 仍小于正式，便携迭代不影响 prerelease 比较。
  assert.equal(compareReleaseVersions('1.0.64', '1.0.64-rc.1'), 1)
  assert.equal(compareReleaseVersions('1.0.64-rc.2', '1.0.64-rc.1'), 1)
})

test('官方版本比较和升级目标不会把已对齐的新版本降回去', () => {
  assert.equal(compareReleaseVersions('0.1.0-rc.8', '0.1.0-rc.7') > 0, true)
  assert.equal(compareReleaseVersions('1.0.0-beta.1', '1.0.0-alpha.9') > 0, true)
  assert.equal(compareReleaseVersions('1.0.0', '1.0.0-beta.9') > 0, true)
  assert.equal(planOfficialRuntimeTarget({
    installed: '0.1.0-rc.7',
    aligned: false,
    baked: '0.1.0-rc.8',
  }), '0.1.0-rc.8')
  assert.equal(planOfficialRuntimeTarget({
    installed: '0.1.0-rc.8',
    aligned: true,
    baked: '0.1.0-rc.8',
    published: '0.1.0-rc.9',
  }), '0.1.0-rc.9')
  assert.equal(planOfficialRuntimeTarget({
    installed: '0.1.0-rc.9',
    aligned: true,
    baked: '0.1.0-rc.8',
  }), undefined)
})

test('装配与补种会放行 DSH 所需的原生构建脚本', () => {
  const allow = pnpmAllowBuildsManifest()
  assert.equal(allow.allowBuilds['node-pty'], true)
  assert.equal(allow.allowBuilds['@deepseek-ai/dsh-subprocess-local'], true)
  assert.match(pnpmWorkspaceYaml(), /allowBuilds:/)
  assert.doesNotMatch(pnpmWorkspaceYaml(), /onlyBuiltDependencies:/)
  assert.match(pnpmWorkspaceYaml(), /autoInstallPeers:\s*true/)
  assert.match(pnpmWorkspaceYaml(false), /autoInstallPeers:\s*false/)
  // 未显式要求时不写 resolutionMode（Profile 侧仍用 pnpm 默认的 highest）。
  assert.doesNotMatch(pnpmWorkspaceYaml(false), /resolutionMode/)
  assert.match(pnpmWorkspaceYaml(true, { resolutionMode: OFFICIAL_RUNTIME_RESOLUTION_MODE }), new RegExp(`^resolutionMode: ${OFFICIAL_RUNTIME_RESOLUTION_MODE}$`, 'm'))
})
