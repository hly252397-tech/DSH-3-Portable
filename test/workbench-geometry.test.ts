import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveWorkbenchWidth } from '../src/workbench-geometry.js'
import { capBrowserWorkspacePanelWidth, browserPanelMaxWidthCss } from '../src/browser-panel-layout.js'

test('closed/compact/invalid panels never reserve a positive minimum', () => {
  for (const value of [0, -1, NaN, Infinity]) assert.equal(resolveWorkbenchWidth(value, 1360, 720, false), 0)
  assert.equal(resolveWorkbenchWidth(627, 1088, 576, true), 0)
})
test('render, drag and reservation share the same CSS-pixel cap', () => {
  for (const zoom of [.8, 1, 1.25, 1.5, 2]) {
    const viewport = 1800 / zoom
    const maximum = browserPanelMaxWidthCss(capBrowserWorkspacePanelWidth(1800, 1800), zoom)
    for (const request of [100, 286, 488, 627, 1000, 5000]) {
      const actual = resolveWorkbenchWidth(request, viewport, maximum, false)
      assert.ok(actual <= maximum)
      assert.ok(actual <= viewport - 400)
      assert.equal(resolveWorkbenchWidth(actual, viewport, maximum, false), actual)
    }
  }
  assert.equal(resolveWorkbenchWidth(627, 1360, 720, false), 627)
  assert.equal(resolveWorkbenchWidth(900, 1360, 720, false), 720)
  assert.equal(resolveWorkbenchWidth(900, 1360, NaN, false), 720)
})

test('200 percent zoom keeps reservation and panel on the same 400 CSS-pixel floor', () => {
  assert.equal(resolveWorkbenchWidth(880, 1200, 880, false), 800)
})
test('desktop publishes a viewport limit, never an inset child measurement', () => {
  const main = readFileSync('src/main.ts', 'utf8')
  assert.match(main, /publishBrowserPanelMaxWidth\(capBrowserWorkspacePanelWidth\(bounds\.width, bounds\.width\)\)/)
  assert.doesNotMatch(main, /publishBrowserPanelMaxWidth\(capBrowserWorkspacePanelWidth\(bounds\.width, panel\.width\)\)/)
  assert.match(main, /dispatchEvent\(new Event\('dsh:layout-context'\)\)/)
})
