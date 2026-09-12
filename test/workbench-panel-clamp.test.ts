import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

test('工作台面板宽度被钳制，对话列保留可用下限', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  // better-sidebar 的拖宽只钳到视口宽（clampWidth 上限 = innerWidth），面板一旦存成
  // 接近全屏的宽度，autoOpenSubagent 自动重开就会把对话列挤到竖排（2026-09-12 实证）。
  // theme.css 两层兜底：面板 ≤70vw；对话列 ≥420px。
  assert.match(css, /body \.nArs4W_panel \{\s*max-width: 70vw !important;/)
  assert.match(css, /body \.pI_x6G_centerCol \{\s*min-width: 420px;/)
})
