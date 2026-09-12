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

test('对话内容列不再使用持久化像素宽度，窄容器下不再裁切', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  // 宽度把手时代拖拽后内联持久化的像素值（--dsh-conversation-column-width: 1035px 之类）
  // 会在容器变窄时把内容列溢出裁切（标题/卡片切一半）。把手已退役，内容列响应式：
  // 填满容器、上限 900px；用户气泡同理封顶 640px。
  assert.match(css, /body \.wSkVaW_root \{\s*--dsh-conversation-column-width: min\(100%, 900px\) !important;/)
  assert.match(css, /--dsh-chat-user-width: min\(100%, 640px\) !important;/)
})
