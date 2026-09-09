import type { ShellActionId } from './shell-actions.js'

export type ShellRendererKind = 'main' | 'browser-panel' | 'shortcuts' | 'about' | 'settings' | 'feature-panels' | 'dsh' | 'unknown'

export function mayGetShellBootstrap(kind: ShellRendererKind): boolean {
  return kind === 'main' || kind === 'browser-panel' || kind === 'shortcuts' || kind === 'about' || kind === 'settings' || kind === 'feature-panels'
}

export function mayInvokeShellAction(kind: ShellRendererKind, id: ShellActionId): boolean {
  if (kind === 'main') return true
  if (kind === 'about') return id === 'whats-new' || id === 'feedback'
  // dsh 内容视图仅授权「重启应用」这一个动作（侧栏入口），其余 shell 动作一律不放行。
  if (kind === 'dsh') return id === 'app-restart'
  return false
}

export function mayInvokeBrowserIpc(kind: ShellRendererKind): boolean {
  return kind === 'browser-panel'
}

/** DSH 内容区只可挂载、卸载和定位浏览器面板，不能获得浏览器管理权限。 */
export function mayManageBrowserPanel(kind: ShellRendererKind): boolean {
  return kind === 'dsh'
}

export function mayPopupShellMenu(kind: ShellRendererKind): boolean {
  return kind === 'main'
}

export function mayReportDshState(kind: ShellRendererKind): boolean {
  return kind === 'dsh'
}

export function mayReportDshNotification(kind: ShellRendererKind): boolean {
  return kind === 'dsh'
}

export function mayReportDshLocale(kind: ShellRendererKind): boolean {
  return kind === 'dsh'
}

export function mayReportDshTheme(kind: ShellRendererKind): boolean {
  return kind === 'dsh'
}

export function mayReportDshSettingsVisibility(kind: ShellRendererKind): boolean {
  return kind === 'dsh'
}

export function mayAccessNotificationPreferences(kind: ShellRendererKind): boolean {
  return kind === 'settings'
}

export function mayAccessThemePreferences(kind: ShellRendererKind): boolean {
  return kind === 'settings'
}

export function mayAccessDesktopUpdates(kind: ShellRendererKind): boolean {
  return kind === 'settings'
}

export function mayCloseDesktopSettings(kind: ShellRendererKind): boolean {
  return kind === 'settings'
}

/** 仅「功能板块」开发态窗口能调文件路径复制；其它 renderer 一律拒绝。 */
export function mayInvokeFeaturePanelsCopy(kind: ShellRendererKind): boolean {
  return kind === 'feature-panels'
}
