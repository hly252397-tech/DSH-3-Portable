import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow, Screen } from 'electron'
import { bindContainedSettingsWindow, centeredSettingsBounds } from '../src/contained-settings-window.js'

test('settings are centered within the visible owner, including small and negative-coordinate displays', () => {
  for (const parent of [
    { x: 400, y: 8, width: 1360, height: 900 },
    { x: 200, y: 80, width: 640, height: 480 },
    { x: -1800, y: 70, width: 1200, height: 700 },
    { x: 1700, y: 800, width: 1360, height: 900 },
  ]) {
    const work = parent.x < 0 ? { x: -1920, y: 0, width: 1920, height: 1040 } : { x: 0, y: 0, width: 2560, height: 1400 }
    const bounds = centeredSettingsBounds(parent, work)
    const left = Math.max(parent.x, work.x), right = Math.min(parent.x + parent.width, work.x + work.width)
    const top = Math.max(parent.y, work.y), bottom = Math.min(parent.y + parent.height, work.y + work.height)
    assert.ok(bounds.x >= left && bounds.y >= top)
    assert.ok(bounds.x + bounds.width <= right && bounds.y + bounds.height <= bottom)
    assert.ok(Math.abs(bounds.x * 2 + bounds.width - left - right) <= 1)
    assert.ok(Math.abs(bounds.y * 2 + bounds.height - top - bottom) <= 1)
  }
})

test('fully off-screen owner falls back to the display work area', () => {
  assert.deepEqual(centeredSettingsBounds({ x: 4000, y: 0, width: 1000, height: 800 }, { x: 0, y: 0, width: 1920, height: 1080 }), { x: 580, y: 230, width: 760, height: 620 })
})

test('movement, reopening and display changes align the child and closing removes all listeners', () => {
  class WindowFake extends EventEmitter {
    bounds = { x: 400, y: 40, width: 1360, height: 900 }
    destroyed = false
    minimized = false
    writes = 0
    isDestroyed() { return this.destroyed }
    isMinimized() { return this.minimized }
    getContentBounds() { return this.bounds }
    getBounds() { return this.bounds }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; this.writes++ }
  }
  const parent = new WindowFake(), child = new WindowFake()
  const workArea = { x: 0, y: 0, width: 2560, height: 1400 }
  const displays = Object.assign(new EventEmitter(), { getDisplayMatching: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) })
  const dispose = bindContainedSettingsWindow(child as unknown as BrowserWindow, parent as unknown as BrowserWindow, displays as unknown as Screen)
  assert.deepEqual(child.bounds, centeredSettingsBounds(parent.bounds, workArea))
  for (const event of ['move', 'resize', 'restore', 'show']) {
    parent.bounds = { ...parent.bounds, x: parent.bounds.x + 10, width: parent.bounds.width - 15 }
    parent.emit(event)
    assert.deepEqual(child.bounds, centeredSettingsBounds(parent.bounds, workArea))
  }
  child.bounds = { ...child.bounds, x: 0 }; child.emit('show')
  assert.deepEqual(child.bounds, centeredSettingsBounds(parent.bounds, workArea))
  workArea.width = 1200; displays.emit('display-metrics-changed')
  assert.deepEqual(child.bounds, centeredSettingsBounds(parent.bounds, workArea))
  const writes = child.writes
  child.emit('show'); assert.equal(child.writes, writes)
  parent.minimized = true; parent.emit('move'); assert.equal(child.writes, writes)
  child.emit('closed'); dispose()
  for (const emitter of [parent, child, displays]) assert.deepEqual(emitter.eventNames(), [])
})

test('child move from OS re-placement is pulled back and settle re-sync corrects late overrides', async () => {
  class WindowFake extends EventEmitter {
    bounds = { x: 400, y: 40, width: 1360, height: 900 }
    destroyed = false
    minimized = false
    writes = 0
    isDestroyed() { return this.destroyed }
    isMinimized() { return this.minimized }
    getContentBounds() { return this.bounds }
    getBounds() { return this.bounds }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; this.writes++ }
  }
  const parent = new WindowFake(), child = new WindowFake()
  const workArea = { x: 0, y: 0, width: 2560, height: 1400 }
  const displays = Object.assign(new EventEmitter(), { getDisplayMatching: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) })
  const dispose = bindContainedSettingsWindow(child as unknown as BrowserWindow, parent as unknown as BrowserWindow, displays as unknown as Screen, { settleDelays: [1, 2] })
  const expected = () => centeredSettingsBounds(parent.bounds, workArea)
  // OS 层叠摆放把子窗口挪出宿主：child 自身 move 事件必须立刻拉回。
  child.bounds = { x: 30, y: 55, width: expected().width, height: expected().height }
  child.emit('move')
  assert.deepEqual(child.bounds, expected())
  // show 之后 OS 再覆盖：立即同步无事可做（子窗口已就位），延时落定后的再同步必须纠正。
  child.bounds = expected()
  child.emit('show')
  child.bounds = { x: 30, y: 55, width: expected().width, height: expected().height }
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(child.bounds, expected())
  child.emit('closed'); dispose()
  for (const emitter of [parent, child, displays]) assert.deepEqual(emitter.eventNames(), [])
})
