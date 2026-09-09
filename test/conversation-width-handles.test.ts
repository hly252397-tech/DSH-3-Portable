import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

test('conversation width handles are hidden by the portable theme independently of plugin updates', async () => {
  const style = (await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')).replace(/\s+/g, '')
  assert.ok(style.includes('body[data-width-handle="left"],body[data-width-handle="right"]{display:none!important;pointer-events:none!important;}'))
  assert.ok(style.includes('body[data-width-handle="left"]::after,body[data-width-handle="right"]::after{display:none!important;content:none!important;}'))
  assert.ok(!style.includes('localStorage'), 'Hiding controls must not reset width preferences')
})
