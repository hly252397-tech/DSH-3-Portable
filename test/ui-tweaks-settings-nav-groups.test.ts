import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 设置导航分组镜像的结构防回退（2026-09-29）。
 *
 * 背景：官方 codex-ui 的设置导航 DOM 是
 *   nav.dcu-settings-nav > button.dcu-settings-back
 *                      + label.dcu-settings-search > input
 *                      + div.dcu-settings-groups > section.dcu-settings-group
 *                            > h2.dcu-settings-group-label + button.dcu-settings-link
 * 第一版镜像按「按钮是 nav 直接子节点」取值，拿到 0 个入口、整段静默放弃——用户界面上
 * 完全看不出失败。本文件把真实结构写成 fixture 断言取值方式，并钉住两条易退化的行为：
 *   ① 入口取值必须是 descendant 查询（错法会让分组永远建不出来）；
 *   ② 搜索过滤的可见性判据必须是「原件是否在 DOM」，不得用 offsetParent
 *     （原件容器被我们 CSS 隐藏，offsetParent 恒为 null ⇒ 全部项被判不可见）。
 */

const SOURCE = readFileSync('customizations/ui-tweaks/lib/client.js', 'utf8')

function extractFunction(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `未找到函数 ${name}`)
  const end = SOURCE.indexOf('\n    }', start)
  assert.ok(end > start, `函数 ${name} 未正常闭合`)
  // 剥掉行注释：本文件要断言的是「代码怎么写」，而函数里恰好写着「绝不能用 offsetParent」
  // 这类说明性注释，直接全文匹配会把注释当成违规代码。
  return SOURCE.slice(start, end).replace(/^\s*\/\/.*$/gm, '')
}

test('入口取值走 descendant 查询（nav 直接子节点假设会让分组永远建不出来）', () => {
  const body = extractFunction('installSettingsNavGroups')
  assert.match(body, /querySelectorAll\('\.dcu-settings-groups button, button\.dcu-settings-link'\)/,
    '必须按 .dcu-settings-groups 内 descendant 查入口；官方按钮不是 nav 的直接子节点')
  assert.doesNotMatch(body, /\[\.\.\.nav\.children\]\.filter/, '不得再用 nav.children 直接子节点过滤取入口')
})

test('搜索过滤可见性判据是 DOM 存在性，不得用 offsetParent', () => {
  const body = extractFunction('installSettingsNavGroups')
  assert.doesNotMatch(body, /offsetParent/, '原件容器被本插件 CSS 隐藏，offsetParent 恒 null，会把全部项判为不可见')
  assert.match(body, /findOriginalByKey\(nav, navKey\(item\.textContent\)\)/, '必须按 key 回查当前 DOM 里的原件')
})

test('点击转发按 key 现查，不闭包持有原节点', () => {
  const body = extractFunction('installSettingsNavGroups')
  assert.match(body, /dataset\.dshNavKey/, '镜像按钮须记录原件 key')
  assert.doesNotMatch(body, /original\.click\(\)/, '不得直接调用建镜像时捕获的原节点（React 重建后即死按钮）')
})

test('搜索过滤时空组标题一并收起', () => {
  const body = extractFunction('installSettingsNavGroups')
  assert.match(body, /group\.hidden = \[\.\.\.group\.querySelectorAll\('\.dsh-sg-item'\)\]\.every/, '空组必须连标题一起隐藏')
})

test('分组表覆盖六大类，未识别项有兜底组', () => {
  for (const title of ['基础', '插件与扩展', '智能体', '界面定制', '自动化与消息', '会话记录', '其他']) {
    assert.ok(SOURCE.includes(`'${title}'`), `分组表缺少「${title}」`)
  }
})
