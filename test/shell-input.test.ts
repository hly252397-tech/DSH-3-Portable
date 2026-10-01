import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseForwardedInput } from '../src/shell-input.js'

test('forwarded inputs preserve valid zero wheel and reject malformed/outside-view events', () => {
  assert.deepEqual(parseForwardedInput({ type: 'wheel', x: 10, y: 20, deltaY: 0 }, 100, 80), { type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: 0 })
  assert.deepEqual(parseForwardedInput({ type: 'mousedown', x: 99.9, y: 20 }, 100, 80), { type: 'mouseDown', x: 99, y: 20, button: 'left', clickCount: 1 })
  for (const payload of [null, {}, { type: 'mousedown', x: -1, y: 0 }, { type: 'mousedown', x: 100, y: 0 },
    { type: 'wheel', x: 0, y: 0, deltaY: Infinity }, { type: 'mousemove', x: NaN, y: 0 }, { type: 'char', keyCode: '' }, { type: 'arbitrary', x: 0, y: 0 }]) {
    assert.equal(parseForwardedInput(payload, 100, 80), undefined)
  }
  assert.deepEqual(parseForwardedInput({ type: 'keydown', keyCode: 'Tab' }, 100, 80), { type: 'keyDown', keyCode: 'Tab' })
})

test('input forwarding is bound to focused shell main frame, never arbitrary renderer', () => {
  const source = readFileSync('src/main.ts', 'utf8')
  const handler = source.slice(source.indexOf('ipcMain.on(SHELL_IPC.forwardInput'), source.indexOf('ipcMain.removeHandler(SHELL_IPC.browserEmbeddedConfig)'))
  assert.match(handler, /shellRendererKind\(event.sender\) !== 'main'/)
  assert.match(handler, /event.senderFrame !== event.sender.mainFrame/)
  assert.match(handler, /!window.isFocused\(\)/)
  const layout = source.slice(source.indexOf('function layoutDshView'), source.indexOf('function setMainWindowContentVisible'))
  assert.match(layout, /mainWindowLayoutDeferred[\s\S]*?setBounds/)
  assert.doesNotMatch(layout, /\.focus\(/)
})
