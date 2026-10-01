import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { readPreservationManifest } from '../src/customization-preservation.js'
import { makeTrackedTempDirSync } from './helpers/tmp.js'

/**
 * iOS 动效层防回退门禁（2026-09-29 用户要求「必须防止回退」）。
 * 任何会话按 AGENTS 必须跑全量测试才能交付——本文件让「删掉/改坏动效层」直接红：
 *   ① 源码必须包含动效层的关键机制标记（总闸/冷却/点击布防/计费面板接管）；
 *   ② 实际活动 Profile 必须加载已接受清单保护的客户端，并保持真实 link/bundle 关系。
 * 候选源码可以先于部署变化；源码保护另行阻止未接受漂移进入构建，不能要求历史回滚家园
 * 跟随新 SOURCE 重写。CI 仅在整个 Data 缺失时跳过实机检查，损坏或缺失活动部署必须红。
 */

const SOURCE = resolve('customizations/ui-tweaks/lib/client.js')
const PLUGIN = 'dsh-ui-tweaks'
const { activeUiProfile } = await import(pathToFileURL(resolve('scripts/lib/active-ui-profile.mjs')).href) as {
  activeUiProfile(root: string): { profile: string; runtime?: string }
}
const normalizedSha256 = (source: string): string => createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex')
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right

function hasPortableData(root: string): boolean {
  try {
    const data = lstatSync(resolve(root, 'Data'))
    assert.ok(data.isDirectory() && !data.isSymbolicLink(), 'Data must be an ordinary portable directory')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Deliberately compares deployment with the accepted registry, never the pending SOURCE. */
function assertAcceptedActiveClient(root: string): string {
  const accepted = readPreservationManifest(root)
  assert.ok(accepted.requiredPlugins.includes(PLUGIN), 'Accepted plugin requirement is missing')
  const source = accepted.sources.find(item => item.pluginName === PLUGIN)
  assert.ok(source, 'Accepted ui-tweaks source record is missing')
  assert.equal(source.sourceDir, 'customizations/ui-tweaks', 'Accepted ui-tweaks source mapping changed')
  const client = source.files.find(file => file.path === 'lib/client.js')
  assert.ok(client && client.runtime !== false, 'Accepted runtime client hash is missing')

  const { profile } = activeUiProfile(root)
  assert.ok(samePath(realpathSync(profile), resolve(profile)), 'Active Profile must remain canonical')
  const profileFile = join(profile, 'package.json')
  assert.ok(lstatSync(profileFile).isFile(), 'Active Profile manifest must be an ordinary file')
  const manifest = JSON.parse(readFileSync(profileFile, 'utf8'))
  const spec = manifest.dependencies?.[PLUGIN]
  assert.equal(typeof spec, 'string', 'Active ui-tweaks link dependency is missing')
  assert.match(spec, /^link:/, 'Active ui-tweaks must use a local link dependency')
  assert.equal(spec.slice(5).replaceAll('\\', '/').replace(/^\.\//, ''), `local/${PLUGIN}`, 'Active ui-tweaks link points elsewhere')
  assert.ok(Array.isArray(manifest.dsh?.profile?.bundles), 'Active Profile bundles are missing')
  assert.equal(manifest.dsh.profile.bundles.filter((name: unknown) => name === PLUGIN).length, 1, 'Active ui-tweaks bundle must be enabled exactly once')

  const local = join(profile, 'local', PLUGIN), installed = join(profile, 'node_modules', PLUGIN)
  const localInfo = lstatSync(local)
  assert.ok(localInfo.isDirectory() && !localInfo.isSymbolicLink(), 'Active local ui-tweaks source must be an ordinary directory')
  assert.ok(samePath(realpathSync(local), resolve(local)), 'Active local ui-tweaks source resolves elsewhere')
  assert.ok(lstatSync(installed).isSymbolicLink(), 'Installed ui-tweaks must remain a directory link')
  assert.ok(samePath(realpathSync(installed), realpathSync(local)), 'Installed ui-tweaks target differs from the active local source')
  const pluginFile = join(local, 'package.json')
  assert.ok(lstatSync(pluginFile).isFile(), 'Active plugin manifest must be an ordinary file')
  const plugin = JSON.parse(readFileSync(pluginFile, 'utf8'))
  assert.equal(plugin.name, PLUGIN, 'Active plugin identity changed')
  assert.equal(plugin.exports?.['./client'], './lib/client.js', 'Active plugin exports a different client')
  const file = join(local, 'lib/client.js')
  assert.ok(lstatSync(file).isFile(), 'Active ui-tweaks client must be an ordinary file')
  assert.ok(samePath(realpathSync(file), resolve(file)), 'Active ui-tweaks client resolves elsewhere')
  assert.equal(normalizedSha256(readFileSync(file, 'utf8')), client.sha256.toLowerCase(), 'Active ui-tweaks client differs from its accepted normalized SHA256')
  return file
}

const REQUIRED_MARKERS: Array<[string, string]> = [
  ['总闸 dataset', "dataset.dshMotion = 'ios'"],
  ['退出开关 prefers-reduced-motion', 'prefers-reduced-motion'],
  // 2026-09-29 apple-design 第 14 条：减弱动效从「整层静止」改为「降档交叉淡化」，
  // 语义变了所以两条都要钉——降档档位值、降档关键帧、以及 reduced 档下的计费面板接管。
  ['减弱动效降档档位（非删除属性）', "dataset.dshMotion = 'reduced'"],
  ['减弱动效降档关键帧', 'dsh-ios-fade-in'],
  ['降档档位选择器', 'html[data-dsh-motion="reduced"] .dsh-ios-view'],
  ['降档下计费面板接管', 'html[data-dsh-motion="reduced"] .dsh-billing-modal{animation:none'],
  ['全局冷却（防双弹）', 'lastAnimAt < 450'],
  ['点击布防触发', 'NAV_CLICK_SEL'],
  ['视图入场动画类', 'dsh-ios-view-in'],
  ['弹层弹簧动画类', 'dsh-ios-pop-in'],
  ['计费面板接管（稳定类）', '.dsh-billing-modal{animation:none'],
  ['页签接管（稳定 testid）', '[data-testid^="billing-tab-panel-"]'],
  ['热重载令牌轮询', '/ui-tweaks/reload-token'],
  // 设置导航分组镜像（2026-09-29 用户「给这个分个类，然后排布」）
  ['设置导航分组表', 'SETTINGS_NAV_GROUPS'],
  ['分组镜像安装入口', 'installSettingsNavGroups'],
  ['分组镜像容器 id', "box.id = 'dsh-settings-groups'"],
  ['原官方分组容器接管', '.dcu-settings-nav.dsh-grouped>.dcu-settings-groups{display:none!important}'],
  ['搜索过滤同步（按 DOM 查原件，禁用 offsetParent）', 'findOriginalByKey'],
  ['空组标题收起', "group.hidden = [...group.querySelectorAll('.dsh-sg-item')].every"],
]

test('iOS 动效层机制标记完整（源码未被回退/肢解）', () => {
  const source = readFileSync(SOURCE, 'utf8')
  for (const [name, marker] of REQUIRED_MARKERS) {
    assert.ok(source.includes(marker), `动效层标记缺失：${name}（搜索 "${marker}"）——若为有意下线，须先更新本测试并留 docs 记录`)
  }
})

test('减弱动效走降档而非删除总闸（防止退回「整层静止」）', () => {
  const source = readFileSync(SOURCE, 'utf8')
  assert.ok(
    !/delete\s+document\.documentElement\.dataset\.dshMotion/.test(source),
    'syncFlag 又改回 delete dataset.dshMotion 了——那会让系统「减少动态」时整层零反馈、切换像卡住。降档请写 dataset.dshMotion = \'reduced\'',
  )
})

test('实际活动 ui-tweaks 保持已接受客户端及 link/bundle（仅无 Data 的 CI 跳过）', t => {
  const root = process.cwd()
  if (!hasPortableData(root)) return t.skip('Portable Data absent (CI fresh checkout); canonical motion tests remain mandatory')
  assertAcceptedActiveClient(root)
})

function acceptedFixture() {
  const root = makeTrackedTempDirSync(join(tmpdir(), 'dsh-motion-accepted-'))
  const put = (relative: string, value: unknown): void => {
    const file = join(root, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const deployed = '/* accepted motion client */\n'
  const preservation = {
    schema: 1, revision: 1, features: ['plugin.dsh-ui-tweaks'], requiredPlugins: [PLUGIN],
    sources: [{ pluginName: PLUGIN, sourceDir: 'customizations/ui-tweaks', files: [{ path: 'lib/client.js', sha256: normalizedSha256(deployed) }] }],
  }
  put('customizations/preservation.json', preservation)
  put('customizations/ui-tweaks/lib/client.js', '/* unaccepted candidate changes unrelated settings */\n')
  const current = { version: '0.2.0-rc.2', relativePath: 'Harness/slots/rc2' }
  mkdirSync(join(root, 'Data/Runtime', current.relativePath), { recursive: true })
  put('Data/Runtime/Harness/current.json', { schema: 1, current })
  put(`Data/Updates/Harness/homes/${current.version}.json`, {
    schema: 2, runtimeVersion: current.version, generation: 'active', runtimeRelativePath: `Data/Runtime/${current.relativePath}`,
  })
  const profileRelative = 'Data/DSH-generations/active/home/profiles/web'
  const profile = join(root, profileRelative), local = join(profile, 'local', PLUGIN), installed = join(profile, 'node_modules', PLUGIN)
  const profileManifest = { dependencies: { [PLUGIN]: `link:./local/${PLUGIN}` }, dsh: { profile: { bundles: [PLUGIN] } } }
  put(`${profileRelative}/package.json`, profileManifest)
  put(`${profileRelative}/local/${PLUGIN}/package.json`, { name: PLUGIN, exports: { './client': './lib/client.js' } })
  put(`${profileRelative}/local/${PLUGIN}/lib/client.js`, deployed.replaceAll('\n', '\r\n'))
  mkdirSync(dirname(installed), { recursive: true })
  symlinkSync(local, installed, process.platform === 'win32' ? 'junction' : 'dir')
  // Frozen historical homes deliberately differ; they are not the selected active Profile.
  put(`Data/DSH-generations/previous/home/profiles/web/local/${PLUGIN}/lib/client.js`, '/* historical rollback client */\n')
  return { root, profile, local, installed, deployed, preservation, profileManifest, put }
}

test('候选源码与历史家园可不同，活动部署仍按已接受 normalized SHA 校验', () => {
  const f = acceptedFixture()
  assert.notEqual(readFileSync(join(f.root, 'customizations/ui-tweaks/lib/client.js'), 'utf8'), f.deployed)
  assert.equal(assertAcceptedActiveClient(f.root), join(f.local, 'lib/client.js'))
})

test('替换活动客户端或丢失接受记录必须失败，不能跟新候选源码取绿灯', () => {
  const replaced = acceptedFixture()
  writeFileSync(join(replaced.local, 'lib/client.js'), readFileSync(join(replaced.root, 'customizations/ui-tweaks/lib/client.js')))
  assert.throws(() => assertAcceptedActiveClient(replaced.root), /accepted normalized SHA256/)
  for (const missing of ['source', 'client'] as const) {
    const f = acceptedFixture()
    f.put('customizations/preservation.json', missing === 'source'
      ? { ...f.preservation, sources: [] }
      : { ...f.preservation, sources: [{ ...f.preservation.sources[0], files: [{ path: 'lib/other.js', sha256: normalizedSha256('other') }] }] })
    assert.throws(() => assertAcceptedActiveClient(f.root), /source record is missing|runtime client hash is missing/)
  }
})

test('错 link、禁用 bundle 和指向其他目录的 node_modules 即使字节一致也必须失败', () => {
  for (const scenario of ['dependency', 'bundle', 'target'] as const) {
    const f = acceptedFixture()
    if (scenario === 'dependency') {
      writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ ...f.profileManifest, dependencies: { [PLUGIN]: 'link:../other' } }))
    } else if (scenario === 'bundle') {
      writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ ...f.profileManifest, dsh: { profile: { bundles: [] } } }))
    } else {
      const other = join(f.profile, 'local', 'other')
      mkdirSync(join(other, 'lib'), { recursive: true })
      writeFileSync(join(other, 'lib/client.js'), f.deployed)
      unlinkSync(f.installed)
      symlinkSync(other, f.installed, process.platform === 'win32' ? 'junction' : 'dir')
    }
    assert.throws(() => assertAcceptedActiveClient(f.root), /link points elsewhere|enabled exactly once|target differs/)
  }
})

test('只有完全无 Data 可跳过，已存在 Data 的活动 Profile 或客户端缺失仍失败', () => {
  const root = makeTrackedTempDirSync(join(tmpdir(), 'dsh-motion-no-data-'))
  assert.equal(hasPortableData(root), false)
  mkdirSync(join(root, 'Data'))
  assert.equal(hasPortableData(root), true)
  const f = acceptedFixture()
  unlinkSync(join(f.local, 'lib/client.js'))
  assert.throws(() => assertAcceptedActiveClient(f.root), (error: any) => error.code === 'ENOENT')
  unlinkSync(join(f.profile, 'package.json'))
  assert.throws(() => assertAcceptedActiveClient(f.root), /Active UI Profile is missing/)
})
