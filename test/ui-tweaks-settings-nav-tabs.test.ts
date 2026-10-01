import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

/**
 * 2026-09-30 用户拍板（终版）：「桌面设置」整页分区下线，**真拆分**——
 * 通知/更新是外壳注册的两个独立 settings.section（各自只显示自己的页签），
 * 外观嵌进「常规」页官方外观行（settings.general.item 槽）。ui-tweaks 只做导航归组，
 * 不再有任何合成项/跳转/注入机制（第一版"换地方显示"的实现已整体撤销）。
 *
 * 本文件锁四方契约：
 * 1. src/desktop-bridge-client-source.ts：注册 desktop-notifications / desktop-updates
 *    两个分区 + settings.general.item 的独立 desktop-appearance 行内外观面板；不抢占 appearance。
 * 2. assets/settings.html：自己监听 settingsSection 事件（setPage + data-dsh-section 标记），
 *    且 CSS 按 data-dsh-section 隐藏内部页签栏（分区只显示自己的页签）。
 * 3. ui-tweaks：更新进基础、通知进自动化与消息（真分区条目）；无合成机制残留；
 *    通知/更新有语义图标（走官方 mask 管线，杜绝"图标一坨"）。
 * 4. 更新链路零接触红线：settings.html 的更新动作处理器必须在场。
 */
const read = (relative: string): string | null => {
  const file = resolve(relative)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

test('src registers three split desktop settings surfaces, not one monolith', t => {
  const source = read('src/desktop-bridge-client-source.ts')
  if (source === null) return t.skip('src file missing')
  assert.ok(source.includes("'desktop-notifications'"), '必须注册独立的「通知」分区')
  assert.ok(source.includes("'desktop-updates'"), '必须注册独立的「更新」分区')
  assert.ok(source.includes("'settings.general.item'"), '外观面板必须经官方 general.item 槽嵌进常规页')
  assert.ok(source.includes("id: 'desktop-appearance'"), '窗口主题扩展必须使用独立 ID，不抢占官方 appearance')
  assert.ok(!source.includes("'desktop-settings'"), '单块「桌面设置」分区必须下线')
  assert.ok(source.includes("event: 'settingsSection'"), '分区宿主必须向 iframe 投递选中页签事件')
})

test('settings.html honors section selection and hides its own tab bar in split mode', t => {
  const source = read('assets/settings.html')
  if (source === null) return t.skip('settings.html missing')
  assert.ok(
    source.includes("data.channel!=='dsh-desktop-settings-v1'||data.event!=='settingsSection'"),
    '必须有自己的 settingsSection 消息监听（分区宿主选中页签）',
  )
  assert.ok(
    source.includes('dataset.dshSection'),
    '监听必须写 data-dsh-section 标记（单分区模式）',
  )
  assert.ok(
    source.includes('html[data-dsh-section] aside{display:none!important}'),
    '单分区模式必须隐藏内部页签栏——这是「真拆分」的关键判据',
  )
  // 更新链路零接触红线：两路更新动作处理器必须在场
  assert.ok(source.includes('api.desktopUpdateAction'), '桌面更新动作处理器必须在场')
  assert.ok(source.includes('api.harnessUpdateAction'), 'DSH 内核更新动作处理器必须在场')
})

// 正式源码门禁不依赖旧/现役 Profile 被提前同步；部署一致性由真实 Profile/Loader 验收覆盖。
for (const relative of ['customizations/ui-tweaks/lib/client.js']) {
  test(`ui-tweaks groups the real sections without synthetic machinery: ${relative}`, t => {
    const source = read(relative)
    assert.ok(source, 'canonical UI source must exist')

    // ① 只归组真实入口，旧宿主的兼容留存在执行矩阵中验证，不恢复合成旧页跳转。
    assert.ok(
      source.includes("['基础', ['常规', '模型', '更新']]"),
      '基础组必须只包含常规、模型和真实更新入口',
    )
    assert.ok(source.includes("['自动化与消息', ['通知', '定时任务', 'IM 助理', '多智能体交互管理']]"),
      '真实通知入口必须归自动化与消息')
    assert.match(source, /module\.exports\.inject = \['slots'\]/, '公开 slots 服务必须声明客户端注入依赖')
    // ② 第一版合成机制必须整体清除（用户判定为"换了个地方显示"的糊弄实现）
    for (const banned of ['dshDesktopTab', 'requestDesktopTab', 'dsh-desktop-appearance', 'SETTINGS_NAV_DESKTOP_TABS', 'installGeneralDesktopAppearanceRow']) {
      assert.ok(!source.includes(banned), `合成机制残留：${banned}（已撤销的实现不得复活）`)
    }
    // ③ 通知/更新的语义图标走官方 mask 管线（图标一坨的根因是合成项裸 SVG）
    assert.ok(source.includes("['通知', 'Notifications']"), '通知必须有语义图标条目')
    assert.ok(source.includes("['更新', 'Updates']"), '更新必须有语义图标条目')
    assert.ok(!source.includes("['桌面设置',"), '桌面设置导航条目必须移除')
  })
}

test('appearance grouping only styles adjacent public rows, without relocating original React nodes', () => {
  const source = read('customizations/ui-tweaks/lib/client.js')
  assert.ok(source)
  assert.ok(source.includes('.dcu-settings-row[data-dcu-settings-item="appearance"]+.dcu-settings-row[data-dcu-settings-item="desktop-appearance"]{border-top:0!important}'))
  assert.ok(source.includes('.dcu-settings-row[data-dcu-settings-item="appearance"]+.dcu-settings-row[data-dcu-settings-item="desktop-appearance"]>[data-slot]>*{padding-top:0!important}'))
  assert.doesNotMatch(source, /(?:querySelector|querySelectorAll)\([^\n]*data-dcu-settings-item/,
    '不从官方外观行摘/移动 React 节点，也不注入第三套设置按钮')
})
