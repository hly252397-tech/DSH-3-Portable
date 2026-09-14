import { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, protocol, safeStorage, session, shell, type Input, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { writeFile as writeTextFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DESKTOP_APP_NAME, DESKTOP_APP_USER_MODEL_ID, DESKTOP_TOAST_ACTIVATOR_CLSID, resolveDesktopRuntimeDir, resolveDesktopUserDataDir } from './app-identity.js'
import { OFFICIAL_DSH_VERSION } from './bundled-plugins.js'
import { resolveAppIconPath, resolveCompactIconCrop, resolveNotificationIconPath, resolveRasterIconPath, resolveTaskBadgeIconPath, resolveTaskbarIconPath, resolveTrayIconPath, TRAY_ICON_SIZE } from './app-icon.js'
import { isLoopbackFaviconRequest } from './window-icon.js'
import { quitDesktopApp, shouldHideInsteadOfClose } from './app-lifecycle.js'
import type { DshServer, StartDshOptions } from './dsh-process.js'
import { isExternalHttpUrl, isExternalOpenUrl, isSameOrigin } from './navigation.js'
import { applyPendingProfileUpdates, resolvePnpmStoreDir, seedBundledPlugins, resolveWebProfileDir } from './plugin-seed.js'
import { parseUnresolvedBundleError, startWithProfileSelfRepair } from './profile-repair.js'
import { quarantineProfileBundle } from './profile-quarantine.js'
import { resolveBundledPluginStore, resolvePluginBinDir } from './plugin-toolchain.js'
import { resolveDshBootstrap, resolveDshRuntime, resolveNodeExecutable } from './runtime.js'
import { extractPackagedRuntimesInChild, packagedRuntimesNeedExtraction, preparePackagedRuntimeCacheInChild, resolvePackagedRuntimeCache, type RuntimeExtractionProgress } from './extract-runtime.js'
import { advanceStartupProgress, formatStartupProgress, STARTUP_PROGRESS, type StartupProgress } from './startup-progress.js'
import { resolvePrebuiltOfficialRuntime } from './runtime-prebuilt.js'
import { activateRuntimeSlot, commitRuntimeSlot, readRuntimeSlotPointer, recoverInterruptedRuntimeSwitch, resolveActiveRuntimeDir, rollbackRuntimeSlot, runtimeSlotVersion } from './runtime-slots.js'
import { buildHarnessRuntimeCandidate, type HarnessRuntimeCandidate } from './harness-runtime-candidate.js'
import { validateHarnessShadowStart } from './harness-shadow.js'
import { DEFAULT_HARNESS_UPDATE_POLICY, acquireHarnessUpdateLock, appendHarnessUpdateEvent, checkHarnessUpdate, clearDeploymentFailure, evaluateDeploymentRetryGate, harnessUpdatePolicyPath, harnessUpdateRoot, harnessUpdateStatePath, loadHarnessUpdatePolicy, loadHarnessUpdateState, recordDeploymentFailure, saveHarnessUpdatePolicy, saveHarnessUpdateState, type HarnessReleaseCandidate, type HarnessUpdatePolicy, type HarnessUpdateState } from './harness-update.js'
import { applyInitialWindowState } from './window-state.js'
import { WindowNavigationCoordinator } from './window-navigation.js'
import { escapeRoute } from './escape-routing.js'
import { installDesktopBridge, resolveDesktopBridgeDir } from './desktop-host.js'
import { isChineseLocale, localizedShellActions, localizedShellMenus, normalizeShellLocale, shellActionForShortcut, SHELL_ACTIONS, type ShellActionId, type ShellMenuId } from './shell-actions.js'
import { SHELL_BAR_HEIGHT, SHELL_IPC, type BrowserDownloadState, type BrowserPageSnapshot, type BrowserPanelBounds, type BrowserPanelSnapshot, type BrowserShellState, type BrowserTabState, type DshNavigationState, type DshShellActionId, type ShellBootstrap, type ShellMenuPopupRequest, type ShellState } from './shell-contract.js'
import { mayAccessDesktopUpdates, mayAccessNotificationPreferences, mayAccessThemePreferences, mayCloseDesktopSettings, mayGetShellBootstrap, mayInvokeBrowserIpc, mayInvokeFeaturePanelsCopy, mayInvokeShellAction, mayManageBrowserPanel, mayPopupShellMenu, mayReportDshLocale, mayReportDshNotification, mayReportDshState, mayReportDshTheme, mayReportDshSettingsVisibility, type ShellRendererKind } from './shell-ipc-policy.js'
import { FEATURE_PANEL_CATEGORIES, FEATURE_PANELS } from './feature-panels.js'
import { capBrowserWorkspacePanelWidth, normalizeBrowserPanelBounds, resolveBrowserDownloadsDrawerHeight } from './browser-panel-layout.js'
import { normalizeNativeBrowserRequest } from './native-browser-request.js'
import { clearStaleDshAuthCookies } from './dsh-session-cookies.js'
import { DEFAULT_DESKTOP_THEME_PREFERENCES, DESKTOP_THEME_PALETTES, loadDesktopThemePreferences, normalizeDesktopThemeSnapshot, saveDesktopThemePreferences, type DesktopColorScheme, type DesktopThemePreference, type DesktopThemePreferences } from './desktop-theme.js'
import { DSH_MARKET_STATUS_PATH, isDshMarketOperationBusy, waitForDshMarketBatchToSettle } from './dshmarket-batch.js'
import { DEFAULT_NOTIFICATION_PREFERENCES, buildWindowsReplyToastXml, loadNotificationPreferences, parseDesktopNotificationBridgeEvent, parseWindowsNotificationReplyActivation, saveNotificationPreferences, shouldShowDesktopNotification, windowsNotificationReplyArguments, type DesktopNotificationEvent, type DesktopNotificationPreferences } from './desktop-notifications.js'
import { watchProfileActivation } from './profile-watch.js'
import { repairMisplacedSessionLogs } from './session-path-repair.js'
import { DEFAULT_UPDATE_PREFERENCES, STARTUP_UPDATE_CHECK_DELAY_MS, buildDesktopTrayItems, desktopUpdatePrompt, loadUpdatePreferences, preserveDesktopUpdateFailure, publicDesktopUpdateError, saveUpdatePreferences, shouldCheckForUpdatesOnStartup, shouldDownloadUpdateAutomatically, type DesktopUpdateAction, type DesktopUpdatePreferences, type DesktopUpdateSnapshot, type DesktopUpdateStatus } from './desktop-updater.js'
import { PortableDesktopUpdater, resolvePortableReleaseSource, PORTABLE_RELEASE_SOURCE_OVERRIDE_PATH, type PortableDesktopUpdateState } from './portable-desktop-update.js'
import { applyPortableEnvironment, ensurePortableDirectories, resolvePortablePaths } from './portable-paths.js'

const portablePaths = resolvePortablePaths(process.env.DSH_PORTABLE_ROOT)
if (portablePaths !== undefined) {
  ensurePortableDirectories(portablePaths)
  applyPortableEnvironment(portablePaths)
}

interface DshProcessModule {
  isApplyPluginUpdatesIpc: (message: unknown) => boolean
  isRequestHarnessUpdateIpc?: (message: unknown) => boolean
  startDsh: (options: StartDshOptions) => Promise<DshServer>
}

const dshProcessModule = await import(app.isPackaged
  ? pathToFileURL(join(process.resourcesPath, 'desktop-bridge', 'dsh-process.js')).href
  : './dsh-process.js') as DshProcessModule
const { isApplyPluginUpdatesIpc, isRequestHarnessUpdateIpc, startDsh } = dshProcessModule

let mainWindow: BrowserWindow | undefined
let dshView: WebContentsView | undefined
let browserPanelView: WebContentsView | undefined
let shortcutsWindow: BrowserWindow | undefined
let aboutWindow: BrowserWindow | undefined
let featurePanelsWindow: BrowserWindow | undefined
let settingsWindow: BrowserWindow | undefined
let server: DshServer | undefined
let tray: Tray | undefined
let isQuitting = false
let isRecycling = false
let runtimeExtractionAbortController: AbortController | undefined
let runtimeExtractionTask: Promise<void> | undefined
let desktopActivationHeartbeatTimer: NodeJS.Timeout | undefined
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
let portableDesktopUpdater: PortableDesktopUpdater | undefined
let isReportingUnexpectedError = false
let startupProgress = 0
let startupStatusRevision = 0
const windowNavigation = new WindowNavigationCoordinator()
let dshNavigationState: DshNavigationState = { canBack: false, canForward: false, canNextChat: false, canPreviousChat: false }
let notificationPreferences: DesktopNotificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES
const activeNotifications = new Map<string, Notification>()
let unreadCompletionCount = 0
let activeDshLocale: 'zh' | 'en' | undefined
let activeDshColorScheme: DesktopColorScheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
let activeDshThemePreference: DesktopThemePreference = 'system'
let themePreferences: DesktopThemePreferences = DEFAULT_DESKTOP_THEME_PREFERENCES
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
// 全功能浏览器（完整移植自 G:\DSH-Portable 空间板块浏览器）
// ---------------------------------------------------------------------------
const BROWSER_DEFAULT_HOMEPAGES: readonly string[] = ['https://deepseek.com/en/', 'https://chat.deepseek.com/']
// 必须与 assets/browser-panel.html 的 .browser-tabs / .browser-nav 高度一致；
// 该文件全局 box-sizing:border-box，这里的数值已含 1px 下边框。
const BROWSER_TABS_BAR_HEIGHT = 40
const BROWSER_NAV_BAR_HEIGHT = 42
const BROWSER_MAXIMUM_TABS = 12
const BROWSER_DEFAULT_WIDTH_RATIO = 0.36
const BROWSER_PARTITION = 'persist:dsh-browser'
const DSH_PARTITION = 'persist:dsh-ui'

interface BrowserTab {
  readonly id: string
  title: string
  url: string
  favicon: string
  crashed: boolean
  lastRecordedUrl?: string
  readonly view: WebContentsView
}

interface BrowserLibrarySnapshot {
  readonly history: { id: string; url: string; title: string; favicon?: string; lastVisitAt?: string; visitCount?: number }[]
  readonly bookmarks: { id: string; url: string; title: string; favicon?: string; createdAt?: string }[]
  readonly credentials: { id: string; origin: string; username: string; label?: string; createdAt?: string; updatedAt?: string; importedFrom?: string }[]
  readonly autofill: { name: string; value: string }[]
  readonly extensions: { id: string; name: string; version?: string; enabled: boolean; source?: string; error?: string }[]
  readonly pendingImport: { source: string; items: string[]; lastAttemptAt?: string } | null
  readonly lastImport: Record<string, unknown> | null
  readonly settings: { historyEnabled: boolean; autoRetryImport: boolean; loadExtensions: boolean; homepages: string[] }
  readonly encryptionAvailable: boolean
  readonly sources: { id: string; name: string; available: boolean }[]
}

interface BrowserLibraryModule {
  publicSnapshot(): BrowserLibrarySnapshot
  recordHistory(url: string, title: string, favicon?: string): void
  toggleBookmark(entry: { url: string; title: string; favicon?: string }): boolean
  remove(kind: string, id: string): boolean
  clear(kind: string): boolean
  saveCredential(input: { id?: string; origin: string; username?: string; password: string; label?: string }): boolean
  credentialSecret(id: string): { origin: string; username: string; password: string }
  setSettings(patch: Partial<BrowserLibrarySnapshot['settings']>): BrowserLibrarySnapshot['settings']
  importProfile(sourceId: string, browserSession: Electron.Session): Promise<Record<string, unknown>>
  retryPending(browserSession: Electron.Session): Promise<Record<string, unknown> | null>
  loadExtensions(browserSession: Electron.Session): Promise<unknown[]>
  toggleExtension(id: string, enabled: boolean): boolean
}

interface BrowserWorkspaceFile {
  version: number
  browserVisible: boolean
  browserWidthRatio: number
  browserMaximized: boolean
  activeTabId: string | null
  tabs: { id: string; title: string; url: string }[]
}

// 库延迟到首次使用时初始化：app.setPath('userData') 的便携重定向发生在此模块顶层之后，
// 过早调用 createBrowserLibrary 会把历史/凭据写到错误的系统目录（B-1）。
const fallbackBrowserSnapshot = (): BrowserLibrarySnapshot => ({
  history: [], bookmarks: [], credentials: [], autofill: [], extensions: [], pendingImport: null, lastImport: null,
  settings: { historyEnabled: true, autoRetryImport: true, loadExtensions: true, homepages: [...BROWSER_DEFAULT_HOMEPAGES] },
  encryptionAvailable: false, sources: [],
})

const browserLibraryFallback: BrowserLibraryModule = {
  publicSnapshot: fallbackBrowserSnapshot,
  recordHistory: () => undefined,
  toggleBookmark: () => false,
  remove: () => false,
  clear: () => false,
  saveCredential: () => false,
  credentialSecret: () => { throw new Error('浏览器资料库不可用。') },
  setSettings: patch => ({ ...fallbackBrowserSnapshot().settings, ...patch }),
  importProfile: async () => ({}),
  retryPending: async () => null,
  loadExtensions: async () => [],
  toggleExtension: () => false,
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
let browserPanelOccluded = false
let browserPanelBounds: BrowserPanelBounds | undefined
let browserPanelOwner: string | undefined
let browserWidthRatio = BROWSER_DEFAULT_WIDTH_RATIO
let browserMaximized = false
let browserManagerOpen = false
let browserMenuOpen = false
let browserDownloadsOpen = false
let browserDownloadsDrawerHeight = 0
let browserPageZoom = 1
let browserWorkspaceSaveTimer: NodeJS.Timeout | undefined
let browserSessionConfigured = false
let browserDownloadSequence = 0
type BrowserDownloadRecord = { -readonly [Key in keyof BrowserDownloadState]: BrowserDownloadState[Key] } & { readonly path: string; readonly url: string }
const browserDownloads: BrowserDownloadRecord[] = []

function browserDownloadsRoot(): string {
  return portablePaths === undefined ? app.getPath('downloads') : join(portablePaths.root, 'Downloads')
}

function browserWorkspacePath(): string {
  return join(app.getPath('userData'), 'shell', 'browser-workspace.json')
}

function loadBrowserWorkspace(): BrowserWorkspaceFile | null {
  try {
    const parsed = JSON.parse(readFileSync(browserWorkspacePath(), 'utf8')) as BrowserWorkspaceFile
    if (!Array.isArray(parsed.tabs)) return null
    // 历史遗留的超宽比例（旧上限 0.75）在加载时收敛到新上限，避免重启后仍占大半窗。
    if (typeof parsed.browserWidthRatio === 'number' && parsed.browserWidthRatio > 0.55) {
      parsed.browserWidthRatio = 0.55
    }
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
    browserMaximized,
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

function configuredBrowserHomepages(): readonly string[] {
  const configured = browserData().publicSnapshot().settings.homepages
  const pages = configured.filter(isAllowedBrowserUrl).slice(0, 8)
  return pages.length === 0 ? BROWSER_DEFAULT_HOMEPAGES : pages
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

function applyBrowserPageZoom(contents?: WebContents): void {
  if (contents === undefined || contents.isDestroyed()) return
  contents.setZoomFactor(browserPageZoom)
}

function configureBrowserSession(): void {
  if (browserSessionConfigured) return
  browserSessionConfigured = true
  const browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true })
  const allowedPermissions = new Set(['clipboard-sanitized-write', 'fullscreen'])
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowedPermissions.has(permission)))
  browserSession.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission))
  browserSession.on('will-download', (_event, item) => {
    const downloadsRoot = browserDownloadsRoot()
    mkdirSync(downloadsRoot, { recursive: true })
    const sourceName = basename(item.getFilename() || 'download')
    const parsed = parse(sourceName)
    let destination = join(downloadsRoot, sourceName)
    let suffix = 1
    while (existsSync(destination)) {
      destination = join(downloadsRoot, `${parsed.name} (${suffix})${parsed.ext}`)
      suffix += 1
    }
    item.setSavePath(destination)
    const record: BrowserDownloadRecord = {
      id: `download-${Date.now()}-${browserDownloadSequence += 1}`,
      name: basename(destination),
      path: destination,
      url: item.getURL(),
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      progress: 0,
      status: 'progressing',
      startedAt: new Date().toISOString(),
    }
    browserDownloads.unshift(record)
    browserDownloads.splice(20)
    browserDownloadsOpen = true
    relayout()
    item.on('updated', (_updateEvent, downloadState) => {
      record.status = downloadState
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes()
      record.progress = record.totalBytes > 0 ? record.receivedBytes / record.totalBytes : 0
      broadcastShellState()
    })
    item.once('done', (_doneEvent, downloadState) => {
      record.status = downloadState
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes()
      record.progress = downloadState === 'completed' ? 1 : record.progress
      record.completedAt = new Date().toISOString()
      broadcastShellState()
    })
  })
  runMainTask(browserData().loadExtensions(browserSession).then(() => broadcastShellState()))
  runMainTask(browserData().retryPending(browserSession).then(result => { if (result !== null) broadcastShellState() }))
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
  applyBrowserPageZoom(view.webContents)
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
  view.webContents.on('found-in-page', (_event, result) => {
    if (browserPanelView !== undefined && !browserPanelView.webContents.isDestroyed()) browserPanelView.webContents.send(SHELL_IPC.browserFindResult, result)
  })
  view.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []
    if (params.selectionText !== '') template.push({ role: 'copy', label: desktopText('复制', 'Copy') })
    if (params.isEditable) template.push({ role: 'paste', label: desktopText('粘贴', 'Paste') })
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: mainWindow })
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

/** DSH 外链统一路由：http/https 进内置浏览器（新标签页），mailto:/tel: 走系统默认程序。 */
function routeDshExternalLink(url: string): void {
  if (isExternalHttpUrl(url, allowedOrigin)) {
    // 建视图是重活，排到微任务队列，避免在导航回调里同步执行
    queueMicrotask(() => { openBrowser(url, true) })
    return
  }
  if (isExternalOpenUrl(url, allowedOrigin)) runMainTask(shell.openExternal(url))
}

function openBrowser(url?: string, newTab = false): BrowserTab {
  browserVisible = true
  browserManagerOpen = false
  browserMenuOpen = false
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
  // Start with the workspace closed; the visible shell control opens it explicitly.
  browserVisible = false
  relayout()
  broadcastShellState()
}

function browserShellState(): BrowserShellState {
  const active = getActiveBrowserTab()
  const contents = active?.view.webContents
  const library = browserData().publicSnapshot()
  return {
    visible: browserVisible,
    tabs: browserTabs.map((tab): BrowserTabState => ({ id: tab.id, title: tab.title, url: tab.url, favicon: tab.favicon, crashed: tab.crashed })),
    activeId: activeBrowserTabId,
    canBack: contents?.navigationHistory.canGoBack() ?? false,
    canForward: contents?.navigationHistory.canGoForward() ?? false,
    loading: contents?.isLoading() ?? false,
    widthRatio: browserWidthRatio,
    maximized: browserMaximized,
    managerOpen: browserManagerOpen,
    menuOpen: browserMenuOpen,
    downloadsOpen: browserDownloadsOpen,
    downloadsDrawerHeight: browserDownloadsDrawerHeight,
    pageZoomPercent: Math.round(browserPageZoom * 100),
    bookmarked: active !== null && library.bookmarks.some(entry => entry.url === active.url),
    downloads: browserDownloads.map(({ path: _path, url: _url, ...record }) => record),
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

async function spawnPortableLauncherForRestart(): Promise<void> {
  if (portablePaths === undefined || process.platform !== 'win32') throw new Error('当前不是 Windows 便携模式。')
  const launcherScript = join(portablePaths.root, 'Start-DSH-Portable.ps1')
  if (!existsSync(launcherScript)) throw new Error('便携启动器脚本不存在。')
  const windowsRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim()
  if (windowsRoot === undefined || windowsRoot === '') throw new Error('Windows 系统目录环境变量不存在。')
  const powerShellExecutable = join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!existsSync(powerShellExecutable)) throw new Error('Windows PowerShell 可执行文件不存在。')
  const commandBrokerExecutable = join(windowsRoot, 'System32', 'cmd.exe')
  if (!existsSync(commandBrokerExecutable)) throw new Error('Windows 命令代理可执行文件不存在。')
  const handoffDirectory = join(portablePaths.root, 'Data', 'Updates', 'Desktop', 'handoffs')
  mkdirSync(handoffDirectory, { recursive: true })
  const handoffReadyFile = join(handoffDirectory, `${process.pid}-${randomUUID()}.json`)
  const child = spawn(commandBrokerExecutable, [
    '/d', '/s', '/c', 'start', '', '/b', powerShellExecutable,
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', launcherScript, '-WaitForProcessId', String(process.pid), '-HandoffReadyFile', handoffReadyFile,
  ], {
    cwd: portablePaths.root,
    windowsHide: true,
    stdio: 'ignore',
  })
  await new Promise<void>((resolvePromise, reject) => {
    child.once('spawn', resolvePromise)
    child.once('error', reject)
  })
  const handoffDeadline = Date.now() + 10_000
  while (!existsSync(handoffReadyFile)) {
    if (Date.now() >= handoffDeadline) throw new Error('等待便携启动器接管超时。')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  try { unlinkSync(handoffReadyFile) } catch { }
  child.unref()
}

/**
 * 安排重启：Windows 便携模式必须回到根目录启动器，确保 pending
 * 候选会经过清单校验、健康提交和失败回滚。普通安装模式才使用
 * Electron relaunch，并在失败时降级为分离子进程。
 */
async function scheduleAppRelaunch(): Promise<boolean> {
  if (portablePaths !== undefined && process.platform === 'win32') {
    try {
      await spawnPortableLauncherForRestart()
      return true
    } catch (error) {
      const restartAuditPath = join(portablePaths.root, 'Data', 'Updates', 'Desktop', 'restart-handoff.log')
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown restart handoff error'
      try { appendFileSync(restartAuditPath, `[${new Date().toISOString()}] ${detail}\n`, 'utf8') } catch { }
      return false
    }
  }
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

/** 完全关闭并重启：安排新实例 → 走既有优雅关停（托盘/服务/配置落盘）。
 *  防误触由外壳按钮的两步确认承担（同旧版空间板块外壳：首次点击红底确认态，5s/Esc 取消）。 */
async function requestAppRestart(): Promise<void> {
  if (!await scheduleAppRelaunch()) {
    const zh = desktopDialogLocale() === 'zh'
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
      stopDesktopActivationHeartbeat()
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
  startDesktopActivationHeartbeat()
  await app.whenReady()
  ensureWindowsNotificationIdentity()
  installWindowsNotificationActivationHandler()
  notificationPreferences = await loadNotificationPreferences(notificationPreferencesPath())
  themePreferences = await loadDesktopThemePreferences(themePreferencesPath())
  updatePreferences = await loadUpdatePreferences(updatePreferencesPath())
  installShellIpc()
  installDesktopFaviconReplacement()
  Menu.setApplicationMenu(null)
  await configureDesktopUpdater()
  createTray()
  await showStartupWindow(desktopText('正在启动', 'Starting'), STARTUP_PROGRESS.boot)

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
    const interruptedPointer = readRuntimeSlotPointer(legacyDesktopRuntimeDir)
    if (interruptedPointer?.pendingTransactionId !== undefined) {
      recoverInterruptedRuntimeSwitch(legacyDesktopRuntimeDir)
      console.warn('检测到上次未完成的 DSH 运行时观察事务，已恢复上一已知可用槽。')
    }
    const activeRuntimeDir = resolveActiveRuntimeDir(legacyDesktopRuntimeDir)
    const usingActiveRuntimeSlot = resolve(activeRuntimeDir) !== resolve(legacyDesktopRuntimeDir)
    const packagedCache = app.isPackaged
      ? resolvePackagedRuntimeCache(process.resourcesPath, dirname(legacyDesktopRuntimeDir))
      : undefined
    const packagedOfficialDir = usingActiveRuntimeSlot ? undefined : packagedCache?.official
    const extractedStoreDir = packagedCache?.store
    const nodeExecutable = resolveNodeExecutable(runtimeOptions)
    if (app.isPackaged && packagedCache !== undefined && extractedStoreDir !== undefined) {
      const firstInitialization = packagedRuntimesNeedExtraction(process.resourcesPath, packagedOfficialDir, extractedStoreDir)
      if (firstInitialization) {
        await updateStartupMessage(firstInitializationMessage(), STARTUP_PROGRESS.firstLaunchPreparation)
        const controller = new AbortController()
        runtimeExtractionAbortController = controller
        const extraction = extractPackagedRuntimesInChild({
          nodeExecutable,
          scriptPath: join(process.resourcesPath, 'extract-runtime.mjs'),
          installDir: packagedCache.installDir,
          resourcesDir: process.resourcesPath,
          signal: controller.signal,
          skipOfficial: usingActiveRuntimeSlot,
          onProgress: reportExtractionProgress,
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
        ), STARTUP_PROGRESS.workspacePreparation)
      }
    }
    await updateStartupMessage(
      desktopText('正在准备插件和工作区…', 'Preparing plugins and workspace…'),
      STARTUP_PROGRESS.workspacePreparation,
    )
    const desktopRuntimeDir = usingActiveRuntimeSlot ? activeRuntimeDir : packagedOfficialDir ?? activeRuntimeDir
    const pluginStoreDir = resolveBundledPluginStore({
      ...runtimeOptions,
      ...(extractedStoreDir === undefined ? {} : { extractedStoreDir }),
    })
    const profileStoreDir = resolvePnpmStoreDir(profileDir, pluginStoreDir)
    const prebuiltRuntimeDir = resolvePrebuiltOfficialRuntime(runtimeOptions)
    const seedOptions = {
      onProgress: reportSeedProgress,
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
      await showStartupPluginWarning('seed', message)
    }
    await updateStartupMessage(
      desktopText('内置插件已就绪，正在应用配置…', 'Bundled plugins are ready. Applying configuration…'),
      STARTUP_PROGRESS.bundledPluginsReady,
    )
    try {
      const updated = await applyPendingProfileUpdates(seedOptions)
      if (updated.length > 0) console.log('已在启动前应用插件更新：' + updated.join('、'))
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动前应用插件更新失败。'
      await writeTextFile(join(app.getPath('userData'), 'plugin-update.log'), `${message}\n`, 'utf8').catch(() => undefined)
      await showStartupPluginWarning('pending', message)
    }
    await updateStartupMessage(
      desktopText('配置已应用，正在检查用户数据…', 'Configuration applied. Checking user data…'),
      STARTUP_PROGRESS.profileUpdatesApplied,
    )
    installDesktopBridge(profileDir, resolveDesktopBridgeDir(runtimeOptions))
    const sessionRepairRoot = join(app.getPath('userData'), 'session-path-repair', new Date().toISOString().replaceAll(':', '-'))
    const sessionRepairs = await repairMisplacedSessionLogs(join(resolve(profileDir, '..', '..'), 'sessions'), sessionRepairRoot)
    if (sessionRepairs.length > 0) {
      await writeTextFile(
        join(app.getPath('userData'), 'session-path-repair.log'),
        `${new Date().toISOString()} 已安全重定位 ${sessionRepairs.length} 个会话；原始日志备份位于 ${sessionRepairRoot}\n`,
        'utf8',
      )
    }
    await updateStartupMessage(
      desktopText('用户环境已就绪，正在启动 DSH…', 'Your environment is ready. Starting DSH…'),
      STARTUP_PROGRESS.profileReady,
    )
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
    await updateStartupMessage(desktopText('正在启动 DSH 服务…', 'Starting the DSH service…'), STARTUP_PROGRESS.dshStarting)
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
    await updateStartupMessage(desktopText('DSH 已就绪，正在打开主界面…', 'DSH is ready. Opening the main window…'), STARTUP_PROGRESS.dshReady)
    if (started.repaired.length > 0) console.log('已自我修复损坏的插件清单：' + started.repaired.join('、'))
    profileWatcher?.stop()
    profileWatcher = watchProfileActivation(profileDir, scheduleProfileActivationRecycle, { onError: handleUnexpectedMainError })
    await createMainWindow(server.url)
    startupProgress = STARTUP_PROGRESS.complete
    const smokeReadyFile = process.env.DSH_DESKTOP_SMOKE_READY_FILE
    if (smokeReadyFile !== undefined && smokeReadyFile !== '') {
      await writeTextFile(smokeReadyFile, 'ready\n', 'utf8')
    }
    const desktopUpdateTransaction = process.env.DSH_DESKTOP_UPDATE_TRANSACTION
    const desktopUpdateHealthFile = process.env.DSH_DESKTOP_UPDATE_HEALTH_FILE
    if (portableDesktopUpdater !== undefined && desktopUpdateTransaction !== undefined && desktopUpdateHealthFile !== undefined) {
      await portableDesktopUpdater.confirmRunningCandidate(desktopUpdateTransaction, dirname(process.execPath), desktopUpdateHealthFile)
      stopDesktopActivationHeartbeat()
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
    if (!isQuitting) {
      await reportStartupFailure(error)
      // A candidate must fail closed so the external launcher can immediately
      // restore the last-known-good slot. Keeping the error window alive would
      // renew the activation lease until the hard deadline and delay rollback.
      if (process.env.DSH_DESKTOP_UPDATE_TRANSACTION !== undefined) {
        stopDesktopActivationHeartbeat()
        app.exit(1)
      }
    }
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
  const options = {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  }
  return resolveTaskbarIconPath(options) ?? resolveRasterIconPath(options) ?? resolveWindowIconPath()
}

function resolveFaviconIconFilePath(): string | undefined {
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
  // Preserve the ICO file-backed handle so Windows can select its exact size.
  // Cropping/resizing here discards the individual ICO frames and optical margins.
  if (iconPath.toLowerCase().endsWith('.ico')) {
    cachedWindowIcon = source
    return source
  }
  const compactSource = source.crop(resolveCompactIconCrop(source.getSize()))
  // Windows converts NativeImage's 1x bitmap to HICON. Registering every size
  // at scaleFactor: 1 leaves the first 16px bitmap selected, then Windows
  // enlarges it for the taskbar. Keep the original high-resolution bitmap.
  cachedWindowIcon = compactSource.isEmpty() ? source : compactSource
  return cachedWindowIcon
}

function installDesktopFaviconReplacement(): void {
  const iconPath = resolveFaviconIconFilePath()
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

function startupStatusScript(message: string, progress: number | undefined, detail?: string): string {
  const revision = ++startupStatusRevision
  const payload = JSON.stringify({ message, progress, detail: detail ?? '', revision })
  return `(() => {
    const next = ${payload};
    const root = document.documentElement;
    const currentRevision = Number(root.dataset.startupStatusRevision ?? '-1');
    if (next.revision < currentRevision) return;
    root.dataset.startupStatusRevision = String(next.revision);
    document.getElementById('msg')?.replaceChildren(document.createTextNode(next.message));
    const detailNode = document.getElementById('detail');
    if (detailNode instanceof HTMLElement) {
      detailNode.textContent = next.detail;
      detailNode.hidden = next.detail === '';
    }
    const indicator = document.getElementById('startupProgress');
    const value = document.getElementById('progressValue');
    if (!(indicator instanceof HTMLElement) || !(value instanceof HTMLElement)) return;
    if (typeof next.progress !== 'number') {
      indicator.hidden = true;
      indicator.removeAttribute('aria-valuenow');
      return;
    }
    indicator.hidden = false;
    indicator.style.setProperty('--startup-progress', String(next.progress));
    indicator.setAttribute('aria-valuenow', String(next.progress));
    value.textContent = next.progress + '%';
  })()`
}

async function showStartupWindow(message: string, progress?: number): Promise<void> {
  startupProgress = progress === undefined ? 0 : advanceStartupProgress(0, progress)
  const window = mainWindow ??= createWindow()
  const view = requireDshView()
  const html = resolveStartupHtml()
  if (html !== undefined) {
    await windowNavigation.navigate(
      view,
      () => view.webContents.loadFile(html, { query: desktopThemeQuery() }),
      () => view.webContents.executeJavaScript(startupStatusScript(message, progress === undefined ? undefined : startupProgress)),
    )
    return
  }
  const escaped = message.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  await windowNavigation.navigate(
    view,
    () => view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<main style="font-family:sans-serif;padding:48px"><h1>DSH Codex Desktop</h1><p>' + escaped + '</p></main>')),
  )
}

async function updateStartupMessage(message: string, progress?: number, detail?: string): Promise<void> {
  const view = requireDshView()
  if (view.webContents.isDestroyed()) return
  const nextProgress = progress === undefined
    ? undefined
    : (startupProgress = advanceStartupProgress(startupProgress, progress))
  await view.webContents.executeJavaScript(startupStatusScript(message, nextProgress, detail))
    .catch(() => undefined)
}

/** 内置插件补种 / 待更新失败必须在启动窗口上说出来——只写日志等于对用户静默失败。
 *  文案刻意不承诺本产品没有的界面：本地外壳没有上游的"恢复页面"，可执行的只有重启、
 *  查日志与重解压完整便携包。冒烟由错误日志判定成败、不能等人工弹窗，故冒烟运行时不弹。 */
async function showStartupPluginWarning(kind: 'seed' | 'pending', message: string): Promise<void> {
  if ((process.env.DSH_DESKTOP_SMOKE_READY_FILE ?? '').trim() !== '') return
  await dialog.showMessageBox({
    type: 'warning',
    title: kind === 'seed'
      ? desktopText('内置插件更新未完成', 'Bundled plugin update incomplete')
      : desktopText('插件更新未完成', 'Plugin update incomplete'),
    message: kind === 'seed'
      ? desktopText('未能安装此桌面版本配套的插件。', 'Could not install the plugins bundled with this desktop version.')
      : desktopText('未能应用等待安装的插件更新。', 'Could not apply pending plugin updates.'),
    detail: desktopText(
      '将使用现有插件继续启动，功能可能不完整。请检查网络后重新启动应用；若仍然失败，可查看应用数据目录下的 plugin-seed.log / plugin-update.log，或重新解压完整的便携版压缩包。',
      'Startup will continue with the existing plugins; some features may be incomplete. Check your network and restart the app. If it still fails, check plugin-seed.log / plugin-update.log in the app data directory, or extract a fresh copy of the full portable package.',
    ) + '\n\n' + message,
    buttons: [desktopText('继续启动', 'Continue startup')],
  })
}

function firstInitializationMessage(): string {
  return desktopText(
    '检测到共享环境缓存不完整，正在执行离线修复…\n应用会在修复完成后继续启动。',
    'The shared runtime cache is incomplete. Repairing it offline…\nThe app will continue after recovery.',
  )
}

function runtimeExtractionMessage(progress: RuntimeExtractionProgress): string {
  const hint = desktopText('\n这是断电或缓存损坏后的自愈流程，请勿关闭应用。', '\nThis is recovery after an interrupted or damaged cache. Please keep the app open.')
  if (progress.phase === 'runtime') {
    return desktopText('正在校验并解压 DSH 运行环境…', 'Verifying and extracting the DSH runtime…') + hint
  }
  return desktopText('正在准备内置插件仓库…', 'Preparing the bundled plugin store…') + hint
}

function runtimeExtractionPercentage(progress: RuntimeExtractionProgress): number {
  if (progress.phase === 'runtime') {
    return progress.state === 'start' ? STARTUP_PROGRESS.runtimeExtractionStarted : STARTUP_PROGRESS.runtimeReady
  }
  return progress.state === 'start' ? STARTUP_PROGRESS.pluginStorePreparationStarted : STARTUP_PROGRESS.pluginStoreReady
}

/** 实测计量在阶段区间内按完成比例插值，让进度条跟着真实计数推进，而不是只在阶段端点跳变。 */
function measuredPercentage(start: number, end: number, completed: number | undefined, total: number | undefined): number | undefined {
  if (typeof completed !== 'number' || typeof total !== 'number' || total <= 0) return undefined
  const ratio = Math.min(1, Math.max(0, completed / total))
  return start + (end - start) * ratio
}

/** 解压子进程的进度：起止沿用阶段文案与区间端点；实测刻度显示"正在校验/解压/写入 + 真实计数"。 */
function reportExtractionProgress(progress: RuntimeExtractionProgress): void {
  if (progress.state !== 'progress' || progress.progress === undefined) {
    void updateStartupMessage(runtimeExtractionMessage(progress), runtimeExtractionPercentage(progress))
    return
  }
  const state = formatStartupProgress(progress.progress, isChineseLocale(desktopLocale()))
  const start = progress.phase === 'runtime' ? STARTUP_PROGRESS.runtimeExtractionStarted : STARTUP_PROGRESS.pluginStorePreparationStarted
  const end = progress.phase === 'runtime' ? STARTUP_PROGRESS.runtimeReady : STARTUP_PROGRESS.pluginStoreReady
  void updateStartupMessage(
    state.message,
    measuredPercentage(start, end, state.completed, state.total) ?? startupProgress,
    state.detail,
  )
}

/** 插件播种/待更新：pnpm 只报计数不报总量，因此进度条保持原位，只更新文案与细节行。 */
function reportSeedProgress(progress: StartupProgress): void {
  const state = formatStartupProgress(progress, isChineseLocale(desktopLocale()))
  void updateStartupMessage(state.message, startupProgress, state.detail)
}

let allowedOrigin = ''

async function createMainWindow(serverUrl: string): Promise<void> {
  allowedOrigin = new URL(serverUrl).origin
  mainWindow ??= createWindow()
  configureBrowserSession()
  const view = requireDshView()
  await clearStaleDshAuthCookies(view.webContents.session.cookies, serverUrl)
  await windowNavigation.navigate(view, () => view.webContents.loadURL(serverUrl))
  await applyDshDesktopTheme(view)
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
  if (isRequestHarnessUpdateIpc?.(message) === true) {
    // 「关于」页点“更新”官方运行时时，桥接进程只上报意图：真正的升级必须走
    // A/B 更新器，绝不能原地覆盖正在运行的活动槽。
    startHarnessUpdateTask(true)
    return
  }
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

function resolveShellAsset(name: 'shell.html' | 'browser-panel.html' | 'shortcuts.html' | 'about.html' | 'settings.html' | 'feature-panels.html' | 'theme.css'): string {
  const packaged = join(process.resourcesPath, name)
  return existsSync(packaged) ? packaged : join(app.getAppPath(), 'assets', name)
}

function resolvePreload(name: 'shell-preload.cjs' | 'browser-panel-preload.cjs' | 'dsh-view-preload.cjs'): string {
  return join(app.getAppPath(), 'dist', 'src', name)
}

function requireDshView(): WebContentsView {
  if (dshView === undefined) throw new Error('DSH 内容视图尚未创建。')
  return dshView
}

function layoutDshView(window: BrowserWindow): void {
  const bounds = window.getContentBounds()
  const dshHeight = Math.max(0, bounds.height - SHELL_BAR_HEIGHT)
  const panel = browserWorkspacePanelBounds(bounds.width, dshHeight)
  const visible = browserVisible && !browserPanelOccluded && !dshSettingsDialogVisible
    && (browserPanelOwner === undefined || browserPanelBounds !== undefined)
  dshView?.setVisible(true)
  dshView?.setBounds({ x: 0, y: SHELL_BAR_HEIGHT, width: bounds.width, height: dshHeight })
  browserPanelView?.setVisible(visible)
  if (visible) browserPanelView?.setBounds({ x: panel.x, y: panel.y + SHELL_BAR_HEIGHT, width: panel.width, height: panel.height })
  const pageTop = BROWSER_TABS_BAR_HEIGHT + BROWSER_NAV_BAR_HEIGHT
  const drawer = resolveBrowserDownloadsDrawerHeight(browserDownloadsOpen, browserDownloads.length, panel.height)
  const pageHeight = Math.max(0, panel.height - pageTop - drawer)
  for (const tab of browserTabs) {
    const show = visible && tab.id === activeBrowserTabId && !browserManagerOpen && !browserMenuOpen && pageHeight > 0
    tab.view.setVisible(show)
    if (show) tab.view.setBounds({ x: panel.x, y: panel.y + SHELL_BAR_HEIGHT + pageTop, width: panel.width, height: pageHeight })
  }
  broadcastShellState()
}

function browserWorkspacePanelBounds(viewportWidth: number, viewportHeight: number): BrowserPanelBounds {
  const reported = normalizeBrowserPanelBounds(browserPanelBounds, viewportWidth, viewportHeight)
  if (reported !== undefined) return reported
  const width = browserMaximized ? viewportWidth : capBrowserWorkspacePanelWidth(viewportWidth, Math.max(280, Math.round(viewportWidth * browserWidthRatio)))
  return { x: Math.max(0, viewportWidth - width), y: 0, width, height: viewportHeight }
}

async function captureBrowserPanelSnapshot(): Promise<BrowserPanelSnapshot | null> {
  const window = mainWindow
  const chrome = browserPanelView?.webContents
  if (window === undefined || chrome === undefined || chrome.isDestroyed() || !browserVisible || browserPanelOccluded) return null
  const content = window.getContentBounds()
  const dshHeight = Math.max(0, content.height - SHELL_BAR_HEIGHT)
  const panel = browserWorkspacePanelBounds(content.width, dshHeight)
  const pageTop = BROWSER_TABS_BAR_HEIGHT + BROWSER_NAV_BAR_HEIGHT
  const drawerHeight = resolveBrowserDownloadsDrawerHeight(browserDownloadsOpen, browserDownloads.length, panel.height)
  const pageHeight = Math.max(0, panel.height - pageTop - drawerHeight)
  const active = getActiveBrowserTab()?.view.webContents
  try {
    const [chromeImage, pageImage] = await Promise.all([
      chrome.capturePage(),
      active === undefined || active.isDestroyed() || browserManagerOpen || browserMenuOpen || pageHeight === 0
        ? Promise.resolve(undefined)
        : active.capturePage(),
    ])
    return {
      chromeDataUrl: chromeImage.toDataURL(),
      ...(pageImage === undefined ? {} : { pageDataUrl: pageImage.toDataURL() }),
      pageTop,
      pageHeight,
    }
  } catch (error) {
    console.warn(`浏览器遮挡快照生成失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function captureBrowserMenuPageSnapshot(): Promise<BrowserPageSnapshot | null> {
  const window = mainWindow
  if (window === undefined || window.isDestroyed() || !browserVisible || browserPanelOccluded || browserManagerOpen || browserMenuOpen) return null
  const content = window.getContentBounds()
  const dshHeight = Math.max(0, content.height - SHELL_BAR_HEIGHT)
  const panel = browserWorkspacePanelBounds(content.width, dshHeight)
  const pageTop = BROWSER_TABS_BAR_HEIGHT + BROWSER_NAV_BAR_HEIGHT
  const drawerHeight = resolveBrowserDownloadsDrawerHeight(browserDownloadsOpen, browserDownloads.length, panel.height)
  const pageHeight = Math.max(0, panel.height - pageTop - drawerHeight)
  const page = getActiveBrowserTab()?.view.webContents
  if (page === undefined || page.isDestroyed() || pageHeight === 0) return null
  try {
    const image = await page.capturePage()
    if (image.isEmpty()) return null
    return { pageDataUrl: image.toDataURL(), pageTop, pageHeight }
  } catch (error) {
    console.warn(`浏览器菜单网页快照生成失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
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
    partition: DSH_PARTITION,
    preload: resolvePreload('dsh-view-preload.cjs'),
    sandbox: true,
  } })
  dshView = view
  window.contentView.addChildView(view)
  const panelView = new WebContentsView({ webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: resolvePreload('browser-panel-preload.cjs'),
    sandbox: true,
  } })
  browserPanelView = panelView
  window.contentView.addChildView(panelView)
  panelView.setVisible(false)
  layoutDshView(window)
  window.on('resize', () => layoutDshView(window))
  window.on('maximize', () => layoutDshView(window))
  window.on('unmaximize', () => layoutDshView(window))
  runMainTask(window.loadFile(resolveShellAsset('shell.html'), { query: desktopThemeQuery() }))
  runMainTask(panelView.webContents.loadFile(resolveShellAsset('browser-panel.html'), { query: desktopThemeQuery() }))

  view.webContents.setWindowOpenHandler(({ url }) => {
    routeDshExternalLink(url)
    return { action: 'deny' }
  })
  view.webContents.on('did-start-navigation', () => { dshSettingsDialogVisible = false })
  view.webContents.on('dom-ready', () => {
    if (!isSameOrigin(view.webContents.getURL(), allowedOrigin)) return
    // Electron removes insertCSS styles on document navigation/reload.
    // Share this document's insertion with the initial startup readiness check.
    dshDocumentThemeLoads.delete(view)
    runMainTask(applyDshDesktopTheme(view))
  })
  view.webContents.on('will-navigate', (event, url) => {
    if (windowNavigation.isNavigating()) {
      event.preventDefault()
      return
    }
    if (isSameOrigin(url, allowedOrigin)) return
    event.preventDefault()
    routeDshExternalLink(url)
  })
  view.webContents.on('will-redirect', (event, url) => {
    if (isSameOrigin(url, allowedOrigin)) return
    event.preventDefault()
    routeDshExternalLink(url)
  })
  installShortcutHandler(window.webContents)
  installShortcutHandler(view.webContents)
  installShortcutHandler(panelView.webContents)
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
      browserPanelView = undefined
      browserPanelBounds = undefined
      browserPanelOwner = undefined
      browserPanelOccluded = false
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
    browserWorkspaceVisible: browserVisible,
  }
}

function runningDshRuntimeVersion(): string {
  const runtimeRoot = lastStartOptions?.runtime.root
  if (runtimeRoot === undefined) return OFFICIAL_DSH_VERSION
  return runtimeSlotVersion(runtimeRoot) ?? harnessUpdateState?.currentVersion ?? OFFICIAL_DSH_VERSION
}

function shellBootstrap(state: ShellState = currentShellState()): ShellBootstrap {
  const locale = desktopLocale()
  return {
    actions: localizedShellActions(locale, process.platform),
    bundledRuntimeVersion: OFFICIAL_DSH_VERSION,
    colorScheme: activeDshColorScheme,
    featurePanels: {
      categories: FEATURE_PANEL_CATEGORIES.map(category => ({ id: category.id, label: category.label, hint: category.hint })),
      panels: FEATURE_PANELS.map(({ panel, categoryId }) => ({
        id: panel.id,
        name: panel.name,
        file: panel.file,
        description: panel.description,
        ...(panel.notes === undefined ? {} : { notes: panel.notes }),
        categoryId,
      })),
    },
    themePreset: themePreferences.preset,
    locale,
    menus: localizedShellMenus(locale),
    platform: process.platform,
    runtimeUpdateChannel: harnessUpdatePolicy.channel,
    runtimeVersion: runningDshRuntimeVersion(),
    state,
    version: app.getVersion(),
  }
}

function broadcastShellBootstrap(): void {
  const state = currentShellState()
  const hiddenBrowserState = { ...state, browser: { ...state.browser, visible: false } }
  const bootstrap = shellBootstrap(hiddenBrowserState)
  for (const window of [mainWindow, shortcutsWindow, aboutWindow, featurePanelsWindow, settingsWindow]) {
    if (window !== undefined && !window.isDestroyed()) window.webContents.send(SHELL_IPC.bootstrap, bootstrap)
  }
  if (browserPanelView !== undefined && !browserPanelView.webContents.isDestroyed()) {
    browserPanelView.webContents.send(SHELL_IPC.bootstrap, shellBootstrap(state))
  }
  sendDesktopThemeToDsh()
}

function desktopThemeQuery(): Record<string, string> {
  return { theme: activeDshColorScheme, preset: themePreferences.preset }
}

function desktopThemePayload(): { colorScheme: DesktopColorScheme; preset: DesktopThemePreferences['preset'] } {
  return { colorScheme: activeDshColorScheme, preset: themePreferences.preset }
}

function sendDesktopThemeToDsh(): void {
  if (dshView !== undefined && !dshView.webContents.isDestroyed()) {
    dshView.webContents.send(SHELL_IPC.desktopTheme, desktopThemePayload())
  }
}

const dshDocumentThemeLoads = new WeakMap<WebContentsView, Promise<void>>()

async function applyDshDesktopTheme(view: WebContentsView): Promise<void> {
  let pending = dshDocumentThemeLoads.get(view)
  if (pending === undefined) {
    pending = (async () => {
      await view.webContents.insertCSS(readFileSync(resolveShellAsset('theme.css'), 'utf8'))
      if (!view.webContents.isDestroyed()) view.webContents.send(SHELL_IPC.desktopTheme, desktopThemePayload())
    })()
    dshDocumentThemeLoads.set(view, pending)
  }
  await pending
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
  setWindowBackground(featurePanelsWindow, palette.shortcutsBackground)
  if (process.platform !== 'darwin' && mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.setTitleBarOverlay({ color: palette.titleBarBackground, symbolColor: palette.titleBarSymbol, height: SHELL_BAR_HEIGHT })
  }
}

function broadcastShellState(): void {
  const state = currentShellState()
  const hiddenBrowserState = { ...state, browser: { ...state.browser, visible: false } }
  for (const window of [mainWindow, shortcutsWindow, aboutWindow, featurePanelsWindow, settingsWindow]) {
    if (window !== undefined && !window.isDestroyed()) window.webContents.send(SHELL_IPC.state, hiddenBrowserState)
  }
  if (browserPanelView !== undefined && !browserPanelView.webContents.isDestroyed()) {
    browserPanelView.webContents.send(SHELL_IPC.state, state)
  }
}

function desktopUpdateSnapshot(): DesktopUpdateSnapshot {
  return {
    currentVersion: app.getVersion(),
    packaged: app.isPackaged && portableDesktopUpdater !== undefined,
    status: updateStatus,
    ...(lastUpdateCheckAt === undefined ? {} : { lastCheckedAt: lastUpdateCheckAt }),
  }
}

function broadcastDesktopUpdateState(): void {
  const snapshot = desktopUpdateSnapshot()
  for (const window of [mainWindow, settingsWindow]) {
    if (window !== undefined && !window.isDestroyed()) window.webContents.send(SHELL_IPC.desktopUpdateState, snapshot)
  }
}

function startDesktopActivationHeartbeat(): void {
  const transactionId = process.env.DSH_DESKTOP_UPDATE_TRANSACTION
  const healthFile = process.env.DSH_DESKTOP_UPDATE_HEALTH_FILE
  if (transactionId === undefined || healthFile === undefined || desktopActivationHeartbeatTimer !== undefined) return
  const progressFile = join(dirname(healthFile), 'startup-progress.json')
  const writeHeartbeat = (): void => {
    try {
      writeFileSync(progressFile, `${JSON.stringify({ schema: 1, transactionId, updatedAt: new Date().toISOString() })}\n`, 'utf8')
    } catch {
      // The launcher still enforces its finite lease and hard deadline if progress reporting fails.
    }
  }
  writeHeartbeat()
  desktopActivationHeartbeatTimer = setInterval(writeHeartbeat, 5_000)
  desktopActivationHeartbeatTimer.unref()
}

function stopDesktopActivationHeartbeat(): void {
  if (desktopActivationHeartbeatTimer !== undefined) clearInterval(desktopActivationHeartbeatTimer)
  desktopActivationHeartbeatTimer = undefined
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
  ipcMain.removeHandler(SHELL_IPC.updateThemePreferences)
  ipcMain.removeHandler(SHELL_IPC.getUpdatePreferences)
  ipcMain.removeHandler(SHELL_IPC.updateUpdatePreferences)
  ipcMain.removeHandler(SHELL_IPC.getDesktopUpdateState)
  ipcMain.removeHandler(SHELL_IPC.desktopUpdateAction)
  ipcMain.removeHandler(SHELL_IPC.getHarnessUpdateState)
  ipcMain.removeHandler(SHELL_IPC.updateHarnessUpdatePolicy)
  ipcMain.removeHandler(SHELL_IPC.harnessUpdateAction)
  ipcMain.removeHandler(SHELL_IPC.closeDesktopSettings)
  ipcMain.handle(SHELL_IPC.getBootstrap, event => {
    const kind = shellRendererKind(event.sender)
    if (!mayGetShellBootstrap(kind)) return
    const state = currentShellState()
    return shellBootstrap(kind === 'browser-panel' ? state : { ...state, browser: { ...state.browser, visible: false } })
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
  ipcMain.handle(SHELL_IPC.updateThemePreferences, async (event, value: unknown) => {
    if (!mayAccessThemePreferences(shellRendererKind(event.sender))) return
    themePreferences = await saveDesktopThemePreferences(themePreferencesPath(), value)
    broadcastShellBootstrap()
    return themePreferences
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
    const task = startHarnessUpdateTask(true)
    // 设置页等待本次周期结束再刷新快照；周期内的每次状态变化另有广播。
    if (task !== undefined) await task
    return harnessUpdateSnapshot()
  })
  ipcMain.handle(SHELL_IPC.closeDesktopSettings, event => {
    if (!mayCloseDesktopSettings(shellRendererKind(event.sender))) return
    settingsWindow?.close()
  })
  ipcMain.removeHandler(SHELL_IPC.featurePanelsCopy)
  ipcMain.handle(SHELL_IPC.featurePanelsCopy, (event, value: unknown) => {
    if (!mayInvokeFeaturePanelsCopy(shellRendererKind(event.sender))) return false
    if (typeof value !== 'string' || value === '') return false
    clipboard.writeText(value)
    return true
  })
  ipcMain.removeHandler(SHELL_IPC.browserToggle)
  ipcMain.handle(SHELL_IPC.browserToggle, event => {
    const kind = shellRendererKind(event.sender)
    // The shell may open/close the workspace; privileged browser operations stay in its own renderer.
    if (kind !== 'main' && !mayInvokeBrowserIpc(kind)) return
    browserVisible = !browserVisible
    if (browserVisible && getActiveBrowserTab() === null) activeBrowserTabId = createBrowserTab(primaryBrowserHomepage()).id
    if (!browserVisible) {
      browserManagerOpen = false
      browserMenuOpen = false
      browserDownloadsOpen = false
      browserMaximized = false
    }
    relayout()
    scheduleBrowserWorkspaceSave()
    if (!browserVisible && dshView !== undefined && !dshView.webContents.isDestroyed()) {
      browserPanelOwner = undefined
      browserPanelBounds = undefined
      dshView.webContents.send(SHELL_IPC.dshBrowserCloseRequest)
    }
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
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents === undefined || contents.isDestroyed()) return
    if (contents.isLoading()) contents.stop()
    else contents.reload()
  })
  ipcMain.removeHandler(SHELL_IPC.browserOpenExternal)
  ipcMain.handle(SHELL_IPC.browserOpenExternal, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return false
    const url = getActiveBrowserTab()?.url
    if (url === undefined || !isAllowedBrowserUrl(url)) return false
    runMainTask(shell.openExternal(url))
    return true
  })
  ipcMain.removeHandler(SHELL_IPC.browserPrint)
  ipcMain.handle(SHELL_IPC.browserPrint, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return false
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents === undefined || contents.isDestroyed()) return false
    contents.print({ printBackground: true })
    return true
  })
  ipcMain.removeHandler(SHELL_IPC.browserScreenshot)
  ipcMain.handle(SHELL_IPC.browserScreenshot, async event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents === undefined || contents.isDestroyed()) return null
    const image = await contents.capturePage()
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const fileName = `screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
    const downloadsRoot = browserDownloadsRoot()
    mkdirSync(downloadsRoot, { recursive: true })
    const filePath = join(downloadsRoot, fileName)
    writeFileSync(filePath, image.toPNG())
    shell.showItemInFolder(filePath)
    return fileName
  })
  ipcMain.removeHandler(SHELL_IPC.browserClearData)
  ipcMain.handle(SHELL_IPC.browserClearData, async event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return false
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    await browserSession.clearCache()
    await browserSession.clearStorageData({
      storages: ['cachestorage', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'shadercache'],
    })
    getActiveBrowserTab()?.view.webContents.reload()
    return true
  })
  ipcMain.removeHandler(SHELL_IPC.browserGetLibrary)
  ipcMain.handle(SHELL_IPC.browserGetLibrary, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    return browserData().publicSnapshot()
  })
  ipcMain.removeHandler(SHELL_IPC.browserToggleManager)
  ipcMain.handle(SHELL_IPC.browserToggleManager, (event, visible: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    browserManagerOpen = typeof visible === 'boolean' ? visible : !browserManagerOpen
    if (browserManagerOpen) {
      browserVisible = true
      browserMenuOpen = false
      browserDownloadsOpen = false
    }
    relayout()
    return browserShellState()
  })
  ipcMain.removeHandler(SHELL_IPC.browserToggleMenu)
  ipcMain.removeHandler(SHELL_IPC.browserPrepareMenuSnapshot)
  ipcMain.handle(SHELL_IPC.browserPrepareMenuSnapshot, event => {
    if (shellRendererKind(event.sender) !== 'browser-panel') return null
    return captureBrowserMenuPageSnapshot()
  })
  ipcMain.handle(SHELL_IPC.browserToggleMenu, (event, visible: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    browserMenuOpen = typeof visible === 'boolean' ? visible : !browserMenuOpen
    if (browserMenuOpen) {
      browserVisible = true
      browserManagerOpen = false
    }
    relayout()
    return browserShellState()
  })
  ipcMain.removeHandler(SHELL_IPC.browserBookmarkCurrent)
  ipcMain.handle(SHELL_IPC.browserBookmarkCurrent, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    const tab = getActiveBrowserTab()
    if (tab === null || !isAllowedBrowserUrl(tab.url)) return null
    const added = browserData().toggleBookmark({ url: tab.url, title: tab.title, favicon: tab.favicon })
    broadcastShellState()
    return { added, library: browserData().publicSnapshot() }
  })
  ipcMain.removeHandler(SHELL_IPC.browserLibraryRemove)
  ipcMain.handle(SHELL_IPC.browserLibraryRemove, (event, kind: unknown, id: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    if (typeof kind !== 'string' || typeof id !== 'string' || !['history', 'bookmark', 'credential'].includes(kind)) return null
    browserData().remove(kind, id)
    broadcastShellState()
    return browserData().publicSnapshot()
  })
  ipcMain.removeHandler(SHELL_IPC.browserLibraryClear)
  ipcMain.handle(SHELL_IPC.browserLibraryClear, (event, kind: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    if (typeof kind !== 'string' || !['history', 'bookmarks', 'credentials'].includes(kind)) return null
    browserData().clear(kind)
    broadcastShellState()
    return browserData().publicSnapshot()
  })
  ipcMain.removeHandler(SHELL_IPC.browserSaveSettings)
  ipcMain.handle(SHELL_IPC.browserSaveSettings, async (event, patch: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return browserData().publicSnapshot()
    const input = patch as Record<string, unknown>
    const settings: Partial<BrowserLibrarySnapshot['settings']> = {}
    if (Array.isArray(input.homepages)) settings.homepages = input.homepages.filter((value): value is string => typeof value === 'string').slice(0, 8)
    for (const key of ['historyEnabled', 'autoRetryImport', 'loadExtensions'] as const) {
      if (typeof input[key] === 'boolean') settings[key] = input[key]
    }
    browserData().setSettings(settings)
    if (settings.loadExtensions !== undefined) await browserData().loadExtensions(session.fromPartition(BROWSER_PARTITION))
    return browserData().publicSnapshot()
  })
  ipcMain.removeHandler(SHELL_IPC.browserSaveCredential)
  ipcMain.handle(SHELL_IPC.browserSaveCredential, (event, credential: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    if (typeof credential !== 'object' || credential === null || Array.isArray(credential)) throw new Error('凭据格式无效。')
    const input = credential as Record<string, unknown>
    browserData().saveCredential({
      ...(typeof input.id === 'string' ? { id: input.id.slice(0, 200) } : {}),
      origin: String(input.origin ?? '').slice(0, 2_000),
      username: String(input.username ?? '').slice(0, 500),
      password: String(input.password ?? '').slice(0, 10_000),
      label: String(input.label ?? '').slice(0, 500),
    })
    return browserData().publicSnapshot()
  })
  ipcMain.removeHandler(SHELL_IPC.browserFillCredential)
  ipcMain.handle(SHELL_IPC.browserFillCredential, async (event, id: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender)) || typeof id !== 'string') return null
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents === undefined || contents.isDestroyed()) throw new Error('没有可填充的活动页面。')
    const credential = browserData().credentialSecret(id)
    const pageOrigin = new URL(contents.getURL()).origin
    if (credential.origin !== pageOrigin) throw new Error(`该密码属于 ${credential.origin}，不会填入当前网站。`)
    const payload = JSON.stringify({ username: credential.username, password: credential.password })
    return contents.executeJavaScript(`(() => {
      const value = ${payload};
      const password = document.querySelector('input[type="password"]');
      const username = document.querySelector('input[autocomplete="username"],input[type="email"],input[name*="user" i],input[name*="email" i],input[type="text"]');
      const set = (node, next) => { if (!node) return false; const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); descriptor?.set?.call(node, next); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; };
      return { username: set(username, value.username), password: set(password, value.password) };
    })()`, true)
  })
  ipcMain.removeHandler(SHELL_IPC.browserAutofillPage)
  ipcMain.handle(SHELL_IPC.browserAutofillPage, async event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return { filled: 0 }
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents === undefined || contents.isDestroyed()) return { filled: 0 }
    const payload = JSON.stringify(browserData().publicSnapshot().autofill.slice(0, 500))
    return contents.executeJavaScript(`(() => {
      const entries = ${payload}; let filled = 0;
      for (const input of document.querySelectorAll('input:not([type="password"]),textarea')) {
        if (input.value) continue; const key = String(input.name || input.autocomplete || input.id || '').toLowerCase();
        const match = entries.find(entry => key && (key === String(entry.name).toLowerCase() || key.includes(String(entry.name).toLowerCase()))); if (!match) continue;
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, match.value); input.dispatchEvent(new Event('input', { bubbles: true })); filled += 1;
      } return { filled };
    })()`, true)
  })
  ipcMain.removeHandler(SHELL_IPC.browserImportProfile)
  ipcMain.handle(SHELL_IPC.browserImportProfile, async (event, sourceId: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender)) || typeof sourceId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(sourceId)) return null
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    const result = await browserData().importProfile(sourceId, browserSession)
    await browserData().loadExtensions(browserSession)
    broadcastShellState()
    return { result, library: browserData().publicSnapshot() }
  })
  ipcMain.removeHandler(SHELL_IPC.browserToggleExtension)
  ipcMain.handle(SHELL_IPC.browserToggleExtension, async (event, id: unknown, enabled: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender)) || typeof id !== 'string' || typeof enabled !== 'boolean') return null
    browserData().toggleExtension(id, enabled)
    await browserData().loadExtensions(session.fromPartition(BROWSER_PARTITION))
    return browserData().publicSnapshot()
  })
  ipcMain.removeHandler(SHELL_IPC.browserFind)
  ipcMain.handle(SHELL_IPC.browserFind, async (event, text: unknown, options: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    const contents = getActiveBrowserTab()?.view.webContents
    const queryText = typeof text === 'string' ? text.slice(0, 500) : ''
    if (contents === undefined || contents.isDestroyed() || queryText === '') return null
    const input = typeof options === 'object' && options !== null ? options as Record<string, unknown> : {}
    const forward = input.forward !== false
    const findNext = input.findNext === true
    const requestId = contents.findInPage(queryText, { forward, findNext })
    return { requestId }
  })
  ipcMain.removeHandler(SHELL_IPC.browserFindStop)
  ipcMain.handle(SHELL_IPC.browserFindStop, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents !== undefined && !contents.isDestroyed()) contents.stopFindInPage('keepSelection')
  })
  ipcMain.removeHandler(SHELL_IPC.browserDevTools)
  ipcMain.handle(SHELL_IPC.browserDevTools, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return false
    const contents = getActiveBrowserTab()?.view.webContents
    if (contents === undefined || contents.isDestroyed()) return false
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'detach', activate: true })
    return true
  })
  ipcMain.removeHandler(SHELL_IPC.browserRuntimeInfo)
  ipcMain.handle(SHELL_IPC.browserRuntimeInfo, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    return { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, updateManagedByDesktop: true }
  })
  ipcMain.removeHandler(SHELL_IPC.browserRuntimeCheck)
  ipcMain.handle(SHELL_IPC.browserRuntimeCheck, async event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    const response = await net.fetch('https://releases.electronjs.org/releases.json', { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Electron 版本服务返回 ${response.status}`)
    const releases = await response.json() as { version?: string }[]
    const parts = (value: string): number[] => value.split('.').map(item => Number.parseInt(item, 10) || 0)
    const stable = releases.filter(entry => /^\d+\.\d+\.\d+$/.test(String(entry.version ?? '')))
    stable.sort((left, right) => {
      const a = parts(String(left.version)); const b = parts(String(right.version))
      for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return (b[index] ?? 0) - (a[index] ?? 0)
      return 0
    })
    const current = process.versions.electron
    const latest = String(stable[0]?.version ?? current)
    const currentParts = parts(current); const latestParts = parts(latest)
    let updateAvailable = false
    for (let index = 0; index < 3; index += 1) {
      const difference = (latestParts[index] ?? 0) - (currentParts[index] ?? 0)
      if (difference === 0) continue
      updateAvailable = difference > 0
      break
    }
    return { current, latest, updateAvailable, checkedAt: new Date().toISOString() }
  })
  ipcMain.removeHandler(SHELL_IPC.browserPageZoom)
  ipcMain.handle(SHELL_IPC.browserPageZoom, (event, action: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return Math.round(browserPageZoom * 100)
    if (action === 'reset') browserPageZoom = 1
    else if (action === 'in') browserPageZoom = Math.min(2, Math.round((browserPageZoom + 0.1) * 10) / 10)
    else if (action === 'out') browserPageZoom = Math.max(0.5, Math.round((browserPageZoom - 0.1) * 10) / 10)
    for (const tab of browserTabs) applyBrowserPageZoom(tab.view.webContents)
    broadcastShellState()
    return Math.round(browserPageZoom * 100)
  })
  ipcMain.removeHandler(SHELL_IPC.browserToggleDownloads)
  ipcMain.handle(SHELL_IPC.browserToggleDownloads, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    browserDownloadsOpen = !browserDownloadsOpen
    browserManagerOpen = false
    browserMenuOpen = false
    relayout()
    return browserShellState()
  })
  ipcMain.removeHandler(SHELL_IPC.browserOpenDownloadsFolder)
  ipcMain.handle(SHELL_IPC.browserOpenDownloadsFolder, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    const downloadsRoot = browserDownloadsRoot()
    mkdirSync(downloadsRoot, { recursive: true })
    return shell.openPath(downloadsRoot)
  })
  ipcMain.removeHandler(SHELL_IPC.browserOpenDownload)
  ipcMain.handle(SHELL_IPC.browserOpenDownload, (event, id: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender)) || typeof id !== 'string') return
    const record = browserDownloads.find(entry => entry.id === id)
    if (record?.status === 'completed' && existsSync(record.path)) return shell.openPath(record.path)
  })
  ipcMain.removeHandler(SHELL_IPC.browserShowDownload)
  ipcMain.handle(SHELL_IPC.browserShowDownload, (event, id: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender)) || typeof id !== 'string') return
    const record = browserDownloads.find(entry => entry.id === id)
    if (record !== undefined && existsSync(record.path)) shell.showItemInFolder(record.path)
  })
  ipcMain.removeHandler(SHELL_IPC.browserClearDownloads)
  ipcMain.handle(SHELL_IPC.browserClearDownloads, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    browserDownloads.splice(0)
    browserDownloadsOpen = false
    relayout()
    return browserShellState()
  })
  ipcMain.removeHandler(SHELL_IPC.browserToggleMaximize)
  ipcMain.handle(SHELL_IPC.browserToggleMaximize, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    browserMaximized = !browserMaximized
    relayout()
    scheduleBrowserWorkspaceSave()
  })
  ipcMain.removeHandler(SHELL_IPC.browserSetRatio)
  ipcMain.handle(SHELL_IPC.browserSetRatio, (event, ratio: unknown) => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return
    const windowWidth = Math.max(960, mainWindow?.getContentBounds().width ?? 960)
    // 比例上限 0.55：面板最多占窗口的 55%（WorkBuddy 参照比例），对话区保底 ~40%
    const minimumRatio = 320 / windowWidth
    const maximumRatio = Math.min(0.55, (windowWidth - 900) / windowWidth)
    browserWidthRatio = Math.max(minimumRatio, Math.min(maximumRatio, ratio))
    browserMaximized = false
    relayout()
    scheduleBrowserWorkspaceSave()
  })
  ipcMain.removeHandler(SHELL_IPC.browserPanelShow)
  ipcMain.handle(SHELL_IPC.browserPanelShow, (event, value: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) throw new Error('Browser card sender rejected')
    const request = normalizeNativeBrowserRequest(value, allowedOrigin)
    if (browserPanelOwner !== request.owner) browserPanelBounds = undefined
    browserPanelOwner = request.owner
    browserVisible = true
    browserPanelOccluded = false
    browserMaximized = false
    browserManagerOpen = false
    browserMenuOpen = false
    browserDownloadsOpen = false
    if (request.url !== undefined) openBrowser(request.url, true)
    else if (getActiveBrowserTab() === null) activeBrowserTabId = createBrowserTab(primaryBrowserHomepage()).id
    relayout()
    scheduleBrowserWorkspaceSave()
    return { owner: request.owner }
  })
  ipcMain.removeHandler(SHELL_IPC.browserPanelHide)
  ipcMain.handle(SHELL_IPC.browserPanelHide, (event, owner: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender)) || owner !== browserPanelOwner) return
    browserPanelOwner = undefined
    browserVisible = false
    browserPanelOccluded = false
    browserPanelBounds = undefined
    browserManagerOpen = false
    browserMenuOpen = false
    browserDownloadsOpen = false
    relayout()
    scheduleBrowserWorkspaceSave()
  })
  ipcMain.removeHandler(SHELL_IPC.browserPanelOccluded)
  ipcMain.removeHandler(SHELL_IPC.browserPanelPrepareOcclusion)
  ipcMain.handle(SHELL_IPC.browserPanelPrepareOcclusion, event => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) return null
    return captureBrowserPanelSnapshot()
  })
  ipcMain.handle(SHELL_IPC.browserPanelOccluded, (event, value: unknown, owner: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender)) || typeof value !== 'boolean' || owner !== browserPanelOwner) return
    if (browserPanelOccluded === value) return
    browserPanelOccluded = value
    relayout()
  })
  ipcMain.removeAllListeners(SHELL_IPC.browserPanelBounds)
  ipcMain.on(SHELL_IPC.browserPanelBounds, (event, value: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) return
    if (typeof value !== 'object' || value === null || (value as { owner?: unknown }).owner !== browserPanelOwner) return
    const content = mainWindow?.getContentBounds()
    if (content === undefined) return
    const panel = normalizeBrowserPanelBounds(value, content.width, Math.max(0, content.height - SHELL_BAR_HEIGHT), event.sender.getZoomFactor())
    browserPanelBounds = panel
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
    const visible = value === true
    if (visible !== dshSettingsDialogVisible) {
      dshSettingsDialogVisible = visible
      relayout()
    }
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
  if (sender === browserPanelView?.webContents) return 'browser-panel'
  if (sender === shortcutsWindow?.webContents) return 'shortcuts'
  if (sender === aboutWindow?.webContents) return 'about'
  if (sender === featurePanelsWindow?.webContents) return 'feature-panels'
  if (sender === settingsWindow?.webContents) return 'settings'
  if (sender === dshView?.webContents) return 'dsh'
  return 'unknown'
}

/** 调试"当前正在看的那个页面"：辅助窗口（快捷键/关于/功能面板/设置）各自独立，焦点在它们身上
 *  就调试它们自己，否则调试工作台内容视图——本地外壳用同一个 dshView 承载启动页与工作台。 */
function resolveDevToolsContents(): Electron.WebContents | undefined {
  const focusedAuxiliary = [shortcutsWindow, aboutWindow, featurePanelsWindow, settingsWindow]
    .find(candidate => candidate !== undefined && !candidate.isDestroyed() && candidate.isFocused())
  const contents = focusedAuxiliary?.webContents ?? dshView?.webContents
  return contents === undefined || contents.isDestroyed() ? undefined : contents
}

function isActionEnabled(id: ShellActionId): boolean {
  if (id === 'toggle-devtools') return resolveDevToolsContents() !== undefined
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
        // 勾选态必须来自实际内容页，手动关掉调试器后菜单也要跟着回到未勾选。
        ...(action.id === 'toggle-devtools'
          ? { type: 'checkbox' as const, checked: resolveDevToolsContents()?.isDevToolsOpened() ?? false }
          : {}),
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
    const browserTab = browserTabs.find(tab => tab.view.webContents === contents)
    if (browserTab !== undefined) {
      const command = process.platform === 'darwin' ? input.meta : input.control
      const key = input.key.toLowerCase()
      if (command && key === 'f') {
        event.preventDefault()
        browserPanelView?.webContents.send(SHELL_IPC.browserOpenFind)
        return
      }
      if (command && key === 'l') {
        event.preventDefault()
        browserPanelView?.webContents.send(SHELL_IPC.browserFocusAddress)
        return
      }
      if (command && key === 't') {
        event.preventDefault()
        createBrowserTab(configuredBrowserHomepages()[0])
        return
      }
      if (command && key === 'w') {
        event.preventDefault()
        closeBrowserTab(browserTab.id)
        return
      }
      if ((command && key === 'r') || input.key === 'F5') {
        event.preventDefault()
        contents.reload()
        return
      }
      if (input.alt && input.key === 'Left' && contents.canGoBack()) {
        event.preventDefault()
        contents.goBack()
        return
      }
      if (input.alt && input.key === 'Right' && contents.canGoForward()) {
        event.preventDefault()
        contents.goForward()
        return
      }
    }
    const auxiliaryWindow = [shortcutsWindow, aboutWindow, featurePanelsWindow, settingsWindow].find(window => window?.webContents === contents)
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
  if (id === 'toggle-devtools') {
    const target = resolveDevToolsContents()
    if (target?.isDevToolsOpened() === true) target.closeDevTools()
    else target?.openDevTools({ mode: 'detach', activate: true })
    return
  }
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
  else if (id === 'feature-panels') { showFeaturePanelsWindow(); return }
  else if (id === 'reload') await recycleDshForPluginUpdate()
  else if (id === 'check-updates') {
    showDesktopSettingsWindow('updates')
    await checkDesktopUpdate('settings')
  }
  else if (id === 'whats-new') await shell.openExternal('https://github.com/MichengAI/dsh-codex-desktop/releases')
  else if (id === 'feedback') await shell.openExternal('https://github.com/MichengAI/dsh-codex-desktop/issues/new')
  else if (id === 'about') showAboutWindow()
  broadcastShellState()
}

function notificationPreferencesPath(): string {
  return join(app.getPath('userData'), 'desktop-settings.json')
}

function themePreferencesPath(): string {
  return join(app.getPath('userData'), 'shell', 'theme.json')
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
  runMainTask(window.loadFile(resolveShellAsset('settings.html'), { query: desktopThemeQuery() }))
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
  runMainTask(window.loadFile(resolveShellAsset('shortcuts.html'), { query: desktopThemeQuery() }))
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
  runMainTask(window.loadFile(resolveShellAsset('about.html'), { query: desktopThemeQuery() }))
}

function showFeaturePanelsWindow(): void {
  if (featurePanelsWindow !== undefined && !featurePanelsWindow.isDestroyed()) {
    featurePanelsWindow.show()
    featurePanelsWindow.focus()
    return
  }
  const window = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 760,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    title: desktopText('功能板块', 'Feature Panels'),
    autoHideMenuBar: true,
    backgroundColor: DESKTOP_THEME_PALETTES[activeDshColorScheme].shortcutsBackground,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: resolvePreload('shell-preload.cjs'), sandbox: true },
  })
  removeNativeWindowMenu(window)
  featurePanelsWindow = window
  window.on('closed', () => { if (featurePanelsWindow === window) featurePanelsWindow = undefined })
  installShortcutHandler(window.webContents)
  runMainTask(window.loadFile(resolveShellAsset('feature-panels.html'), { query: desktopThemeQuery() }))
}

async function configureDesktopUpdater(): Promise<void> {
  if (!app.isPackaged || portablePaths === undefined || process.platform !== 'win32' || process.arch !== 'x64') return
  portableDesktopUpdater = new PortableDesktopUpdater({
    portableRoot: portablePaths.root,
    currentVersion: app.getVersion(),
    // 机器本地 Data/config 覆盖优先于构建期烘焙的 resources/release-source.json；
    // 都没有时回落内置默认（上游仓库，缺契约的 Release 会被拦成「已阻止」）。
    releaseSource: resolvePortableReleaseSource([
      join(portablePaths.root, PORTABLE_RELEASE_SOURCE_OVERRIDE_PATH),
      join(process.resourcesPath, 'release-source.json'),
    ]),
    onState: applyPortableDesktopUpdateState,
    prepareCandidateRuntime: async (appDirectory, onProgress) => {
      const resourcesDir = join(appDirectory, 'resources')
      const legacyRuntimeDir = resolveDesktopRuntimeDir(app.getPath('userData'), {
        isPackaged: true,
        execPath: join(appDirectory, 'DSH Codex Desktop.exe'),
        portableRoot: portablePaths.root,
      })
      const activeRuntimeDir = resolveActiveRuntimeDir(legacyRuntimeDir)
      await preparePackagedRuntimeCacheInChild({
        resourcesDir,
        runtimeRoot: dirname(legacyRuntimeDir),
        nodeExecutable: resolveNodeExecutable({ isPackaged: true, resourcesPath: resourcesDir }),
        scriptPath: join(resourcesDir, 'extract-runtime.mjs'),
        skipOfficial: resolve(activeRuntimeDir) !== resolve(legacyRuntimeDir),
        onProgress,
      })
    },
  })
  await portableDesktopUpdater.initialize()
}

function applyPortableDesktopUpdateState(state: PortableDesktopUpdateState): void {
  if (state.lastCheckedAt !== undefined) lastUpdateCheckAt = state.lastCheckedAt
  const progress = {
    detail: state.detail,
    overallProgress: state.overallProgress,
    stageProgress: state.stageProgress,
    ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
    ...(state.transactionId === undefined ? {} : { transactionId: state.transactionId }),
  }
  const version = state.targetVersion ?? state.release?.version
  let status: DesktopUpdateStatus
  if (state.phase === 'available' && version !== undefined) {
    status = { kind: 'available', version, ...(state.release?.releaseNotes === undefined ? {} : { releaseNotes: state.release.releaseNotes }), ...progress }
  } else if (state.phase === 'downloading') {
    status = { kind: 'downloading', percent: state.stageProgress, ...(version === undefined ? {} : { version }), ...progress }
  } else if (state.phase === 'ready' && version !== undefined) {
    status = { kind: 'ready', version, ...progress }
  } else if (state.phase === 'completed') {
    status = { kind: 'completed', version: version ?? state.currentVersion, ...progress }
  } else if (state.phase === 'rolled-back') {
    status = { kind: 'rolled-back', ...(version === undefined ? {} : { version }), message: state.detail, ...progress }
  } else if (state.phase === 'incompatible') {
    status = { kind: 'incompatible', ...(version === undefined ? {} : { version }), message: state.detail, ...progress }
  } else if (state.phase === 'error') {
    status = { kind: 'error', message: state.detail, ...progress }
  } else if (state.phase === 'verifying' || state.phase === 'building' || state.phase === 'deploying' || state.phase === 'validating') {
    status = { kind: state.phase, ...(version === undefined ? {} : { version }), ...progress }
  } else if (state.phase === 'idle' || state.phase === 'checking' || state.phase === 'none') {
    status = { kind: state.phase, ...progress }
  } else {
    status = { kind: 'error', message: '桌面更新状态缺少目标版本，已安全停止。', ...progress }
  }
  setDesktopUpdateStatus(status)
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

/** 手动触发的更新周期（设置页按钮、插件「关于」页请求）。同一时刻只跑一个周期，
 * 返回正在运行的周期以便调用方等待；已有周期在跑时返回 undefined。 */
function startHarnessUpdateTask(interactive: boolean): Promise<void> | undefined {
  const context = harnessUpdaterContext
  if (context === undefined || harnessUpdateTask !== undefined) return harnessUpdateTask
  if (harnessUpdateTimer !== undefined) clearTimeout(harnessUpdateTimer)
  harnessUpdateTimer = undefined
  const task = runHarnessUpdateCycle(context, interactive)
  harnessUpdateTask = task
  broadcastHarnessUpdateState()
  void task.finally(() => {
    harnessUpdateTask = undefined
    broadcastHarnessUpdateState()
    if (!isQuitting && harnessUpdatePolicy.mode !== 'manual') scheduleHarnessUpdateCheck(harnessUpdatePolicy.checkIntervalHours * 60 * 60_000)
  }).catch(() => undefined)
  return task
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
    // 同一版本反复「构建 → 切换 → 回滚 → 重启」会把界面变成失败循环，这里按版本退避；
    // 用户手动触发的检查（interactive）永远放行，让他们自己决定要不要再试一次。
    const retryGate = evaluateDeploymentRetryGate({
      version: candidate.version,
      failures: harnessUpdateState?.deploymentFailures,
      policy: harnessUpdatePolicy,
    })
    if (!interactive && !retryGate.allowed) {
      const detail = retryGate.reason ?? '该版本自动升级已暂停。'
      await setHarnessUpdateState(context, 'blocked', {
        lastCheckedAt: checked.checkedAt,
        targetVersion: candidate.version,
        detail,
      })
      await appendHarnessUpdateEvent(context.updateRoot, {
        transactionId: checkTransactionId,
        phase: 'retry-gate',
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
    await setHarnessUpdateState(context, 'failed', {
      transactionId,
      targetVersion: release.version,
      detail,
      deploymentFailures: recordDeploymentFailure(harnessUpdateState, release.version, detail, new Date().toISOString()),
    }).catch(() => undefined)
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
    await setHarnessUpdateState(context, 'succeeded', {
      transactionId,
      targetVersion: candidate.version,
      lastSucceededAt: completedAt,
      detail: 'readiness 与在线观察均通过，A/B 指针已提交。',
      deploymentFailures: clearDeploymentFailure(harnessUpdateState, candidate.version),
    })
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
    await setHarnessUpdateState(context, 'rolled-back', {
      transactionId,
      targetVersion: candidate.version,
      detail: `候选失败，已自动恢复上一运行时：${detail}`,
      deploymentFailures: recordDeploymentFailure(harnessUpdateState, candidate.version, detail, new Date().toISOString()),
    })
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
  const rasterPath = resolveTrayIconPath({
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
  if (['checking', 'downloading', 'verifying', 'building', 'deploying', 'validating'].includes(updateStatus.kind)) return
  if (portableDesktopUpdater === undefined) {
    if (interaction === 'interactive') {
      await dialog.showMessageBox({
        type: 'info',
        title: DESKTOP_APP_NAME,
        message: desktopText('桌面端 A/B 更新仅在 Windows x64 便携版中启用。', 'Desktop A/B updates are available in the Windows x64 portable build.'),
      })
    }
    return
  }
  try {
    const checked = await portableDesktopUpdater.check()
    if (checked.phase === 'error') {
      if (interaction === 'interactive') await dialog.showMessageBox({ type: 'error', title: DESKTOP_APP_NAME, message: checked.detail })
      return
    }
    if (checked.phase === 'none') {
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
    if (checked.phase !== 'available' || checked.release === undefined) return
    const available: Extract<DesktopUpdateStatus, { kind: 'available' }> = {
      kind: 'available',
      version: checked.release.version,
      ...(checked.release.releaseNotes === undefined ? {} : { releaseNotes: checked.release.releaseNotes }),
    }
    if (interaction === 'background') {
      if (shouldDownloadUpdateAutomatically(updatePreferences)) await downloadDesktopUpdate('background')
      else showDesktopUpdateNotification('available', checked.release.version)
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
    setDesktopUpdateStatus(preserveDesktopUpdateFailure(updateStatus, message), true)
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
  if (updateStatus.kind !== 'available' || portableDesktopUpdater === undefined) return
  const version = updateStatus.version
  try {
    const prepared = await portableDesktopUpdater.prepare()
    if (prepared.phase === 'error') {
      if (interaction === 'interactive') await dialog.showMessageBox({ type: 'error', title: DESKTOP_APP_NAME, message: prepared.detail })
      return
    }
    if (prepared.phase !== 'ready') return
    const ready = { kind: 'ready' as const, version }
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
    setDesktopUpdateStatus(preserveDesktopUpdateFailure(updateStatus, message))
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
      ? desktopText(`桌面端 ${version} 已完成构建验证，点击选择部署时间。`, `Desktop ${version} passed build validation. Click to choose when to deploy.`)
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
  if (portableDesktopUpdater === undefined || portablePaths === undefined || updateStatus.kind !== 'ready') return
  const staged = await portableDesktopUpdater.stageActivation()
  if (staged.phase === 'error') throw new Error(staged.detail)
  await spawnPortableLauncherForRestart()
  await shutdownDesktop(() => { app.exit(0) })
}

function showMainWindow(): void {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
