import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const sourceUrl = new URL('../Data/DSH/profiles/web/local/dsh-better-sidebar/src/client/state.ts', import.meta.url)
const sidebarUrl = new URL('../Data/DSH/profiles/web/local/dsh-better-sidebar/src/client/Sidebar.tsx', import.meta.url)
const bundleUrl = new URL('../Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js', import.meta.url)
const havePlugin = existsSync(sourceUrl) && existsSync(sidebarUrl) && existsSync(bundleUrl)

test('right-workbench presentation follows one global preference while tabs stay session-owned', async t => {
  if (!havePlugin) return t.skip('实机 better-sidebar 产物缺失（CI 全新检出）')
  const entries = new Map<string, string>()
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const fakeWindow = { innerWidth: 1330, innerHeight: 900, location: { search: '' }, setTimeout, clearTimeout }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value) },
      removeItem: (key: string) => { entries.delete(key) },
    },
  })
  try {
    const state = await import(sourceUrl.href)
    const first = state.makeDefaultState(380, true)
    const second = state.makeDefaultState(550, false)
    first.bottomOpen = false
    second.bottomOpen = true
    second.bottomHeight = 310
    assert.equal(second.splits.kind, 'leaf')
    if (second.splits.kind === 'leaf') second.splits.tabs[0]!.title = 'Only B'
    entries.set('dsh-sidebar:v1:A', JSON.stringify(first))
    entries.set('dsh-sidebar:v1:B', JSON.stringify(second))

    const store = state.createSidebarStore()
    store.setSession('A')
    assert.equal(store.getSnapshot().state?.panelOpen, true)
    assert.equal(store.getSnapshot().state?.bottomOpen, false)
    store.setSession('B')
    assert.equal(store.getSnapshot().state?.panelOpen, true)
    assert.equal(store.getSnapshot().state?.bottomOpen, false)
    assert.equal(store.getSnapshot().state?.width, 380) // first visited session establishes a shared width
    assert.equal(store.getSnapshot().state?.splits.kind, 'leaf')
    if (store.getSnapshot().state?.splits.kind === 'leaf') {
      assert.equal(store.getSnapshot().state!.splits.tabs[0]!.title, 'Only B')
    }

    store.reduce((s: Record<string, unknown>) => ({ ...s, panelOpen: false, bottomOpen: true, bottomHeight: 325, width: 470 }))
    store.setSession('A')
    assert.equal(store.getSnapshot().state?.panelOpen, false)
    assert.equal(store.getSnapshot().state?.bottomOpen, true)
    assert.equal(store.getSnapshot().state?.bottomHeight, 325)
    assert.equal(store.getSnapshot().state?.width, 470)
    if (store.getSnapshot().state?.splits.kind === 'leaf') {
      assert.equal(store.getSnapshot().state!.splits.tabs[0]!.title, 'Files')
    }

    store.reduceFor('B', (s: Record<string, unknown>) => ({ ...s, panelOpen: true, bottomOpen: false, bottomHeight: 180 }))
    assert.equal(JSON.parse(entries.get('dsh-sidebar:v1:presentation')!).panelOpen, false)
    store.setSession('B')
    assert.equal(store.getSnapshot().state?.panelOpen, false)
    assert.equal(store.getSnapshot().state?.bottomOpen, true)
    assert.equal(store.getSnapshot().state?.bottomHeight, 325)
    const reloaded = state.createSidebarStore()
    reloaded.setSession('A')
    assert.equal(reloaded.getSnapshot().state?.panelOpen, false)
    assert.equal(reloaded.getSnapshot().state?.bottomOpen, true)
    assert.equal(reloaded.getSnapshot().state?.bottomHeight, 325)

    store.reduce((s: Record<string, unknown>) => ({ ...s, panelOpen: true }))
    fakeWindow.innerWidth = 600
    store.setSession('N')
    assert.equal(store.getSnapshot().state?.panelOpen, false, 'narrow drawers remain opt-in')
    store.reduce((s: Record<string, unknown>) => ({ ...s, panelOpen: true, width: 300 }))
    assert.equal(JSON.parse(entries.get('dsh-sidebar:v1:presentation')!).panelOpen, true, 'narrow drawer does not overwrite desktop preference')
    assert.equal(entries.get('dsh-sidebar:v1:width'), '470', 'narrow drawer does not overwrite desktop width')
    fakeWindow.innerWidth = 1330
    store.setSession('A')
    assert.equal(store.getSnapshot().state?.panelOpen, true)
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('the shipped client and source both guard session switches from auto-opening a terminal', t => {
  if (!havePlugin) return t.skip('实机 better-sidebar 产物缺失（CI 全新检出）')
  const source = readFileSync(sourceUrl, 'utf8')
  const sidebar = readFileSync(sidebarUrl, 'utf8')
  const bundle = readFileSync(bundleUrl, 'utf8')
  for (const code of [source, bundle]) {
    assert.match(code, /dsh-sidebar:v1:presentation/)
    assert.match(code, /adoptGlobalPresentation/)
    assert.match(code, /writeGlobalPresentation\(state\)/)
  }
  for (const code of [sidebar, bundle]) {
    assert.match(code, /previous\.sessionId !== sessionId/)
    assert.match(code, /bottomWasOpenRef\.current = \{ sessionId, open: state\.bottomOpen \}/)
  }
})
