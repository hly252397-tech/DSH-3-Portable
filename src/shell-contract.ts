import type { LocalizedShellAction, LocalizedShellMenu, LocalizedText, ShellActionId, ShellMenuId } from './shell-actions.js'

export const SHELL_BAR_HEIGHT = 44

export const SHELL_IPC = {
  action: 'dsh-shell:action',
  getBootstrap: 'dsh-shell:get-bootstrap',
  popupMenu: 'dsh-shell:popup-menu',
  state: 'dsh-shell:state',
  bootstrap: 'dsh-shell:bootstrap',
  dshAction: 'dsh-shell:dsh-action',
  dshLocale: 'dsh-shell:dsh-locale',
  dshTheme: 'dsh-shell:dsh-theme',
  desktopTheme: 'dsh-shell:desktop-theme',
  dshSettingsVisibility: 'dsh-shell:dsh-settings-visibility',
  dshOpenSession: 'dsh-shell:dsh-open-session',
  dshBrowserCloseRequest: 'dsh-shell:dsh-browser-close-request',
  dshNotificationReply: 'dsh-shell:dsh-notification-reply',
  dshState: 'dsh-shell:dsh-state',
  dshNotification: 'dsh-shell:dsh-notification',
  getNotificationPreferences: 'dsh-shell:get-notification-preferences',
  updateNotificationPreferences: 'dsh-shell:update-notification-preferences',
  updateThemePreferences: 'dsh-shell:update-theme-preferences',
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
  browserOpenExternal: 'dsh-shell:browser-open-external',
  browserPrint: 'dsh-shell:browser-print',
  browserScreenshot: 'dsh-shell:browser-screenshot',
  browserClearData: 'dsh-shell:browser-clear-data',
  browserGetLibrary: 'dsh-shell:browser-get-library',
  browserToggleManager: 'dsh-shell:browser-toggle-manager',
  browserPrepareMenuSnapshot: 'dsh-shell:browser-prepare-menu-snapshot',
  browserToggleMenu: 'dsh-shell:browser-toggle-menu',
  browserBookmarkCurrent: 'dsh-shell:browser-bookmark-current',
  browserLibraryRemove: 'dsh-shell:browser-library-remove',
  browserLibraryClear: 'dsh-shell:browser-library-clear',
  browserSaveSettings: 'dsh-shell:browser-save-settings',
  browserSaveCredential: 'dsh-shell:browser-save-credential',
  browserFillCredential: 'dsh-shell:browser-fill-credential',
  browserAutofillPage: 'dsh-shell:browser-autofill-page',
  browserImportProfile: 'dsh-shell:browser-import-profile',
  browserToggleExtension: 'dsh-shell:browser-toggle-extension',
  browserFind: 'dsh-shell:browser-find',
  browserFindStop: 'dsh-shell:browser-find-stop',
  browserFindResult: 'dsh-shell:browser-find-result',
  browserOpenFind: 'dsh-shell:browser-open-find',
  browserFocusAddress: 'dsh-shell:browser-focus-address',
  browserDevTools: 'dsh-shell:browser-devtools',
  browserRuntimeInfo: 'dsh-shell:browser-runtime-info',
  browserRuntimeCheck: 'dsh-shell:browser-runtime-check',
  browserPageZoom: 'dsh-shell:browser-page-zoom',
  browserToggleDownloads: 'dsh-shell:browser-toggle-downloads',
  browserOpenDownloadsFolder: 'dsh-shell:browser-open-downloads-folder',
  browserOpenDownload: 'dsh-shell:browser-open-download',
  browserShowDownload: 'dsh-shell:browser-show-download',
  browserClearDownloads: 'dsh-shell:browser-clear-downloads',
  browserToggleMaximize: 'dsh-shell:browser-toggle-maximize',
  browserSetRatio: 'dsh-shell:browser-set-ratio',
  browserPanelShow: 'dsh-shell:browser-panel-show',
  browserPanelHide: 'dsh-shell:browser-panel-hide',
  browserPanelPrepareOcclusion: 'dsh-shell:browser-panel-prepare-occlusion',
  browserPanelOccluded: 'dsh-shell:browser-panel-occluded',
  browserPanelBounds: 'dsh-shell:browser-panel-bounds',
  featurePanelsCopy: 'dsh-shell:feature-panels-copy',
} as const

export interface BrowserPanelBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserPanelSnapshot {
  readonly chromeDataUrl: string
  readonly pageDataUrl?: string
  readonly pageTop: number
  readonly pageHeight: number
}

export interface BrowserPageSnapshot {
  readonly pageDataUrl: string
  readonly pageTop: number
  readonly pageHeight: number
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

export interface BrowserDownloadState {
  readonly id: string
  readonly name: string
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly progress: number
  readonly status: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  readonly startedAt: string
  readonly completedAt?: string
}

export interface BrowserShellState {
  readonly visible: boolean
  readonly tabs: readonly BrowserTabState[]
  readonly activeId: string | null
  readonly canBack: boolean
  readonly canForward: boolean
  readonly loading: boolean
  readonly widthRatio: number
  readonly maximized: boolean
  readonly managerOpen: boolean
  readonly menuOpen: boolean
  readonly downloadsOpen: boolean
  readonly downloadsDrawerHeight: number
  readonly pageZoomPercent: number
  readonly bookmarked: boolean
  readonly downloads: readonly BrowserDownloadState[]
  readonly homepages: readonly string[]
}

export interface ShellState extends DshNavigationState {
  readonly browserWorkspaceVisible?: boolean
  readonly fullscreen: boolean
  readonly reloading: boolean
  readonly zoomPercent: number
  readonly browser: BrowserShellState
}

export interface ShellBootstrap {
  readonly actions: readonly LocalizedShellAction[]
  readonly bundledRuntimeVersion: string
  readonly colorScheme: 'light' | 'dark'
  readonly themePreset: 'qoder' | 'deep-sea' | 'lake' | 'verde' | 'vermilion' | 'slate' | 'gold'
  readonly featurePanels: {
    readonly categories: readonly { readonly id: string; readonly label: LocalizedText; readonly hint: LocalizedText }[]
    readonly panels: readonly { readonly id: string; readonly name: LocalizedText; readonly file: string; readonly description: LocalizedText; readonly notes?: string; readonly categoryId: string }[]
  }
  readonly locale: string
  readonly menus: readonly LocalizedShellMenu[]
  readonly platform: NodeJS.Platform
  readonly runtimeUpdateChannel: 'alpha'
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
