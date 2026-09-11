import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { normalizeNativeBrowserRequest } from '../src/native-browser-request.js'

// 实机 profile 里的 better-sidebar 产物；全新检出（如 CI）缺失时相关用例跳过。
const browserViewPath = new URL('../../Data/DSH/profiles/web/local/dsh-better-sidebar/portable/browser-view.js', import.meta.url)
const haveLiveBrowserView = existsSync(browserViewPath)

test('browser cards accept web URLs but cannot open privileged schemes or the DSH origin', () => {
  const self = 'http://127.0.0.1:3080'
  assert.deepEqual(normalizeNativeBrowserRequest({ owner: 'card-1', url: 'https://example.com' }, self), { owner: 'card-1', url: 'https://example.com/' })
  assert.deepEqual(normalizeNativeBrowserRequest({ owner: 'card-2' }, self), { owner: 'card-2' })
  assert.equal(normalizeNativeBrowserRequest({ owner: 'card-1', url: 'http://127.0.0.1:9090' }, self).url, 'http://127.0.0.1:9090/')
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'http://127.0.0.1:3080/settings', 'https://user:secret@example.com', 'invalid']) {
    assert.throws(() => normalizeNativeBrowserRequest({ owner: 'card-1', url }, self))
  }
  for (const value of [null, {}, { owner: '../bad' }, { owner: 'x'.repeat(101) }]) assert.throws(() => normalizeNativeBrowserRequest(value, self))
})

async function componentHarness(show: () => Promise<unknown> = async () => ({})) {
  const source = await readFile(browserViewPath, 'utf8')
  const effects: Array<() => (() => void) | undefined> = []
  const calls: Array<[string, any]> = []
  const frames: Array<() => void> = []
  let changed = () => {}
  let closed = () => {}
  let overlays: any[] = []
  const context: any = {
    crypto: { randomUUID: () => 'unique' },
    window: { dshDesktopShell: { browserPanel: {
      version: 1,
      show: (input: unknown) => { calls.push(['show', input]); return show() },
      hide: async (owner: string) => { calls.push(['hide', owner]) },
      reportBounds: (bounds: unknown) => calls.push(['bounds', bounds]),
      setOccluded: async (value: boolean, owner: string) => { calls.push(['occluded', { value, owner }]) },
      onCloseRequested: (fn: () => void) => { closed = fn; return () => calls.push(['unsubscribe', null]) },
    } } },
    document: { body: {}, querySelectorAll: () => overlays },
    MutationObserver: class { constructor(fn: () => void) { changed = fn } observe() {} disconnect() { calls.push(['disconnect', null]) } },
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length },
    cancelAnimationFrame: () => calls.push(['cancel', null]),
    getComputedStyle: () => ({ visibility: 'visible' }),
  }
  runInNewContext(source.replace('export function ', 'function ') + '\nthis.factory = createNativeBrowserView;', context)
  const react = {
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [value, (next: unknown) => calls.push(['state', next])],
    useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  }
  const View = context.factory(react, (key: string) => key)
  const element = View({ visible: true, tab: { id: 'browser:1', path: 'https://example.com/' }, scope: { sessionId: 'test' }, ctx: { get: () => ({ closeTab: (id: string) => calls.push(['closeTab', id]) }) } })
  element.props.ref.current = { getBoundingClientRect: () => ({ x: 500, y: 100, width: 400, height: 500, left: 500, right: 900, top: 100, bottom: 600 }) }
  return { calls, frames, start: effects[0], close: () => closed(), resize: (width: number, height: number) => {
    element.props.ref.current.getBoundingClientRect = () => ({ x: 500, y: 100, width, height, left: 500, right: 500 + width, top: 100, bottom: 100 + height })
  }, overlay: () => {
    overlays = [{ contains: () => false, isConnected: true, getClientRects: () => [1], getBoundingClientRect: () => ({ left: 550, right: 800, top: 110, bottom: 250 }) }]
    changed()
  } }
}

test('a card smaller than the native viewport minimum hides the browser and recovers after resize', async t => {
  if (!haveLiveBrowserView) return t.skip('实机 better-sidebar 产物缺失（CI 全新检出）')

  const h = await componentHarness()
  const dispose = h.start()!
  await Promise.resolve()
  h.resize(200, 180)
  h.frames.shift()!()
  assert.equal(h.calls.filter(([name]) => name === 'occluded').at(-1)![1].value, true)
  h.resize(400, 500)
  h.frames.shift()!()
  assert.equal(h.calls.filter(([name]) => name === 'occluded').at(-1)![1].value, false)
  dispose()
})

test('native card mounts the shared browser, tracks its bounds, yields to dialogs and releases ownership', async t => {
  if (!haveLiveBrowserView) return t.skip('实机 better-sidebar 产物缺失（CI 全新检出）')

  const h = await componentHarness()
  const dispose = h.start()!
  await Promise.resolve()
  assert.equal(h.calls.find(([name]) => name === 'show')![1].url, 'https://example.com/')
  assert.equal(h.calls.find(([name]) => name === 'bounds')![1].x, 500)
  h.overlay(); h.frames.shift()!(); await Promise.resolve()
  assert.equal(h.calls.filter(([name]) => name === 'occluded').at(-1)![1].value, true)
  h.close(); assert.ok(h.calls.some(([name, id]) => name === 'closeTab' && id === 'browser:1'))
  dispose()
  assert.ok(h.calls.some(([name, owner]) => name === 'hide' && owner === 'sidebar-browser-unique'))
  assert.ok(h.calls.some(([name]) => name === 'disconnect'))
  assert.ok(h.calls.some(([name]) => name === 'unsubscribe'))
})

test('an unmounted card cannot resume its render loop when a delayed show finishes', async t => {
  if (!haveLiveBrowserView) return t.skip('实机 better-sidebar 产物缺失（CI 全新检出）')

  let resolveShow!: () => void
  const h = await componentHarness(() => new Promise<void>(resolve => { resolveShow = resolve }))
  h.start()!()
  resolveShow(); await Promise.resolve()
  assert.equal(h.frames.length, 0)
  assert.equal(h.calls.filter(([name]) => name === 'bounds').length, 0)
})
