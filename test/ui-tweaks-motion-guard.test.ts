import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

/**
 * iOS 动效层防回退门禁（2026-09-29 用户要求「必须防止回退」）。
 * 任何会话按 AGENTS 必须跑全量测试才能交付——本文件让「删掉/改坏动效层」直接红：
 *   ① 源码必须包含动效层的关键机制标记（总闸/冷却/点击布防/计费面板接管）；
 *   ② 三份部署副本（现役/回滚/回落家园）必须与源码字节一致（存在时才检查，CI 全新检出跳过）。
 * 要合法更新动效层：先 attrib -R 解除只读锁（见 docs/01-当前工作/20260929-iOS风格动效层.md），
 * 四份一起改、同步本文件的标记断言，再过全量。
 */

const SOURCE = resolve('customizations/ui-tweaks/lib/client.js')
const DEPLOYED = [
  ['现役 v5', resolve('Data/DSH-generations/v5-020rc1/home/profiles/web/local/dsh-ui-tweaks/lib/client.js')],
  ['回滚 v4', resolve('Data/DSH-generations/v4-rc2b/home/profiles/web/local/dsh-ui-tweaks/lib/client.js')],
  ['回落 legacy', resolve('Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js')],
] as const

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

test('部署副本与源码字节一致（存在时；CI 全新检出按仓库规则跳过）', (t) => {
  if (!existsSync(DEPLOYED[0][1])) return t.skip('实机部署副本缺失（CI 全新检出）')
  const source = readFileSync(SOURCE)
  for (const [label, path] of DEPLOYED) {
    if (!existsSync(path)) { t.skip(`${label} 副本缺失，跳过`); continue }
    assert.ok(Buffer.compare(readFileSync(path), source) === 0, `${label} 部署副本与源码不一致——改 ui-tweaks 必须四份同步（源 + v5 + v4 + legacy）`)
  }
})
