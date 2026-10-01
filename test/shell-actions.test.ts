import assert from 'node:assert/strict'
import test from 'node:test'

import { localizedShellActions, localizedShellMenus, normalizeShellLocale, shellActionForShortcut, SHELL_ACTIONS, SHELL_ACTION_IDS, type ShellActionId } from '../src/shell-actions.js'

test('桌面壳动作注册表没有重复命令且四个菜单均有内容', () => {
  assert.equal(new Set(SHELL_ACTIONS.map(action => action.id)).size, SHELL_ACTIONS.length)
  assert.deepEqual(new Set(SHELL_ACTIONS.map(action => action.menu)), new Set(['file', 'edit', 'view', 'help']))
  assert.equal(SHELL_ACTIONS.some(action => action.id === ('browser-toggle' as never)), false)
})

test('桌面壳菜单和动作随 DSH 语言本地化', () => {
  assert.deepEqual(localizedShellMenus('zh-CN').map(menu => menu.label), ['文件', '编辑', '视图', '帮助'])
  assert.deepEqual(localizedShellMenus('en-US').map(menu => menu.label), ['File', 'Edit', 'View', 'Help'])
  assert.equal(localizedShellActions('zh-CN', 'win32').find(action => action.id === 'quit')?.label, '退出')
  assert.equal(localizedShellActions('en-US', 'darwin').find(action => action.id === 'show-shortcuts')?.acceleratorLabel, 'Cmd+/')
  assert.equal(localizedShellActions('zh-CN', 'darwin').find(action => action.id === 'redo')?.acceleratorLabel, 'Cmd+Shift+Z')
})

test('只接受 DSH 当前支持的中英文 locale', () => {
  assert.equal(normalizeShellLocale('zh-CN'), 'zh')
  assert.equal(normalizeShellLocale('en'), 'en')
  assert.equal(normalizeShellLocale('fr-FR'), undefined)
  assert.equal(normalizeShellLocale(null), undefined)
})

test('全局快捷键使用同一动作注册表并正确区分平台修饰键', () => {
  assert.equal(shellActionForShortcut({ key: 'n', control: true, meta: false, alt: false, shift: false }, 'win32'), 'new-chat')
  assert.equal(shellActionForShortcut({ key: 'n', control: false, meta: true, alt: false, shift: false }, 'darwin'), 'new-chat')
  assert.equal(shellActionForShortcut({ key: '=', control: true, meta: false, alt: false, shift: true }, 'win32'), 'zoom-in')
  assert.equal(shellActionForShortcut({ key: ',', control: true, meta: false, alt: false, shift: false }, 'win32'), undefined)
  assert.equal(shellActionForShortcut({ key: 'F11', control: false, meta: false, alt: false, shift: false }, 'win32'), 'toggle-fullscreen')
  assert.equal(shellActionForShortcut({ key: 'F12', control: false, meta: false, alt: false, shift: false }, 'win32'), 'toggle-devtools')
  assert.equal(shellActionForShortcut({ key: 'i', control: false, meta: true, alt: true, shift: false }, 'darwin'), 'toggle-devtools')
  assert.equal(shellActionForShortcut({ key: 'n', control: false, meta: false, alt: false, shift: false }, 'win32'), undefined)
  assert.equal(shellActionForShortcut({ key: 'b', control: true, meta: false, alt: false, shift: true }, 'win32'), undefined)
})

// 2026-09-29 菜单去重的护栏。移除的是"菜单里的重复/无关入口"，不是能力：
// 每一条都另有生效入口（设置页板块 / 设置窗口更新页 / 关于窗口按钮 / 顶栏按钮）。
const OFF_MENU: readonly { id: ShellActionId, elsewhere: string }[] = [
  { id: 'desktop-settings', elsewhere: '设置页「通知」「更新」分区（2026-09-30 拆分后各分区独立成页）' },
  { id: 'settings', elsewhere: '顶栏 #settings-btn' },
  { id: 'check-updates', elsewhere: '设置窗口「更新」页 + 托盘右键菜单' },
  { id: 'whats-new', elsewhere: '关于窗口「查看新功能」按钮' },
  { id: 'feedback', elsewhere: '关于窗口「问题反馈」按钮' },
  { id: 'reload', elsewhere: '顶栏「重启应用」按钮 + 托盘右键菜单' },
]

test('已下线的重复入口不再出现在菜单里', () => {
  const ids = new Set(SHELL_ACTIONS.map(action => action.id))
  for (const { id, elsewhere } of OFF_MENU) {
    assert.equal(ids.has(id), false, `${id} 不应再出现在菜单中（有效入口：${elsewhere}）`)
    assert.equal(localizedShellActions('zh-CN', 'win32').some(action => action.id === id), false)
  }
})

test('下线条目仍保留动作 id，主进程分发分支不得随之删除', () => {
  // 上一版这里只断言 `OFF_MENU.map(...).length === 6`——恒真、什么都没验，
  // 于是在菜单去重把 6 个 id 移出菜单表、连带把它们移出 IPC 白名单后依然全绿，
  // 顶栏「设置」按钮点了没反应且零报错（2026-09-29 实机）。改成真的断言两件事：
  //   ① 这些 id 仍在 ShellActionId 联合里（编译期就会挡住分发分支被删）；
  //   ② 这些 id 仍在 SHELL_ACTION_IDS 白名单里（运行时才拦得住，编译期看不出来）。
  const stillDispatchable: ShellActionId[] = OFF_MENU.map(entry => entry.id)
  assert.equal(stillDispatchable.length, 6)
  for (const { id, elsewhere } of OFF_MENU) {
    assert.equal(SHELL_ACTION_IDS.has(id), true, `${id} 必须仍可从 UI 入口分发（有效入口：${elsewhere}）`)
  }
})

test('动作白名单覆盖 ShellActionId 全集，菜单表不得成为白名单的唯一来源', () => {
  // main.ts 的 ipcMain.handle(SHELL_IPC.action) 用 shellActionIds 做准入，
  // 漏登记 = 那个动作的所有 UI 入口静默失效。这里按联合类型逐个兜住。
  const declared: ShellActionId[] = [
    'new-chat', 'open-folder', 'close-window', 'quit', 'undo', 'redo', 'cut', 'copy', 'paste',
    'delete', 'select-all', 'desktop-settings', 'settings', 'app-restart', 'toggle-sidebar', 'find',
    'previous-chat', 'next-chat', 'home', 'back', 'forward', 'zoom-in', 'zoom-out', 'zoom-reset',
    'toggle-fullscreen', 'toggle-devtools', 'whats-new', 'feedback', 'show-shortcuts', 'reload',
    'check-updates', 'about', 'feature-panels',
  ]
  for (const id of declared) {
    assert.equal(SHELL_ACTION_IDS.has(id), true, `${id} 未登记进 SHELL_ACTION_IDS，其 UI 入口会静默失效`)
  }
  // 反向：白名单不得凭空多出未在联合类型里的 id（防手滑拼错字符串后永远匹配不上）。
  const menuIds = new Set(SHELL_ACTIONS.map(action => action.id))
  for (const id of SHELL_ACTION_IDS) {
    assert.equal(declared.includes(id as ShellActionId) || menuIds.has(id as ShellActionId), true, `白名单里的 ${id} 不在 ShellActionId 联合里`)
  }
})

test('下线的全局快捷键不再触发运行时回收', () => {
  // 重新加载此前占用 Cmd/Ctrl+R；移除后该键位不应命中任何动作。
  assert.equal(shellActionForShortcut({ key: 'r', control: true, meta: false, alt: false, shift: false }, 'win32'), undefined)
  assert.equal(shellActionForShortcut({ key: 'r', control: false, meta: true, alt: false, shift: false }, 'darwin'), undefined)
})

test('每个菜单的分组号自 0 连续，渲染时不产生尾部空分隔线', () => {
  for (const menu of ['file', 'edit', 'view', 'help'] as const) {
    const groups = SHELL_ACTIONS.filter(action => action.menu === menu).map(action => action.group)
    assert.ok(groups.length > 0, `${menu} 菜单不应为空`)
    // popupShellMenu 只在 group 变化处插分隔线：分组必须非降序，且取值从 0 起连续，
    // 否则删除条目后会留下空洞或尾部分隔线。
    assert.deepEqual(groups, [...groups].sort((a, b) => a - b), `${menu} 的分组应非降序排列`)
    const distinct = [...new Set(groups)]
    assert.deepEqual(distinct, distinct.map((_, index) => index), `${menu} 的分组号必须从 0 起连续`)
  }
})

test('去重后菜单规模符合预期', () => {
  const count = (menu: string): number => SHELL_ACTIONS.filter(action => action.menu === menu).length
  assert.deepEqual({ file: count('file'), edit: count('edit'), view: count('view'), help: count('help') }, { file: 5, edit: 7, view: 13, help: 2 })
  // 合计也必须钉住（去重前 33）。此前合计只存在于文档散文里、被手算成 30→26 而无人发现：
  // 分项断言全绿，错的只有没人校验的那个总数。见 20260929-顶栏菜单去重.md §3 更正说明。
  assert.equal(SHELL_ACTIONS.length, 27)
})
