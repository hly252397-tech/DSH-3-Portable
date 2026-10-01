import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'

const shell = () => readFileSync('assets/shell.html', 'utf8')
function parseInline(html: string) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(m => !/\bsrc\s*=/.test(m[1]!))
  assert.ok(scripts.length >= 2)
  for (const match of scripts) new Script(match[2]!)
}
test('shell inline action scripts parse as the bytes shipped in assets', () => {
  parseInline(shell())
  assert.doesNotMatch(shell(), /dsh-fwd-layer/)
})
test('shell syntax gate rejects a damaged localized string quote', () => {
  const broken = shell().replace("'正在重启…'", "'姝ｅ湪閲嶅惎鈥?")
  assert.notEqual(broken, shell())
  assert.throws(() => parseInline(broken), SyntaxError)
})
