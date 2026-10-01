import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('shared UI typography aliases preserve content font sizes and editor fonts', () => {
  const css = readFileSync('assets/theme.css', 'utf8')
  assert.match(css, /--dsh-font-ui: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif/)
  const aliases = css.match(/html, body, \.dcu-root, \.dcu-settings-page \{([^}]+)\}/)?.[1] ?? ''
  assert.match(aliases, /--dcu-font: var\(--dsh-font-ui\) !important/)
  assert.match(aliases, /--dsw-font-family: var\(--dsh-font-ui\) !important/)
  assert.doesNotMatch(aliases, /^\s*(?:font-size|line-height|font)\s*:/m)
  assert.ok(css.includes(':not(:where(pre *, code *, .panel-file, .monaco-editor *, .cm-editor *, .xterm *))'))
})

test('browser font inheritance cannot reset toolbar and menu font sizes', () => {
  const css = readFileSync('assets/browser-workspace.css', 'utf8')
  assert.ok(css.includes('.browser button,.browser input,.browser textarea{font-family:inherit}'))
  assert.doesNotMatch(css, /font:\s*inherit/)
  assert.match(css, /\.browser-overflow button\{[^}]*font-size:var\(--dsh-font-size-menu,13px\)/)
  assert.match(css, /:focus-visible\{outline:2px solid var\(--browser-accent\)/)
})
