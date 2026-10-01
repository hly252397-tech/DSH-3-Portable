import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

test('conversation tabs stay adjacent to mode in flex and narrow grid', t => {
  const root = 'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/'
  if (!existsSync(root + 'client.src.js')) return t.skip('Optional live Profile is not installed')
  for (const file of ['client.src.js', 'client.js']) {
    const source = readFileSync(root + file, 'utf8')
    assert.ok(source.includes('body header:has([data-dcu-inline-tabs]) [data-dcu-inline-tabs] { margin-left: 0; }'))
    assert.ok(source.includes('.wSkVaW_headerUtilities { margin-left: auto;'))
    assert.ok(source.includes('@container dss-conversation (max-width: 760px)'))
    assert.ok(source.includes('grid-column: 2 / 4; justify-self: start;'))
  }
})
