import type { LocalizedShellAction, LocalizedShellMenu, ShellActionId, ShellMenuId } from './shell-actions.js'

export const SHELL_BAR_HEIGHT = 40

export const SHELL_IPC = {
  action: 'dsh-shell:action',
  getBootstrap: 'dsh-shell:get-bootstrap',
  popupMenu: 'dsh-shell:popup-menu',
  state: 'dsh-shell:state',
  bootstrap: 'dsh-shell:bootstrap',
  dshAction: 'dsh-shell:dsh-action',
  dshLocale: 'dsh-shell:dsh-locale',
  dshTheme: 'dsh-shell:dsh-theme',
  dshSettingsVisibility: 'dsh-shell:dsh-settings-visibility',
  dshOpenSession: 'dsh-shell:dsh-open-session',
  dshNotificationReply: 'dsh-shell:dsh-notification-reply',
  dshState: 'dsh-shell:dsh-state',
  dshNotification: 'dsh-shell:dsh-notification',
  getNotificationPreferences: 'dsh-shell:get-notification-preferences',
  updateNotificationPreferences: 'dsh-shell:update-notification-preferences',
  getUpdatePreferences: 'dsh-shell:get-update-preferences',
  updateUpdatePreferences: 'dsh-shell:update-update-preferences',
  getDesktopUpdateState: 'dsh-shell:get-desktop-update-state',
  desktopUpdateAction: 'dsh-shell:desktop-update-action',
  desktopUpdateState: 'dsh-shell:desktop-update-state',
  getHarnessUpdateState: 'dsh-shell:get-harness-update-state',
  updateHarnessUpdatePolicy: 'dsh-shell:update-harness-update-policy',
  harnessUpdateAction: 'dsh-shell:harness-update-action',
  harnessUpdateState: 'dsh-shell:harness-update-state',
  settingsSection: 'dsh-shell:settings-section',
  closeDesktopSettings: 'dsh-shell:close-desktop-settings',
  browserToggle: 'dsh-shell:browser-toggle',
  browserNewTab: 'dsh-shell:browser-new-tab',
  browserOpenHomepages: 'dsh-shell:browser-open-homepages',
  browserActivateTab: 'dsh-shell:browser-activate-tab',
  browserCloseTab: 'dsh-shell:browser-close-tab',
  browserNavigate: 'dsh-shell:browser-navigate',
  browserBack: 'dsh-shell:browser-back',
  browserForward: 'dsh-shell:browser-forward',
  browserReload: 'dsh-shell:browser-reload',
  browserShowPanel: 'dsh-shell:browser-show-panel',
  browserHidePanel: 'dsh-shell:browser-hide-panel',
  browserPanelBounds: 'dsh-shell:browser-panel-bounds',
} as const

export interface BrowserPanelBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DshNavigationState {
  readonly canBack: boolean
  readonly canForward: boolean
  readonly canNextChat: boolean
  readonly canPreviousChat: boolean
}

export interface BrowserTabState {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly favicon: string
  readonly crashed: boolean
}

export interface BrowserShellState {
  readonly visible: boolean
  readonly tabs: readonly BrowserTabState[]
  readonly activeId: string | null
  readonly canBack: boolean
  readonly canForward: boolean
  readonly loading: boolean
  readonly widthRatio: number
  readonly homepages: readonly string[]
}

export interface ShellState extends DshNavigationState {
  readonly fullscreen: boolean
  readonly reloading: boolean
  readonly zoomPercent: number
  readonly browser: BrowserShellState
}

export interface ShellBootstrap {
  readonly actions: readonly LocalizedShellAction[]
  readonly colorScheme: 'light' | 'dark'
  readonly locale: string
  readonly menus: readonly LocalizedShellMenu[]
  readonly platform: NodeJS.Platform
  readonly runtimeVersion: string
  readonly state: ShellState
  readonly version: string
}

export interface ShellMenuPopupRequest {
  readonly menu: ShellMenuId
  /** X coordinate in the shell renderer's content viewport. */
  readonly x: number
  /** Y coordinate in the shell renderer's content viewport. */
  readonly y: number
}

export type DshShellActionId = Extract<ShellActionId,
  'new-chat' | 'open-folder' | 'settings' | 'toggle-sidebar' | 'find' |
  'previous-chat' | 'next-chat' | 'back' | 'forward'>
