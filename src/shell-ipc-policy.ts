import type { ShellActionId } from './shell-actions.js'

export type ShellRendererKind = 'main' | 'shortcuts' | 'about' | 'settings' | 'dsh' | 'unknown'

export function mayGetShellBootstrap(kind: ShellRendererKind): boolean {
  return kind === 'main' || kind === 'shortcuts' || kind === 'about' || kind === 'settings'
}

export function mayInvokeShellAction(kind: ShellRendererKind, id: ShellActionId): boolean {
  if (kind === 'main') return true
  if (kind === 'about') return id === 'whats-new' || id === 'feedback'
  // dsh 内容视图仅授权「重启应用」这一个动作（侧栏入口），其余 shell 动作一律不放行。
  if (kind === 'dsh') return id === 'app-restart'
  return false
}

export function mayInvokeBrowserIpc(kind: ShellRendererKind): boolean {
  return kind === 'main'
}

export function mayInvokeBrowserPanelIpc(kind: ShellRendererKind): boolean {
  return kind === 'main' || kind === 'dsh'
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

export function mayAccessDesktopUpdates(kind: ShellRendererKind): boolean {
  return kind === 'settings'
}

export function mayCloseDesktopSettings(kind: ShellRendererKind): boolean {
  return kind === 'settings'
}
