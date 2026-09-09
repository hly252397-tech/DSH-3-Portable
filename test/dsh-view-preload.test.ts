import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const resolveThemeSource = async (): Promise<string> => {
  const candidatePaths = [
    path.resolve(process.cwd(), 'assets/theme.css'),
    path.resolve(process.cwd(), 'dist', 'assets', 'theme.css'),
    fileURLToPath(new URL('../assets/theme.css', import.meta.url)),
  ]
  for (const candidate of candidatePaths) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {}
  }
  const last = candidatePaths[candidatePaths.length - 1]
  return readFile(last, 'utf8')
}

test('桌面主题同时同步官方 body 深色标记和 DSH 变量作用域', async () => {
  const source = await readFile(new URL('../src/dsh-view-preload.cjs', import.meta.url), 'utf8')
  const listeners = new Map<string, (...args: any[]) => void>()
  const root = { dataset: {} as Record<string, string>, lang: 'zh-CN', style: { colorScheme: '' } }
  const attributes = new Set<string>()
  const body = {
    dataset: {} as Record<string, string>,
    toggleAttribute(name: string, force: boolean): void {
      if (force) attributes.add(name)
      else attributes.delete(name)
    },
  }
  const document = {
    body,
    documentElement: root,
    addEventListener(): void {},
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  vm.runInNewContext(source, {
    exports: {},
    module: { exports: {} },
    require: () => ({
      contextBridge: { exposeInMainWorld(): void {} },
      ipcRenderer: {
        on(channel: string, listener: (...args: any[]) => void): void { listeners.set(channel, listener) },
        removeListener(): void {},
        send(): void {},
      },
    }),
    window: { addEventListener(): void {} },
    document,
    MutationObserver: class { observe(): void {} },
    setTimeout: (callback: () => void) => { callback(); return 0 },
  })

  const apply = listeners.get('dsh-shell:desktop-theme')
  assert.ok(apply)
  apply({}, { colorScheme: 'dark', preset: 'verde' })
  assert.equal(root.style.colorScheme, 'dark')
  assert.equal(root.dataset.colorScheme, 'dark')
  assert.equal(root.dataset.dshPreset, 'verde')
  assert.equal(body.dataset.colorScheme, 'dark')
  assert.equal(body.dataset.dshPreset, 'verde')
  assert.equal(attributes.has('data-ds-dark-theme'), true)

  apply({}, { colorScheme: 'light', preset: 'lake' })
  assert.equal(attributes.has('data-ds-dark-theme'), false)
  assert.equal(body.dataset.dshPreset, 'lake')
})

test('全局主题样式覆盖官方画布、侧栏、浮层和交互语义变量', async () => {
  const source = await resolveThemeSource()
  for (const token of [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-specific-sidebar-fill',
    '--dsw-specific-menu',
    '--dsw-specific-input-major',
  ]) assert.match(source, new RegExp(`${token.replaceAll('-', '\\-')}:`))
  assert.match(source, /body\[data-dsh-preset\]/)
})

test('client bridge 卸载后重新启用 DOM fallback', async () => {
  const source = await readFile(new URL('../src/dsh-view-preload.cjs', import.meta.url), 'utf8')
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  let exposed: { onAction(listener: (id: string) => void): () => void; onOpenSession(listener: (id: string) => void): () => void; onNotificationReply(listener: (value: { sessionId: string; text: string }) => void): () => void; reportState(state: unknown): void; reportNotification(event: unknown): void; reportLocale(locale: unknown): void; reportTheme(colorScheme: unknown): void; browserPanel: { show(): Promise<void>; hide(): Promise<void>; prepareOcclusion(): Promise<unknown>; setOccluded(occluded: boolean): Promise<void>; reportBounds(bounds: unknown): void; onCloseRequested(listener: () => void): () => void } } | undefined
  const sent: string[] = []
  let clicks = 0
  const button = {
    offsetParent: {},
    getAttribute: () => null,
    textContent: '新建任务',
    click: () => { clicks += 1 },
  }
  const ipcRenderer = {
    on(channel: string, listener: (...args: unknown[]) => void): void {
      listeners.set(channel, [...listeners.get(channel) ?? [], listener])
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void): void {
      listeners.set(channel, (listeners.get(channel) ?? []).filter(item => item !== listener))
    },
    send(channel: string): void { sent.push(channel) },
    invoke(channel: string): Promise<void> { sent.push(channel); return Promise.resolve() },
  }
  vm.runInNewContext(source, {
    exports: {},
    module: { exports: {} },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, api: typeof exposed) => { exposed = api } },
      ipcRenderer,
    }),
    window: { addEventListener(): void {} },
    document: { body: {}, documentElement: { lang: 'zh-CN' }, addEventListener(): void {}, querySelectorAll: () => [button], querySelector: () => null },
    MutationObserver: class { observe(): void {} },
    setTimeout: (callback: () => void) => { callback(); return 0 },
  })
  assert.ok(exposed)
  const unregister = exposed.onAction(() => {})
  const unregisterOpen = exposed.onOpenSession(() => {})
  const unregisterReply = exposed.onNotificationReply(() => {})
  exposed.reportState({})
  exposed.reportNotification({ type: 'dismiss', sessionId: 'a' })
  exposed.reportLocale('en')
  exposed.reportTheme({ colorScheme: 'light', preference: 'light' })
  exposed.browserPanel.reportBounds({ x: 1, y: 2, width: 300, height: 400 })
  await exposed.browserPanel.show()
  await exposed.browserPanel.prepareOcclusion()
  await exposed.browserPanel.setOccluded(true)
  await exposed.browserPanel.hide()
  assert.equal(sent.includes('dsh-shell:browser-panel-bounds'), true)
  assert.equal(sent.includes('dsh-shell:browser-panel-show'), true)
  assert.equal(sent.includes('dsh-shell:browser-panel-prepare-occlusion'), true)
  assert.equal(sent.includes('dsh-shell:browser-panel-occluded'), true)
  assert.equal(sent.includes('dsh-shell:browser-panel-hide'), true)
  unregister()
  unregisterOpen()
  unregisterReply()
  for (const listener of listeners.get('dsh-shell:dsh-action') ?? []) listener({}, 'new-chat')
  assert.equal(clicks, 1)
})

test('DSH 设置对话框可由 Escape 关闭', async () => {
  const source = await readFile(new URL('../src/dsh-view-preload.cjs', import.meta.url), 'utf8')
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  let clicks = 0
  const close = {
    getAttribute: () => null,
    textContent: '关闭',
    click: () => { clicks += 1 },
  }
  const dialog = {
    getAttribute: (name: string) => name === 'aria-labelledby' ? 'settings-title' : null,
    offsetParent: {},
    querySelectorAll: () => [close],
    querySelector: () => close,
  }
  const document = {
    body: {},
    documentElement: { lang: 'zh-CN', style: { colorScheme: 'light' } },
    activeElement: null,
    addEventListener(type: string, listener: (...args: any[]) => void): void {
      listeners.set(type, [...listeners.get(type) ?? [], listener])
    },
    getElementById: (id: string) => id === 'settings-title' ? { getAttribute: () => null, textContent: '设置' } : null,
    querySelectorAll: (selector: string) => selector.includes('[role="dialog"]') ? [dialog] : [],
    querySelector: () => null,
  }
  const ipcRenderer = { on(): void {}, removeListener(): void {}, send(): void {} }
  vm.runInNewContext(source, {
    exports: {},
    module: { exports: {} },
    require: () => ({ contextBridge: { exposeInMainWorld(): void {} }, ipcRenderer }),
    window: { addEventListener: (type: string, listener: () => void) => { if (type === 'DOMContentLoaded') listener() } },
    document,
    MutationObserver: class { observe(): void {} },
    setTimeout: (callback: () => void) => { callback(); return 0 },
  })
  let prevented = false
  let stopped = false
  for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Escape', preventDefault: () => { prevented = true }, stopImmediatePropagation: () => { stopped = true } })
  assert.equal(clicks, 1)
  assert.equal(prevented, true)
  assert.equal(stopped, true)
})

test('Escape 不会拦截非设置对话框，也不会误点关闭会话', async () => {
  const source = await readFile(new URL('../src/dsh-view-preload.cjs', import.meta.url), 'utf8')
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  let clicks = 0
  const closeSession = { getAttribute: () => null, textContent: '关闭会话', click: () => { clicks += 1 } }
  const dialog = {
    getAttribute: (name: string) => name === 'aria-labelledby' ? 'confirm-title' : name === 'aria-modal' ? 'true' : null,
    offsetParent: {},
    querySelectorAll: () => [closeSession],
  }
  const document = {
    body: {}, documentElement: { lang: 'zh-CN', style: { colorScheme: 'light' } }, activeElement: null,
    addEventListener(type: string, listener: (...args: any[]) => void): void { listeners.set(type, [...listeners.get(type) ?? [], listener]) },
    getElementById: (id: string) => id === 'confirm-title' ? { getAttribute: () => null, textContent: '确认删除' } : null,
    querySelectorAll: (selector: string) => selector.includes('[role="dialog"]') ? [dialog] : [],
    querySelector: () => null,
  }
  const ipcRenderer = { on(): void {}, removeListener(): void {}, send(): void {} }
  vm.runInNewContext(source, { exports: {}, module: { exports: {} }, require: () => ({ contextBridge: { exposeInMainWorld(): void {} }, ipcRenderer }), window: { addEventListener: (type: string, listener: () => void) => { if (type === 'DOMContentLoaded') listener() } }, document, MutationObserver: class { observe(): void {} }, setTimeout: (callback: () => void) => { callback(); return 0 } })
  let prevented = false
  for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Escape', preventDefault: () => { prevented = true }, stopImmediatePropagation(): void {} })
  assert.equal(clicks, 0)
  assert.equal(prevented, false)
})
