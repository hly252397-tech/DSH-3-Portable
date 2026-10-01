import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'yaml'
import { removeDesktopBridgePatch } from '../src/desktop-bridge-migration.js'

test('YAML 3 migration removes only bridge rows, including nested insert, preserving comments and other config', () => {
  const input = '# user comment\n- id: keep\n  name: custom\n  config: { enabled: true }\n- id: dsh-desktop-bridge\n  name: dsh-desktop-bridge\n- insert:\n    - id: dsh-desktop-bridge\n    - id: child\n      name: custom-child\n- id: dsh-desktop-bridge\n  name: different-plugin\n'
  const result = removeDesktopBridgePatch(input)
  assert.match(result, /# user comment/)
  assert.deepEqual(parse(result), [
    { id: 'keep', name: 'custom', config: { enabled: true } },
    { insert: [{ id: 'child', name: 'custom-child' }] },
    { id: 'dsh-desktop-bridge', name: 'different-plugin' },
  ])
  assert.equal(removeDesktopBridgePatch(result), result)
})

test('bridge migration preserves unrelated bytes, removes empty inserts and rejects invalid patches', () => {
  const unchanged = '# dsh-desktop-bridge is only a comment\n- id: keep\n  config: [1,  2]\n'
  assert.equal(removeDesktopBridgePatch(unchanged), unchanged)
  assert.deepEqual(parse(removeDesktopBridgePatch('- insert:\n    - id: dsh-desktop-bridge\n')), [])
  assert.deepEqual(parse(removeDesktopBridgePatch('- id: dsh-desktop-bridge\n  name: dsh-desktop-bridge\n[]\n')), [])
  assert.throws(() => removeDesktopBridgePatch('dsh-desktop-bridge: ['), /不是有效/)
})
