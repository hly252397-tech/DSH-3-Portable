import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('settings portal gets the same light neutral sidebar palette without affecting dark mode', () => {
  const source = readFileSync('customizations/ui-tweaks/lib/client.js', 'utf8')
  const block = source.split('// I023/53:')[1]?.split('// End I023/53 settings palette.')[0]
  assert.ok(block)
  assert.ok(block.includes('body[data-color-scheme="light"]:not([data-ds-dark-theme]) .dcu-settings-page'))
  const theme = readFileSync('assets/theme.css', 'utf8')
  for (const [key, color] of Object.entries({background:'#ffffff',hover:'#f4f4f5',border:'#e4e4e7',primary:'#18181b',secondary:'#52525b',navigation:'#18181b',icon:'#52525b'})) {
    assert.ok(block.includes(`--dcu-sidebar-${key}:${color}`))
    assert.ok(theme.includes(`--dcu-sidebar-${key}: ${color}`))
  }
  assert.ok(block.includes('--sp-active:#e4e4e7'))
})
