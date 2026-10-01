import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { mayAccessDesktopUpdates, mayAccessNotificationPreferences, mayAccessThemePreferences, mayCloseDesktopSettings, mayGetShellBootstrap, mayInvokeBrowserIpc, mayInvokeShellAction, mayManageBrowserPanel, mayPopupShellMenu, mayReportDshLocale, mayReportDshNotification, mayReportDshState, mayReportDshTheme, mayReportDshSettingsVisibility } from '../src/shell-ipc-policy.js'

test('IPC 权限按 renderer 最小化开放', () => {
  assert.equal(mayGetShellBootstrap('main'), true)
  assert.equal(mayGetShellBootstrap('shortcuts'), true)
  assert.equal(mayGetShellBootstrap('about'), true)
  assert.equal(mayGetShellBootstrap('dsh'), false)
  assert.equal(mayGetShellBootstrap('settings'), true)
  assert.equal(mayGetShellBootstrap('browser-panel'), true)
  assert.equal(mayPopupShellMenu('main'), true)
  assert.equal(mayPopupShellMenu('about'), false)
  assert.equal(mayReportDshState('dsh'), true)
  assert.equal(mayReportDshState('main'), false)
  assert.equal(mayReportDshNotification('dsh'), true)
  assert.equal(mayReportDshNotification('settings'), false)
  assert.equal(mayReportDshLocale('dsh'), true)
  assert.equal(mayReportDshLocale('main'), false)
  assert.equal(mayReportDshTheme('dsh'), true)
  assert.equal(mayReportDshTheme('main'), false)
  assert.equal(mayReportDshSettingsVisibility('dsh'), true)
  assert.equal(mayReportDshSettingsVisibility('main'), false)
  assert.equal(mayAccessNotificationPreferences('settings'), true)
  assert.equal(mayAccessNotificationPreferences('main'), false)
  assert.equal(mayAccessThemePreferences('settings'), true)
  assert.equal(mayAccessThemePreferences('main'), false)
  assert.equal(mayCloseDesktopSettings('settings'), true)
  assert.equal(mayCloseDesktopSettings('main'), false)
  assert.equal(mayAccessDesktopUpdates('settings'), true)
  assert.equal(mayAccessDesktopUpdates('main'), false)
  assert.equal(mayInvokeShellAction('about', 'whats-new'), true)
  assert.equal(mayInvokeShellAction('about', 'feedback'), true)
  assert.equal(mayInvokeShellAction('about', 'quit'), false)
  assert.equal(mayInvokeShellAction('shortcuts', 'quit'), false)
  assert.equal(mayInvokeShellAction('main', 'quit'), true)
  assert.equal(mayManageBrowserPanel('dsh'), true)
  assert.equal(mayManageBrowserPanel('main'), false)
  assert.equal(mayManageBrowserPanel('browser-panel'), false)
  assert.equal(mayInvokeBrowserIpc('browser-panel'), true)
  assert.equal(mayInvokeBrowserIpc('main'), false)
  assert.equal(mayInvokeBrowserIpc('dsh'), false)
})

test('动作准入白名单不再由菜单表推导（顶栏「设置」静默失灵真因的护栏）', async () => {
  // 2026-09-29：main.ts 曾用 `new Set(SHELL_ACTIONS.map(a => a.id))` 当 IPC 准入白名单。
  // 菜单去重把 settings 等 6 个 id 移出菜单表 ⇒ 白名单同步缩小 ⇒ 顶栏「设置」点击
  // 在 `!shellActionIds.has(id)` 处静默 return，控件在、分支在、就是没反应且零报错。
  // 这条断言从源码层钉死"白名单只能来自 SHELL_ACTION_IDS"，防止有人再改回菜单表。
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /const shellActionIds = SHELL_ACTION_IDS/)
  assert.doesNotMatch(main, /new Set<[^>]*>\(SHELL_ACTIONS\.map/)
  assert.doesNotMatch(main, /new Set\(SHELL_ACTIONS\.map/)
})
