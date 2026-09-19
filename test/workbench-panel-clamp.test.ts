import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

test('工作台面板宽度被钳制，对话列保留官方内容下限', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  // better-sidebar 的拖宽只钳到视口宽（clampWidth 上限 = innerWidth），面板一旦存成
  // 接近全屏的宽度，autoOpenSubagent 自动重开就会把对话列挤到竖排（2026-09-12 实证）。
  // 官方内容下限 680px（clamp(680, 64%, 920) 的下限）；2026-09-15 实测页面真正执行的上限是
  // **视口 − 640**（页面自带同选择器、同 !important 的规则且特异性更高），窗口窄于 1100px 时面板整个隐藏。
  // 2026-09-14 起改为**单一来源**：外壳（src/browser-panel-layout.ts）按同一策略常量算出上限、
  // 折成 CSS px 后经 --dsh-browser-panel-max-width 下发；这里的兜底值必须与外壳常量同值
  // （跨模块一致性由 browser-panel-layout.test.ts 钉住）。
  assert.match(css, /body \.nArs4W_panel \{\s*max-width: var\(--dsh-browser-panel-max-width, calc\(var\(--dsh-app-w\) - var\(--dsh-panel-margin\)\)\) !important;/)
  // 2026-09-16：隐藏判定只留外壳那一次（data-dsh-compact），页面不再自带 1100px 媒体查询
  assert.match(css, /:root\[data-dsh-compact="1"\] body \.nArs4W_panel \{\s*display: none !important;/)
  assert.doesNotMatch(css, /@media \(max-width: \d+px\) \{\s*body \.nArs4W_panel/, '页面不得再自带面板的视口阈值（注释里引用旧规则不算）')
  // 对话列仍以官方内容下限 680px 为目标，但**不许超过可用宽度**（窄档自适应，不再硬撑出溢出）
  assert.match(css, /body \.pI_x6G_centerCol \{\s*min-width: min\(680px, calc\(var\(--dsh-app-w\) - var\(--dsh-chrome-w\) - 24px\)\);/)
  assert.match(css, /body \.dcu-home-cards \{\s*flex-wrap: wrap !important;/)
})

// 0.1.5-rc.2 新前端的标签菜单 fixed 定位、JS 右对齐——左缘会伸进侧栏区，钳到侧栏之外。
test('对话内容列恢复官方响应式模型，清除历史拖拽偏好', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  // 官方模型：--dsh-chat-content-width = var(--dsh-chat-user-width, clamp(680, 64%, 920))
  // 自带响应式；历史拖拽偏好（固定像素 640px）会盖掉它导致窄容器裁切——清除之。
  assert.match(css, /body \.wSkVaW_root \{\s*--dsh-chat-user-width: unset !important;/)
  // 我方 min(100%, 900px) 覆盖已移除（与官方模型冲突）
  assert.doesNotMatch(css, /--dsh-conversation-column-width: min\(100%, 900px\)/)
})

test('rc.2 新前端的标签菜单不越出便携侧栏区', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  // _menu_17p4l_444（fixed、JS 右对齐锚点）在按钮位于标签条左端时左缘伸进侧栏。
  // 用模块前缀匹配本构建系列，强制左对齐到侧栏之外（260px）。
  // 260 = 侧栏 252 + 8：改为由 --dsh-sidebar-w 派生（侧栏宽只在一处定义）
  assert.match(css, /--dsh-sidebar-w: 252px;/)
  assert.match(css, /body \[class\*="_menu_17p4l"\] \{\s*left: calc\(var\(--dsh-sidebar-w\) \+ 8px\) !important;/)
  assert.match(css, /right: auto !important;/)
})

test('便携侧栏保持展开文字和底部动作', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  assert.match(css, /body\[data-color-scheme="light"\]\[data-dsh-preset="qoder"\] \.dcu-root \{[\s\S]*width: 252px !important;/)
  assert.match(css, /body\[data-color-scheme="light"\]\[data-dsh-preset="qoder"\] \.dcu-footer-actions \{\s*display: flex;/)
  assert.match(css, /body\[data-color-scheme="light"\]\[data-dsh-preset="qoder"\] \.dcu-settings-seat > button \{\s*width: 100%;/)
  assert.doesNotMatch(css, /body \.dcu-root > \.dcu-expanded-shell \{\s*display: none !important;/)
  assert.doesNotMatch(css, /body \.dcu-root \{\s*width: 56px !important;/)
})
