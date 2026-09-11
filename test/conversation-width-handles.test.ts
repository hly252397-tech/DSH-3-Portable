import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

test('conversation width handles are hidden by the portable theme independently of plugin updates', async () => {
  const style = (await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')).replace(/\s+/g, '')
  // 旧官方把手是 data-width-handle；实装 UI 改名后新增 data-dcu-width-handle 同代退役
  // （2026-09-12：改名把手以 32px×100% 全列高复活并覆盖对话工作区）。
  assert.ok(style.includes('body[data-width-handle="left"],body[data-width-handle="right"],body[data-dcu-width-handle="left"],body[data-dcu-width-handle="right"]{display:none!important;pointer-events:none!important;}'))
  assert.ok(style.includes('body[data-width-handle="left"]::after,body[data-width-handle="right"]::after,body[data-dcu-width-handle="left"]::after,body[data-dcu-width-handle="right"]::after{display:none!important;content:none!important;}'))
  assert.ok(!style.includes('localStorage'), 'Hiding controls must not reset width preferences')
})
