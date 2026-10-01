import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('shell central and compact search use one reciprocal breakpoint', () => {
  const shell = readFileSync('assets/shell.html', 'utf8')
  assert.ok(shell.includes('.bar-right [data-action="find"]{display:none}'))
  assert.ok(shell.includes('@media(max-width:1000px){.command-center{display:none}.bar-right [data-action="find"]{display:grid}}'))
  assert.match(shell, /id="command-center"[^>]*data-action="find"/)
  assert.equal((shell.match(/<button[^>]*data-action="find"/g) ?? []).length, 2)
})
