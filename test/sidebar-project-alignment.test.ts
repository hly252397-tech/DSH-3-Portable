import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('project alignment stays scoped and reserves the running indicator', () => {
  const source = readFileSync('customizations/ui-tweaks/lib/client.js', 'utf8')
  assert.ok(source.includes('.dcu-root:not(.dcu-compact) .dcu-wb-project-body>.dcu-wb-session:not(:has(.dcu-wb-running))'))
  assert.ok(source.includes('.dcu-root:not(.dcu-compact) .dcu-wb-project-body>.dcu-wb-nochat{padding-left:8px}'))
  assert.ok(source.includes('.dcu-root:not(.dcu-compact) .dcu-wb-project-body>.dcu-wb-session-more{padding-left:0}'))
})
