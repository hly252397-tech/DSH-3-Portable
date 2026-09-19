import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import { localizedShellActions, SHELL_ACTIONS } from '../src/shell-actions.js'
import { mayInvokeShellAction } from '../src/shell-ipc-policy.js'

// 执行主进程构建产物里的真实实现，只替换 Electron 与外壳状态。
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')
const executable = ['resolveDevToolsContents', 'isActionEnabled', 'executeShellAction', 'popupShellMenu'].map((name) => {
  const declaration = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm').exec(source)?.[0]
  assert.ok(declaration, `未能在构建产物中找到 ${name}`)
  return declaration
}).join('\n')

interface StubContents {
  opened: boolean
  destroyed: boolean
  mode: string
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
  closeDevTools(): void
  openDevTools(options: { mode: string }): void
}

function stubContents(): StubContents {
  return {
    opened: false,
    destroyed: false,
    mode: '',
    isDestroyed() { return this.destroyed },
    isDevToolsOpened() { return this.opened },
    closeDevTools() { this.opened = false },
    openDevTools(options: { mode: string }) { this.opened = true; this.mode = options.mode },
  }
}

test('开发者工具动作与菜单共同指向当前内容页，勾选态跟随真实开关', async () => {
  const workbench = stubContents()
  const settings = stubContents()
  const focus = { settings: false }
  let template: Array<{ label?: string; checked?: boolean; enabled?: boolean }> = []
  const scope = vm.createContext({
    dshView: { webContents: workbench },
    shortcutsWindow: undefined,
    aboutWindow: undefined,
    featurePanelsWindow: undefined,
    settingsWindow: { webContents: settings, isDestroyed: () => false, isFocused: () => focus.settings },
    mainWindow: { isDestroyed: () => false },
    desktopLocale: () => 'zh',
    localizedShellActions,
    process: { platform: 'win32' },
    isRecycling: false,
    lastStartOptions: undefined,
    lastSeedOptions: undefined,
    dshNavigationState: { canBack: false, canForward: false, canPreviousChat: false, canNextChat: false },
    runMainTask: () => undefined,
    dshSettingsDialogVisible: false,
    exitDshSettingsPage: () => {},
    Menu: {
      buildFromTemplate(items: typeof template) {
        template = items
        return { once() {}, popup({ callback }: { callback(): void }) { callback() } }
      },
    },
  })
  vm.runInContext(executable, scope)
  const toggle = async (): Promise<void> => { await vm.runInContext("executeShellAction('toggle-devtools')", scope) as Promise<void> }
  const menuEntry = async () => {
    await vm.runInContext("popupShellMenu({ menu: 'view', x: 0, y: 0 })", scope) as Promise<void>
    return template.find(item => item.label === '开发者工具')
  }

  assert.equal((await menuEntry())?.checked, false)
  await toggle()
  assert.equal(workbench.opened, true)
  assert.equal(workbench.mode, 'detach')
  assert.equal((await menuEntry())?.checked, true)
  await toggle()
  assert.equal(workbench.opened, false)

  // 焦点在设置窗口时调试设置窗口自己，而不是工作台。
  focus.settings = true
  await toggle()
  assert.equal(settings.opened, true)
  assert.equal(workbench.opened, false)
  // 手动关闭调试器后菜单勾选态必须跟着回到未勾选。
  settings.closeDevTools()
  assert.equal((await menuEntry())?.checked, false)

  // 内容页销毁后动作不可用，且调用是安全的空操作。
  settings.destroyed = true
  workbench.destroyed = true
  assert.equal((await menuEntry())?.enabled, false)
  await toggle()
  assert.equal(settings.opened, false)
})

test('开发者工具动作挂在视图菜单并带 F12 / Cmd+Alt+I', () => {
  const action = SHELL_ACTIONS.find(item => item.id === 'toggle-devtools')
  assert.ok(action, '开关动作必须注册在动作表里，否则全局快捷键与菜单都取不到它')
  assert.equal(action.menu, 'view')
  assert.equal(action.accelerator, 'F12')
  assert.equal(action.macAccelerator, 'CmdOrCtrl+Alt+I')
  assert.equal(action.globalShortcut, true)
  assert.equal(localizedShellActions('zh-CN', 'win32').find(item => item.id === 'toggle-devtools')?.label, '开发者工具')
})

test('开发者工具只接受桌面外壳调用，内容视图与辅助窗口一律拒绝', () => {
  assert.equal(mayInvokeShellAction('main', 'toggle-devtools'), true)
  for (const kind of ['dsh', 'about', 'settings', 'shortcuts', 'feature-panels', 'browser-panel', 'unknown'] as const) {
    assert.equal(mayInvokeShellAction(kind, 'toggle-devtools'), false, `${kind} 不应能调用开发者工具`)
  }
})
