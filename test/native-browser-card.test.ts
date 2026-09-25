import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { normalizeNativeBrowserRequest } from '../src/native-browser-request.js'

// 实机 profile 里的 better-sidebar 产物；全新检出（如 CI）缺失时相关用例跳过。
const browserViewPath = new URL('../../Data/DSH/profiles/web/local/dsh-better-sidebar/portable/browser-view.js', import.meta.url)
const embeddedBrowserViewPath = new URL('../../Data/DSH/profiles/web/local/dsh-better-sidebar/portable/embedded-browser-view.js', import.meta.url)
const sidebarCssPath = new URL('../../Data/DSH/profiles/web/local/dsh-better-sidebar/src/client/sidebar.module.css', import.meta.url)
const browserBundlePath = new URL('../../Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js', import.meta.url)
const desktopMainPath = resolve('src/main.ts')
const haveLiveBrowserView = existsSync(browserViewPath)

test('the deployed browser client contains only the card-owned embedded backend', async t => {
  if (!existsSync(embeddedBrowserViewPath) || !existsSync(browserBundlePath)) return t.skip('实机 better-sidebar 产物缺失（CI 全新检出）')
  const source = await readFile(embeddedBrowserViewPath, 'utf8')
  const bundle = await readFile(browserBundlePath, 'utf8')
  assert.ok(bundle.includes(source.replace('export function ', 'function ')), 'browser client was not rebuilt from the embedded source')
  assert.doesNotMatch(bundle, /createNativeBrowserView|NativeBrowserView/, 'the old native browser card must not be packaged')
})

test('embedded browser is the only backend and keeps sibling webviews', async t => {
  if (!existsSync(embeddedBrowserViewPath) || !existsSync(browserBundlePath)) return t.skip('实机 embedded browser 产物缺失（CI 全新检出）')
  const source = await readFile(embeddedBrowserViewPath, 'utf8')
  const bundle = await readFile(browserBundlePath, 'utf8')
  const main = await readFile(desktopMainPath, 'utf8')
  assert.doesNotMatch(main, /browserPanelView|DSH_EMBEDDED_BROWSER|tab\.view/, 'the old pixel-positioned browser layer must not return')
  assert.equal((main.match(/new WebContentsView\(/g) ?? []).length, 1, 'only the DSH document may use a WebContentsView')
  const navigateHandler = main.slice(main.indexOf('ipcMain.handle(SHELL_IPC.browserNavigate'), main.indexOf('ipcMain.removeHandler(SHELL_IPC.browserBack'))
  assert.match(navigateHandler, /scheduleBrowserWorkspaceSave\(\)/,
    'address-bar navigation must persist even if webview guest navigation events differ')
  if (bundle.includes('const EmbeddedBrowserView = createEmbeddedBrowserView(')) {
    assert.ok(bundle.includes(source.replace('export function ', 'function ')), 'candidate client was not rebuilt from its source')
  }
  assert.match(source, /chrome\.setAttribute\('partition', config\.chromePartition\)/)
  assert.match(source, /view\.setAttribute\('partition', config\.pagePartition\)/)
  assert.match(source, /view\.getWebContentsId\?\.\(\)/)
  assert.match(source, /document\.body\.append\(root\)/, 'candidate webviews must retain one DOM host during card switches')
  assert.match(source, /if \(!activeHost\?\.isConnected \|\| root\.style\.visibility !== 'visible'\) return;/,
    'a tab restored for another session must not create its guest while the card is parked off-screen')
  assert.match(source, /if \(!wasVisible && root\.style\.visibility === 'visible'\) render\(\);/,
    'the restored guest must be created when the card becomes visible')
  assert.match(source, /display:flex/, 'Electron webview display must remain flex for full-height painting')
  assert.match(source, /root\.style\.left = '-10000px';[\s\S]*root\.style\.visibility = 'hidden';/,
    'parked guests must leave the visible card area, not rely on visibility alone')
  assert.match(source, /explicitNavigation \|\| !hasExistingTabs/,
    'a stale card path must not replace the current full-browser address')
  if (existsSync(sidebarCssPath)) {
    const css = await readFile(sidebarCssPath, 'utf8')
    const panelLayer = Number(css.match(/:global\(\[data-dsh-panel-host\]\)\s*\{[^}]*z-index:\s*(\d+)/)?.[1])
    const browserLayer = Number(source.match(/root\.style\.cssText\s*=\s*'[^']*z-index:(\d+)/)?.[1])
    assert.ok(browserLayer > panelLayer && browserLayer < 100,
      `embedded browser layer ${browserLayer} must paint above workbench ${panelLayer} but below app overlays`)
  }
  assert.doesNotMatch(source, /createElement\(['"]iframe['"]/, 'ERP must not fall back to an iframe')
})

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

test('full browser card claims its desktop view during layout and does not render an iframe', async t => {
  if (!haveLiveBrowserView) return t.skip('实机 better-sidebar 产物缺失（CI 全新检出）')
  const source = await readFile(browserViewPath, 'utf8')
  assert.match(source, /react\.useLayoutEffect\(\(\) => \{/, '首次可见提交必须在 layout effect 认领浏览器')
  assert.doesNotMatch(source, /createElement\(['"]iframe['"]/, '卡片不得退回第二套 iframe 浏览器')
  const calls: Array<[string, any]> = []
  const context: any = {
    crypto: { randomUUID: () => 'test-owner' },
    document: { body: {}, querySelectorAll: () => [] },
    MutationObserver: class { observe() {} disconnect() {} },
    cancelAnimationFrame: () => {},
    window: {
      dshDesktopShell: { browserPanel: {
        version: 1,
        show: (request: unknown) => { calls.push(['show', request]); return new Promise(() => {}) },
        hide: async (owner: string) => { calls.push(['hide', owner]) },
        onCloseRequested: () => () => {},
      } },
    },
  }
  runInNewContext(source.replace('export function ', 'function ') + '\nthis.factory = createNativeBrowserView;', context)
  const layoutEffects: Array<() => void | (() => void)> = []
  const passiveEffects: Array<() => void | (() => void)> = []
  const react = {
    useRef: (v: unknown) => ({ current: v }),
    useState: (v: unknown) => [v, () => {}],
    useLayoutEffect: (effect: () => void | (() => void)) => layoutEffects.push(effect),
    useEffect: (effect: () => void | (() => void)) => passiveEffects.push(effect),
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  }
  const View = context.factory(react, (k: string) => k)
  const card = View({ visible: true, tab: { id: 'b1', path: 'http://127.0.0.1:8975/index.html' }, scope: {}, ctx: { get: () => ({}) } })
  assert.equal(card.type, 'div')
  assert.equal(layoutEffects.length, 1)
  assert.equal(passiveEffects.length, 0)
  layoutEffects[0]!()
  assert.equal(calls[0]?.[0], 'show')
  assert.equal(calls[0]?.[1]?.owner, 'sidebar-browser-test-owner')
  assert.equal(calls[0]?.[1]?.url, 'http://127.0.0.1:8975/index.html')
})

test('visible browser card reclaims a desktop lease lost after a tab switch', async t => {
  if (!haveLiveBrowserView) return t.skip('实机 better-sidebar 产物缺失（CI 全新检出）')
  const source = await readFile(browserViewPath, 'utf8')
  const shows: Array<{ owner: string; url?: string }> = []
  let desktopOwner: string | null = null
  let now = 0
  let frame: (() => void) | undefined
  const bridge = {
    version: 1,
    show: async (request: { owner: string; url?: string }) => { shows.push(request); desktopOwner = request.owner },
    hide: async () => { desktopOwner = null },
    tabs: async () => ({ owner: desktopOwner }),
    reportBounds: () => {},
    setOccluded: () => new Promise(() => {}),
    onCloseRequested: () => () => {},
  }
  const context: any = {
    crypto: { randomUUID: () => 'reclaim-owner' },
    document: { body: {}, documentElement: {}, querySelectorAll: () => [] },
    getComputedStyle: () => ({ getPropertyValue: () => '1' }),
    performance: { now: () => now },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: () => void) => { frame = callback; return 1 },
    cancelAnimationFrame: () => {},
    window: { dshDesktopShell: { browserPanel: bridge } },
  }
  runInNewContext(source.replace('export function ', 'function ') + '\nthis.factory = createNativeBrowserView;', context)
  let effect: (() => void | (() => void)) | undefined
  const react = {
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [value, () => {}],
    useLayoutEffect: (callback: () => void | (() => void)) => { effect = callback },
    createElement: (type: unknown, props: unknown) => ({ type, props }),
  }
  const View = context.factory(react, (key: string) => key)
  const card = View({ visible: true, tab: { id: 'b1' }, scope: {}, ctx: { get: () => ({}) } })
  card.props.ref.current = { getBoundingClientRect: () => ({ x: 790, y: 42, width: 563, height: 807 }) }
  effect!()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(shows.length, 1)
  assert.ok(frame, 'the visible card must keep its bounds and lease heartbeat running')
  desktopOwner = null // a late hide or hidden-card signal revoked the just-opened native view
  now = 1200
  frame!()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(shows.length, 2)
  assert.equal(shows[1]?.owner, 'sidebar-browser-reclaim-owner')
  assert.equal(shows[1]?.url, undefined, 'reclaim must reuse the existing page, not open a duplicate tab')
})
