import { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, net, protocol, safeStorage, session, shell, type Input, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { writeFile as writeTextFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DESKTOP_APP_NAME, DESKTOP_APP_USER_MODEL_ID, DESKTOP_TOAST_ACTIVATOR_CLSID, resolveDesktopRuntimeDir, resolveDesktopUserDataDir } from './app-identity.js'
import { OFFICIAL_DSH_VERSION } from './bundled-plugins.js'
import { resolveAppIconPath, resolveCompactIconCrop, resolveNotificationIconPath, resolveRasterIconPath, resolveTaskBadgeIconPath, TRAY_ICON_SIZE } from './app-icon.js'
import { WINDOW_ICON_PIXEL_SIZES, isLoopbackFaviconRequest } from './window-icon.js'
import { quitDesktopApp, shouldHideInsteadOfClose } from './app-lifecycle.js'
import type { DshServer, StartDshOptions } from './dsh-process.js'
import { isExternalOpenUrl, isSameOrigin } from './navigation.js'
import { applyPendingProfileUpdates, resolvePnpmStoreDir, seedBundledPlugins, resolveWebProfileDir } from './plugin-seed.js'
import { parseUnresolvedBundleError, startWithProfileSelfRepair } from './profile-repair.js'
import { quarantineProfileBundle } from './profile-quarantine.js'
import { resolveBundledPluginStore, resolvePluginBinDir } from './plugin-toolchain.js'
import { resolveDshBootstrap, resolveDshRuntime, resolveNodeExecutable } from './runtime.js'
import { extractPackagedRuntimesInChild, packagedRuntimesNeedExtraction, type RuntimeExtractionProgress } from './extract-runtime.js'
import { resolvePrebuiltOfficialRuntime } from './runtime-prebuilt.js'
import { activateRuntimeSlot, commitRuntimeSlot, readRuntimeSlotPointer, recoverInterruptedRuntimeSwitch, resolveActiveRuntimeDir, rollbackRuntimeSlot, runtimeSlotVersion } from './runtime-slots.js'
import { buildHarnessRuntimeCandidate, type HarnessRuntimeCandidate } from './harness-runtime-candidate.js'
import { validateHarnessShadowStart } from './harness-shadow.js'
import { DEFAULT_HARNESS_UPDATE_POLICY, acquireHarnessUpdateLock, appendHarnessUpdateEvent, checkHarnessUpdate, harnessUpdatePolicyPath, harnessUpdateRoot, harnessUpdateStatePath, loadHarnessUpdatePolicy, loadHarnessUpdateState, saveHarnessUpdatePolicy, saveHarnessUpdateState, type HarnessReleaseCandidate, type HarnessUpdatePolicy, type HarnessUpdateState } from './harness-update.js'
import { applyInitialWindowState } from './window-state.js'
import { WindowNavigationCoordinator } from './window-navigation.js'
import { escapeRoute } from './escape-routing.js'
import { installDesktopBridge, resolveDesktopBridgeDir } from './desktop-host.js'
import { isChineseLocale, localizedShellActions, localizedShellMenus, normalizeShellLocale, shellActionForShortcut, SHELL_ACTIONS, type ShellActionId, type ShellMenuId } from './shell-actions.js'
import { SHELL_BAR_HEIGHT, SHELL_IPC, type BrowserPanelBounds, type BrowserShellState, type BrowserTabState, type DshNavigationState, type DshShellActionId, type ShellBootstrap, type ShellMenuPopupRequest, type ShellState } from './shell-contract.js'
import { mayAccessDesktopUpdates, mayAccessNotificationPreferences, mayCloseDesktopSettings, mayGetShellBootstrap, mayInvokeBrowserIpc, mayInvokeBrowserPanelIpc, mayInvokeShellAction, mayPopupShellMenu, mayReportDshLocale, mayReportDshNotification, mayReportDshState, mayReportDshTheme, mayReportDshSettingsVisibility, type ShellRendererKind } from './shell-ipc-policy.js'
import { DESKTOP_THEME_PALETTES, normalizeDesktopThemeSnapshot, type DesktopColorScheme, type DesktopThemePreference } from './desktop-theme.js'
import { DSH_MARKET_STATUS_PATH, isDshMarketOperationBusy, waitForDshMarketBatchToSettle } from './dshmarket-batch.js'
import { DEFAULT_NOTIFICATION_PREFERENCES, buildWindowsReplyToastXml, loadNotificationPreferences, parseDesktopNotificationBridgeEvent, parseWindowsNotificationReplyActivation, saveNotificationPreferences, shouldShowDesktopNotification, windowsNotificationReplyArguments, type DesktopNotificationEvent, type DesktopNotificationPreferences } from './desktop-notifications.js'
import { watchProfileActivation } from './profile-watch.js'
import updater from 'electron-updater'
import { DEFAULT_UPDATE_PREFERENCES, STARTUP_UPDATE_CHECK_DELAY_MS, buildDesktopTrayItems, desktopUpdateChannel, desktopUpdatePrompt, formatDesktopReleaseNotes, loadUpdatePreferences, publicDesktopUpdateError, saveUpdatePreferences, shouldCheckForUpdatesOnStartup, shouldDownloadUpdateAutomatically, type DesktopUpdateAction, type DesktopUpdatePreferences, type DesktopUpdateSnapshot, type DesktopUpdateStatus } from './desktop-updater.js'
import { applyPortableEnvironment, ensurePortableDirectories, resolvePortablePaths } from './portable-paths.js'

const portablePaths = resolvePortablePaths(process.env.DSH_PORTABLE_ROOT)
if (portablePaths !== undefined) {
  ensurePortableDirectories(portablePaths)
  applyPortableEnvironment(portablePaths)
}

interface DshProcessModule {
  isApplyPluginUpdatesIpc: (message: unknown) => boolean
  startDsh: (options: StartDshOptions) => Promise<DshServer>
}

const dshProcessModule = await import(app.isPackaged
  ? pathToFileURL(join(process.resourcesPath, 'desktop-bridge', 'dsh-process.js')).href
  : './dsh-process.js') as DshProcessModule
const { isApplyPluginUpdatesIpc, startDsh } = dshProcessModule

let mainWindow: BrowserWindow | undefined
let dshView: WebContentsView | undefined
let shortcutsWindow: BrowserWindow | undefined
let aboutWindow: BrowserWindow | undefined
let settingsWindow: BrowserWindow | undefined
let server: DshServer | undefined
let tray: Tray | undefined
let isQuitting = false
let isRecycling = false
let runtimeExtractionAbortController: AbortController | undefined
let runtimeExtractionTask: Promise<void> | undefined
let lastStartOptions: Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'> | undefined
let lastSeedOptions: Parameters<typeof applyPendingProfileUpdates>[0] | undefined
let profileWatcher: { stop: () => void; sync: () => void } | undefined
let profileActivationRecyclePending = false
let profileActivationRecycleTask: Promise<void> | undefined
let profileActivationRecycleGeneration = 0
let updateStatus: DesktopUpdateStatus = { kind: 'idle' }
let updatePreferences: DesktopUpdatePreferences = DEFAULT_UPDATE_PREFERENCES
let lastUpdateCheckAt: string | undefined
let startupUpdateTimer: NodeJS.Timeout | undefined
let harnessUpdateTimer: NodeJS.Timeout | undefined
let harnessUpdateTask: Promise<void> | undefined
let harnessUpdatePolicy: HarnessUpdatePolicy = DEFAULT_HARNESS_UPDATE_POLICY
let harnessUpdateState: HarnessUpdateState | undefined
const { autoUpdater } = updater
let isReportingUnexpectedError = false
const windowNavigation = new WindowNavigationCoordinator()
let dshNavigationState: DshNavigationState = { canBack: false, canForward: false, canNextChat: false, canPreviousChat: false }
let notificationPreferences: DesktopNotificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES
const activeNotifications = new Map<string, Notification>()
let unreadCompletionCount = 0
let activeDshLocale: 'zh' | 'en' | undefined
let activeDshColorScheme: DesktopColorScheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
let activeDshThemePreference: DesktopThemePreference = 'system'
let dshSettingsDialogVisible = false
let activeDshWorkCount = 0
let activeDshWorkChangedAt = Date.now()
const shellActionIds = new Set<string>(SHELL_ACTIONS.map(action => action.id))

interface HarnessUpdaterContext {
  readonly appPath: string
  readonly bootstrapPath: string
  readonly isPackaged: boolean
  readonly legacyRuntimeDir: string
  readonly nodeExecutable: string
  readonly pathPrefix?: string
  readonly pnpmEntry: string
  readonly profileDir: string
  readonly resourcesPath: string
  readonly updateRoot: string
}

let harnessUpdaterContext: HarnessUpdaterContext | undefined

// ---------------------------------------------------------------------------
// 内置浏览器（移植自 G:\DSH-Portable 空间板块浏览器，主页固定为 deepseek.com）
// ---------------------------------------------------------------------------
const BROWSER_DEFAULT_HOMEPAGES: readonly string[] = ['https://www.deepseek.com/en/']
const BROWSER_TABS_BAR_HEIGHT = 38
const BROWSER_NAV_BAR_HEIGHT = 36
const BROWSER_MAXIMUM_TABS = 12
const BROWSER_DEFAULT_WIDTH_RATIO = 0.36
const BROWSER_PARTITION = 'persist:dsh-browser'

interface BrowserTab {
  readonly id: string
  title: string
  url: string
  favicon: string
  crashed: boolean
  lastRecordedUrl?: string
  readonly view: WebContentsView
}

interface BrowserLibraryModule {
  publicSnapshot(): { settings?: { homepages?: string[] } }
  recordHistory(url: string, title: string, favicon?: string): void
  setSettings(patch: { homepages: string[] }): { homepages: string[] }
}

interface BrowserWorkspaceFile {
  version: number
  browserVisible: boolean
  browserWidthRatio: number
  activeTabId: string | null
  tabs: { id: string; title: string; url: string }[]
}

// 库延迟到首次使用时初始化：app.setPath('userData') 的便携重定向发生在此模块顶层之后，
// 过早调用 createBrowserLibrary 会把历史/凭据写到错误的系统目录（B-1）。
const browserLibraryFallback: BrowserLibraryModule = {
  publicSnapshot: () => ({ settings: { homepages: [...BROWSER_DEFAULT_HOMEPAGES] } }),
  recordHistory: () => undefined,
  setSettings: patch => ({ homepages: patch.homepages }),
}

let browserLibraryModule: { createBrowserLibrary(options: { safeStorage: Electron.SafeStorage; browserDataRoot: string; stateRoot: string; appendLog: (message: string) => void }): BrowserLibraryModule } | undefined
try {
  const browserRequire = createRequire(import.meta.url)
  browserLibraryModule = browserRequire(join(app.getAppPath(), 'browser-library.cjs')) as typeof browserLibraryModule
} catch (error) {
  console.error('browser-library.cjs 加载失败，内置浏览器降级为无历史记录模式：', error)
}

let browserDataInstance: BrowserLibraryModule | undefined

function browserData(): BrowserLibraryModule {
  if (browserDataInstance === undefined) {
    browserDataInstance = browserLibraryModule === undefined
      ? browserLibraryFallback
      : browserLibraryModule.createBrowserLibrary({
        safeStorage,
        browserDataRoot: join(app.getPath('userData'), 'browser'),
        stateRoot: join(app.getPath('userData'), 'state'),
        appendLog: (message: string) => console.log(`[browser] ${message}`),
      })
  }
  return browserDataInstance
}

const browserTabs: BrowserTab[] = []
let activeBrowserTabId: string | null = null
let browserVisible = false
let browserWidthRatio = BROWSER_DEFAULT_WIDTH_RATIO
let browserWorkspaceSaveTimer: NodeJS.Timeout | undefined
// DSH Web GUI 右侧面板内容区的窗口坐标（由 GUI 通过 IPC 实时报告）
let browserPanelBounds: BrowserPanelBounds | undefined

function browserWorkspacePath(): string {
  return join(app.getPath('userData'), 'shell', 'browser-workspace.json')
}

function loadBrowserWorkspace(): BrowserWorkspaceFile | null {
  try {
    const parsed = JSON.parse(readFileSync(browserWorkspacePath(), 'utf8')) as BrowserWorkspaceFile
    if (!Array.isArray(parsed.tabs)) return null
    return parsed
  } catch {
    return null
  }
}

function scheduleBrowserWorkspaceSave(): void {
  if (browserWorkspaceSaveTimer !== undefined) clearTimeout(browserWorkspaceSaveTimer)
  browserWorkspaceSaveTimer = setTimeout(() => {
    browserWorkspaceSaveTimer = undefined
    saveBrowserWorkspace()
  }, 300)
}

function saveBrowserWorkspace(): void {
  // 同步 + 临时文件原子替换：退出路径（app.exit）不等微任务，异步写会丢数据（H-2）；
  // 直接覆盖可能与防抖写交错产生半截 JSON（M-1）。
  if (browserWorkspaceSaveTimer !== undefined) {
    clearTimeout(browserWorkspaceSaveTimer)
    browserWorkspaceSaveTimer = undefined
  }
  const state: BrowserWorkspaceFile = {
    version: 1,
    browserVisible,
    browserWidthRatio,
    activeTabId: activeBrowserTabId,
    tabs: browserTabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url })),
  }
  try {
    const target = browserWorkspacePath()
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    console.error('浏览器工作区保存失败：', error)
  }
}

// 首页固定（用户要求）：不读取/不覆写 library 持久化设置，恒返回固定主页。
function configuredBrowserHomepages(): readonly string[] {
  return BROWSER_DEFAULT_HOMEPAGES
}

// 历史记录防抖：recordHistory 内部是全量同步写盘，逐次触发会卡主进程（M-3）。
const browserHistoryQueue: { url: string; title: string; favicon: string }[] = []
let browserHistoryTimer: NodeJS.Timeout | undefined

function queueBrowserHistory(url: string, title: string, favicon: string): void {
  browserHistoryQueue.push({ url, title, favicon })
  if (browserHistoryTimer !== undefined) return
  browserHistoryTimer = setTimeout(() => {
    browserHistoryTimer = undefined
    const entries = browserHistoryQueue.splice(0)
    for (const entry of entries) browserData().recordHistory(entry.url, entry.title, entry.favicon)
  }, 2000)
}

function primaryBrowserHomepage(): string {
  return configuredBrowserHomepages()[0] ?? BROWSER_DEFAULT_HOMEPAGES[0]
}

function isAllowedBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeBrowserAddress(value: string): string {
  const trimmed = String(value || '').trim()
  if (trimmed === '') return primaryBrowserHomepage()
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function updateBrowserTabFromContents(tab: BrowserTab, persist = false): void {
  const contents = tab.view.webContents
  if (contents.isDestroyed()) return
  tab.url = contents.getURL() || tab.url
  tab.title = contents.getTitle() || tab.title || '新标签页'
  tab.crashed = false
  if (persist) scheduleBrowserWorkspaceSave()
  broadcastShellState()
}

function createBrowserTab(url: string = primaryBrowserHomepage(), requestedId?: string): BrowserTab {
  if (browserTabs.length >= BROWSER_MAXIMUM_TABS) {
    // 达到上限时不再静默丢弃 URL，改为在当前活动标签中打开（L-1）
    const existing = getActiveBrowserTab() ?? browserTabs[0]
    if (existing !== undefined) {
      const fallbackUrl = isAllowedBrowserUrl(url) ? url : normalizeBrowserAddress(url)
      existing.url = fallbackUrl
      void existing.view.webContents.loadURL(fallbackUrl).catch((error: Error) => console.error(`浏览器加载失败：${error.message}`))
      relayout()
    }
    return existing
  }
  const id = requestedId || randomUUID()
  const targetUrl = isAllowedBrowserUrl(url) ? url : normalizeBrowserAddress(url)
  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      safeDialogs: true,
      spellcheck: true,
    },
  })
  const tab: BrowserTab = { id, title: targetUrl, url: targetUrl, favicon: '', crashed: false, view }
  browserTabs.push(tab)
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.contentView.addChildView(view)
  view.setVisible(false)
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    // 回调内避免同步做创建视图的重活（L-5）
    if (isAllowedBrowserUrl(popupUrl)) queueMicrotask(() => { openBrowser(popupUrl, true) })
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedBrowserUrl(targetUrl)) event.preventDefault()
  })
  view.webContents.on('did-start-loading', () => updateBrowserTabFromContents(tab))
  view.webContents.on('did-stop-loading', () => {
    updateBrowserTabFromContents(tab)
    if (tab.url !== '' && tab.lastRecordedUrl !== tab.url) {
      tab.lastRecordedUrl = tab.url
      queueBrowserHistory(tab.url, tab.title, tab.favicon)
    }
  })
  view.webContents.on('did-navigate', () => updateBrowserTabFromContents(tab, true))
  view.webContents.on('did-navigate-in-page', () => updateBrowserTabFromContents(tab, true))
  view.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || !isAllowedBrowserUrl(failedUrl)) return
    tab.url = failedUrl
    tab.title = failedUrl
    scheduleBrowserWorkspaceSave()
    broadcastShellState()
  })
  view.webContents.on('page-title-updated', (_event, title) => {
    tab.title = String(title || '新标签页').trim()
    updateBrowserTabFromContents(tab, true)
  })
  view.webContents.on('page-favicon-updated', (_event, favicons) => {
    tab.favicon = favicons.find(favicon => /^https?:\/\//i.test(favicon)) || ''
    broadcastShellState()
  })
  view.webContents.on('render-process-gone', (_event, details) => {
    tab.crashed = true
    console.error(`浏览器标签渲染进程停止 ${tab.url} ${JSON.stringify(details)}`)
    broadcastShellState()
  })
  activeBrowserTabId = id
  tab.crashed = false
  void view.webContents.loadURL(targetUrl).catch((error: Error) => console.error(`浏览器加载失败：${error.message}`))
  scheduleBrowserWorkspaceSave()
  relayout()
  return tab
}

function getActiveBrowserTab(): BrowserTab | null {
  return browserTabs.find(tab => tab.id === activeBrowserTabId) ?? browserTabs[0] ?? null
}

function activateBrowserTab(id: string): void {
  if (!browserTabs.some(tab => tab.id === id)) return
  activeBrowserTabId = id
  browserVisible = true
  relayout()
  focusActiveBrowserTab()
  scheduleBrowserWorkspaceSave()
}

function closeBrowserTab(id: string): void {
  const index = browserTabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  const [tab] = browserTabs.splice(index, 1)
  try {
    mainWindow?.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  } catch {
    // 视图已随窗口销毁
  }
  if (activeBrowserTabId === id) {
    activeBrowserTabId = browserTabs[Math.min(index, browserTabs.length - 1)]?.id ?? null
  }
  if (browserTabs.length === 0) createHomepageTabs()
  relayout()
  scheduleBrowserWorkspaceSave()
}

function openBrowser(url?: string, newTab = false): BrowserTab {
  browserVisible = true
  let tab = getActiveBrowserTab()
  if (tab === null || newTab) tab = createBrowserTab(url || primaryBrowserHomepage())
  else if (url) void tab.view.webContents.loadURL(normalizeBrowserAddress(url)).catch((error: Error) => console.error(`浏览器加载失败：${error.message}`))
  activeBrowserTabId = tab.id
  relayout()
  focusActiveBrowserTab()
  scheduleBrowserWorkspaceSave()
  return tab
}

function focusActiveBrowserTab(): void {
  // 面板可见时把键盘焦点交给页面，用户无需先点一下才能打字（L-3）
  if (!browserVisible) return
  const contents = getActiveBrowserTab()?.view.webContents
  if (contents !== undefined && !contents.isDestroyed()) contents.focus()
}

function createHomepageTabs(): void {
  for (const url of configuredBrowserHomepages()) createBrowserTab(url)
}

function openHomepageGroup(): void {
  browserVisible = true
  const homepages = configuredBrowserHomepages()
  let firstTab = getActiveBrowserTab()
  if (firstTab === null) {
    firstTab = createBrowserTab(homepages[0])
  } else {
    firstTab.url = homepages[0]
    firstTab.title = homepages[0]
    void firstTab.view.webContents.loadURL(homepages[0]).catch(() => undefined)
  }
  activeBrowserTabId = firstTab.id
  const homepageTabs = new Set<string>([firstTab.id])
  for (const url of homepages.slice(1)) {
    const existing = browserTabs.find(tab => !homepageTabs.has(tab.id) && tab.url === url)
    const tab = existing ?? createBrowserTab(url)
    homepageTabs.add(tab.id)
  }
  relayout()
  scheduleBrowserWorkspaceSave()
}

function restoreBrowserWorkspace(): void {
  // 首页固定在 configuredBrowserHomepages()（恒返回 deepseek.com/en），不覆写库配置（M-2）
  const saved = loadBrowserWorkspace()
  if (saved !== null) {
    browserVisible = saved.browserVisible === true
    if (typeof saved.browserWidthRatio === 'number' && saved.browserWidthRatio > 0.15 && saved.browserWidthRatio < 0.8) {
      browserWidthRatio = saved.browserWidthRatio
    }
    for (const savedTab of saved.tabs.slice(0, BROWSER_MAXIMUM_TABS)) {
      if (isAllowedBrowserUrl(savedTab.url)) createBrowserTab(savedTab.url, savedTab.id)
    }
    if (saved.activeTabId !== null && browserTabs.some(tab => tab.id === saved.activeTabId)) activeBrowserTabId = saved.activeTabId
  }
  if (browserTabs.length === 0) createHomepageTabs()
  relayout()
  broadcastShellState()
}

function browserShellState(): BrowserShellState {
  const active = getActiveBrowserTab()
  const contents = active?.view.webContents
  return {
    visible: browserVisible,
    tabs: browserTabs.map((tab): BrowserTabState => ({ id: tab.id, title: tab.title, url: tab.url, favicon: tab.favicon, crashed: tab.crashed })),
    activeId: activeBrowserTabId,
    canBack: contents?.navigationHistory.canGoBack() ?? false,
    canForward: contents?.navigationHistory.canGoForward() ?? false,
    loading: contents?.isLoading() ?? false,
    widthRatio: browserWidthRatio,
    homepages: [...configuredBrowserHomepages()],
  }
}

function relayout(): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) layoutDshView(mainWindow)
}

function desktopLocale(): string {
  return activeDshLocale ?? app.getLocale()
}

function desktopText(zh: string, en: string): string {
  return isChineseLocale(desktopLocale()) ? zh : en
}

process.on('uncaughtException', handleUnexpectedMainError)
process.on('unhandledRejection', handleUnexpectedMainError)

app.setName(DESKTOP_APP_NAME)
app.setAppUserModelId(DESKTOP_APP_USER_MODEL_ID)
if (process.platform === 'win32') app.setToastActivatorCLSID(DESKTOP_TOAST_ACTIVATOR_CLSID)
if (portablePaths !== undefined) {
  app.setPath('home', portablePaths.home)
  app.setPath('appData', portablePaths.appData)
  app.setPath('userData', portablePaths.userData)
  app.setPath('sessionData', portablePaths.sessionData)
  app.setPath('cache', portablePaths.cache)
  app.setPath('temp', portablePaths.temp)
  app.setPath('logs', portablePaths.logs)
  app.setPath('crashDumps', portablePaths.crashDumps)
} else if (!process.argv.some(argument => argument.startsWith('--user-data-dir='))) {
  app.setPath('userData', resolveDesktopUserDataDir(app.getPath('appData')))
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'dsh-icon', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  app.on('activate', () => showMainWindow())
  app.on('before-quit', event => {
    if (isQuitting) return
    event.preventDefault()
    runMainTask(requestQuit())
  })

  runMainTask(startApplication())
}

async function requestQuit(): Promise<void> {
  await shutdownDesktop(() => app.exit())
}

function desktopDialogLocale(): 'zh' | 'en' {
  return isChineseLocale(activeDshLocale ?? app.getLocale()) ? 'zh' : 'en'
}

/**
 * 安排重启：优先 Electron 官方 relaunch；失败时降级为分离子进程拉起新实例。
 * 返回是否成功安排。注意必须在应用退出前调用。
 */
function scheduleAppRelaunch(): boolean {
  try {
    app.relaunch({ execPath: process.execPath, args: process.argv.slice(1) })
    return true
  } catch {
    // 降级：detached 子进程重启
  }
  try {
    const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** 完全关闭并重启：确认对话框 → 安排新实例 → 走既有优雅关停（托盘/服务/配置落盘）。 */
async function requestAppRestart(): Promise<void> {
  const zh = desktopDialogLocale() === 'zh'
  const confirmed = await dialog.showMessageBox({
    type: 'warning',
    buttons: zh ? ['取消', '重启'] : ['Cancel', 'Restart'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: zh ? '重启应用' : 'Restart App',
    message: zh ? '完全关闭并重启 DSH Codex Desktop？' : 'Fully quit and restart DSH Codex Desktop?',
    detail: zh
      ? '所有窗口将关闭，正在运行的任务会被中断；会话与配置保留在磁盘上，重启后可继续。'
      : 'All windows will close and running tasks are interrupted. Sessions and settings are preserved on disk and resume after restart.',
  })
  if (confirmed.response !== 1) return
  if (!scheduleAppRelaunch()) {
    await dialog.showMessageBox({
      type: 'error',
      buttons: ['OK'],
      title: zh ? '重启失败' : 'Restart failed',
      message: zh ? '无法安排重启，请从托盘退出后手动启动应用。' : 'Could not schedule a restart. Quit from the tray and start the app manually.',
    })
    return
  }
  await shutdownDesktop(() => app.exit(0))
}

async function shutdownDesktop(exit: () => void): Promise<void> {
  await quitDesktopApp({
    isQuitting,
    markQuitting: () => { isQuitting = true },
    destroyTray: () => {
      if (startupUpdateTimer !== undefined) clearTimeout(startupUpdateTimer)
      startupUpdateTimer = undefined
      if (harnessUpdateTimer !== undefined) clearTimeout(harnessUpdateTimer)
      harnessUpdateTimer = undefined
      tray?.destroy()
      tray = undefined
      profileWatcher?.stop()
      profileWatcher = undefined
    },
    stopServer: async () => {
      const extraction = runtimeExtractionTask
      runtimeExtractionAbortController?.abort()
      await extraction?.catch(() => undefined)
      const current = server
      server = undefined
      await current?.stop()
    },
    exit,
  })
}

async function startApplication(): Promise<void> {
  await app.whenReady()
  ensureWindowsNotificationIdentity()
  installWindowsNotificationActivationHandler()
  notificationPreferences = await loadNotificationPreferences(notificationPreferencesPath())
  updatePreferences = await loadUpdatePreferences(updatePreferencesPath())
  installShellIpc()
  installDesktopFaviconReplacement()
  Menu.setApplicationMenu(null)
  configureDesktopUpdater()
  createTray()
  await showStartupWindow(desktopText('正在启动', 'Starting'))

  try {
    const runtimeOptions = {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }
    const pathPrefix = resolvePluginBinDir(runtimeOptions)
    const pnpmEntry = pathPrefix === undefined ? process.env.npm_execpath : join(pathPrefix, 'pnpm-package', 'bin', 'pnpm.cjs')
    const profileDir = resolveWebProfileDir()
    const legacyDesktopRuntimeDir = resolveDesktopRuntimeDir(app.getPath('userData'), {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      ...(portablePaths === undefined ? {} : { portableRoot: portablePaths.root }),
    })
    const extractedStoreDir = app.isPackaged ? join(dirname(legacyDesktopRuntimeDir), 'plugins', 'store') : undefined
    const nodeExecutable = resolveNodeExecutable(runtimeOptions)
    if (app.isPackaged) {
      const firstInitialization = packagedRuntimesNeedExtraction(process.resourcesPath, legacyDesktopRuntimeDir, extractedStoreDir!)
      if (firstInitialization) {
        await updateStartupMessage(firstInitializationMessage())
        const controller = new AbortController()
        runtimeExtractionAbortController = controller
        const extraction = extractPackagedRuntimesInChild({
          nodeExecutable,
          scriptPath: join(process.resourcesPath, 'extract-runtime.mjs'),
          installDir: dirname(legacyDesktopRuntimeDir),
          resourcesDir: process.resourcesPath,
          signal: controller.signal,
          onProgress: progress => { void updateStartupMessage(runtimeExtractionMessage(progress)) },
        })
        runtimeExtractionTask = extraction
        try {
          await extraction
        } finally {
          if (runtimeExtractionTask === extraction) runtimeExtractionTask = undefined
          if (runtimeExtractionAbortController === controller) runtimeExtractionAbortController = undefined
        }
        await updateStartupMessage(desktopText(
          '正在初始化插件和工作区…\n首次启动可能需要 1–3 分钟，请勿关闭应用。',
          'Initializing plugins and workspace…\nThe first launch may take 1–3 minutes. Please keep the app open.',
        ))
      }
    }
    const interruptedPointer = readRuntimeSlotPointer(legacyDesktopRuntimeDir)
    if (interruptedPointer?.pendingTransactionId !== undefined) {
      recoverInterruptedRuntimeSwitch(legacyDesktopRuntimeDir)
      console.warn('检测到上次未完成的 DSH 运行时观察事务，已恢复上一已知可用槽。')
    }
    const desktopRuntimeDir = resolveActiveRuntimeDir(legacyDesktopRuntimeDir)
    const pluginStoreDir = resolveBundledPluginStore({
      ...runtimeOptions,
      ...(extractedStoreDir === undefined ? {} : { extractedStoreDir }),
    })
    const profileStoreDir = resolvePnpmStoreDir(profileDir, pluginStoreDir)
    const prebuiltRuntimeDir = resolvePrebuiltOfficialRuntime(runtimeOptions)
    const seedOptions = {
      nodeExecutable,
      profileDir,
      desktopRuntimeDir,
      pluginStoreDir: pluginStoreDir ?? '',
      ...(prebuiltRuntimeDir === undefined ? {} : { prebuiltRuntimeDir }),
      ...(pathPrefix === undefined ? {} : { pathPrefix }),
    }
    try {
      const seeded = await seedBundledPlugins(seedOptions)
      if (seeded.seeded.length > 0) console.log(`已补种官方运行时和社区插件：${seeded.seeded.join('、')}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '内置插件补种失败。'
      await writeTextFile(join(app.getPath('userData'), 'plugin-seed.log'), `${message}\n`, 'utf8').catch(() => undefined)
    }
    try {
      const updated = await applyPendingProfileUpdates(seedOptions)
      if (updated.length > 0) console.log('已在启动前应用插件更新：' + updated.join('、'))
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动前应用插件更新失败。'
      await writeTextFile(join(app.getPath('userData'), 'plugin-update.log'), ` ${message}\n`, 'utf8').catch(() => undefined)

    }
    installDesktopBridge(profileDir, resolveDesktopBridgeDir(runtimeOptions))
    lastSeedOptions = seedOptions
    const runtime = resolveDshRuntime({ ...runtimeOptions, profileDir, desktopRuntimeDir })
    const startOptions = {
      bootstrapPath: resolveDshBootstrap(runtimeOptions),
      ...(pathPrefix === undefined ? {} : { pathPrefix }),
      runtime,
      nodeExecutable,
      environment: {
        DSH_HOME: resolve(profileDir, '..', '..'),
        DSH_PROFILE_DIR: profileDir,
        DSH_PROFILE_NAME: 'web',
        DSH_RUNTIME_DIR: desktopRuntimeDir,
        ...(pnpmEntry === undefined ? {} : { DSH_PNPM_ENTRY: pnpmEntry }),
        ...(profileStoreDir === undefined ? {} : { DSH_PNPM_STORE_DIR: profileStoreDir }),
      },
    }
    lastStartOptions = startOptions
    const started = await startWithProfileSelfRepair({
      profileDir,
      extraDirs: [desktopRuntimeDir],
      start: () => startDsh({
        ...startOptions,
        onUnexpectedExit: handleUnexpectedDshExit,
        onIpcMessage: handleDshIpc,
      }),
    })
    server = started.result
    if (started.repaired.length > 0) console.log('已自我修复损坏的插件清单：' + started.repaired.join('、'))
    profileWatcher?.stop()
    profileWatcher = watchProfileActivation(profileDir, scheduleProfileActivationRecycle, { onError: handleUnexpectedMainError })
    await createMainWindow(server.url)
    const smokeReadyFile = process.env.DSH_DESKTOP_SMOKE_READY_FILE
    if (smokeReadyFile !== undefined && smokeReadyFile !== '') {
      await writeTextFile(smokeReadyFile, 'ready\n', 'utf8')
    }
    scheduleStartupUpdateCheck()
    if (portablePaths !== undefined && pnpmEntry !== undefined) {
      await configureHarnessUpdater({
        ...runtimeOptions,
        bootstrapPath: startOptions.bootstrapPath,
        legacyRuntimeDir: legacyDesktopRuntimeDir,
        nodeExecutable,
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
        pnpmEntry,
        profileDir,
        updateRoot: harnessUpdateRoot(portablePaths.root),
      })
    }
  } catch (error) {
    if (!isQuitting) await reportStartupFailure(error)
  }
}

function resolveStartupHtml(): string | undefined {
  const packaged = join(process.resourcesPath, 'startup.html')
  const dev = join(app.getAppPath(), 'assets', 'startup.html')
  if (existsSync(packaged)) return packaged
  if (existsSync(dev)) return dev
  return undefined
}

let cachedWindowIcon: Electron.NativeImage | undefined

function resolveWindowIconFilePath(): string | undefined {
  return resolveRasterIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  }) ?? resolveWindowIconPath()
}

function resolveWindowIconImage(): Electron.NativeImage | undefined {
  if (cachedWindowIcon !== undefined && !cachedWindowIcon.isEmpty()) return cachedWindowIcon
  const iconPath = resolveWindowIconFilePath()
  if (iconPath === undefined) return undefined
  const source = nativeImage.createFromPath(iconPath)
  if (source.isEmpty()) return undefined
  const compactSource = source.crop(resolveCompactIconCrop(source.getSize()))
  const icon = nativeImage.createEmpty()
  for (const size of WINDOW_ICON_PIXEL_SIZES) {
    const resized = compactSource.resize({ width: size, height: size, quality: 'best' })
    icon.addRepresentation({
      width: size,
      height: size,
      buffer: resized.toPNG(),
      scaleFactor: 1,
    })
  }
  cachedWindowIcon = icon.isEmpty() ? source : icon
  return cachedWindowIcon
}

function installDesktopFaviconReplacement(): void {
  const iconPath = resolveWindowIconFilePath()
  if (iconPath === undefined) return
  const iconUrl = pathToFileURL(iconPath).href
  protocol.handle('dsh-icon', () => net.fetch(iconUrl))
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!isLoopbackFaviconRequest(details.url)) {
      callback({})
      return
    }
    callback({ redirectURL: 'dsh-icon://app/favicon.ico' })
  })
}

async function showStartupWindow(message: string): Promise<void> {
  const window = mainWindow ??= createWindow()
  const view = requireDshView()
  const html = resolveStartupHtml()
  if (html !== undefined) {
    await windowNavigation.navigate(
      view,
      () => view.webContents.loadFile(html, { query: { theme: activeDshColorScheme } }),
      () => view.webContents.executeJavaScript('document.getElementById("msg").textContent = ' + JSON.stringify(message)),
    )
    return
  }
  const escaped = message.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  await windowNavigation.navigate(
    view,
    () => view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<main style="font-family:sans-serif;padding:48px"><h1>DSH Codex Desktop</h1><p>' + escaped + '</p></main>')),
  )
}

async function updateStartupMessage(message: string): Promise<void> {
  const view = requireDshView()
  if (view.webContents.isDestroyed()) return
  await view.webContents.executeJavaScript(`document.getElementById('msg')?.replaceChildren(document.createTextNode(${JSON.stringify(message)}))`)
    .catch(() => undefined)
}

function firstInitializationMessage(): string {
  return desktopText(
    '首次启动，正在准备运行环境…\n可能需要 1–3 分钟，请勿关闭应用。',
    'Preparing the runtime for the first launch…\nThis may take 1–3 minutes. Please keep the app open.',
  )
}

function runtimeExtractionMessage(progress: RuntimeExtractionProgress): string {
  const hint = desktopText('\n首次启动可能需要 1–3 分钟，请勿关闭应用。', '\nThe first launch may take 1–3 minutes. Please keep the app open.')
  if (progress.phase === 'runtime') {
    return desktopText('正在校验并解压 DSH 运行环境…', 'Verifying and extracting the DSH runtime…') + hint
  }
  return desktopText('正在准备内置插件仓库…', 'Preparing the bundled plugin store…') + hint
}

let allowedOrigin = ''

async function createMainWindow(serverUrl: string): Promise<void> {
  allowedOrigin = new URL(serverUrl).origin
  mainWindow ??= createWindow()
  const view = requireDshView()
  await windowNavigation.navigate(view, () => view.webContents.loadURL(serverUrl))
  // 仅在首次启动（标签页为空）时恢复浏览器工作区；插件热更新回收时保留现有标签页
  if (browserTabs.length === 0) {
    restoreBrowserWorkspace()
  } else {
    relayout()
  }
  broadcastShellState()
}

async function reportStartupFailure(error: unknown): Promise<void> {
  const logPath = join(app.getPath('userData'), 'startup-error.log')
  const message = error instanceof Error ? error.message : '未知启动错误。'
  await writeTextFile(logPath, message + '\n', 'utf8').catch(() => undefined)
  const short = message.split(/\r?\n/)[0]?.slice(0, 240) ?? '未知启动错误。'
  try {
    await showStartupWindow(desktopText('启动失败：', 'Startup failed: ') + short + desktopText('\n日志：', '\nLog: ') + logPath)
  } catch (displayError) {
    console.error('显示启动错误页面失败。', displayError)
  }
}

function handleUnexpectedMainError(error: unknown): void {
  console.error('主进程发生未处理异常。', error)
  if (!app.isReady() || isQuitting || isReportingUnexpectedError) return
  isReportingUnexpectedError = true
  void reportStartupFailure(error)
    .catch(reportError => { console.error('主进程异常报告失败。', reportError) })
    .finally(() => { isReportingUnexpectedError = false })
}

function runMainTask(task: Promise<unknown>): void {
  void task.catch(handleUnexpectedMainError)
}


function handleDshIpc(message: unknown): void {
  if (!isApplyPluginUpdatesIpc(message)) return
  // dsh-codex-ui uses this IPC after its own update-all flow. It has the
  // same contract as a profile mutation, so letting it bypass the market
  // queue would still interrupt a batch after its first item.
  scheduleProfileActivationRecycle()
}

const DSH_MARKET_BATCH_POLL_MS = 750
const DSH_MARKET_BATCH_MAX_WAIT_MS = 10 * 60 * 1_000

function scheduleProfileActivationRecycle(): void {
  if (isQuitting || isRecycling) return
  profileActivationRecyclePending = true
  profileActivationRecycleGeneration += 1
  if (profileActivationRecycleTask !== undefined) return
  const task = recycleAfterDshMarketBatch()
  profileActivationRecycleTask = task
  runMainTask(task.finally(() => { profileActivationRecycleTask = undefined }))
}

async function dshMarketOperationStatus(): Promise<unknown> {
  const url = server?.url
  if (url === undefined) return undefined
  try {
    const response = await fetch(new URL(DSH_MARKET_STATUS_PATH, url), { signal: AbortSignal.timeout(1_000) })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    // dshmarket is optional. A missing, stopped, or old market should retain
    // the normal profile-change restart behavior.
    return undefined
  }
}

async function recycleAfterDshMarketBatch(): Promise<void> {
  while (profileActivationRecyclePending && !isQuitting && !isRecycling) {
    profileActivationRecyclePending = false
    const generation = profileActivationRecycleGeneration
    const settled = await waitForDshMarketBatchToSettle(
      dshMarketOperationStatus,
      () => new Promise(resolve => setTimeout(resolve, DSH_MARKET_BATCH_POLL_MS)),
      { maxWaitMs: DSH_MARKET_BATCH_MAX_WAIT_MS, pollIntervalMs: DSH_MARKET_BATCH_POLL_MS },
    )
    if (!settled) console.warn(`dshmarket 批量更新等待超时（${DSH_MARKET_BATCH_MAX_WAIT_MS}ms），继续重载插件。`)
    if (isQuitting || isRecycling) return
    // Another profile change or update-all IPC arrived during the quiet
    // check. Start the check over rather than restarting a just-continued
    // batch from its first completion boundary.
    if (profileActivationRecycleGeneration !== generation) continue
    await recycleDshForPluginUpdate()
  }
}

async function recycleDshForPluginUpdate(): Promise<void> {
  if (isQuitting || isRecycling || lastStartOptions === undefined || lastSeedOptions === undefined) return
  const startOptions = lastStartOptions
  const seedOptions = lastSeedOptions
  isRecycling = true
  broadcastShellState()
  try {
    await showStartupWindow(desktopText('加载中', 'Loading'))
    const current = server
    server = undefined
    await current?.stop()
    const updated = await applyPendingProfileUpdates(seedOptions)
    if (updated.length > 0) console.log('已热更新插件：' + updated.join('、'))
    const started = await startWithProfileSelfRepair({
      profileDir: seedOptions.profileDir,
      extraDirs: seedOptions.desktopRuntimeDir === undefined ? [] : [seedOptions.desktopRuntimeDir],
      start: () => startDsh({
        ...startOptions,
        onUnexpectedExit: handleUnexpectedDshExit,
        onIpcMessage: handleDshIpc,
      }),
    })
    server = started.result
    await createMainWindow(server.url)
  } catch (error) {
    await reportStartupFailure(error)
  } finally {
    profileWatcher?.sync()
    isRecycling = false
    broadcastShellState()
  }
}

function handleUnexpectedDshExit(message: string): void {
  if (isQuitting || isRecycling) return
  server = undefined
  const missing = parseUnresolvedBundleError(message)
  if (missing !== undefined && lastSeedOptions !== undefined) {
    runMainTask(quarantineProfileBundle(lastSeedOptions.profileDir, missing, message, 'runtime').then((removed) => {
      if (removed) runMainTask(recycleDshForPluginUpdate())
    }))
    return
  }
  void writeTextFile(join(app.getPath('userData'), 'startup-error.log'), `${message}\n`, 'utf8').catch(() => undefined)
  runMainTask(showStartupWindow(desktopText('DSH 已停止运行。请重新启动应用。', 'DSH has stopped. Restart the app.')))
}

function resolveWindowIconPath(): string | undefined {
  return resolveAppIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
}

function resolveShellAsset(name: 'shell.html' | 'shortcuts.html' | 'about.html' | 'settings.html'): string {
  const packaged = join(process.resourcesPath, name)
  return existsSync(packaged) ? packaged : join(app.getAppPath(), 'assets', name)
}

function resolvePreload(name: 'shell-preload.cjs' | 'dsh-view-preload.cjs'): string {
  return join(app.getAppPath(), 'dist', 'src', name)
}

function requireDshView(): WebContentsView {
  if (dshView === undefined) throw new Error('DSH 内容视图尚未创建。')
  return dshView
}

function layoutDshView(window: BrowserWindow): void {
  const bounds = window.getContentBounds()
  if (browserVisible && browserPanelBounds !== undefined) {
    // DSH Web GUI 右侧面板模式：WebContentsView 覆盖在面板内容区上方
    // dshView 保持全宽（GUI 自己管理面板布局），浏览器 view 定位到面板坐标
    dshView?.setBounds({ x: 0, y: SHELL_BAR_HEIGHT, width: bounds.width, height: Math.max(0, bounds.height - SHELL_BAR_HEIGHT) })
    const bp = browserPanelBounds
    for (const tab of browserTabs) {
      const visible = tab.id === activeBrowserTabId
      tab.view.setVisible(visible)
      if (visible) tab.view.setBounds({ x: bp.x, y: bp.y + SHELL_BAR_HEIGHT, width: bp.width, height: bp.height })
    }
  } else if (browserVisible) {
    // 回退：独立右侧面板模式（顶栏按钮触发，无 GUI 面板坐标）
    const panelWidth = Math.round(bounds.width * browserWidthRatio)
    const browserX = bounds.width - panelWidth
    dshView?.setBounds({ x: 0, y: SHELL_BAR_HEIGHT, width: Math.max(0, browserX), height: Math.max(0, bounds.height - SHELL_BAR_HEIGHT) })
    const browserY = SHELL_BAR_HEIGHT + BROWSER_TABS_BAR_HEIGHT + BROWSER_NAV_BAR_HEIGHT
    const browserHeight = Math.max(0, bounds.height - browserY)
    for (const tab of browserTabs) {
      const visible = tab.id === activeBrowserTabId
      tab.view.setVisible(visible)
      if (visible) tab.view.setBounds({ x: browserX, y: browserY, width: panelWidth, height: browserHeight })
    }
  } else {
    dshView?.setBounds({ x: 0, y: SHELL_BAR_HEIGHT, width: bounds.width, height: Math.max(0, bounds.height - SHELL_BAR_HEIGHT) })
    for (const tab of browserTabs) tab.view.setVisible(false)
  }
  broadcastShellState()
}

function createWindow(): BrowserWindow {
  const windowIcon = resolveWindowIconImage()
  const palette = DESKTOP_THEME_PALETTES[activeDshColorScheme]
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: true,
    title: DESKTOP_APP_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // The small Windows non-client edge is painted from this color. Keep it
    // aligned with the title-bar wash instead of leaving a white seam above
    // the CSS gradient.
    backgroundColor: palette.titleBarBackground,
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: palette.titleBarBackground, symbolColor: palette.titleBarSymbol, height: SHELL_BAR_HEIGHT } }),
    ...(windowIcon === undefined ? {} : { icon: windowIcon }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolvePreload('shell-preload.cjs'),
      sandbox: true,
    },
  })
  const view = new WebContentsView({ webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: resolvePreload('dsh-view-preload.cjs'),
    sandbox: true,
  } })
  dshView = view
  window.contentView.addChildView(view)
  layoutDshView(window)
  window.on('resize', () => layoutDshView(window))
  window.on('maximize', () => layoutDshView(window))
  window.on('unmaximize', () => layoutDshView(window))
  runMainTask(window.loadFile(resolveShellAsset('shell.html'), { query: { theme: activeDshColorScheme } }))

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenUrl(url, allowedOrigin)) runMainTask(shell.openExternal(url))
    return { action: 'deny' }
  })
  view.webContents.on('did-start-navigation', () => { dshSettingsDialogVisible = false })
  view.webContents.on('will-navigate', (event, url) => {
    if (windowNavigation.isNavigating()) {
      event.preventDefault()
      return
    }
    if (isSameOrigin(url, allowedOrigin)) return
    event.preventDefault()
    if (isExternalOpenUrl(url, allowedOrigin)) runMainTask(shell.openExternal(url))
  })
  view.webContents.on('will-redirect', (event, url) => {
    if (isSameOrigin(url, allowedOrigin)) return
    event.preventDefault()
    if (isExternalOpenUrl(url, allowedOrigin)) runMainTask(shell.openExternal(url))
  })
  installShortcutHandler(window.webContents)
  installShortcutHandler(view.webContents)
  applyInitialWindowState(window)
  window.on('enter-full-screen', broadcastShellState)
  window.on('leave-full-screen', broadcastShellState)
  window.on('close', event => {
    saveBrowserWorkspace()
    if (!shouldHideInsteadOfClose(isQuitting)) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined
      dshView = undefined
      dshSettingsDialogVisible = false
      browserTabs.splice(0)
      activeBrowserTabId = null
    }
  })
  return window
}

function currentShellState(): ShellState {
  const window = mainWindow
  const zoomFactor = dshView?.webContents.getZoomFactor() ?? 1
  return {
    ...dshNavigationState,
    fullscreen: window?.isFullScreen() ?? false,
    reloading: isRecycling,
    zoomPercent: Math.round(zoomFactor * 100),
    browser: browserShellState(),
  }
}

function shellBootstrap(): ShellBootstrap {
  const locale = desktopLocale()
  return {
    actions: localizedShellActions(locale, process.platform),
    colorScheme: activeDshColorScheme,
    locale,
    menus: localizedShellMenus(locale),
    platform: process.platform,
    runtimeVersion: OFFICIAL_DSH_VERSION,
    state: currentShellState(),
    version: app.getVersion(),
  }
}

function broadcastShellBootstrap(): void {
  const bootstrap = shellBootstrap()
  for (const window of [mainWindow, shortcutsWindow, aboutWindow, settingsWindow]) {
    if (window !== undefined && !window.isDestroyed()) window.webContents.send(SHELL_IPC.bootstrap, bootstrap)
  }
}

function setWindowBackground(window: BrowserWindow | undefined, color: string): void {
  if (window !== undefined && !window.isDestroyed()) window.setBackgroundColor(color)
}

function applyDesktopTheme(colorScheme: DesktopColorScheme, preference?: DesktopThemePreference): void {
  activeDshColorScheme = colorScheme
  if (preference !== undefined) {
    activeDshThemePreference = preference
    nativeTheme.themeSource = preference
  }
  const palette = DESKTOP_THEME_PALETTES[colorScheme]
  setWindowBackground(mainWindow, palette.titleBarBackground)
  setWindowBackground(settingsWindow, palette.settingsBackground)
  setWindowBackground(shortcutsWindow, palette.shortcutsBackground)
  setWindowBackground(aboutWindow, palette.aboutBackground)
  if (process.platform !== 'darwin' && mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.setTitleBarOverlay({ color: palette.titleBarBackground, symbolColor: palette.titleBarSymbol, height: SHELL_BAR_HEIGHT })
  }
}

function broadcastShellState(): void {
  const state = currentShellState()
  for (const window of [mainWindow, shortcutsWindow, aboutWindow, settingsWindow]) {
    if (window !== undefined && !window.isDestroyed()) window.webContents.send(SHELL_IPC.state, state)
  }
}

function desktopUpdateSnapshot(): DesktopUpdateSnapshot {
  return {
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    status: updateStatus,
    ...(lastUpdateCheckAt === undefined ? {} : { lastCheckedAt: lastUpdateCheckAt }),
  }
}

function broadcastDesktopUpdateState(): void {
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(SHELL_IPC.desktopUpdateState, desktopUpdateSnapshot())
  }
}

function harnessUpdateSnapshot(): { available: boolean; policy: HarnessUpdatePolicy; state?: HarnessUpdateState; running: boolean } {
  return {
    available: harnessUpdaterContext !== undefined,
    policy: harnessUpdatePolicy,
    ...(harnessUpdateState === undefined ? {} : { state: harnessUpdateState }),
    running: harnessUpdateTask !== undefined,
  }
}

function broadcastHarnessUpdateState(): void {
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(SHELL_IPC.harnessUpdateState, harnessUpdateSnapshot())
  }
}

function setDesktopUpdateStatus(status: DesktopUpdateStatus, checked = false): void {
  updateStatus = status
  if (checked) lastUpdateCheckAt = new Date().toISOString()
  refreshTrayMenu()
  broadcastDesktopUpdateState()
}

function installShellIpc(): void {
  ipcMain.removeHandler(SHELL_IPC.getBootstrap)
  ipcMain.removeHandler(SHELL_IPC.action)
  ipcMain.removeHandler(SHELL_IPC.popupMenu)
  ipcMain.removeHandler(SHELL_IPC.getNotificationPreferences)
  ipcMain.removeHandler(SHELL_IPC.updateNotificationPreferences)
  ipcMain.removeHandler(SHELL_IPC.getUpdatePreferences)
  ipcMain.removeHandler(SHELL_IPC.updateUpdatePreferences)
  ipcMain.removeHandler(SHELL_IPC.getDesktopUpdateState)
  ipcMain.removeHandler(SHELL_IPC.desktopUpdateAction)
  ipcMain.removeHandler(SHELL_IPC.getHarnessUpdateState)
  ipcMain.removeHandler(SHELL_IPC.updateHarnessUpdatePolicy)
  ipcMain.removeHandler(SHELL_IPC.harnessUpdateAction)
  ipcMain.removeHandler(SHELL_IPC.closeDesktopSettings)
  ipcMain.handle(SHELL_IPC.getBootstrap, event => {
    if (!mayGetShellBootstrap(shellRendererKind(event.sender))) return
    return shellBootstrap()
  })
  ipcMain.handle(SHELL_IPC.action, (event, id: unknown) => {
    if (typeof id !== 'string' || !shellActionIds.has(id)) return
    const actionId = id as ShellActionId
    if (!mayInvokeShellAction(shellRendererKind(event.sender), actionId)) return
    return executeShellAction(actionId)
  })
  ipcMain.handle(SHELL_IPC.popupMenu, (event, request: ShellMenuPopupRequest) => {
    if (!mayPopupShellMenu(shellRendererKind(event.sender))) return
    return popupShellMenu(request)
  })
  ipcMain.handle(SHELL_IPC.getNotificationPreferences, event => {
    if (!mayAccessNotificationPreferences(shellRendererKind(event.sender))) return
    return notificationPreferences
  })
  ipcMain.handle(SHELL_IPC.updateNotificationPreferences, async (event, value: unknown) => {
    if (!mayAccessNotificationPreferences(shellRendererKind(event.sender))) return
    notificationPreferences = await saveNotificationPreferences(notificationPreferencesPath(), value)
    return notificationPreferences
  })
  ipcMain.handle(SHELL_IPC.getUpdatePreferences, event => {
    if (!mayAccessDesktopUpdates(shellRendererKind(event.sender))) return
    return updatePreferences
  })
  ipcMain.handle(SHELL_IPC.updateUpdatePreferences, async (event, value: unknown) => {
    if (!mayAccessDesktopUpdates(shellRendererKind(event.sender))) return
    updatePreferences = await saveUpdatePreferences(updatePreferencesPath(), value)
    if (shouldDownloadUpdateAutomatically(updatePreferences) && updateStatus.kind === 'available') {
      runMainTask(downloadDesktopUpdate('settings'))
    }
    return updatePreferences
  })
  ipcMain.handle(SHELL_IPC.getDesktopUpdateState, event => {
    if (!mayAccessDesktopUpdates(shellRendererKind(event.sender))) return
    return desktopUpdateSnapshot()
  })
  ipcMain.handle(SHELL_IPC.desktopUpdateAction, async (event, value: unknown) => {
    if (!mayAccessDesktopUpdates(shellRendererKind(event.sender))) return
    if (value !== 'check' && value !== 'download' && value !== 'install') return
    await handleDesktopUpdateSettingsAction(value)
    return desktopUpdateSnapshot()
  })
  ipcMain.handle(SHELL_IPC.getHarnessUpdateState, event => {
    if (!mayAccessDesktopUpdates(shellRendererKind(event.sender))) return
    return harnessUpdateSnapshot()
  })
  ipcMain.handle(SHELL_IPC.updateHarnessUpdatePolicy, async (event, value: unknown) => {
    if (!mayAccessDesktopUpdates(shellRendererKind(event.sender)) || harnessUpdaterContext === undefined) return harnessUpdateSnapshot()
    harnessUpdatePolicy = await saveHarnessUpdatePolicy(harnessUpdatePolicyPath(harnessUpdaterContext.updateRoot), value)
    if (harnessUpdateTimer !== undefined) clearTimeout(harnessUpdateTimer)
    harnessUpdateTimer = undefined
    if (harnessUpdatePolicy.mode !== 'manual') scheduleHarnessUpdateCheck(0)
    broadcastHarnessUpdateState()
    return harnessUpdateSnapshot()
  })
  ipcMain.handle(SHELL_IPC.harnessUpdateAction, async (event, value: unknown) => {
    if (!mayAccessDesktopUpdates(shellRendererKind(event.sender)) || value !== 'check' || harnessUpdaterContext === undefined) return harnessUpdateSnapshot()
    if (harnessUpdateTask === undefined) {
      if (harnessUpdateTimer !== undefined) clearTimeout(harnessUpdateTimer)
      harnessUpdateTimer = undefined
      const task = runHarnessUpdateCycle(harnessUpdaterContext, true)
      harnessUpdateTask = task
      broadcastHarnessUpdateState()
      await task.finally(() => {
        harnessUpdateTask = undefined
        broadcastHarnessUpdateState()
        if (!isQuitting && harnessUpdatePolicy.mode !== 'manual') scheduleHarnessUpdateCheck(harnessUpdatePolicy.checkIntervalHours * 60 * 60_000)
      })
    }
    return harnessUpdateSnapshot()
  })
  ipcMain.handle(SHELL_IPC.closeDesktopSettings, event => {
    if (!mayCloseDesktopSettings(shellRendererKind(event.sender))) return
    settingsWindow?.close()
  })
  ipcMain.removeHandler(SHELL_IPC.browserToggle)
  ipcMain.handle(SHELL_IPC.browserToggle, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    browserVisible = !browserVisible
    relayout()
    scheduleBrowserWorkspaceSave()
  })
  ipcMain.removeHandler(SHELL_IPC.browserNewTab)
  ipcMain.handle(SHELL_IPC.browserNewTab, (event, url: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    openBrowser(typeof url === 'string' && url !== '' ? url : undefined, true)
  })
  ipcMain.removeHandler(SHELL_IPC.browserOpenHomepages)
  ipcMain.handle(SHELL_IPC.browserOpenHomepages, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    openHomepageGroup()
  })
  ipcMain.removeHandler(SHELL_IPC.browserActivateTab)
  ipcMain.handle(SHELL_IPC.browserActivateTab, (event, id: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    if (typeof id === 'string') activateBrowserTab(id)
  })
  ipcMain.removeHandler(SHELL_IPC.browserCloseTab)
  ipcMain.handle(SHELL_IPC.browserCloseTab, (event, id: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    if (typeof id === 'string') closeBrowserTab(id)
  })
  ipcMain.removeHandler(SHELL_IPC.browserNavigate)
  ipcMain.handle(SHELL_IPC.browserNavigate, (event, value: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    if (typeof value !== 'string' || value.trim() === '') return
    const tab = getActiveBrowserTab()
    if (tab !== null) void tab.view.webContents.loadURL(normalizeBrowserAddress(value)).catch((error: Error) => console.error(`浏览器加载失败：${error.message}`))
  })
  ipcMain.removeHandler(SHELL_IPC.browserBack)
  ipcMain.handle(SHELL_IPC.browserBack, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents !== undefined && !contents.isDestroyed() && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  })
  ipcMain.removeHandler(SHELL_IPC.browserForward)
  ipcMain.handle(SHELL_IPC.browserForward, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents !== undefined && !contents.isDestroyed() && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  })
  ipcMain.removeHandler(SHELL_IPC.browserReload)
  ipcMain.handle(SHELL_IPC.browserReload, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    getActiveBrowserTab()?.view.webContents.reload()
  })
  ipcMain.removeHandler(SHELL_IPC.browserShowPanel)
  ipcMain.handle(SHELL_IPC.browserShowPanel, event => {
    if (!mayInvokeBrowserPanelIpc(shellRendererKind(event.sender))) return
    browserVisible = true
    relayout()
    focusActiveBrowserTab()
    scheduleBrowserWorkspaceSave()
  })
  ipcMain.removeHandler(SHELL_IPC.browserHidePanel)
  ipcMain.handle(SHELL_IPC.browserHidePanel, event => {
    if (!mayInvokeBrowserPanelIpc(shellRendererKind(event.sender))) return
    browserVisible = false
    browserPanelBounds = undefined
    relayout()
    scheduleBrowserWorkspaceSave()
  })
  ipcMain.removeAllListeners(SHELL_IPC.browserPanelBounds)
  ipcMain.on(SHELL_IPC.browserPanelBounds, (event, bounds: unknown) => {
    if (!mayInvokeBrowserPanelIpc(shellRendererKind(event.sender))) return
    if (typeof bounds !== 'object' || bounds === null) return
    const b = bounds as Record<string, unknown>
    if (typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.width !== 'number' || typeof b.height !== 'number') return
    browserPanelBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    if (browserVisible) relayout()
  })
  ipcMain.removeAllListeners(SHELL_IPC.dshState)
  ipcMain.on(SHELL_IPC.dshState, (event, state: Partial<DshNavigationState>) => {
    if (!mayReportDshState(shellRendererKind(event.sender))) return
    if (typeof state !== 'object' || state === null) return
    dshNavigationState = {
      canBack: state.canBack === true,
      canForward: state.canForward === true,
      canNextChat: state.canNextChat === true,
      canPreviousChat: state.canPreviousChat === true,
    }
    broadcastShellState()
  })
  ipcMain.removeAllListeners(SHELL_IPC.dshLocale)
  ipcMain.on(SHELL_IPC.dshLocale, (event, value: unknown) => {
    if (!mayReportDshLocale(shellRendererKind(event.sender))) return
    const locale = normalizeShellLocale(value)
    if (locale === undefined || locale === activeDshLocale) return
    activeDshLocale = locale
    broadcastShellBootstrap()
    updateUnreadCompletionBadge(unreadCompletionCount)
  })
  ipcMain.removeAllListeners(SHELL_IPC.dshTheme)
  ipcMain.on(SHELL_IPC.dshTheme, (event, value: unknown) => {
    if (!mayReportDshTheme(shellRendererKind(event.sender))) return
    const snapshot = normalizeDesktopThemeSnapshot(value)
    if (snapshot === undefined) return
    const colorSchemeChanged = snapshot.colorScheme !== activeDshColorScheme
    const preferenceChanged = snapshot.preference !== undefined && snapshot.preference !== activeDshThemePreference
    if (!colorSchemeChanged && !preferenceChanged) return
    applyDesktopTheme(snapshot.colorScheme, snapshot.preference)
    if (colorSchemeChanged) broadcastShellBootstrap()
  })
  ipcMain.removeAllListeners(SHELL_IPC.dshSettingsVisibility)
  ipcMain.on(SHELL_IPC.dshSettingsVisibility, (event, value: unknown) => {
    if (!mayReportDshSettingsVisibility(shellRendererKind(event.sender))) return
    dshSettingsDialogVisible = value === true
  })
  ipcMain.removeAllListeners(SHELL_IPC.dshNotification)
  ipcMain.on(SHELL_IPC.dshNotification, (event, value: unknown) => {
    if (!mayReportDshNotification(shellRendererKind(event.sender))) return
    const notificationEvent = parseDesktopNotificationBridgeEvent(value)
    if (notificationEvent === undefined) return
    if (notificationEvent.type === 'badge') {
      updateUnreadCompletionBadge(notificationEvent.count)
      return
    }
    if (notificationEvent.type === 'activity') {
      if (notificationEvent.count !== activeDshWorkCount) {
        activeDshWorkCount = notificationEvent.count
        activeDshWorkChangedAt = Date.now()
      }
      return
    }
    if (notificationEvent.type === 'dismiss') {
      dismissNotificationsForSession(notificationEvent.sessionId)
      return
    }
    if (notificationEvent.type === 'reply-error') {
      showNotificationReplyError(notificationEvent.sessionId)
      return
    }
    showDesktopNotification(notificationEvent)
  })
}

function shellRendererKind(sender: WebContents): ShellRendererKind {
  if (sender === mainWindow?.webContents) return 'main'
  if (sender === shortcutsWindow?.webContents) return 'shortcuts'
  if (sender === aboutWindow?.webContents) return 'about'
  if (sender === settingsWindow?.webContents) return 'settings'
  if (sender === dshView?.webContents) return 'dsh'
  return 'unknown'
}

function isActionEnabled(id: ShellActionId): boolean {
  if (id === 'reload') return !isRecycling && lastStartOptions !== undefined && lastSeedOptions !== undefined
  if (id === 'back') return dshNavigationState.canBack
  if (id === 'forward') return dshNavigationState.canForward
  if (id === 'previous-chat') return dshNavigationState.canPreviousChat
  if (id === 'next-chat') return dshNavigationState.canNextChat
  return true
}

function popupShellMenu(request: ShellMenuPopupRequest): Promise<void> {
  return new Promise(resolve => {
    if (request === null || typeof request !== 'object') { resolve(); return }
    if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) { resolve(); return }
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) { resolve(); return }
    const menuId = request.menu as ShellMenuId
    const actions = localizedShellActions(desktopLocale(), process.platform).filter(action => action.menu === menuId)
    if (actions.length === 0) { resolve(); return }
    const template: MenuItemConstructorOptions[] = []
    let group = actions[0]?.group
    for (const action of actions) {
      if (group !== undefined && action.group !== group) template.push({ type: 'separator' })
      group = action.group
      template.push({
        label: action.label,
        enabled: isActionEnabled(action.id),
        ...(action.acceleratorLabel === undefined ? {} : { accelerator: action.acceleratorLabel }),
        click: () => { runMainTask(Promise.resolve(executeShellAction(action.id))) },
      })
    }
    const menu = Menu.buildFromTemplate(template)
    // `popup`'s callback is not delivered consistently when a native Windows
    // menu is dismissed by clicking its owner window. `menu-will-close` is
    // the close lifecycle event, so resolve from either signal exactly once.
    let settled = false
    const close = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    menu.once('menu-will-close', close)
    menu.popup({
      window,
      x: Math.round(request.x),
      y: Math.round(request.y),
      callback: close,
    })
  })
}

const DISMISS_DSH_SETTINGS_DIALOG_SCRIPT = `(() => {
  const label = (element) => ((element.getAttribute('aria-label') || '') + ' ' + (element.textContent || '')).replace(/\s+/g, ' ').trim().toLowerCase()
  const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .find((element) => {
      if (element.offsetParent === null) return false
      const titleId = element.getAttribute('aria-labelledby')
      const title = titleId === null ? null : document.getElementById(titleId)
      return title !== null && /^(设置|settings)$/i.test(label(title))
    })
  if (!dialog) return false
  const close = [...dialog.querySelectorAll('button')]
    .find((element) => /^(关闭|close)$/i.test(label(element)))
  if (!close) return false
  close.click()
  return true
})()`

function dismissDshSettingsDialog(): void {
  const contents = dshView?.webContents
  if (contents === undefined || contents.isDestroyed()) return
  void contents.executeJavaScript(DISMISS_DSH_SETTINGS_DIALOG_SCRIPT).catch(() => undefined)
}

function installShortcutHandler(contents: Electron.WebContents): void {
  contents.on('before-input-event', (event, input: Input) => {
    if (input.type !== 'keyDown') return
    const auxiliaryWindow = [shortcutsWindow, aboutWindow, settingsWindow].find(window => window?.webContents === contents)
    const route = escapeRoute({
      key: input.key,
      isAuxiliaryWindow: auxiliaryWindow !== undefined,
      isDesktopSettingsWindow: auxiliaryWindow === settingsWindow,
      isMainShell: contents === mainWindow?.webContents,
      isDshSettingsDialogVisible: dshSettingsDialogVisible,
    })
    if (route === 'close-auxiliary') {
      event.preventDefault()
      auxiliaryWindow?.close()
      return
    }
    if (route === 'dismiss-dsh-settings') {
      event.preventDefault()
      dismissDshSettingsDialog()
      return
    }
    const id = shellActionForShortcut(input, process.platform)
    if (id === undefined || !isActionEnabled(id)) return
    event.preventDefault()
    if (id === 'close-window' && auxiliaryWindow !== undefined) {
      auxiliaryWindow.close()
      return
    }
    runMainTask(Promise.resolve(executeShellAction(id)))
  })
}

function sendDshAction(id: DshShellActionId): void {
  if (dshView !== undefined && !dshView.webContents.isDestroyed()) dshView.webContents.send(SHELL_IPC.dshAction, id)
}

async function executeShellAction(id: ShellActionId): Promise<void> {
  if (!isActionEnabled(id)) return
  const contents = dshView?.webContents
  if (id === 'new-chat' || id === 'open-folder' || id === 'settings' || id === 'toggle-sidebar' || id === 'find' || id === 'previous-chat' || id === 'next-chat' || id === 'back' || id === 'forward') {
    sendDshAction(id)
    return
  }
  if (id === 'close-window') { mainWindow?.hide(); return }
  if (id === 'desktop-settings') { showDesktopSettingsWindow(); return }
  if (id === 'quit') { await requestQuit(); return }
  if (id === 'app-restart') { await requestAppRestart(); return }
  if (id === 'home') { openHomepageGroup(); return }
  if (id === 'browser-toggle') {
    browserVisible = !browserVisible
    relayout()
    scheduleBrowserWorkspaceSave()
    return
  }
  if (contents === undefined) return
  if (id === 'undo') contents.undo()
  else if (id === 'redo') contents.redo()
  else if (id === 'cut') contents.cut()
  else if (id === 'copy') contents.copy()
  else if (id === 'paste') contents.paste()
  else if (id === 'delete') contents.delete()
  else if (id === 'select-all') contents.selectAll()
  else if (id === 'zoom-in') contents.setZoomFactor(Math.min(2, contents.getZoomFactor() + 0.1))
  else if (id === 'zoom-out') contents.setZoomFactor(Math.max(0.5, contents.getZoomFactor() - 0.1))
  else if (id === 'zoom-reset') contents.setZoomFactor(1)
  else if (id === 'toggle-fullscreen') mainWindow?.setFullScreen(!(mainWindow?.isFullScreen() ?? false))
  else if (id === 'show-shortcuts') showShortcutsWindow()
  else if (id === 'reload') await recycleDshForPluginUpdate()
  else if (id === 'check-updates') await checkDesktopUpdate()
  else if (id === 'whats-new') await shell.openExternal('https://github.com/MichengAI/dsh-codex-desktop/releases')
  else if (id === 'feedback') await shell.openExternal('https://github.com/MichengAI/dsh-codex-desktop/issues/new')
  else if (id === 'about') showAboutWindow()
  broadcastShellState()
}

function notificationPreferencesPath(): string {
  return join(app.getPath('userData'), 'desktop-settings.json')
}

function updatePreferencesPath(): string {
  return join(app.getPath('userData'), 'desktop-update-settings.json')
}

/**
 * Windows resolves a toast's small source icon from a Start Menu shortcut that
 * matches both the running executable and AppUserModelID. Packaged installs get
 * this from electron-builder; isolated test runs need the same registration or
 * Windows falls back to the generic Electron identity shown in the toast header.
 */
function ensureWindowsNotificationIdentity(): void {
  if (process.platform !== 'win32') return
  const notificationIcon = resolveNotificationIconPath({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
  const shortcutDirectories = [
    join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.ProgramData === undefined ? undefined : join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ].filter((value): value is string => value !== undefined)
  for (const directory of shortcutDirectories) {
    for (const name of [`${DESKTOP_APP_NAME}.lnk`, `${DESKTOP_APP_NAME} Test.lnk`]) {
      const shortcut = join(directory, name)
      if (!existsSync(shortcut)) continue
      try {
        const details = shell.readShortcutLink(shortcut)
        if (resolve(details.target).toLocaleLowerCase() !== resolve(process.execPath).toLocaleLowerCase()) continue
        shell.writeShortcutLink(shortcut, 'update', {
          target: details.target,
          appUserModelId: DESKTOP_APP_USER_MODEL_ID,
          toastActivatorClsid: DESKTOP_TOAST_ACTIVATOR_CLSID,
          ...(notificationIcon === undefined ? {} : { icon: notificationIcon, iconIndex: 0 }),
        })
      } catch {
        // A stale or protected shortcut must not prevent the desktop app from starting.
      }
    }
  }
  if (app.isPackaged || !process.argv.some(argument => argument.startsWith('--user-data-dir='))) return
  const icon = notificationIcon
  if (icon === undefined) return
  const shortcut = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${DESKTOP_APP_NAME} Test.lnk`)
  const args = process.argv.slice(1)
    .map(argument => /\s|"/.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument)
    .join(' ')
  shell.writeShortcutLink(shortcut, existsSync(shortcut) ? 'replace' : 'create', {
    target: process.execPath,
    args,
    cwd: app.getAppPath(),
    description: `${DESKTOP_APP_NAME} test build`,
    icon,
    iconIndex: 0,
    appUserModelId: DESKTOP_APP_USER_MODEL_ID,
    toastActivatorClsid: DESKTOP_TOAST_ACTIVATOR_CLSID,
  })
}

function sendNotificationReplyToDsh(sessionId: string, text: string): void {
  if (dshView === undefined || dshView.webContents.isDestroyed()) {
    showNotificationReplyError(sessionId)
    return
  }
  dshView.webContents.send(SHELL_IPC.dshNotificationReply, { sessionId, text })
}

function installWindowsNotificationActivationHandler(): void {
  if (process.platform !== 'win32') return
  Notification.handleActivation(details => {
    const reply = parseWindowsNotificationReplyActivation(details)
    if (reply === undefined) return
    sendNotificationReplyToDsh(reply.sessionId, reply.text)
  })
}

function notificationCopy(event: DesktopNotificationEvent): { title: string; body: string } {
  const zh = isChineseLocale(desktopLocale())
  const status = event.kind === 'approval'
    ? (zh ? '需要审批' : 'Approval required')
    : event.kind === 'question'
      ? (zh ? '需要你的输入' : 'Your input is needed')
      : (zh ? '任务已完成' : 'Task completed')
  const title = event.title === undefined ? status : `${status} · ${event.title}`
  if (event.body !== undefined) {
    return { title, body: event.body }
  }
  const task = event.title === undefined
    ? (zh ? 'DeepSeek Harness 任务' : 'DeepSeek Harness task')
    : `“${event.title}”`
  if (event.kind === 'approval') return { title, body: zh ? `${task}正在等待审批` : `${task} is waiting for approval` }
  if (event.kind === 'question') return { title, body: zh ? `${task}正在等待你的回答` : `${task} is waiting for your answer` }
  return { title, body: zh ? `${task}已完成` : `${task} is complete` }
}

function updateUnreadCompletionBadge(count: number): void {
  unreadCompletionCount = count
  if (process.platform === 'win32' && mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (count === 0) {
      mainWindow.setOverlayIcon(null, '')
    } else {
      const iconPath = resolveTaskBadgeIconPath({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }, count)
      const overlay = nativeImage.createFromPath(iconPath)
      if (!overlay.isEmpty()) {
        const description = isChineseLocale(desktopLocale()) ? `${count} 个已完成任务` : `${count} completed tasks`
        mainWindow.setOverlayIcon(overlay, description)
      }
    }
  } else if (process.platform === 'darwin' || process.platform === 'linux') {
    app.setBadgeCount(count)
  }
  refreshTrayMenu()
}

function dismissNotificationsForSession(sessionId: string): void {
  for (const [id, notification] of activeNotifications) {
    if (!id.endsWith(`:${sessionId}`)) continue
    notification.close()
    activeNotifications.delete(id)
  }
}

function focusMainWindowForNotification(): void {
  showMainWindow()
  if (process.platform !== 'win32' || mainWindow === undefined) return
  mainWindow.setAlwaysOnTop(true)
  mainWindow.focus()
  mainWindow.setAlwaysOnTop(false)
}

function openNotificationSession(sessionId: string): void {
  focusMainWindowForNotification()
  if (dshView !== undefined && !dshView.webContents.isDestroyed()) {
    dshView.webContents.send(SHELL_IPC.dshOpenSession, sessionId)
  }
}

function showNotificationReplyError(sessionId: string): void {
  if (!Notification.isSupported()) return
  const zh = isChineseLocale(desktopLocale())
  const id = `reply-error:${sessionId}`
  activeNotifications.get(id)?.close()
  const notification = new Notification({
    title: zh ? '回复发送失败' : 'Reply not sent',
    body: zh ? '未能将回复发送到这个任务。请打开任务后重试。' : 'The reply could not be sent to this task. Open it and try again.',
    timeoutType: 'never',
  })
  activeNotifications.set(id, notification)
  notification.on('click', () => {
    openNotificationSession(sessionId)
    dismissNotificationsForSession(sessionId)
  })
  notification.on('close', () => {
    if (activeNotifications.get(id) === notification) activeNotifications.delete(id)
  })
  notification.show()
}

function showDesktopNotification(event: DesktopNotificationEvent): void {
  if (!Notification.isSupported()) return
  if (!shouldShowDesktopNotification(event, notificationPreferences, mainWindow?.isFocused() ?? false)) return
  const id = `${event.kind}:${event.sessionId}`
  activeNotifications.get(id)?.close()
  const copy = notificationCopy(event)
  const supportsReply = event.kind !== 'approval' && (process.platform === 'win32' || process.platform === 'darwin')
  const zh = isChineseLocale(desktopLocale())
  const replyPlaceholder = zh ? `回复 ${DESKTOP_APP_NAME}` : `Reply to ${DESKTOP_APP_NAME}`
  const toastId = `dsh-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`
  const notification = new Notification({
    ...copy,
    ...(supportsReply ? {
      hasReply: true,
      replyPlaceholder,
    } : {}),
    ...(supportsReply && process.platform === 'win32' ? {
      id: toastId,
      toastXml: buildWindowsReplyToastXml({
        ...copy,
        id: toastId,
        persistent: event.kind !== 'turn-complete',
        placeholder: replyPlaceholder,
        replyLabel: zh ? '回复' : 'Reply',
        replyArguments: windowsNotificationReplyArguments(event.sessionId),
        closeLabel: zh ? '关闭' : 'Close',
      }),
    } : {}),
    ...(event.kind === 'turn-complete' ? {} : { timeoutType: 'never' }),
  })
  activeNotifications.set(id, notification)
  notification.on('click', () => {
    openNotificationSession(event.sessionId)
    dismissNotificationsForSession(event.sessionId)
  })
  if (supportsReply && process.platform !== 'win32') {
    notification.on('reply', (details, legacyReply) => {
      const text = (details.reply ?? legacyReply).trim().slice(0, 4_000)
      if (text === '') return
      sendNotificationReplyToDsh(event.sessionId, text)
    })
  }
  notification.on('close', () => {
    if (activeNotifications.get(id) === notification) activeNotifications.delete(id)
  })
  notification.show()
}

type DesktopSettingsSection = 'notifications' | 'updates'

function removeNativeWindowMenu(window: BrowserWindow): void {
  if (process.platform === 'darwin') return
  window.setMenu(null)
  window.setMenuBarVisibility(false)
}

function showDesktopSettingsWindow(section: DesktopSettingsSection = 'notifications'): void {
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    settingsWindow.webContents.send(SHELL_IPC.settingsSection, section)
    return
  }
  const window = new BrowserWindow({
    parent: mainWindow,
    width: 760,
    height: 620,
    minWidth: 680,
    minHeight: 540,
    title: desktopText('桌面端设置', 'Desktop Settings'),
    autoHideMenuBar: true,
    backgroundColor: DESKTOP_THEME_PALETTES[activeDshColorScheme].settingsBackground,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: resolvePreload('shell-preload.cjs'), sandbox: true },
  })
  removeNativeWindowMenu(window)
  settingsWindow = window
  window.on('closed', () => { if (settingsWindow === window) settingsWindow = undefined })
  installShortcutHandler(window.webContents)
  window.webContents.once('did-finish-load', () => {
    window.webContents.send(SHELL_IPC.settingsSection, section)
    window.webContents.send(SHELL_IPC.desktopUpdateState, desktopUpdateSnapshot())
  })
  runMainTask(window.loadFile(resolveShellAsset('settings.html'), { query: { theme: activeDshColorScheme } }))
}

function showShortcutsWindow(): void {
  if (shortcutsWindow !== undefined && !shortcutsWindow.isDestroyed()) {
    shortcutsWindow.show(); shortcutsWindow.focus(); return
  }
  const window = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 620,
    height: 650,
    minWidth: 520,
    minHeight: 480,
    title: desktopText('键盘快捷键', 'Keyboard Shortcuts'),
    autoHideMenuBar: true,
    backgroundColor: DESKTOP_THEME_PALETTES[activeDshColorScheme].shortcutsBackground,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: resolvePreload('shell-preload.cjs'), sandbox: true },
  })
  removeNativeWindowMenu(window)
  shortcutsWindow = window
  window.on('closed', () => { if (shortcutsWindow === window) shortcutsWindow = undefined })
  installShortcutHandler(window.webContents)
  runMainTask(window.loadFile(resolveShellAsset('shortcuts.html'), { query: { theme: activeDshColorScheme } }))
}

function showAboutWindow(): void {
  if (aboutWindow !== undefined && !aboutWindow.isDestroyed()) {
    aboutWindow.show()
    aboutWindow.focus()
    return
  }
  const icon = resolveWindowIconImage()
  const window = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 560,
    height: 680,
    minWidth: 560,
    minHeight: 680,
    maxWidth: 560,
    maxHeight: 680,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: desktopText(`关于 ${DESKTOP_APP_NAME}`, `About ${DESKTOP_APP_NAME}`),
    autoHideMenuBar: true,
    backgroundColor: DESKTOP_THEME_PALETTES[activeDshColorScheme].aboutBackground,
    ...(icon === undefined ? {} : { icon }),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: resolvePreload('shell-preload.cjs'), sandbox: true },
  })
  removeNativeWindowMenu(window)
  aboutWindow = window
  window.on('closed', () => { if (aboutWindow === window) aboutWindow = undefined })
  installShortcutHandler(window.webContents)
  runMainTask(window.loadFile(resolveShellAsset('about.html'), { query: { theme: activeDshColorScheme } }))
}

function configureDesktopUpdater(): void {
  autoUpdater.logger = console
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  const channel = desktopUpdateChannel()
  if (channel !== undefined) {
    autoUpdater.channel = channel
    autoUpdater.allowDowngrade = false
  }
  autoUpdater.on('download-progress', progress => {
    setDesktopUpdateStatus({ kind: 'downloading', percent: progress.percent })
  })
  autoUpdater.on('update-downloaded', info => {
    setDesktopUpdateStatus({ kind: 'ready', version: info.version })
  })
  autoUpdater.on('error', error => {
    setDesktopUpdateStatus({ kind: 'error', message: publicDesktopUpdateError(error, desktopLocale()) })
  })
}

function scheduleStartupUpdateCheck(): void {
  if (startupUpdateTimer !== undefined || !shouldCheckForUpdatesOnStartup(updatePreferences, app.isPackaged)) return
  startupUpdateTimer = setTimeout(() => {
    startupUpdateTimer = undefined
    if (!isQuitting && shouldCheckForUpdatesOnStartup(updatePreferences, app.isPackaged)) {
      runMainTask(checkDesktopUpdate('background'))
    }
  }, STARTUP_UPDATE_CHECK_DELAY_MS)
}

const HARNESS_INITIAL_CHECK_DELAY_MS = 15_000
const HARNESS_IDLE_POLL_MS = 1_000
const HARNESS_IDLE_MAX_WAIT_MS = 10 * 60_000

async function configureHarnessUpdater(context: HarnessUpdaterContext): Promise<void> {
  harnessUpdaterContext = context
  const currentVersion = runtimeSlotVersion(resolveActiveRuntimeDir(context.legacyRuntimeDir)) ?? OFFICIAL_DSH_VERSION
  harnessUpdatePolicy = await loadHarnessUpdatePolicy(harnessUpdatePolicyPath(context.updateRoot))
  harnessUpdateState = await loadHarnessUpdateState(harnessUpdateStatePath(context.updateRoot), currentVersion)
  scheduleHarnessUpdateCheck(HARNESS_INITIAL_CHECK_DELAY_MS)
}

function scheduleHarnessUpdateCheck(delayMs: number): void {
  if (harnessUpdaterContext === undefined || harnessUpdateTimer !== undefined || harnessUpdateTask !== undefined || harnessUpdatePolicy.mode === 'manual') return
  harnessUpdateTimer = setTimeout(() => {
    harnessUpdateTimer = undefined
    if (isQuitting || harnessUpdaterContext === undefined) return
    if (harnessUpdateTask !== undefined) {
      scheduleHarnessUpdateCheck(harnessUpdatePolicy.checkIntervalHours * 60 * 60_000)
      return
    }
    const task = runHarnessUpdateCycle(harnessUpdaterContext)
    harnessUpdateTask = task
    void task.catch(handleUnexpectedMainError).finally(() => {
      harnessUpdateTask = undefined
      if (!isQuitting) scheduleHarnessUpdateCheck(harnessUpdatePolicy.checkIntervalHours * 60 * 60_000)
    })
  }, delayMs)
  harnessUpdateTimer.unref?.()
}

async function setHarnessUpdateState(
  context: HarnessUpdaterContext,
  phase: HarnessUpdateState['phase'],
  patch: Partial<Omit<HarnessUpdateState, 'schema' | 'phase' | 'updatedAt'>> = {},
): Promise<void> {
  const currentVersion = runtimeSlotVersion(resolveActiveRuntimeDir(context.legacyRuntimeDir)) ?? OFFICIAL_DSH_VERSION
  harnessUpdateState = await saveHarnessUpdateState(harnessUpdateStatePath(context.updateRoot), {
    ...harnessUpdateState,
    ...patch,
    schema: 1,
    phase,
    currentVersion,
    updatedAt: new Date().toISOString(),
  }, currentVersion)
  broadcastHarnessUpdateState()
}

async function runHarnessUpdateCycle(context: HarnessUpdaterContext, interactive = false): Promise<void> {
  const checkTransactionId = randomUUID()
  const startedAt = Date.now()
  const currentVersion = runtimeSlotVersion(resolveActiveRuntimeDir(context.legacyRuntimeDir)) ?? OFFICIAL_DSH_VERSION
  try {
    await setHarnessUpdateState(context, 'checking', { transactionId: checkTransactionId, detail: '正在核对 npm、GitHub 标签和受信发布清单。' })
    await appendHarnessUpdateEvent(context.updateRoot, {
      transactionId: checkTransactionId,
      phase: 'check',
      outcome: 'start',
      timestamp: new Date().toISOString(),
      currentVersion,
    })
    const checked = await checkHarnessUpdate({ currentVersion, policy: harnessUpdatePolicy })
    if (!checked.updateAvailable || checked.candidate === undefined) {
      await setHarnessUpdateState(context, 'idle', { lastCheckedAt: checked.checkedAt, detail: '当前已是受检通道的最新版本。' })
      await appendHarnessUpdateEvent(context.updateRoot, {
        transactionId: checkTransactionId,
        phase: 'check',
        outcome: 'success',
        timestamp: new Date().toISOString(),
        currentVersion,
        durationMs: Date.now() - startedAt,
        detail: '没有可用更新。',
      })
      return
    }
    const candidate = checked.candidate
    if (!candidate.automaticEligible || (!interactive && harnessUpdatePolicy.mode !== 'safe-auto' && harnessUpdatePolicy.mode !== 'maintenance-auto')) {
      const detail = candidate.automaticBlockReason ?? '策略要求仅通知，不自动部署。'
      await setHarnessUpdateState(context, candidate.automaticEligible ? 'available' : 'blocked', {
        lastCheckedAt: checked.checkedAt,
        targetVersion: candidate.version,
        detail,
      })
      await appendHarnessUpdateEvent(context.updateRoot, {
        transactionId: checkTransactionId,
        phase: 'trust-gate',
        outcome: 'blocked',
        timestamp: new Date().toISOString(),
        currentVersion,
        targetVersion: candidate.version,
        detail,
      })
      return
    }
    await deployHarnessCandidate(context, candidate, checked.checkedAt)
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知 DSH 运行时更新错误。'
    await setHarnessUpdateState(context, 'failed', { transactionId: checkTransactionId, detail }).catch(() => undefined)
    await appendHarnessUpdateEvent(context.updateRoot, {
      transactionId: checkTransactionId,
      phase: 'cycle',
      outcome: 'failure',
      timestamp: new Date().toISOString(),
      currentVersion,
      durationMs: Date.now() - startedAt,
      detail,
    }).catch(() => undefined)
    console.error(`DSH 运行时后台更新失败：${detail}`)
  }
}

async function deployHarnessCandidate(context: HarnessUpdaterContext, release: HarnessReleaseCandidate, checkedAt: string): Promise<void> {
  const lock = await acquireHarnessUpdateLock(context.updateRoot)
  const transactionId = lock.transactionId
  const currentVersion = runtimeSlotVersion(resolveActiveRuntimeDir(context.legacyRuntimeDir)) ?? OFFICIAL_DSH_VERSION
  const event = async (phase: string, outcome: 'start' | 'success' | 'failure' | 'blocked' | 'info', detail?: string): Promise<void> => {
    await appendHarnessUpdateEvent(context.updateRoot, {
      transactionId,
      phase,
      outcome,
      timestamp: new Date().toISOString(),
      currentVersion,
      targetVersion: release.version,
      ...(detail === undefined ? {} : { detail }),
    })
  }
  try {
    await setHarnessUpdateState(context, 'building', { transactionId, targetVersion: release.version, lastCheckedAt: checkedAt, detail: '正在独立槽装配候选运行时。' })
    await event('build', 'start')
    const candidate = await buildCandidateWithRetries(context, release)
    await event('build', 'success', `候选指纹 ${candidate.fingerprint}，官方包 ${candidate.packageCount} 个。`)

    await setHarnessUpdateState(context, 'shadow-validating', { transactionId, targetVersion: release.version, detail: '正在使用一次性 profile 做真实启动和 HTTP readiness 验证。' })
    await event('shadow-start', 'start')
    await validateHarnessShadowStart({
      updateRoot: context.updateRoot,
      start: profile => startDsh({
        bootstrapPath: context.bootstrapPath,
        nodeExecutable: context.nodeExecutable,
        ...(context.pathPrefix === undefined ? {} : { pathPrefix: context.pathPrefix }),
        runtime: resolveDshRuntime({ ...context, profileDir: profile.profile, desktopRuntimeDir: candidate.directory }),
        startupTimeoutMs: harnessUpdatePolicy.shadowStartupTimeoutSeconds * 1_000,
        environment: {
          DSH_HOME: profile.home,
          DSH_PROFILE_DIR: profile.profile,
          DSH_PROFILE_NAME: 'web',
          DSH_RUNTIME_DIR: candidate.directory,
          DSH_PNPM_ENTRY: context.pnpmEntry,
          DSH_PNPM_STORE_DIR: join(context.updateRoot, 'pnpm-store'),
        },
      }),
    })
    await event('shadow-start', 'success')

    await setHarnessUpdateState(context, 'waiting-idle', { transactionId, targetVersion: release.version, detail: `等待连续 ${harnessUpdatePolicy.idleQuietSeconds} 秒无运行或待审批任务。` })
    if (!await waitForHarnessIdle(harnessUpdatePolicy.idleQuietSeconds * 1_000, HARNESS_IDLE_MAX_WAIT_MS)) {
      await setHarnessUpdateState(context, 'blocked', { transactionId, targetVersion: release.version, detail: '用户任务持续繁忙，本轮不切换；候选槽已保留供下次复用。' })
      await event('idle-gate', 'blocked', '空闲等待超过上限，未中断用户任务。')
      return
    }
    await switchHarnessRuntime(context, candidate, transactionId)
  } catch (error) {
    const detail = error instanceof Error ? error.message : '候选部署失败。'
    await setHarnessUpdateState(context, 'failed', { transactionId, targetVersion: release.version, detail }).catch(() => undefined)
    await event('deploy', 'failure', detail).catch(() => undefined)
    throw error
  } finally {
    await lock.release()
  }
}

async function buildCandidateWithRetries(context: HarnessUpdaterContext, release: HarnessReleaseCandidate): Promise<HarnessRuntimeCandidate> {
  let lastError: unknown
  for (let attempt = 0; attempt <= harnessUpdatePolicy.maxDownloadRetries; attempt += 1) {
    try {
      return await buildHarnessRuntimeCandidate({
        legacyRuntimeDir: context.legacyRuntimeDir,
        version: release.version,
        expectedNpmIntegrity: release.npmIntegrity,
        nodeExecutable: context.nodeExecutable,
        pnpmEntry: context.pnpmEntry,
        storeDir: join(context.updateRoot, 'pnpm-store'),
      })
    } catch (error) {
      lastError = error
      if (attempt >= harnessUpdatePolicy.maxDownloadRetries) break
      await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** attempt)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('候选运行时装配失败。')
}

async function waitForHarnessIdle(quietMs: number, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs
  let quietSince = Date.now()
  while (!isQuitting && Date.now() < deadline) {
    const marketBusy = isDshMarketOperationBusy(await dshMarketOperationStatus())
    const busy = activeDshWorkCount > 0 || isRecycling || profileActivationRecyclePending || profileActivationRecycleTask !== undefined || marketBusy
    if (busy) quietSince = Date.now()
    else if (Date.now() - Math.max(quietSince, activeDshWorkChangedAt) >= quietMs) return true
    await new Promise(resolve => setTimeout(resolve, HARNESS_IDLE_POLL_MS))
  }
  return false
}

async function switchHarnessRuntime(context: HarnessUpdaterContext, candidate: HarnessRuntimeCandidate, transactionId: string): Promise<void> {
  if (lastStartOptions === undefined || lastSeedOptions === undefined || server === undefined) throw new Error('当前 DSH 服务上下文不完整，不能安全切换。')
  if (activeDshWorkCount > 0 || isRecycling || profileActivationRecyclePending || isDshMarketOperationBusy(await dshMarketOperationStatus())) {
    throw new Error('空闲门禁后检测到新任务，已取消本轮切换。')
  }
  const previousStartOptions = lastStartOptions
  const previousSeedOptions = lastSeedOptions
  const nextStartOptions: Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'> = {
    ...previousStartOptions,
    runtime: resolveDshRuntime({ ...context, profileDir: context.profileDir, desktopRuntimeDir: candidate.directory }),
    startupTimeoutMs: harnessUpdatePolicy.liveStartupTimeoutSeconds * 1_000,
    environment: {
      ...previousStartOptions.environment,
      DSH_RUNTIME_DIR: candidate.directory,
    },
  }
  let activated = false
  let observing = true
  let observationReject: ((error: Error) => void) | undefined
  const observationFailure = new Promise<never>((_resolve, reject) => { observationReject = reject })
  isRecycling = true
  broadcastShellState()
  try {
    await setHarnessUpdateState(context, 'switching', { transactionId, targetVersion: candidate.version, detail: '已通过空闲门禁，正在切换 DSH 子服务。' })
    await showStartupWindow(desktopText('正在安全更新 DSH 运行环境…', 'Safely updating the DSH runtime…'))
    activateRuntimeSlot({
      legacyRuntimeDir: context.legacyRuntimeDir,
      candidateDir: candidate.directory,
      version: candidate.version,
      fingerprint: candidate.fingerprint,
      transactionId,
    })
    activated = true
    const previousServer = server
    server = undefined
    await previousServer.stop()
    const nextServer = await startDsh({
      ...nextStartOptions,
      onUnexpectedExit: message => {
        if (observing) observationReject?.(new Error(message))
        else handleUnexpectedDshExit(message)
      },
      onIpcMessage: handleDshIpc,
    })
    server = nextServer
    lastStartOptions = nextStartOptions
    lastSeedOptions = { ...previousSeedOptions, desktopRuntimeDir: candidate.directory }
    await createMainWindow(nextServer.url)
    isRecycling = false
    broadcastShellState()

    await setHarnessUpdateState(context, 'observing', { transactionId, targetVersion: candidate.version, detail: `候选已上线，观察 ${harnessUpdatePolicy.observationMinutes} 分钟后提交。` })
    await Promise.race([
      observationFailure,
      waitHarnessObservation(harnessUpdatePolicy.observationMinutes * 60_000),
    ])
    observing = false
    commitRuntimeSlot(context.legacyRuntimeDir, transactionId)
    const completedAt = new Date().toISOString()
    await setHarnessUpdateState(context, 'succeeded', { transactionId, targetVersion: candidate.version, lastSucceededAt: completedAt, detail: 'readiness 与在线观察均通过，A/B 指针已提交。' })
    await appendHarnessUpdateEvent(context.updateRoot, {
      transactionId,
      phase: 'commit',
      outcome: 'success',
      timestamp: completedAt,
      currentVersion: candidate.version,
      targetVersion: candidate.version,
      detail: `已提交候选指纹 ${candidate.fingerprint}。`,
    })
  } catch (error) {
    observing = false
    const detail = error instanceof Error ? error.message : '候选在线验证失败。'
    // 退出流程不再拉起任何新子进程；未提交指针会在下次启动时自动回滚。
    if (isQuitting) return
    isRecycling = true
    broadcastShellState()
    const failedServer = server
    server = undefined
    await failedServer?.stop().catch(() => undefined)
    if (activated) rollbackRuntimeSlot(context.legacyRuntimeDir, transactionId, detail)
    lastStartOptions = previousStartOptions
    lastSeedOptions = previousSeedOptions
    const restored = await startDsh({
      ...previousStartOptions,
      startupTimeoutMs: harnessUpdatePolicy.rollbackTimeoutSeconds * 1_000,
      onUnexpectedExit: handleUnexpectedDshExit,
      onIpcMessage: handleDshIpc,
    })
    server = restored
    await createMainWindow(restored.url)
    await setHarnessUpdateState(context, 'rolled-back', { transactionId, targetVersion: candidate.version, detail: `候选失败，已自动恢复上一运行时：${detail}` })
    await appendHarnessUpdateEvent(context.updateRoot, {
      transactionId,
      phase: 'rollback',
      outcome: 'success',
      timestamp: new Date().toISOString(),
      currentVersion: runtimeSlotVersion(resolveActiveRuntimeDir(context.legacyRuntimeDir)) ?? OFFICIAL_DSH_VERSION,
      targetVersion: candidate.version,
      detail,
    })
  } finally {
    observing = false
    isRecycling = false
    profileWatcher?.sync()
    broadcastShellState()
  }
}

async function waitHarnessObservation(durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs
  while (!isQuitting && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now()))))
  }
  if (isQuitting) throw new Error('应用退出，在线观察未完成。')
}

function createTray(): void {
  if (tray !== undefined) {
    refreshTrayMenu()
    return
  }
  const rasterPath = resolveRasterIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  const source = rasterPath === undefined ? nativeImage.createEmpty() : nativeImage.createFromPath(rasterPath)
  const icon = source.isEmpty()
    ? nativeImage.createEmpty()
    : source
        .crop(resolveCompactIconCrop(source.getSize()))
        .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: 'best' })
  try {
    tray = new Tray(icon)
  } catch {
    return
  }
  tray.on('click', () => showMainWindow())
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (tray === undefined) return
  const badgeSuffix = unreadCompletionCount > 0
    ? (isChineseLocale(desktopLocale()) ? ` · ${unreadCompletionCount} 个已完成任务` : ` · ${unreadCompletionCount} completed tasks`)
    : ''
  tray.setToolTip(DESKTOP_APP_NAME + badgeSuffix)
  const items = buildDesktopTrayItems({
    status: updateStatus,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    locale: desktopLocale(),
  })
  tray.setContextMenu(Menu.buildFromTemplate(items.map(item => {
    if (item.type === 'separator') return { type: 'separator' }
    return {
      label: item.label,
      enabled: item.enabled,
      click: () => { runMainTask(handleTrayUpdateAction(item.id)) },
    }
  })))
}

async function handleTrayUpdateAction(id: string): Promise<void> {
  if (id === 'show') {
    showMainWindow()
    return
  }
  if (id === 'reload') {
    await recycleDshForPluginUpdate()
    return
  }
  if (id === 'quit') {
    await requestQuit()
    return
  }
  if (id === 'check') {
    await checkDesktopUpdate()
    return
  }
  if (id === 'download') {
    await downloadDesktopUpdate()
    return
  }
  if (id === 'install') {
    await installDesktopUpdate()
  }
}

type DesktopUpdateInteraction = 'interactive' | 'background' | 'settings'

async function checkDesktopUpdate(interaction: DesktopUpdateInteraction = 'interactive'): Promise<void> {
  if (updateStatus.kind === 'checking' || updateStatus.kind === 'downloading') return
  if (!app.isPackaged) {
    if (interaction === 'interactive') {
      await dialog.showMessageBox({
        type: 'info',
        title: DESKTOP_APP_NAME,
        message: desktopText('开发态不能检查安装包更新，请使用发布的安装包。', 'Update checks are unavailable in development builds. Use a released installer.'),
      })
    }
    return
  }
  setDesktopUpdateStatus({ kind: 'checking' })
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo.version
    if (version === undefined || version === app.getVersion()) {
      setDesktopUpdateStatus({ kind: 'none' }, true)
      dismissDesktopUpdateNotification()
      if (interaction === 'interactive') {
        await dialog.showMessageBox({
          type: 'info',
          title: DESKTOP_APP_NAME,
          message: desktopText('当前已是最新桌面端版本。', 'You already have the latest desktop version.'),
        })
      }
      return
    }
    const available: Extract<DesktopUpdateStatus, { kind: 'available' }> = { kind: 'available', version, releaseNotes: formatDesktopReleaseNotes(result?.updateInfo.releaseNotes) }
    setDesktopUpdateStatus(available, true)
    if (interaction === 'background') {
      if (shouldDownloadUpdateAutomatically(updatePreferences)) await downloadDesktopUpdate('background')
      else showDesktopUpdateNotification('available', version)
      return
    }
    if (interaction === 'settings') return
    const prompt = await dialog.showMessageBox({
      type: 'question',
      title: DESKTOP_APP_NAME,
      message: desktopUpdatePrompt(available, desktopLocale()),
      buttons: [desktopText('下载并安装', 'Download and Install'), desktopText('取消', 'Cancel')],
      defaultId: 0,
      cancelId: 1,
    })
    if (prompt.response === 0) await downloadDesktopUpdate('interactive')
  } catch (error) {
    const message = publicDesktopUpdateError(error, desktopLocale())
    setDesktopUpdateStatus({ kind: 'error', message }, true)
    if (interaction === 'interactive') {
      await dialog.showMessageBox({
        type: 'error',
        title: DESKTOP_APP_NAME,
        message,
      })
    }
  }
}

async function downloadDesktopUpdate(interaction: DesktopUpdateInteraction = 'interactive'): Promise<void> {
  if (updateStatus.kind !== 'available') return
  const version = updateStatus.version
  setDesktopUpdateStatus({ kind: 'downloading', percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
    const ready = { kind: 'ready' as const, version }
    setDesktopUpdateStatus(ready)
    if (interaction === 'background') {
      showDesktopUpdateNotification('ready', version)
      return
    }
    if (interaction === 'settings') return
    const prompt = await dialog.showMessageBox({
      type: 'question',
      title: DESKTOP_APP_NAME,
      message: desktopUpdatePrompt(ready, desktopLocale()),
      buttons: [desktopText('现在安装', 'Install Now'), desktopText('稍后', 'Later')],
      defaultId: 0,
      cancelId: 1,
    })
    if (prompt.response === 0) await installDesktopUpdate()
  } catch (error) {
    const message = publicDesktopUpdateError(error, desktopLocale())
    setDesktopUpdateStatus({ kind: 'error', message })
    if (interaction === 'interactive') {
      await dialog.showMessageBox({
        type: 'error',
        title: DESKTOP_APP_NAME,
        message,
      })
    }
  }
}

async function handleDesktopUpdateSettingsAction(action: DesktopUpdateAction): Promise<void> {
  if (action === 'check') await checkDesktopUpdate('settings')
  else if (action === 'download') await downloadDesktopUpdate('settings')
  else await installDesktopUpdate()
}

const DESKTOP_UPDATE_NOTIFICATION_ID = 'desktop-update'

function dismissDesktopUpdateNotification(): void {
  activeNotifications.get(DESKTOP_UPDATE_NOTIFICATION_ID)?.close()
  activeNotifications.delete(DESKTOP_UPDATE_NOTIFICATION_ID)
}

function showDesktopUpdateNotification(kind: 'available' | 'ready', version: string): void {
  if (!Notification.isSupported()) return
  dismissDesktopUpdateNotification()
  const icon = resolveNotificationIconPath({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
  const notification = new Notification({
    title: DESKTOP_APP_NAME,
    body: kind === 'ready'
      ? desktopText(`桌面端 ${version} 已下载，点击选择安装时间。`, `Desktop ${version} is ready. Click to choose when to install.`)
      : desktopText(`发现桌面端 ${version}，点击查看更新。`, `Desktop ${version} is available. Click to review the update.`),
    ...(icon === undefined ? {} : { icon }),
  })
  activeNotifications.set(DESKTOP_UPDATE_NOTIFICATION_ID, notification)
  notification.on('click', () => {
    showDesktopSettingsWindow('updates')
    dismissDesktopUpdateNotification()
  })
  notification.on('close', () => {
    if (activeNotifications.get(DESKTOP_UPDATE_NOTIFICATION_ID) === notification) activeNotifications.delete(DESKTOP_UPDATE_NOTIFICATION_ID)
  })
  notification.show()
}

async function installDesktopUpdate(): Promise<void> {
  await shutdownDesktop(() => { autoUpdater.quitAndInstall(false, true) })
}

function showMainWindow(): void {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
