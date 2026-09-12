import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

test('工作台面板宽度被钳制，对话列保留官方内容下限', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  // better-sidebar 的拖宽只钳到视口宽（clampWidth 上限 = innerWidth），面板一旦存成
  // 接近全屏的宽度，autoOpenSubagent 自动重开就会把对话列挤到竖排（2026-09-12 实证）。
  // 官方内容下限 680px（clamp(680, 64%, 920) 的下限）→ 面板上限 = 视口 − 1040px，
  // 窗口窄于 1100px 时面板整个隐藏、对话独占。
  assert.match(css, /body \.nArs4W_panel \{\s*max-width: calc\(100vw - 1040px\) !important;/)
  assert.match(css, /@media \(max-width: 1100px\) \{\s*body \.nArs4W_panel \{\s*display: none !important;/)
  assert.match(css, /body \.pI_x6G_centerCol \{\s*min-width: 680px;/)
  assert.match(css, /body \.dcu-home-cards \{\s*flex-wrap: wrap !important;/)
})

test('对话内容列恢复官方响应式模型，清除历史拖拽偏好', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  // 官方模型：--dsh-chat-content-width = var(--dsh-chat-user-width, clamp(680, 64%, 920))
  // 自带响应式；历史拖拽偏好（固定像素 640px）会盖掉它导致窄容器裁切——清除之。
  assert.match(css, /body \.wSkVaW_root \{\s*--dsh-chat-user-width: unset !important;/)
  // 我方 min(100%, 900px) 覆盖已移除（与官方模型冲突）
  assert.doesNotMatch(css, /--dsh-conversation-column-width: min\(100%, 900px\)/)
})
