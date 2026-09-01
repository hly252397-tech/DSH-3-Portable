const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const IPC = {
  action: 'dsh-shell:action',
  getBootstrap: 'dsh-shell:get-bootstrap',
  popupMenu: 'dsh-shell:popup-menu',
  state: 'dsh-shell:state',
  bootstrap: 'dsh-shell:bootstrap',
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
} as const

contextBridge.exposeInMainWorld('dshShell', {
  platform: process.platform,
  action: (id: string) => ipcRenderer.invoke(IPC.action, id),
  getBootstrap: () => ipcRenderer.invoke(IPC.getBootstrap),
  getNotificationPreferences: () => ipcRenderer.invoke(IPC.getNotificationPreferences),
  updateNotificationPreferences: (value: unknown) => ipcRenderer.invoke(IPC.updateNotificationPreferences, value),
  getUpdatePreferences: () => ipcRenderer.invoke(IPC.getUpdatePreferences),
  updateUpdatePreferences: (value: unknown) => ipcRenderer.invoke(IPC.updateUpdatePreferences, value),
  getDesktopUpdateState: () => ipcRenderer.invoke(IPC.getDesktopUpdateState),
  desktopUpdateAction: (action: unknown) => ipcRenderer.invoke(IPC.desktopUpdateAction, action),
  getHarnessUpdateState: () => ipcRenderer.invoke(IPC.getHarnessUpdateState),
  updateHarnessUpdatePolicy: (value: unknown) => ipcRenderer.invoke(IPC.updateHarnessUpdatePolicy, value),
  harnessUpdateAction: (action: unknown) => ipcRenderer.invoke(IPC.harnessUpdateAction, action),
  closeDesktopSettings: () => ipcRenderer.invoke(IPC.closeDesktopSettings),
  browser: {
    toggle: () => ipcRenderer.invoke(IPC.browserToggle),
    newTab: (url: string) => ipcRenderer.invoke(IPC.browserNewTab, url),
    openHomepages: () => ipcRenderer.invoke(IPC.browserOpenHomepages),
    activateTab: (id: string) => ipcRenderer.invoke(IPC.browserActivateTab, id),
    closeTab: (id: string) => ipcRenderer.invoke(IPC.browserCloseTab, id),
    navigate: (url: string) => ipcRenderer.invoke(IPC.browserNavigate, url),
    back: () => ipcRenderer.invoke(IPC.browserBack),
    forward: () => ipcRenderer.invoke(IPC.browserForward),
    reload: () => ipcRenderer.invoke(IPC.browserReload),
  },
  onState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state)
    ipcRenderer.on(IPC.state, wrapped)
    return () => ipcRenderer.removeListener(IPC.state, wrapped)
  },
  onBootstrap: (listener: (bootstrap: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, bootstrap: unknown) => listener(bootstrap)
    ipcRenderer.on(IPC.bootstrap, wrapped)
    return () => ipcRenderer.removeListener(IPC.bootstrap, wrapped)
  },
  onDesktopUpdateState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state)
    ipcRenderer.on(IPC.desktopUpdateState, wrapped)
    return () => ipcRenderer.removeListener(IPC.desktopUpdateState, wrapped)
  },
  onHarnessUpdateState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state)
    ipcRenderer.on(IPC.harnessUpdateState, wrapped)
    return () => ipcRenderer.removeListener(IPC.harnessUpdateState, wrapped)
  },
  onSettingsSection: (listener: (section: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, section: unknown) => listener(section)
    ipcRenderer.on(IPC.settingsSection, wrapped)
    return () => ipcRenderer.removeListener(IPC.settingsSection, wrapped)
  },
  popupMenu: (request: unknown) => ipcRenderer.invoke(IPC.popupMenu, request),
})
