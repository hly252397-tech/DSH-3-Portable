import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { localizedShellActions, SHELL_ACTIONS, type ShellActionId } from '../src/shell-actions.js'
import { FEATURE_PANEL_CATEGORIES, FEATURE_PANELS, type FeaturePanelCategoryId } from '../src/feature-panels.js'

test('功能板块注册表覆盖 docs/00-交接入口/07-功能清单.md 全 74 项且无重复', () => {
  assert.equal(FEATURE_PANELS.length, 74, '面板条目应等于 07-功能清单 编号 1..74')
  const ids = FEATURE_PANELS.map(({ panel }) => panel.id)
  assert.equal(new Set(ids).size, ids.length, '面板 id 必须唯一')
  for (const entry of FEATURE_PANELS) {
    assert.ok(entry.panel.id, '每条面板必须有稳定 id')
    assert.ok(entry.panel.file.trim().length > 0, `面板 ${entry.panel.id} 缺 file`)
    assert.ok(entry.panel.name.zh.length > 0 && entry.panel.name.en.length > 0, `面板 ${entry.panel.id} 缺中英文名`)
    assert.ok(entry.panel.description.zh.length > 0 && entry.panel.description.en.length > 0, `面板 ${entry.panel.id} 缺中英文描述`)
    assert.ok(entry.categoryId.length > 0, `面板 ${entry.panel.id} 缺 categoryId`)
  }
})

test('功能板块 8 个分类全部非空且 id 与条目匹配', () => {
  assert.equal(FEATURE_PANEL_CATEGORIES.length, 8)
  const validIds = new Set(FEATURE_PANEL_CATEGORIES.map(category => category.id))
  const groupedCounts = new Map<FeaturePanelCategoryId, number>()
  for (const { categoryId } of FEATURE_PANELS) {
    assert.ok(validIds.has(categoryId), `未注册的 categoryId：${categoryId}`)
    groupedCounts.set(categoryId, (groupedCounts.get(categoryId) ?? 0) + 1)
  }
  assert.equal([...groupedCounts.values()].reduce((a, b) => a + b, 0), 74)
  for (const category of FEATURE_PANEL_CATEGORIES) {
    const count = groupedCounts.get(category.id) ?? 0
    assert.ok(count > 0, `分类 ${category.id} 不应为空`)
  }
})

test('功能板块分类 hint 拥有中英文文案（便于 tooltip 渲染）', () => {
  for (const category of FEATURE_PANEL_CATEGORIES) {
    assert.ok(category.hint.zh.length > 0 && category.hint.en.length > 0, `分类 ${category.id} 缺中英 hint`)
  }
})

test('feature-panels 在视图菜单注册且打包态同样可见（用户日常功能索引）', () => {
  const action = SHELL_ACTIONS.find(candidate => candidate.id === ('feature-panels' as ShellActionId))
  assert.ok(action !== undefined, 'SHELL_ACTIONS 必须含 feature-panels')
  assert.equal(action.menu, 'view', 'feature-panels 必须在 view 菜单')
  assert.ok(action.label.zh.includes('功能板块') && action.label.en.includes('Feature Panels'),
    'feature-panels 标签必须中英对齐')

  // 不再按打包状态过滤：任何实例（含打包态）的动作列表都必须含功能板块
  const list = localizedShellActions('zh-CN', 'win32')
  assert.ok(list.some(item => item.id === 'feature-panels'), '打包态动作列表必须可见 feature-panels')
})

test('assets/feature-panels.html 含核心 DOM 锚点与 IPC 契约', () => {
  const html = readFileSync(new URL('../../assets/feature-panels.html', import.meta.url), 'utf8')
  for (const anchor of ['id="list"', 'id="query"', 'id="status"', 'data-action="close-window"', 'id="title"']) {
    assert.ok(html.includes(anchor), `HTML 必须含 ${anchor}`)
  }
  // 核心调用：搜索、复制 IPC、bootstrap 订阅
  assert.ok(html.includes('addEventListener(\'input\',render)'), 'HTML 必须监听搜索 input')
  assert.ok(html.includes('api.featurePanelsCopy('), 'HTML 必须调用 featurePanelsCopy IPC')
  assert.ok(html.includes('api.getBootstrap()'), 'HTML 必须拉取 bootstrap')
  assert.ok(html.includes('api.onBootstrap(applyBootstrap)'), 'HTML 必须订阅 onBootstrap 跟主题')
  // 主题接入与 zh/en 切换
  assert.ok(html.includes('theme.css'), 'HTML 必须引入 theme.css')
  assert.ok(html.includes('theme.js'), 'HTML 必须引入 theme.js')
  assert.ok(html.includes('document.documentElement.dataset.colorScheme'), 'HTML 必须应用 colorScheme')
  // Esc 关闭
  assert.ok(html.includes('Escape'), 'HTML 必须支持 Esc 关闭')
})

test('功能板块窗口是模态、挂载 shell-preload 沙箱化、加载 feature-panels.html', () => {
  const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8')
  assert.ok(main.includes('showFeaturePanelsWindow()'), 'main.ts 必须有 showFeaturePanelsWindow 入口')
  assert.ok(main.includes("resolveShellAsset('feature-panels.html')"), 'main.ts 必须加载 feature-panels.html')
  assert.ok(main.includes("parent: mainWindow") && main.includes("modal: true"), 'showFeaturePanelsWindow 必须为模态窗口')
  assert.ok(main.includes("sandbox: true") && main.includes("shell-preload.cjs"), 'showFeaturePanelsWindow 必须使用 shell-preload + sandbox')
})
