import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

test('工作台面板宽度被钳制，对话列保留可用下限', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  // better-sidebar 的拖宽只钳到视口宽（clampWidth 上限 = innerWidth），面板一旦存成
  // 接近全屏的宽度，autoOpenSubagent 自动重开就会把对话列挤到竖排（2026-09-12 实证）。
  // theme.css 硬底线：面板上限 = 视口 − 740px（图标轨 + 侧栏 + 对话 420px 底线 + 间距），
  // 文件可视化可拖到视口余量内的任意宽度（大屏 ~1800px），但吃不掉对话底线。
  assert.match(css, /body \.nArs4W_panel \{\s*max-width: calc\(100vw - 740px\) !important;/)
  assert.match(css, /body \.pI_x6G_centerCol \{\s*min-width: 420px;/)
})
