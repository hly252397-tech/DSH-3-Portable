import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const sourcePath = resolve('Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js')
function fixture(nativeOpen = false, cardOpen = false) {
  const source = readFileSync(sourcePath, 'utf8')
  const start = source.indexOf('function coordinateRightPanels(')
  const end = source.indexOf('\n\t\tfunction observePanelPresentation(', start)
  const coordinate = runInNewContext(`(${source.slice(start, end).trim()})`)
  let listener: (() => void) | undefined
  const state = { panelOpen: cardOpen, bottomOpen: true, tabs: ['preserved'] }
  let expanded = nativeOpen
  let nativeListener: (() => void) | undefined
  const native = { isExpanded: () => expanded, toggleExpanded() { expanded = !expanded } }
  const cards = { getSnapshot: () => ({ state }), subscribeState(fn: () => void) { listener = fn; return () => { listener = undefined } }, setPanelOpen(open: boolean) { state.panelOpen = open; listener?.() } }
  const observe = (fn: () => void) => { nativeListener = fn; return () => { nativeListener = undefined } }
  return { state, native, cards, dispose: coordinate(native, cards, observe), renderNative: () => nativeListener?.(), hasListener: () => !!listener || !!nativeListener }
}

test('right panels coordinate both directions, preserving tabs and bottom panel', t => {
  if (!existsSync(sourcePath)) return t.skip('实机客户端缺失（CI 全新检出）')
  const f = fixture(true, true)
  assert.equal(f.state.panelOpen, false)
  f.cards.setPanelOpen(true)
  assert.equal(f.native.isExpanded(), false)
  f.native.toggleExpanded()
  f.renderNative()
  assert.equal(f.state.panelOpen, false)
  assert.equal(f.state.bottomOpen, true)
  assert.deepEqual(f.state.tabs, ['preserved'])
  f.dispose()
  assert.equal(f.hasListener(), false)
  f.cards.setPanelOpen(true)
  assert.equal(f.native.isExpanded(), true)
})

test('unrelated card changes do not collapse native panel; disposed callbacks do not mutate panels', t => {
  if (!existsSync(sourcePath)) return t.skip('实机客户端缺失（CI 全新检出）')
  const f = fixture(false, false)
  f.native.toggleExpanded()
  f.cards.setPanelOpen(false)
  assert.equal(f.native.isExpanded(), true)
  f.dispose()
  f.cards.setPanelOpen(true)
  f.renderNative()
  assert.equal(f.state.panelOpen, true)
})
