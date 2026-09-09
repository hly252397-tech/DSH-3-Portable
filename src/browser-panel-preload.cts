const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const IPC = {
  getBootstrap: 'dsh-shell:get-bootstrap',
  state: 'dsh-shell:state',
  bootstrap: 'dsh-shell:bootstrap',
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
} as const

function applyThemeBootstrap(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  const candidate = value as { colorScheme?: unknown; themePreset?: unknown }
  if (candidate.colorScheme === 'light' || candidate.colorScheme === 'dark') {
    document.documentElement.dataset.colorScheme = candidate.colorScheme
    document.documentElement.style.colorScheme = candidate.colorScheme
  }
  if (typeof candidate.themePreset === 'string') document.documentElement.dataset.dshPreset = candidate.themePreset
}

const on = (channel: string, listener: (value?: unknown) => void): (() => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, value?: unknown) => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('dshShell', {
  getBootstrap: async () => {
    const value: unknown = await ipcRenderer.invoke(IPC.getBootstrap)
    applyThemeBootstrap(value)
    return value
  },
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
    openExternal: () => ipcRenderer.invoke(IPC.browserOpenExternal),
    printPage: () => ipcRenderer.invoke(IPC.browserPrint),
    captureScreenshot: () => ipcRenderer.invoke(IPC.browserScreenshot),
    clearData: () => ipcRenderer.invoke(IPC.browserClearData),
    getLibrary: () => ipcRenderer.invoke(IPC.browserGetLibrary),
    toggleManager: (visible?: boolean) => ipcRenderer.invoke(IPC.browserToggleManager, visible),
    prepareMenuSnapshot: () => ipcRenderer.invoke(IPC.browserPrepareMenuSnapshot),
    toggleMenu: (visible?: boolean) => ipcRenderer.invoke(IPC.browserToggleMenu, visible),
    bookmarkCurrent: () => ipcRenderer.invoke(IPC.browserBookmarkCurrent),
    removeLibraryItem: (kind: string, id: string) => ipcRenderer.invoke(IPC.browserLibraryRemove, kind, id),
    clearLibraryItems: (kind: string) => ipcRenderer.invoke(IPC.browserLibraryClear, kind),
    saveSettings: (settings: unknown) => ipcRenderer.invoke(IPC.browserSaveSettings, settings),
    saveCredential: (credential: unknown) => ipcRenderer.invoke(IPC.browserSaveCredential, credential),
    fillCredential: (id: string) => ipcRenderer.invoke(IPC.browserFillCredential, id),
    autofillPage: () => ipcRenderer.invoke(IPC.browserAutofillPage),
    importProfile: (sourceId: string) => ipcRenderer.invoke(IPC.browserImportProfile, sourceId),
    toggleExtension: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.browserToggleExtension, id, enabled),
    find: (value: string, options: unknown) => ipcRenderer.invoke(IPC.browserFind, value, options),
    stopFind: () => ipcRenderer.invoke(IPC.browserFindStop),
    toggleDevTools: () => ipcRenderer.invoke(IPC.browserDevTools),
    runtimeInfo: () => ipcRenderer.invoke(IPC.browserRuntimeInfo),
    checkRuntime: () => ipcRenderer.invoke(IPC.browserRuntimeCheck),
    pageZoom: (action: 'in' | 'out' | 'reset') => ipcRenderer.invoke(IPC.browserPageZoom, action),
    toggleDownloads: () => ipcRenderer.invoke(IPC.browserToggleDownloads),
    openDownloadsFolder: () => ipcRenderer.invoke(IPC.browserOpenDownloadsFolder),
    openDownload: (id: string) => ipcRenderer.invoke(IPC.browserOpenDownload, id),
    showDownload: (id: string) => ipcRenderer.invoke(IPC.browserShowDownload, id),
    clearDownloads: () => ipcRenderer.invoke(IPC.browserClearDownloads),
  },
  onState: (listener: (state: unknown) => void) => on(IPC.state, listener),
  onBootstrap: (listener: (bootstrap: unknown) => void) => on(IPC.bootstrap, value => {
    applyThemeBootstrap(value)
    listener(value)
  }),
  onBrowserFindResult: (listener: (result: unknown) => void) => on(IPC.browserFindResult, listener),
  onBrowserOpenFind: (listener: () => void) => on(IPC.browserOpenFind, listener),
  onBrowserFocusAddress: (listener: () => void) => on(IPC.browserFocusAddress, listener),
})
