import { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, protocol, safeStorage, screen, session, shell, webContents, type Input, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { writeFile as writeTextFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { embeddedDesktopSettingsDocument, mayUseEmbeddedDesktopSettings, parseDesktopSettingsRequest } from './embedded-desktop-settings.js'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DESKTOP_APP_NAME, DESKTOP_APP_USER_MODEL_ID, DESKTOP_TOAST_ACTIVATOR_CLSID, resolveDesktopRuntimeDir, resolveDesktopUserDataDir } from './app-identity.js'
import { OFFICIAL_DSH_VERSION } from './bundled-plugins.js'
import { resolveAppIconPath, resolveCompactIconCrop, resolveNotificationIconPath, resolveRasterIconPath, resolveTaskBadgeIconPath, resolveTaskbarIconPath, resolveTrayIconPath, TRAY_ICON_SIZE } from './app-icon.js'
import { isLoopbackFaviconRequest } from './window-icon.js'
import { bindContainedSettingsWindow, centeredSettingsBounds } from './contained-settings-window.js'
import { writeTextFileAtomicSync } from './atomic-file.js'
import { sweepOrphanDshProcesses } from './orphan-sweep.js'
import { quitDesktopApp, shouldHideInsteadOfClose } from './app-lifecycle.js'
import type { DshServer, StartDshOptions } from './dsh-process.js'
import { isExternalHttpUrl, isExternalOpenUrl, isSameOrigin } from './navigation.js'
import { applyPendingProfileUpdates, isOfficialRuntimeLaunchable, resolvePnpmStoreDir, seedBundledPlugins, resolveWebProfileDir } from './plugin-seed.js'
import { preserveMcpRefreshPatch } from './mcp-scope-refresh.js'
import { parseUnresolvedBundleError, startWithProfileSelfRepair } from './profile-repair.js'
import { quarantineProfileBundle } from './profile-quarantine.js'
import { normalizePnpmNodeEntry, resolveBundledPluginStore, resolvePluginBinDir, resolvePnpmNodeEntry } from './plugin-toolchain.js'
import { resolveDshBootstrap, resolveDshRuntime, resolveNodeExecutable } from './runtime.js'
import { extractPackagedRuntimesInChild, packagedRuntimesNeedExtraction, preparePackagedRuntimeCacheInChild, resolvePackagedRuntimeCache, type RuntimeExtractionProgress } from './extract-runtime.js'
import { advanceStartupProgress, formatStartupProgress, STARTUP_PROGRESS, type StartupProgress } from './startup-progress.js'
import { resolvePrebuiltOfficialRuntime } from './runtime-prebuilt.js'
import { activateRuntimeSlot, commitRuntimeSlot, readRuntimeSlotPointer, recoverInterruptedRuntimeSwitch, resolveActiveRuntimeDir, rollbackRuntimeSlot, runtimeSlotVersion } from './runtime-slots.js'
import { buildHarnessRuntimeCandidate, type HarnessRuntimeCandidate } from './harness-runtime-candidate.js'
import { fetchHarnessPrebuiltRelease } from './harness-release-catalog.js'
import { prepareHarnessPrebuiltCandidate } from './harness-prebuilt-update.js'
import { prepareHarnessHome } from './harness-home-preparation.js'
import { ComponentUpdateSafety, harnessActivationSafety } from './component-update-safety.js'
import { assertCustomizationPreserved, captureCustomizationState, checkPreservationManifest, readPreservationManifest, type CustomizationSnapshot, type PreservationManifest } from './customization-preservation.js'
import { validateHarnessShadowStart } from './harness-shadow.js'
import { DEFAULT_HARNESS_UPDATE_POLICY, acquireHarnessUpdateLock, appendHarnessUpdateEvent, checkHarnessUpdate, clearDeploymentFailure, evaluateDeploymentRetryGate, harnessUpdatePolicyPath, harnessUpdateRoot, harnessUpdateStatePath, loadHarnessUpdatePolicy, loadHarnessUpdateState, recordDeploymentFailure, saveHarnessUpdatePolicy, saveHarnessUpdateState, type HarnessReleaseCandidate, type HarnessUpdatePolicy, type HarnessUpdateState } from './harness-update.js'
import { applyInitialWindowState } from './window-state.js'
import { WindowNavigationCoordinator } from './window-navigation.js'
import { escapeRoute } from './escape-routing.js'
import { installDesktopBridge, resolveDesktopBridgeDir } from './desktop-host.js'
import { isChineseLocale, localizedShellActions, localizedShellMenus, normalizeShellLocale, shellActionForShortcut, SHELL_ACTION_IDS, type ShellActionId, type ShellMenuId } from './shell-actions.js'
import { SHELL_BAR_HEIGHT, SHELL_IPC, type BrowserDownloadState, type BrowserPageSnapshot, type BrowserPanelBounds, type BrowserPanelSnapshot, type BrowserShellState, type BrowserTabState, type DshNavigationState, type DshShellActionId, type ShellBootstrap, type ShellMenuPopupRequest, type ShellState } from './shell-contract.js'
import { mayAccessDesktopUpdates, mayAccessNotificationPreferences, mayAccessThemePreferences, mayCloseDesktopSettings, mayGetShellBootstrap, mayInvokeBrowserIpc, mayInvokeFeaturePanelsCopy, mayInvokeShellAction, mayManageBrowserPanel, mayPopupShellMenu, mayReportDshLocale, mayReportDshNotification, mayReportDshState, mayReportDshTheme, mayReportDshSettingsVisibility, type ShellRendererKind } from './shell-ipc-policy.js'
import { FEATURE_PANEL_CATEGORIES, FEATURE_PANELS } from './feature-panels.js'
import { browserPanelMaxWidthCss, capBrowserWorkspacePanelWidth, normalizeBrowserPanelBounds, resolveBrowserDownloadsDrawerHeight, resolveBrowserPageTop, shouldHideBrowserPanel, shouldShowPageTabBar } from './browser-panel-layout.js'
import { isPanelRawVisible, parseActiveSessionSignal, parsePanelCardSignal, shouldAcceptPageToken, type PanelCardState } from './browser-panel-state.js'
import { normalizeNativeBrowserRequest } from './native-browser-request.js'
import { clearStaleDshAuthCookies } from './dsh-session-cookies.js'
import { classifyEmbeddedBrowserGuest, EMBEDDED_BROWSER_CHROME_PARTITION, EMBEDDED_BROWSER_PAGE_PARTITION } from './embedded-browser-guest.js'
import { normalizeSavedBrowserSessions, normalizeSavedBrowserTabs, type SavedBrowserSession } from './browser-workspace-sessions.js'
import { DEFAULT_DESKTOP_THEME_PREFERENCES, DESKTOP_THEME_PALETTES, loadDesktopThemePreferences, normalizeDesktopThemeSnapshot, saveDesktopThemePreferences, type DesktopColorScheme, type DesktopThemePreference, type DesktopThemePreferences } from './desktop-theme.js'
import { DSH_MARKET_STATUS_PATH, isDshMarketOperationBusy, waitForDshMarketBatchToSettle } from './dshmarket-batch.js'
import { DEFAULT_NOTIFICATION_PREFERENCES, buildWindowsReplyToastXml, loadNotificationPreferences, parseDesktopNotificationBridgeEvent, parseWindowsNotificationReplyActivation, saveNotificationPreferences, shouldShowDesktopNotification, windowsNotificationReplyArguments, type DesktopNotificationEvent, type DesktopNotificationPreferences } from './desktop-notifications.js'
import { watchProfileActivation } from './profile-watch.js'
import { parseForwardedInput } from './shell-input.js'
import { repairMisplacedSessionLogs, runSessionPathRepairAtStartup } from './session-path-repair.js'
import { DEFAULT_UPDATE_PREFERENCES, DesktopUpdateChannelGate, STARTUP_UPDATE_CHECK_DELAY_MS, buildDesktopTrayItems, desktopReleaseChannel, desktopUpdateCheckInterval, desktopUpdatePrompt, loadUpdatePreferences, preserveDesktopUpdateFailure, publicDesktopUpdateError, sanitizeUpdatePreferences, saveUpdatePreferences, shouldCheckForUpdatesOnStartup, shouldDownloadUpdateAutomatically, shouldStageUpdateOnExit, type DesktopUpdateAction, type DesktopUpdateChannelTicket, type DesktopUpdatePreferences, type DesktopUpdateSnapshot, type DesktopUpdateStatus } from './desktop-updater.js'
import { PortableDesktopUpdater, resolvePortableReleaseSource, PORTABLE_RELEASE_SOURCE_OVERRIDE_PATH, type PortableDesktopUpdateState } from './portable-desktop-update.js'
import { applyPortableEnvironment, ensurePortableDirectories, resolveActivePortablePaths } from './portable-paths.js'

const portablePaths = resolveActivePortablePaths(process.env.DSH_PORTABLE_ROOT)
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
let browserPanelGuest: WebContents | undefined
const embeddedBrowserGuestIds = new Set<number>()
let shortcutsWindow: BrowserWindow | undefined
let aboutWindow: BrowserWindow | undefined
let featurePanelsWindow: BrowserWindow | undefined
let settingsWindow: BrowserWindow | undefined
let server: DshServer | undefined
let tray: Tray | undefined
let isQuitting = false
let isRecycling = false
const componentUpdateSafety = new ComponentUpdateSafety()
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
const desktopUpdateChannelGate = new DesktopUpdateChannelGate()
let desktopUpdatePreferencesSaving = false
let desktopCandidateMutationPending = false
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
/** 用户**显式**要求看浏览器（点 DSH 页面里的链接、或插件调用 browserPanelShow）时置真：
 *  此时压过"设置页让位"，否则设置页里那些插件链接点开只会落进一个被抑制的面板 = 看起来"进不去浏览器"
 *  （2026-09-15 实机回归）。每次设置页可见性变化时清零，恢复"被动让位"语义。 */
let browserPanelRequested = false
let activeDshWorkCount = 0
let activeDshWorkChangedAt = Date.now()
let mainWindowContentSuppressed = false
let mainWindowLayoutDeferred = false
// 白名单必须来自 SHELL_ACTION_IDS 而不是菜单表：菜单去重会把条目移出菜单，
// 但顶栏按钮 / 设置窗口 / 关于窗口仍按 id 直接分发（2026-09-29 顶栏「设置」静默失灵真因）。
const shellActionIds = SHELL_ACTION_IDS

interface HarnessUpdaterContext {
  readonly appPath: string
  readonly bootstrapPath: string
  readonly isPackaged: boolean
  readonly legacyRuntimeDir: string
  readonly nodeExecutable: string
  readonly nodeVersion: string
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
// Browser chrome and pages are owned by the right-card DOM. The old
// pixel-positioned browser WebContentsViews must not be recreated.

interface BrowserTab {
  readonly id: string
  title: string
  url: string
  favicon: string
  crashed: boolean
  lastRecordedUrl?: string
  guest?: WebContents
}

function browserTabContents(tab: BrowserTab | null | undefined): WebContents | undefined {
  const contents = tab?.guest
  return contents === undefined || contents.isDestroyed() ? undefined : contents
}

function browserChromeContents(): WebContents | undefined {
  const contents = browserPanelGuest
  return contents === undefined || contents.isDestroyed() ? undefined : contents
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
  activeSessionName?: string | null
  sessions?: Record<string, SavedBrowserSession>
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
/** 上一次下发给页面的面板宽度上限（CSS px）；`-1` 表示本文档尚未下发（导航后需重发）。 */
let browserPanelMaxCss = -1
/** publishLayoutContext 的去重键：宽度/高度/缩放/让位状态全同则不下发。 */
let layoutContextKey = ''
/** 上一次算出的面板宽度（DIP），用于导航后按同一把尺子重新下发。 */
let browserPanelWidthDip = 0
let browserPanelOwner: string | undefined
/**
 * 浏览器面板的**生命周期信号**（2026-09-21 P0 修复，见
 * docs/01-当前工作/20260921-移除原生浏览器面板并移植到完整浏览器-方案.md §12）。
 *
 * 病根：原生面板由主进程持有，而拥有它的卡片在页面里、按会话存在；两边各自维护"可见性"且没有握手，
 * 于是 切会话 / 页面重载 / 收起侧栏 / 卡片卸载 任一条路径失配，外壳就继续画面板底（白/幽灵面板）。
 * 不变式：**没有当前页面"卡片可见"的心跳，原生面板绝不允许可见**——判定全部收归主进程。
 */
let browserPanelSignalAt = 0
let browserPanelCardState: PanelCardState | undefined
/** 最近一次 raw bounds 是否与视口有足够交集（**clamp 之前**判定；clamp 会抹掉"飞出屏幕"的证据）。 */
let browserPanelRawVisible = false
/**
 * 按会话分桶的原生标签（补丁 2）：`browserTabs` 始终是**当前会话**那一桶。
 * 官方右栏状态本来就按会话存（`dsh-sidebar:v1:session-<id>`），页面把活动会话 id 放进心跳上报。
 */
const browserTabsBySession = new Map<string, BrowserTab[]>()
const browserActiveTabBySession = new Map<string, string | null>()
let browserSessionName: string | undefined
/**
 * 页面实例令牌（补丁 1）：导航/重载后清空，由新页面实例的第一条 claim 建立；
 * 之后不一致的 claim（僵尸 renderer 的迟到 IPC）一律拒绝。
 */
let browserPanelPageToken: string | undefined
/**
 * 调用方所属会话（2026-09-21 用户令「别的会话不要自动给我开面板」）。
 * 只有与当前活动会话一致时才允许把面板显示出来；别的会话的打开请求降级为"开个后台标签"，不弹面板。
 */
let browserPanelSessionId: string | undefined
/** bounds 的**独立**新鲜度（Codex 第三轮 P0 漏洞）：心跳新鲜 ≠ bounds 新鲜，两者必须各自计时。 */
let browserPanelBoundsAt = 0
/** 是否已挂上 dsh 视图的生命周期钩子（补丁 1，只需一次）。 */
let dshLifecycleHooked = false
let browserWidthRatio = BROWSER_DEFAULT_WIDTH_RATIO
let browserMaximized = false
let browserManagerOpen = false
let browserMenuOpen = false
let browserDownloadsOpen = false
let browserDownloadsDrawerHeight = 0
let browserPageZoom = 1
let browserWorkspaceSaveTimer: NodeJS.Timeout | undefined
let browserWorkspaceRestored = false
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
  const currentTabs = browserTabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url }))
  const allSessions = new Map(browserTabsBySession)
  if (browserSessionName !== undefined) allSessions.set(browserSessionName, [...browserTabs])
  const sessions: Record<string, SavedBrowserSession> = Object.create(null) as Record<string, SavedBrowserSession>
  for (const [sessionId, tabs] of allSessions) {
    sessions[sessionId] = {
      activeTabId: sessionId === browserSessionName ? activeBrowserTabId : browserActiveTabBySession.get(sessionId) ?? tabs[0]?.id ?? null,
      tabs: tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url })),
    }
  }
  const state: BrowserWorkspaceFile = {
    version: 1,
    browserVisible,
    browserWidthRatio,
    browserMaximized,
    activeTabId: activeBrowserTabId,
    tabs: currentTabs,
    activeSessionName: browserSessionName ?? null,
    sessions,
  }
  try {
    const target = browserWorkspacePath()
    mkdirSync(dirname(target), { recursive: true })
    // 2026-09-21：改走统一的原子写 helper（同步 + 瞬时占用重试），不再手搓 write+rename。
    // 原先裸 renameSync 在 Windows 撞杀软/索引器短暂持有时会 EPERM，被 catch 吞成一行日志 = 静默丢工作区。
    writeTextFileAtomicSync(target, `${JSON.stringify(state, null, 2)}\n`)
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
  const contents = browserTabContents(tab)
  if (contents === undefined) return
  tab.url = contents.getURL() || tab.url
  tab.title = contents.getTitle() || tab.title || '新标签页'
  tab.crashed = false
  if (persist) scheduleBrowserWorkspaceSave()
  broadcastShellState()
}

function bindBrowserTabContents(tab: BrowserTab, contents: WebContents): void {
  applyBrowserPageZoom(contents)
  contents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (isAllowedBrowserUrl(popupUrl)) queueMicrotask(() => { openBrowser(popupUrl, true) })
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedBrowserUrl(targetUrl)) event.preventDefault()
  })
  contents.on('did-start-loading', () => updateBrowserTabFromContents(tab))
  contents.on('did-stop-loading', () => {
    updateBrowserTabFromContents(tab)
    if (tab.url !== '' && tab.lastRecordedUrl !== tab.url) {
      tab.lastRecordedUrl = tab.url
      queueBrowserHistory(tab.url, tab.title, tab.favicon)
    }
  })
  contents.on('did-navigate', () => updateBrowserTabFromContents(tab, true))
  contents.on('did-navigate-in-page', () => updateBrowserTabFromContents(tab, true))
  contents.on('did-fail-load', (_event, _code, _description, failedUrl, isMainFrame) => {
    if (!isMainFrame || !isAllowedBrowserUrl(failedUrl)) return
    tab.url = failedUrl
    tab.title = failedUrl
    scheduleBrowserWorkspaceSave()
    broadcastShellState()
  })
  contents.on('page-title-updated', (_event, title) => {
    tab.title = String(title || '新标签页').trim()
    updateBrowserTabFromContents(tab, true)
  })
  contents.on('page-favicon-updated', (_event, favicons) => {
    tab.favicon = favicons.find(favicon => /^https?:\/\//i.test(favicon)) || ''
    broadcastShellState()
  })
  contents.on('found-in-page', (_event, result) => {
    browserChromeContents()?.send(SHELL_IPC.browserFindResult, result)
  })
  contents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []
    if (params.selectionText !== '') template.push({ role: 'copy', label: desktopText('复制', 'Copy') })
    if (params.isEditable) template.push({ role: 'paste', label: desktopText('粘贴', 'Paste') })
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: mainWindow })
  })
  contents.on('render-process-gone', (_event, details) => {
    tab.crashed = true
    console.error(`浏览器标签渲染进程停止 ${tab.url} ${JSON.stringify(details)}`)
    broadcastShellState()
  })
  installShortcutHandler(contents)
}

function createBrowserTab(url: string = primaryBrowserHomepage(), requestedId?: string): BrowserTab {
  if (browserTabs.length >= BROWSER_MAXIMUM_TABS) {
    const existing = getActiveBrowserTab() ?? browserTabs[0]
    if (existing !== undefined) {
      const fallbackUrl = isAllowedBrowserUrl(url) ? url : normalizeBrowserAddress(url)
      existing.url = fallbackUrl
      const contents = browserTabContents(existing)
      if (contents !== undefined) void contents.loadURL(fallbackUrl).catch((error: Error) => console.error(`浏览器加载失败：${error.message}`))
      relayout()
    }
    return existing
  }
  const id = requestedId || randomUUID()
  const targetUrl = isAllowedBrowserUrl(url) ? url : normalizeBrowserAddress(url)
  const tab: BrowserTab = { id, title: targetUrl, url: targetUrl, favicon: '', crashed: false }
  browserTabs.push(tab)
  activeBrowserTabId = id
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
  for (const retained of browserTabsBySession.values()) {
    const retainedIndex = retained.findIndex(candidate => candidate.id === id)
    if (retainedIndex >= 0) retained.splice(retainedIndex, 1)
  }
  try {
    if (tab.guest !== undefined && !tab.guest.isDestroyed()) tab.guest.close()
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

/** DSH 设置页的真实可见性判据。
 *
 *  0.2 内核起，设置页是**整页**（`dcu-settings-nav` + `dcu-settings-main`），不再是
 *  `role="dialog"` 弹层，也不再有客户端通过 `dsh-shell:dsh-settings-visibility` 上报
 *  （该通道在 codex-ui 1.1.x + 0.2 下无发送方，`dshSettingsDialogVisible` 恒为 false，
 *  顶栏「设置」因此既开不了也关不掉 —— 2026-09-29 实机取证）。
 *  实测判据：设置页关闭时 `dcu-settings-back` **不在 DOM 里**（count=0），打开时 count=1
 *  且可见 —— 比 `offsetParent` 更硬，不受隐藏容器影响。 */
const DSH_SETTINGS_BACK_SELECTOR = '.dcu-settings-back, [class*="settings-back"]'
const DSH_SETTINGS_TRIGGER_SELECTOR = '.dcu-settings-trigger'

/** 只读判据：设置页当前是否打开。 */
const DSH_SETTINGS_OPEN_SCRIPT = `document.querySelectorAll(${JSON.stringify(DSH_SETTINGS_BACK_SELECTOR)}).length > 0`

/** 读设置页状态并按需切换：开着就点「返回应用」关掉，没开就点侧栏的设置触发器打开。
 *  返回 `'closed' | 'opened' | 'unavailable'`，供调用方同步标志位。
 *  注意是 `opened`（带 d）不是 `open` —— 调用方曾写成 `'open'`，而本脚本从不返回该值，
 *  标志位在打开后恒为false（2026-09-30 实机复核顶栏开关时发现）。 */
const TOGGLE_DSH_SETTINGS_PAGE_SCRIPT = `(() => {
  const back = document.querySelector(${JSON.stringify(DSH_SETTINGS_BACK_SELECTOR)})
  if (back !== null) { back.click(); return 'closed' }
  const trigger = document.querySelector(${JSON.stringify(DSH_SETTINGS_TRIGGER_SELECTOR)})
  if (trigger !== null) { trigger.click(); return 'opened' }
  return 'unavailable'
})()`

/** 用户从设置页点链接要看浏览器时，先让 DSH 页面**退出设置页**（点它自己的"返回应用"），
 *  再显示面板 —— 否则设置页与面板并存互相挤（2026-09-15 实机："你这又回到原来的了"）。
 *  选中失败也不阻断：覆盖标记仍在，面板会以"压过让位"的方式显示。
 *  无条件调用是安全的：设置页没开时 `dcu-settings-back` 根本不在 DOM 里，脚本空转。 */
function exitDshSettingsPage(): void {
  const view = dshView
  if (view === undefined || view.webContents.isDestroyed()) return
  void view.webContents.executeJavaScript(`(() => {
    const back = document.querySelector(${JSON.stringify(DSH_SETTINGS_BACK_SELECTOR)})
    if (back instanceof HTMLElement) { back.click(); return true }
    return false
  })()`).then((exited) => { if (exited === true) dshSettingsDialogVisible = false }).catch(() => undefined)
}

/** 以 DOM 为准读设置页可见性并回写标志位。
 *  标志位是壳内自用的真相源：ESC 路由、浏览器面板让位、relayout 都读它，
 *  而唯一的上报通道已随 0.2 内核消失 —— 不主动校准，它就永久停在 false。 */
async function isDshSettingsPageOpen(): Promise<boolean> {
  const view = dshView
  if (view === undefined || view.webContents.isDestroyed()) return false
  const open = await view.webContents.executeJavaScript(DSH_SETTINGS_OPEN_SCRIPT).catch(() => false)
  dshSettingsDialogVisible = open === true
  return dshSettingsDialogVisible
}

/** DSH 外链统一路由：http/https 进完整版浏览器（新标签页），mailto:/tel: 走系统默认程序。 */
function routeDshExternalLink(url: string): void {
  if (isExternalHttpUrl(url, allowedOrigin)) {
    browserPanelRequested = true
    exitDshSettingsPage()
    queueMicrotask(() => { openBrowser(url, true) })
    return
  }
  if (isExternalOpenUrl(url, allowedOrigin)) runMainTask(shell.openExternal(url))
}

function openBrowser(url?: string, newTab = false): BrowserTab {
  browserPanelRequested = true
  browserVisible = true
  browserManagerOpen = false
  browserMenuOpen = false
  let tab = getActiveBrowserTab()
  if (tab === null || newTab) tab = createBrowserTab(url || primaryBrowserHomepage())
  else if (url) {
    tab.url = normalizeBrowserAddress(url)
    const contents = browserTabContents(tab)
    if (contents !== undefined) void contents.loadURL(tab.url).catch((error: Error) => console.error(`浏览器加载失败：${error.message}`))
  }
  activeBrowserTabId = tab.id
  relayout()
  focusActiveBrowserTab()
  scheduleBrowserWorkspaceSave()
  return tab
}

function focusActiveBrowserTab(): void {
  // 面板可见时把键盘焦点交给页面，用户无需先点一下才能打字（L-3）
  if (!browserVisible) return
  const contents = browserTabContents(getActiveBrowserTab())
  if (contents !== undefined && !contents.isDestroyed()) contents.focus()
}

function createHomepageTabs(): void {
  for (const url of configuredBrowserHomepages()) createBrowserTab(url)
}

function openHomepageGroup(): void {
  // 完整版浏览器：首页组在内置浏览器打开（默认 DeepSeek）。
  browserPanelRequested = true
  exitDshSettingsPage()
  browserVisible = true
  const homepages = configuredBrowserHomepages()
  let firstTab = getActiveBrowserTab()
  if (firstTab === null) {
    firstTab = createBrowserTab(homepages[0])
  } else {
    firstTab.url = homepages[0]
    firstTab.title = homepages[0]
    const contents = browserTabContents(firstTab)
    if (contents !== undefined) void contents.loadURL(homepages[0]).catch(() => undefined)
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
  // Restore the data, not visibility: the card claims its own display lease.
  browserVisible = false
  if (!browserWorkspaceRestored) {
    browserWorkspaceRestored = true
    const saved = loadBrowserWorkspace()
    if (saved !== null) {
      if (typeof saved.browserWidthRatio === 'number' && saved.browserWidthRatio >= 0.2 && saved.browserWidthRatio <= 0.55) {
        browserWidthRatio = saved.browserWidthRatio
      }
      const sessions = normalizeSavedBrowserSessions(saved.sessions)
      browserTabsBySession.clear()
      browserActiveTabBySession.clear()
      for (const [sessionId, bucket] of sessions) {
        browserTabsBySession.set(sessionId, bucket.tabs.map(tab => ({ ...tab, favicon: '', crashed: false })))
        browserActiveTabBySession.set(sessionId, bucket.activeTabId)
      }
      if (browserSessionName === undefined && typeof saved.activeSessionName === 'string' && sessions.has(saved.activeSessionName)) {
        browserSessionName = saved.activeSessionName
      }
      const active = browserSessionName === undefined ? undefined : sessions.get(browserSessionName)
      const restoredTabs = active?.tabs ?? (sessions.size === 0 ? normalizeSavedBrowserTabs(saved.tabs) : [])
      browserTabs.splice(0, browserTabs.length, ...restoredTabs.map(tab => ({ ...tab, favicon: '', crashed: false })))
      const requestedActive = active?.activeTabId ?? (typeof saved.activeTabId === 'string' ? saved.activeTabId : null)
      activeBrowserTabId = browserTabs.some(tab => tab.id === requestedActive) ? requestedActive : browserTabs[0]?.id ?? null
    }
  }
  relayout()
  broadcastShellState()
}

function browserShellState(): BrowserShellState {
  const active = getActiveBrowserTab()
  const contents = browserTabContents(active)
  const library = browserData().publicSnapshot()
  return {
    visible: browserVisible,
    tabs: browserTabs.map((tab): BrowserTabState => ({ id: tab.id, title: tab.title, url: tab.url, favicon: tab.favicon, crashed: tab.crashed })),
    retainedTabIds: [...new Set([...browserTabs.map(tab => tab.id), ...[...browserTabsBySession.values()].flatMap(tabs => tabs.map(tab => tab.id))])],
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
    // 单网页时页面收起标签条（省约 40px）并把"+"搬进导航条；原生视图的垂直偏移由
    // resolveBrowserPageTop 用**同一个判定**计算，页面只认这个布尔值 —— 两侧同源，避免错开 40px。
    pageTabBarVisible: shouldShowPageTabBar(browserTabs.length),
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
  // 清扫上一代残留的孤儿 DSH 服务进程（死占端口会让本代桥接失败、主视图黑屏）。
  // 必须在启动任何 harness/桥接之前执行；失败静默（清扫只是自愈手段，不阻断启动）。
  void sweepOrphanDshProcesses()
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
    const pnpmEntry = pathPrefix === undefined
      ? (process.env.npm_execpath ? normalizePnpmNodeEntry(process.env.npm_execpath) : undefined)
      : resolvePnpmNodeEntry(join(pathPrefix, 'pnpm-package'))
    const profileDir = resolveWebProfileDir()
    const stagedCustomizations = stagedDesktopCustomization(process.env.DSH_DESKTOP_UPDATE_TRANSACTION)
    // 已安装便携家园由用户拥有，不在每次启动重放随桌面包的默认插件矩阵。
    // 普通启动保持健康现役，不因开发工作区在途改动而停掉它。
    // 严格源码/定制快照检查属于候选准备、激活和健康提交边界。
    const preserveInstalledProfile = portablePaths !== undefined && existsSync(join(profileDir, 'package.json'))
    if (stagedCustomizations !== undefined && portablePaths !== undefined) {
      assertCustomizationPreserved(stagedCustomizations, { portableRoot: portablePaths.root, profileDir, manifest: acceptedPreservationManifest() })
    }
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
    const desktopRuntimeDir = usingActiveRuntimeSlot || (preserveInstalledProfile && isOfficialRuntimeLaunchable(activeRuntimeDir))
      ? activeRuntimeDir : packagedOfficialDir ?? activeRuntimeDir
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
      // 桌面候选只升级桌面；不能借激活把已接受的 Profile/插件矩阵改成随包默认值。
      const seeded = preserveInstalledProfile ? { seeded: [] } : await seedBundledPlugins(seedOptions)
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
      const updated = preserveInstalledProfile ? [] : await applyPendingProfileUpdates(seedOptions)
      if (preserveInstalledProfile && existsSync(join(profileDir, '.dsh-pending-updates.json'))) {
        console.warn('已保留现役 Profile；待更新插件尚未独立完成定制/兼容验证，本次启动不自动重装。')
      }
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
    preserveMcpRefreshPatch(profileDir)
    installDesktopBridge(profileDir, resolveDesktopBridgeDir(runtimeOptions))
    const sessionRepairRoot = join(app.getPath('userData'), 'session-path-repair', new Date().toISOString().replaceAll(':', '-'))
    await runSessionPathRepairAtStartup(join(resolve(profileDir, '..', '..'), 'sessions'), sessionRepairRoot, async sessionRepairResult => {
      // 自愈失败只记录、不中断启动（`failures` 非空是正常情况，例如坏会话或目标已存在）。
      if (sessionRepairResult.repairs.length > 0 || sessionRepairResult.failures.length > 0) {
        const failureNote = sessionRepairResult.failures.length === 0
          ? ''
          : `；${sessionRepairResult.failures.length} 个会话未自愈：${sessionRepairResult.failures.slice(0, 3).join(' / ')}`
        await writeTextFile(
          join(app.getPath('userData'), 'session-path-repair.log'),
          `${new Date().toISOString()} 已安全重定位 ${sessionRepairResult.repairs.length} 个会话；原始日志备份位于 ${sessionRepairRoot}${failureNote}\n`,
          'utf8',
        )
      }
    })
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
    const startCandidate = () => startDsh({
      ...startOptions,
      onUnexpectedExit: handleUnexpectedDshExit,
      onIpcMessage: handleDshIpc,
    })
    const started = preserveInstalledProfile
      ? { result: await startCandidate(), repaired: [] }
      : await startWithProfileSelfRepair({
      profileDir,
      extraDirs: [desktopRuntimeDir],
      start: startCandidate,
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
      if (stagedCustomizations === undefined || portablePaths === undefined) throw new Error('候选缺少已暂存的定制保护快照，拒绝健康提交。')
      assertCustomizationPreserved(stagedCustomizations, { portableRoot: portablePaths.root, profileDir, manifest: acceptedPreservationManifest() })
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
        // Electron 自带 Node 不等于执行 Harness 的随包 Node；身份取本应用自己的清单。
        nodeVersion: String((JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { config: { bundledNodeVersion: string } }).config.bundledNodeVersion).replace(/^v/, ''),
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

/**
 * DSH keeps long-lived client requests open during boot. Electron's loadURL()
 * promise can therefore remain pending even after the authenticated document
 * has reached DOM-ready, which would hold the desktop activation lease until
 * it eventually rejects as ERR_FAILED. DOM-ready is the useful boundary for
 * the shell: the main same-origin document exists and can be rendered.
 */
async function loadDshDocument(view: WebContentsView, serverUrl: string): Promise<void> {
  const domReady = new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error('DSH 主文档 DOM 就绪超时。'))
    }, 120_000)
    const cleanup = (): void => {
      clearTimeout(timeout)
      view.webContents.removeListener('dom-ready', onDomReady)
      view.webContents.removeListener('did-fail-load', onFail)
    }
    const onDomReady = (): void => {
      const currentUrl = view.webContents.getURL()
      if (!isSameOrigin(currentUrl, allowedOrigin)) return
      cleanup()
      resolvePromise()
    }
    const onFail = (_event: Electron.Event, code: number, description: string, failedUrl: string, isMainFrame: boolean): void => {
      if (!isMainFrame || !isSameOrigin(failedUrl, allowedOrigin)) return
      cleanup()
      rejectPromise(new Error(`${description} (${code}) loading '${failedUrl}'`))
    }
    view.webContents.on('dom-ready', onDomReady)
    view.webContents.on('did-fail-load', onFail)
  })
  const load = view.webContents.loadURL(serverUrl).then(
    () => ({ kind: 'loaded' as const }),
    error => ({ kind: 'failed' as const, error }),
  )
  const outcome = await Promise.race([
    load,
    domReady.then(() => ({ kind: 'dom-ready' as const })),
  ])
  if (outcome.kind === 'failed') throw outcome.error
}

async function createMainWindow(serverUrl: string): Promise<void> {
  allowedOrigin = new URL(serverUrl).origin
  mainWindow ??= createWindow()
  configureBrowserSession()
  const view = requireDshView()
  await clearStaleDshAuthCookies(view.webContents.session.cookies, serverUrl)
  await windowNavigation.navigate(view, () => loadDshDocument(view, serverUrl))
  await applyDshDesktopTheme(view)
  // 仅在首次启动（标签页为空）时恢复浏览器工作区；插件热更新回收时保留现有标签页
  if (browserTabs.length === 0) {
    restoreBrowserWorkspace()
  } else {
    relayout()
  }
  // 补丁 1：renderer 生命周期撤销 —— 导航/重载/崩溃/销毁 ⇒ **立即**撤销并作废页面实例令牌。
  // 比心跳 TTL 强：页面重载本身已说明原 renderer 生命周期结束，不必再等最多 4 秒。
  if (!dshLifecycleHooked) {
    dshLifecycleHooked = true
    view.webContents.on('did-navigate', () => onRendererLifecycle('navigate'))
    view.webContents.on('did-finish-load', () => onRendererLifecycle('load'))
    view.webContents.on('render-process-gone', () => onRendererLifecycle('gone'))
    view.webContents.on('destroyed', () => onRendererLifecycle('destroyed'))
    // 卡死但没崩（Codex 第三轮 P1）：别等 4 秒 TTL，立刻撤销
    view.webContents.on('unresponsive', () => onRendererLifecycle('unresponsive'))
    // 窗口最小化/隐藏：主进程自己就知道，不必等页面心跳（同样别留残影）
    mainWindow?.on('minimize', () => onRendererLifecycle('window-minimize'))
    mainWindow?.on('hide', () => onRendererLifecycle('window-hide'))
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


const APP_RESTART_IPC = 'app-restart'

/** 运行时插件（如智能体重启端点）请求外壳优雅重启：兼容字符串与 {type} 两种形态。 */
function isAppRestartIpc(message: unknown): boolean {
  return message === APP_RESTART_IPC
    || (typeof message === 'object' && message !== null && 'type' in message && (message as { type: unknown }).type === APP_RESTART_IPC)
}

function handleDshIpc(message: unknown): void {
  if (isAppRestartIpc(message)) {
    // 与托盘/菜单的「重启应用」同走 requestAppRestart：先调度分离的新实例，
    // 再优雅关停（托盘/服务/配置落盘），绝不硬杀进程。
    runMainTask(requestAppRestart())
    return
  }
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
    preserveMcpRefreshPatch(seedOptions.profileDir)
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
    runMainTask(quarantineProfileBundle(lastSeedOptions.profileDir, missing, message, 'runtime', {
      extraDirs: lastSeedOptions.desktopRuntimeDir === undefined ? [] : [lastSeedOptions.desktopRuntimeDir],
    }).then((removed) => {
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

/** 把面板宽度上限下发给页面（页面用 `--dsh-browser-panel-max-width` 钳住占位卡片）。
 *  目的：页面卡片、外壳 chrome、原生页面视图**共用同一把尺子**（此前页面自带
 *  `100vw - 1040px`、外壳用 `viewport - 900px`，两个数还会差一个缩放因子，
 *  于是右侧露出卡片白底 / 视图压住对话列）。只写一个 CSS 变量，不进页面业务逻辑。 */
function publishBrowserPanelMaxWidth(panelWidthDip: number): void {
  browserPanelWidthDip = panelWidthDip
  if (dshView === undefined || dshView.webContents.isDestroyed()) return
  const css = browserPanelMaxWidthCss(panelWidthDip, dshView.webContents.getZoomFactor())
  if (css <= 0 || css === browserPanelMaxCss) return
  browserPanelMaxCss = css
  void dshView.webContents
    .executeJavaScript(`document.documentElement.style.setProperty('--dsh-browser-panel-max-width', '${css}px')`, true)
    .catch(() => { browserPanelMaxCss = -1 })
}

/** 页面侧**唯一**的布局尺子（2026-09-16 用户要求「全局统一、自适应，不然以后都要一个一个改」）。
 *
 *  此前每个自适应点各自为政：页面 CSS 用 `@media (max-width:1100px)`、外壳用 `shouldHideBrowserPanel()`、
 *  插件用 JS 量到像素再写变量 —— 三把尺子必然漂移（2026-09-14 实机「280px 浏览器 + 右边一片白」即此）。
 *  现在由外壳在**一次 layout 里算一次**，整体下发：
 *  - `--dsh-app-width` / `--dsh-app-height`：DSH 视图可用 CSS px（已按缩放折算）
 *  - `--dsh-app-zoom`：当前网页缩放因子
 *  - `data-dsh-compact`：面板是否让位（= `shouldHideBrowserPanel()` 的唯一判定结果）
 *  页面与插件一律**只读**这些值（CSS 变量 + 属性选择器 / 容器查询），不得再用窗口宽度自行判断。
 *  未变化不下发（沿用 browserPanelMaxCss 的缓存思路，避免每次 resize 都多走一次 IPC）。 */
function publishLayoutContext(widthDip: number, heightDip: number, panelYields: boolean): void {
  if (dshView === undefined || dshView.webContents.isDestroyed()) return
  const zoom = dshView.webContents.getZoomFactor()
  const cssWidth = Math.round(widthDip / zoom)
  const cssHeight = Math.round(heightDip / zoom)
  const compact = panelYields ? '1' : '0'
  const key = `${cssWidth}x${cssHeight}@${zoom}|${compact}`
  if (key === layoutContextKey) return
  layoutContextKey = key
  const script = `(() => {
    const root = document.documentElement
    root.style.setProperty('--dsh-app-width', '${cssWidth}px')
    root.style.setProperty('--dsh-app-height', '${cssHeight}px')
    root.style.setProperty('--dsh-app-zoom', '${zoom}')
    if (root.dataset.dshCompact !== '${compact}') root.dataset.dshCompact = '${compact}'
    window.dispatchEvent(new Event('dsh:layout-context'))
  })()`
  void dshView.webContents.executeJavaScript(script, true).catch(() => { layoutContextKey = '' })
}

/** 网页缩放一变，两个依赖它的东西都要重算：① 下发到页面的 CSS px 宽度上限（同一 DIP 在不同缩放下
 *  对应不同 CSS px）② 窄视口隐藏面板的判定（阈值按 CSS px 比较）。
 *  外壳自己的缩放动作走的是**程序化** `setZoomFactor`，**不会**触发 webContents 的 `zoom-changed`，
 *  所以那条路径必须显式调用本函数（2026-09-14 实机：缩放后白区复现的根因之一）。 */
function syncBrowserPanelForZoom(): void {
  browserPanelMaxCss = -1
  if (browserPanelWidthDip > 0) publishBrowserPanelMaxWidth(browserPanelWidthDip)
  if (mainWindow !== undefined) layoutDshView(mainWindow)
}

/**
 * 撤销浏览器面板：清 owner/bounds；网页 guest 由卡片停放。
 * 会话切换、页面报告卡片不再可见、心跳超时（页面重载/崩溃）都收敛到这里 —— 由主进程单方执行，
 * 页面只提供它能看到的事实（卡片可见性），不反向改主进程状态。
 */
function revokeBrowserPanel(reason: string): void {
  const hadOwner = browserPanelOwner !== undefined
  const hadPanel = hadOwner || browserPanelBounds !== undefined || browserVisible
  browserPanelOwner = undefined
  browserPanelBounds = undefined
  browserPanelRawVisible = false
  browserPanelOccluded = false
  browserManagerOpen = false
  browserMenuOpen = false
  browserDownloadsOpen = false
  // 只有卡片内嵌（曾有 owner）的撤销才关掉工作区可见性。
  // shell 工作区（openBrowser / 外链，无 owner）不因「页面没有浏览器卡片」或 DSH 导航而关闭。
  if (hadOwner && browserVisible) browserVisible = false
  if (!hadPanel) return
  console.log(`[browser-panel] revoke: ${reason}`)
  if (mainWindow !== undefined) relayout()
  scheduleBrowserWorkspaceSave()
}

/**
 * 切换"当前会话"的标签桶（补丁 2：浏览器跟着会话走）。
 * 现场换数组内容而不是换引用 —— 全文件有 150+ 处读 `browserTabs`，原地替换让它们全部继续有效。
 * 标签视图常驻窗口（`addChildView` 只在创建/关闭时发生），所以切换只需改可见性 + 活动标签。
 */
function swapBrowserTabsForSession(nextSession: string | undefined): void {
  const nextName = nextSession === undefined || nextSession === '' ? undefined : nextSession
  if (nextName === browserSessionName) return
  // 🔴 首次收到会话信号（重启后 `browserSessionName` 还是 undefined）时**认领**现有标签，
  //    绝不能清空重建 —— 2026-09-21 实测：首次换桶把恢复出来的标签丢掉，浏览器看着像"打不开"。
  if (browserSessionName === undefined) {
    browserSessionName = nextName
    if (nextName !== undefined) {
      const restored = browserTabsBySession.get(nextName)
      if (restored !== undefined) {
        browserTabs.splice(0, browserTabs.length, ...restored)
        const savedActive = browserActiveTabBySession.get(nextName)
        activeBrowserTabId = browserTabs.some(tab => tab.id === savedActive) ? savedActive ?? null : browserTabs[0]?.id ?? null
      } else if (browserTabs.length > 0) {
        browserTabsBySession.set(nextName, [...browserTabs])
        browserActiveTabBySession.set(nextName, activeBrowserTabId)
      }
    }
    if (mainWindow !== undefined) relayout()
    return
  }
  if (browserSessionName !== undefined) {
    browserTabsBySession.set(browserSessionName, [...browserTabs])
    browserActiveTabBySession.set(browserSessionName, activeBrowserTabId)
  }
  const stash = nextName === undefined ? undefined : browserTabsBySession.get(nextName)
  browserTabs.length = 0
  if (stash !== undefined) browserTabs.push(...stash)
  const savedActive = nextName === undefined ? null : browserActiveTabBySession.get(nextName)
  activeBrowserTabId = browserTabs.some(tab => tab.id === savedActive) ? savedActive ?? null : browserTabs[0]?.id ?? null
  browserSessionName = nextName
  if (mainWindow !== undefined) relayout()
  scheduleBrowserWorkspaceSave()
  console.log(`[browser-panel] session tabs: ${nextName ?? '(default)'} → ${browserTabs.length} 个标签`)
}

/** 活动会话变化：先撤销面板（旧会话的 visible 绝不带进新会话），再换标签桶。 */
function onActiveSessionChanged(nextSession: string | undefined): void {
  if (nextSession === undefined || nextSession === browserSessionName) return
  // 卡片内嵌：切会话必须撤销（旧会话的 visible 绝不带进新会话）。
  // shell 工作区只换标签桶，不关浏览器（否则点开链接后一切会话就没了）。
  if (browserPanelOwner !== undefined) revokeBrowserPanel('session-switch')
  swapBrowserTabsForSession(nextSession)
}

/**
 * renderer 生命周期撤销（补丁 1）：页面导航 / 重载 / renderer 崩溃 / 销毁 ⇒ **立即**撤销并作废页面令牌。
 * 比心跳 TTL 更强：页面重载本身已说明原 renderer 生命周期结束，不必再等几秒判断它是不是死了。
 */
function onRendererLifecycle(reason: string): void {
  browserPanelPageToken = undefined
  browserPanelCardState = undefined
  browserPanelSignalAt = 0
  // 仅卡片内嵌跟着 DSH 页面生命周期撤销；shell 工作区是外壳自己的面板，导航/重载不关它。
  if (browserPanelOwner !== undefined) revokeBrowserPanel(`renderer-${reason}`)
}

function layoutDshView(window: BrowserWindow): void {
  const bounds = window.getContentBounds()
  if (mainWindowContentSuppressed) {
    dshView?.setVisible(false)
    broadcastShellState()
    return
  }
  if (mainWindowLayoutDeferred) {
    // Keep the native hit-test surface aligned throughout maximize/restore animation.
    dshView?.setVisible(true)
    dshView?.setBounds({ x: 0, y: SHELL_BAR_HEIGHT, width: bounds.width, height: Math.max(0, bounds.height - SHELL_BAR_HEIGHT) })
    broadcastShellState()
    return
  }
  const dshHeight = Math.max(0, bounds.height - SHELL_BAR_HEIGHT)
  // 下发**钳后**的上限：变量是页面侧唯一的宽度依据，必须与外壳真正执行的钳制同值
  // （以前下发的是未钳的面板比例宽度 → 等于空操作，页面照旧按自己的上限撑开 → 白带）。
  // A parent layout limit must not depend on its inset browser child width.
  publishBrowserPanelMaxWidth(capBrowserWorkspacePanelWidth(bounds.width, bounds.width))
  // 页面在窄视口会把整块面板隐藏（theme.css 的 @media max-width:1100px：面板先让位、对话独占）。
  // 外壳必须用**同一把尺子**一起收手，否则会出现「一条 280px 的浏览器 + 右边一片白」：
  // 面板已被页面隐藏，原生视图却还在按最小宽度画（2026-09-14 实机截图实证）。阈值按 CSS px 比较。
  const panelHiddenByViewport = shouldHideBrowserPanel(bounds.width, dshView?.webContents.getZoomFactor() ?? 1)
  // 同一把尺子下发页面：宽度/高度/缩放 + 面板让位状态（页面与插件只读，不再各自判断）
  publishLayoutContext(bounds.width, dshHeight, panelHiddenByViewport)
  dshView?.setVisible(true)
  dshView?.setBounds({ x: 0, y: SHELL_BAR_HEIGHT, width: bounds.width, height: dshHeight })
  broadcastShellState()
}

function setMainWindowContentVisible(window: BrowserWindow, visible: boolean): void {
  if (visible) {
    mainWindowContentSuppressed = false
    layoutDshView(window)
    return
  }
  mainWindowContentSuppressed = true
  dshView?.setVisible(false)
}

function installWindowSurfaceGuard(window: BrowserWindow): void {
  // Windows animates the native window while each WebContentsView can still
  // repaint at its old bounds. Hide the child surfaces before minimize,
  // maximize, or restore starts, then relayout them before revealing the
  // settled window. The resize listener is registered here before the normal
  // layout listener so the first maximize/restore frame cannot leak through.
  if (process.platform !== 'win32') return

  let lastMaximized = window.isMaximized()
  let revealTimer: NodeJS.Timeout | undefined
  let transitionGeneration = 0
  let windowOpacitySuppressed = false
  const clearRevealTimer = (): void => {
    if (revealTimer === undefined) return
    clearTimeout(revealTimer)
    revealTimer = undefined
  }
  const hideSurface = (hideWindow = false): void => {
    if (window.isDestroyed()) return
    transitionGeneration += 1
    clearRevealTimer()
    if (hideWindow) {
      window.setOpacity(0)
      windowOpacitySuppressed = true
    }
    setMainWindowContentVisible(window, false)
  }
  const revealSurfaceWhenStable = (delayMs = 180, restoreWindow = false): void => {
    if (window.isDestroyed()) return
    const generation = ++transitionGeneration
    clearRevealTimer()
    const reveal = (): void => {
      if (window.isDestroyed() || generation !== transitionGeneration) return
      if (window.isMinimized()) {
        revealTimer = setTimeout(reveal, 32)
        return
      }
      revealTimer = undefined
      mainWindowLayoutDeferred = false
      setMainWindowContentVisible(window, true)
      if (restoreWindow || windowOpacitySuppressed) {
        window.setOpacity(1)
        windowOpacitySuppressed = false
      }
    }
    revealTimer = setTimeout(reveal, delayMs)
  }
  const beginDisplayModeTransition = (): void => {
    lastMaximized = window.isMaximized()
    // Keep the visible child surfaces during the native maximize/restore
    // animation. Deferring only the bounds calculation avoids the blank or
    // icon-only intermediate frame caused by hiding the whole DSH surface.
    mainWindowLayoutDeferred = true
    revealSurfaceWhenStable()
  }

  window.on('resize', () => {
    const maximized = window.isMaximized()
    if (maximized !== lastMaximized) beginDisplayModeTransition()
  })
  window.on('resized', () => {
    if (window.isMinimized()) return
    if (mainWindowContentSuppressed || mainWindowLayoutDeferred) revealSurfaceWhenStable(32, mainWindowContentSuppressed)
  })
  window.on('minimize', () => {
    hideSurface(true)
  })
  window.on('restore', () => {
    hideSurface(true)
    revealSurfaceWhenStable(32, true)
  })
  window.on('maximize', beginDisplayModeTransition)
  window.on('unmaximize', beginDisplayModeTransition)
  window.once('closed', () => {
    transitionGeneration += 1
    clearRevealTimer()
  })
}

function browserWorkspacePanelBounds(viewportWidth: number, viewportHeight: number): BrowserPanelBounds {
  const reported = normalizeBrowserPanelBounds(browserPanelBounds, viewportWidth, viewportHeight)
  if (reported !== undefined) return reported
  const width = browserMaximized ? viewportWidth : capBrowserWorkspacePanelWidth(viewportWidth, Math.max(280, Math.round(viewportWidth * browserWidthRatio)))
  return { x: Math.max(0, viewportWidth - width), y: 0, width, height: viewportHeight }
}

async function captureBrowserPanelSnapshot(): Promise<BrowserPanelSnapshot | null> {
  const window = mainWindow
  const chrome = browserChromeContents()
  if (window === undefined || chrome === undefined || chrome.isDestroyed() || !browserVisible || browserPanelOccluded) return null
  const content = window.getContentBounds()
  const dshHeight = Math.max(0, content.height - SHELL_BAR_HEIGHT)
  const panel = browserWorkspacePanelBounds(content.width, dshHeight)
  const pageTop = resolveBrowserPageTop(browserTabs.length, BROWSER_TABS_BAR_HEIGHT, BROWSER_NAV_BAR_HEIGHT)
  const drawerHeight = resolveBrowserDownloadsDrawerHeight(browserDownloadsOpen, browserDownloads.length, panel.height)
  const pageHeight = Math.max(0, panel.height - pageTop - drawerHeight)
  const active = browserTabContents(getActiveBrowserTab())
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
  if (!browserVisible || browserPanelOccluded || browserManagerOpen || browserMenuOpen) return null
  let captured: Awaited<ReturnType<typeof captureEmbeddedBrowserPage>> = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Freshly restored guests can report a non-empty but all-white image
    // before Chromium has painted their first frame. Do not freeze that frame
    // behind the overflow menu.
    getActiveBrowserTab()?.guest?.invalidate()
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 100))
    captured = await captureEmbeddedBrowserPage(1)
    if (captured !== null && !isBlankLightBrowserImage(captured.image)) break
    captured = null
  }
  return captured === null ? null : {
    pageDataUrl: captured.image.toDataURL(),
    pageTop: captured.pageTop,
    pageHeight: captured.pageHeight,
  }
}

function isBlankLightBrowserImage(image: Electron.NativeImage): boolean {
  if (image.isEmpty()) return true
  const pixels = image.toBitmap()
  if (pixels.length < 4) return true
  for (let offset = 0; offset + 2 < pixels.length; offset += 64) {
    if (pixels[offset] < 245 || pixels[offset + 1] < 245 || pixels[offset + 2] < 245) return false
  }
  return true
}

async function captureEmbeddedBrowserPage(attempts: number): Promise<{ image: Electron.NativeImage; pageTop: number; pageHeight: number } | null> {
  const host = dshView?.webContents
  if (host === undefined || host.isDestroyed()) return null
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const geometry = await host.executeJavaScript(`(() => {
        const root = document.querySelector('[data-embedded-browser-root]');
        const pages = root?.querySelector('[data-embedded-browser-pages]');
        if (!root || !pages || getComputedStyle(root).visibility !== 'visible' || getComputedStyle(pages).visibility !== 'visible') return null;
        const active = [...pages.children].find(node => node.tagName === 'WEBVIEW' && getComputedStyle(node).visibility === 'visible');
        if (!active) return null;
        const outer = root.getBoundingClientRect();
        const rect = pages.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, pageTop: rect.y - outer.y };
      })()`, true) as { x: number; y: number; width: number; height: number; pageTop: number } | null
      if (geometry !== null && Object.values(geometry).every(Number.isFinite) && geometry.width > 0 && geometry.height > 0) {
        const zoom = host.getZoomFactor()
        const rect = {
          x: Math.max(0, Math.round(geometry.x * zoom)),
          y: Math.max(0, Math.round(geometry.y * zoom)),
          width: Math.max(1, Math.round(geometry.width * zoom)),
          height: Math.max(1, Math.round(geometry.height * zoom)),
        }
        // Capture the actual page guest first. Capturing the host can return a
        // stale/dark compositor surface for a nested webview even while the
        // same page is visibly rendered in the card.
        const guest = getActiveBrowserTab()?.guest
        const image = guest !== undefined && !guest.isDestroyed()
          ? await guest.capturePage()
          : await host.capturePage(rect)
        if (!image.isEmpty()) return { image, pageTop: geometry.pageTop, pageHeight: geometry.height }
      }
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 50))
    }
    return null
  } catch (error) {
    console.warn(`浏览器卡片网页截图失败：${error instanceof Error ? error.message : String(error)}`)
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
    webviewTag: true,
  } })
  dshView = view
  window.contentView.addChildView(view)
  {
    const chromeUrl = pathToFileURL(resolveShellAsset('browser-panel.html')).href
    view.webContents.on('will-attach-webview', (event, preferences, params) => {
      const kind = classifyEmbeddedBrowserGuest(params.src, params.partition, chromeUrl)
      if (kind === 'reject') { event.preventDefault(); return }
      preferences.nodeIntegration = false
      preferences.contextIsolation = true
      preferences.sandbox = true
      preferences.webviewTag = false
      preferences.partition = kind === 'chrome' ? EMBEDDED_BROWSER_CHROME_PARTITION : EMBEDDED_BROWSER_PAGE_PARTITION
      if (kind === 'chrome') preferences.preload = resolvePreload('browser-panel-preload.cjs')
      else delete preferences.preload
    })
    view.webContents.on('did-attach-webview', (_event, guest) => {
      embeddedBrowserGuestIds.add(guest.id)
      guest.on('destroyed', () => {
        embeddedBrowserGuestIds.delete(guest.id)
        if (browserPanelGuest === guest) browserPanelGuest = undefined
        for (const tab of browserTabs) if (tab.guest === guest) tab.guest = undefined
        broadcastShellState()
      })
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
      guest.on('will-navigate', (event, url) => {
        if (guest.session === session.fromPartition(EMBEDDED_BROWSER_PAGE_PARTITION) && !isAllowedBrowserUrl(url)) event.preventDefault()
        if (guest.session === session.fromPartition(EMBEDDED_BROWSER_CHROME_PARTITION) && url !== chromeUrl) event.preventDefault()
      })
      if (guest.session === session.fromPartition(EMBEDDED_BROWSER_CHROME_PARTITION)) {
        browserPanelGuest = guest
        guest.on('dom-ready', () => {
          guest.send(SHELL_IPC.bootstrap, shellBootstrap(currentShellState()))
          guest.send(SHELL_IPC.state, currentShellState())
        })
        installShortcutHandler(guest)
      }
    })
  }
  installWindowSurfaceGuard(window)
  layoutDshView(window)
  window.on('resize', () => layoutDshView(window))
  window.on('maximize', () => layoutDshView(window))
  window.on('unmaximize', () => layoutDshView(window))
  runMainTask(window.loadFile(resolveShellAsset('shell.html'), { query: desktopThemeQuery() }))

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
    // 布局尺子必须跟着文档走：每次（重）加载都是全新 document，之前下发的
    // `--dsh-app-*` / `data-dsh-compact` 随旧文档一起消失；而外壳只在 layout 事件里下发，
    // 首帧又早于页面就绪 ⇒ 不在这里补一次，页面永远拿不到尺子（2026-09-16 实测量到空值）。
    layoutContextKey = ''
    if (mainWindow !== undefined) layoutDshView(mainWindow)
  })
  view.webContents.on('will-navigate', (event, url) => {
    // `WindowNavigationCoordinator` marks a controlled `loadURL()` as active
    // before Electron emits `will-navigate`. Let the coordinator own that
    // navigation; otherwise Electron can self-cancel the startup load as
    // ERR_FAILED before the origin check is even useful.
    if (windowNavigation.isNavigating()) return
    if (isSameOrigin(url, allowedOrigin)) return
    event.preventDefault()
    routeDshExternalLink(url)
  })
  view.webContents.on('will-redirect', (event, url) => {
    if (windowNavigation.isNavigating()) return
    if (isSameOrigin(url, allowedOrigin)) return
    event.preventDefault()
    routeDshExternalLink(url)
  })
  // 键盘/默认加速键等非外壳菜单路径的缩放：仍由事件兜一层，效果与菜单动作一致。
  view.webContents.on('zoom-changed', () => syncBrowserPanelForZoom())
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
      browserPanelGuest = undefined
      embeddedBrowserGuestIds.clear()
      mainWindowContentSuppressed = false
      mainWindowLayoutDeferred = false
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
  browserChromeContents()?.send(SHELL_IPC.bootstrap, shellBootstrap(state))
  if (dshView !== undefined && !dshView.webContents.isDestroyed()) dshView.webContents.send(SHELL_IPC.bootstrap, bootstrap)
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
      // 导航后 DOM 重置（insertCSS 也会失效重插），CSS 变量随之丢失 → 按同一把尺子重发一次。
      browserPanelMaxCss = -1
      if (view === dshView && browserPanelWidthDip > 0) publishBrowserPanelMaxWidth(browserPanelWidthDip)
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
  browserChromeContents()?.send(SHELL_IPC.state, state)
  if (dshView !== undefined && !dshView.webContents.isDestroyed()) {
    dshView.webContents.send(SHELL_IPC.browserEmbeddedState, state.browser)
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
  if (dshView !== undefined && !dshView.webContents.isDestroyed()) dshView.webContents.send(SHELL_IPC.desktopUpdateState, snapshot)
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
  if (dshView !== undefined && !dshView.webContents.isDestroyed()) dshView.webContents.send(SHELL_IPC.harnessUpdateState, harnessUpdateSnapshot())
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
  ipcMain.removeAllListeners(SHELL_IPC.forwardInput)
  ipcMain.on(SHELL_IPC.forwardInput, (event, payload: unknown) => {
    const window = mainWindow
    const view = dshView
    if (!window || window.isDestroyed() || !window.isFocused() || window.isMinimized()
      || mainWindowContentSuppressed || !view || view.webContents.isDestroyed()) return
    if (shellRendererKind(event.sender) !== 'main' || event.senderFrame !== event.sender.mainFrame) return
    const bounds = view.getBounds()
    const input = parseForwardedInput(payload, bounds.width, bounds.height)
    if (!input) return
    // Focus only for explicit input, never from resize/layout (would steal browser/settings focus).
    if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'char') view.webContents.focus()
    view.webContents.sendInputEvent(input)
  })
  ipcMain.removeHandler(SHELL_IPC.browserEmbeddedConfig)
  ipcMain.removeHandler(SHELL_IPC.browserEmbeddedGuestAttached)
  ipcMain.handle(SHELL_IPC.browserEmbeddedConfig, event => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) return { enabled: false }
    return {
      enabled: true,
      chromeUrl: pathToFileURL(resolveShellAsset('browser-panel.html')).href,
      chromePartition: EMBEDDED_BROWSER_CHROME_PARTITION,
      pagePartition: EMBEDDED_BROWSER_PAGE_PARTITION,
      browser: browserShellState(),
    }
  })
  ipcMain.handle(SHELL_IPC.browserEmbeddedGuestAttached, (event, tabId: unknown, guestId: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) return false
    if (typeof tabId !== 'string' || typeof guestId !== 'number' || !Number.isSafeInteger(guestId)) return false
    const tab = browserTabs.find(candidate => candidate.id === tabId)
    const guest = embeddedBrowserGuestIds.has(guestId) ? webContents.fromId(guestId) : undefined
    if (tab === undefined || guest === undefined || guest.isDestroyed() || guest.session !== session.fromPartition(BROWSER_PARTITION)) return false
    if (tab.guest === guest) return true
    if (tab.guest !== undefined || browserTabs.some(candidate => candidate !== tab && candidate.guest === guest)) return false
    tab.guest = guest
    bindBrowserTabContents(tab, guest)
    if (guest.getURL() !== tab.url) void guest.loadURL(tab.url).catch(error => console.error(`浏览器加载失败：${error.message}`))
    else updateBrowserTabFromContents(tab)
    broadcastShellState()
    return true
  })
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
  // One handler implementation for the standalone fallback and the embedded page.
  const settingsHandlers = new Map<string, (value: unknown) => unknown>()
  const registerSettings = (method: keyof typeof SHELL_IPC, permission: (kind: ShellRendererKind) => boolean, handler: (value: unknown) => unknown): void => {
    settingsHandlers.set(method, handler)
    ipcMain.handle(SHELL_IPC[method], (event, value: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame || !permission(shellRendererKind(event.sender))) return
      return handler(value)
    })
  }
  settingsHandlers.set('getBootstrap', () => {
    const state = currentShellState()
    return shellBootstrap({ ...state, browser: { ...state.browser, visible: false } })
  })
  const embeddedSenderAllowed = (event: Electron.IpcMainInvokeEvent): boolean => mayUseEmbeddedDesktopSettings(
    shellRendererKind(event.sender), event.senderFrame === event.sender.mainFrame, event.senderFrame?.url ?? '', allowedOrigin,
  )
  ipcMain.removeHandler(SHELL_IPC.embeddedSettingsDocument)
  ipcMain.handle(SHELL_IPC.embeddedSettingsDocument, event => {
    if (!embeddedSenderAllowed(event)) throw new Error('Desktop settings sender rejected')
    return embeddedDesktopSettingsDocument(
      readFileSync(resolveShellAsset('settings.html'), 'utf8'), readFileSync(resolveShellAsset('theme.css'), 'utf8'),
      readFileSync(join(dirname(resolveShellAsset('settings.html')), 'theme.js'), 'utf8'),
      readFileSync(join(dirname(resolveShellAsset('settings.html')), 'shell-icons', 'chevron-down.svg'), 'utf8'),
    )
  })
  ipcMain.removeHandler(SHELL_IPC.embeddedSettingsRequest)
  ipcMain.handle(SHELL_IPC.embeddedSettingsRequest, (event, value: unknown) => {
    if (!embeddedSenderAllowed(event)) throw new Error('Desktop settings sender rejected')
    const request = parseDesktopSettingsRequest(value)
    const handler = settingsHandlers.get(request.method)
    if (handler === undefined) throw new Error('Desktop settings method unavailable')
    return handler(request.value)
  })
  registerSettings('getNotificationPreferences', mayAccessNotificationPreferences, () => {
    return notificationPreferences
  })
  registerSettings('updateNotificationPreferences', mayAccessNotificationPreferences, async (value: unknown) => {
    notificationPreferences = await saveNotificationPreferences(notificationPreferencesPath(), value)
    return notificationPreferences
  })
  registerSettings('updateThemePreferences', mayAccessThemePreferences, async (value: unknown) => {
    themePreferences = await saveDesktopThemePreferences(themePreferencesPath(), value)
    broadcastShellBootstrap()
    return themePreferences
  })
  registerSettings('getUpdatePreferences', mayAccessDesktopUpdates, () => {
    return updatePreferences
  })
  registerSettings('updateUpdatePreferences', mayAccessDesktopUpdates, async (value: unknown) => {
    if (desktopUpdatePreferencesSaving) throw new Error('更新偏好正在保存，请稍后重试。')
    const next = sanitizeUpdatePreferences(typeof value === 'object' && value !== null ? { ...updatePreferences, ...value } : value)
    const channelChanged = desktopReleaseChannel(next) !== desktopReleaseChannel(updatePreferences)
    if (channelChanged && desktopCandidateMutationPending) throw new Error('桌面候选正在准备或部署，发布通道未更改；请等待当前事务结束。')
    desktopUpdatePreferencesSaving = true
    try {
      if (channelChanged) {
        await componentUpdateSafety.run('desktop', async () => {
          if (portableDesktopUpdater !== undefined && !await portableDesktopUpdater.invalidateReleaseForChannelChange()) {
            throw new Error('桌面更新正在检查、准备或等待激活，发布通道未更改；请先完成当前事务。')
          }
          desktopUpdateChannelGate.invalidate()
          dismissDesktopUpdateNotification()
          updatePreferences = await saveUpdatePreferences(updatePreferencesPath(), next)
        })
      } else {
        updatePreferences = await saveUpdatePreferences(updatePreferencesPath(), next)
      }
      if (startupUpdateTimer !== undefined) clearTimeout(startupUpdateTimer)
      startupUpdateTimer = undefined
      // Saving a policy/channel schedules a fresh check below. Never prepare a
      // cached `available` release from this handler, even if the new policy is
      // automatic: a successful check must authorize the next download.
      return updatePreferences
    } finally {
      desktopUpdatePreferencesSaving = false
      scheduleStartupUpdateCheck(0)
    }
  })
  registerSettings('getDesktopUpdateState', mayAccessDesktopUpdates, () => {
    return desktopUpdateSnapshot()
  })
  registerSettings('desktopUpdateAction', mayAccessDesktopUpdates, async (value: unknown) => {
    if (value !== 'check' && value !== 'download' && value !== 'install') return
    await handleDesktopUpdateSettingsAction(value)
    return desktopUpdateSnapshot()
  })
  registerSettings('getHarnessUpdateState', mayAccessDesktopUpdates, () => {
    return harnessUpdateSnapshot()
  })
  registerSettings('updateHarnessUpdatePolicy', mayAccessDesktopUpdates, async (value: unknown) => {
    if (harnessUpdaterContext === undefined) return harnessUpdateSnapshot()
    harnessUpdatePolicy = await saveHarnessUpdatePolicy(harnessUpdatePolicyPath(harnessUpdaterContext.updateRoot), value)
    if (harnessUpdateTimer !== undefined) clearTimeout(harnessUpdateTimer)
    harnessUpdateTimer = undefined
    if (harnessUpdatePolicy.mode !== 'manual') scheduleHarnessUpdateCheck(0)
    broadcastHarnessUpdateState()
    return harnessUpdateSnapshot()
  })
  registerSettings('harnessUpdateAction', mayAccessDesktopUpdates, async (value: unknown) => {
    if (value !== 'check' || harnessUpdaterContext === undefined) return harnessUpdateSnapshot()
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
    if (browserVisible && getActiveBrowserTab() === null) openBrowser(primaryBrowserHomepage())
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
    if (tab !== null) {
      tab.url = normalizeBrowserAddress(value)
      const contents = browserTabContents(tab)
      if (contents !== undefined) void contents.loadURL(tab.url).catch((error: Error) => console.error(`浏览器加载失败：${error.message}`))
      // Persist the accepted address immediately. A webview guest may not emit
      // the same navigation callbacks as the former WebContentsView path.
      scheduleBrowserWorkspaceSave()
      broadcastShellState()
    }
  })
  ipcMain.removeHandler(SHELL_IPC.browserBack)
  ipcMain.handle(SHELL_IPC.browserBack, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    const contents = browserTabContents(getActiveBrowserTab())
    if (contents !== undefined && !contents.isDestroyed() && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  })
  ipcMain.removeHandler(SHELL_IPC.browserForward)
  ipcMain.handle(SHELL_IPC.browserForward, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    const contents = browserTabContents(getActiveBrowserTab())
    if (contents !== undefined && !contents.isDestroyed() && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  })
  ipcMain.removeHandler(SHELL_IPC.browserReload)
  ipcMain.handle(SHELL_IPC.browserReload, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return
    const contents = browserTabContents(getActiveBrowserTab())
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
    const contents = browserTabContents(getActiveBrowserTab())
    if (contents === undefined || contents.isDestroyed()) return false
    contents.print({ printBackground: true })
    return true
  })
  ipcMain.removeHandler(SHELL_IPC.browserScreenshot)
  ipcMain.handle(SHELL_IPC.browserScreenshot, async event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return null
    const captured = await captureEmbeddedBrowserPage(10)
    if (captured === null || captured.image.isEmpty()) return null
    const image = captured.image
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
    browserTabContents(getActiveBrowserTab())?.reload()
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
    const contents = browserTabContents(getActiveBrowserTab())
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
    const contents = browserTabContents(getActiveBrowserTab())
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
    const contents = browserTabContents(getActiveBrowserTab())
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
    const contents = browserTabContents(getActiveBrowserTab())
    if (contents !== undefined && !contents.isDestroyed()) contents.stopFindInPage('keepSelection')
  })
  ipcMain.removeHandler(SHELL_IPC.browserDevTools)
  ipcMain.handle(SHELL_IPC.browserDevTools, event => {
    if (!mayInvokeBrowserIpc(shellRendererKind(event.sender))) return false
    const contents = browserTabContents(getActiveBrowserTab())
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
    for (const tab of browserTabs) applyBrowserPageZoom(browserTabContents(tab))
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
    // 补丁 1：拒绝迟到 IPC —— 旧页面实例（僵尸 renderer / 上一次加载）的 claim 不得重新占住面板。
    if (!shouldAcceptPageToken(request.pageToken, browserPanelPageToken)) {
      console.log('[browser-panel] 拒绝迟到 claim（页面实例令牌不匹配）')
      return { owner: request.owner, stale: true }
    }
    if (request.pageToken !== undefined) browserPanelPageToken = request.pageToken
    // 🔴 只有"当前活动会话"能打开面板（用户 2026-09-21 令「别的会话不要自动给我开面板」）。
    // 非当前会话的请求**降级为后台开标签**：它的页照样打开（能力不丢），但不抢当前会话的面板与焦点。
    if (request.sessionId !== undefined && browserSessionName !== undefined && request.sessionId !== browserSessionName) {
      if (request.url !== undefined) openBrowser(request.url, true)
      console.log('[browser-panel] 非当前会话的打开请求：只建后台标签，不弹面板')
      return { owner: request.owner, foreignSession: true, opened: request.url === undefined ? 'none' : 'background' }
    }
    if (request.sessionId !== undefined) browserPanelSessionId = request.sessionId
    if (browserPanelOwner !== request.owner) browserPanelBounds = undefined
    browserPanelOwner = request.owner
    browserPanelRequested = true // 显式请求显示面板：压过设置页让位
    exitDshSettingsPage()
    browserVisible = true
    browserPanelOccluded = false
    browserMaximized = false
    browserManagerOpen = false
    browserMenuOpen = false
    browserDownloadsOpen = false
    // 同一 URL 已在某个标签打开 → 复用它，不新建（用户 2026-09-21 令「有就是用现成的」；一处定源）。
    // 必要性：better-sidebar 的浏览器标签**每次挂载**都用它的 path 调本接口，而 openBrowser(url, true) 必新建
    // ⇒ 每次页面重载都会多出一个重复标签（2026-09-21 两轮对照实测：起始恒为 2 → 关到 1 → 重载又回 2）。
    // 判据与 openHomepageGroup 同源；兼容「原始 URL」与「规范化 URL」两种 tab.url 形态（createBrowserTab 两种都会写）。
    if (request.url !== undefined) {
      const target = normalizeBrowserAddress(request.url)
      const existing = browserTabs.find(tab => tab.url === target || tab.url === request.url)
      if (existing === undefined) openBrowser(request.url, true)
      else activateBrowserTab(existing.id)
    } else if (getActiveBrowserTab() === null) openBrowser(primaryBrowserHomepage())
    relayout()
    scheduleBrowserWorkspaceSave()
    return { owner: request.owner }
  })
  ipcMain.removeHandler(SHELL_IPC.browserPanelHide)
  ipcMain.handle(SHELL_IPC.browserPanelHide, (event, owner: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) return
    // hide(undefined) = 强制收掉（文件预览/编辑器接管右侧时）；hide(owner) = 仅当 owner 仍匹配。
    // 否则 WebContentsView 永远压在 HTML 预览上 —— 用户报「内置浏览器和移植浏览器打架」。
    if (owner !== undefined && owner !== null && owner !== browserPanelOwner) return
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
  // 智能体探针通道：在侧边栏浏览器的活动 tab 里执行 JS（2026-09-20 用户令 B 方案）
  ipcMain.removeHandler(SHELL_IPC.browserPanelExecuteJs)
  ipcMain.handle(SHELL_IPC.browserPanelExecuteJs, async (event, code: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) return { ok: false, error: 'forbidden' }
    if (typeof code !== 'string' || code.length > 200_000) return { ok: false, error: 'invalid code' }
    const tab = getActiveBrowserTab()
    const contents = browserTabContents(tab)
    if (contents === undefined) return { ok: false, error: 'no active browser tab' }
    try {
      const result = await contents.executeJavaScript(code, true)
      return { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  // 标签管理（用户 2026-09-21 令「先查再开、只保留一个」）：列清单 / 激活 / 关闭。
  // 关标签只有主进程能做：页面视图无 preload（调不到 API），chrome 视图的 closeTab 不在这条通道内。
  ipcMain.removeHandler(SHELL_IPC.browserPanelTabs)
  ipcMain.handle(SHELL_IPC.browserPanelTabs, (event, value: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) return { ok: false, error: 'forbidden' }
    const request = (value ?? {}) as { action?: unknown; id?: unknown }
    const action = typeof request.action === 'string' ? request.action : 'list'
    const listing = () => browserTabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.id === activeBrowserTabId }))
    // 补丁 3：把"当前 owner + 面板是否真的可见 + 所属会话"回给页面。有了它，页面可以在**收起瞬间**
    // 直接调 hide(owner) 立刻收掉原生层（≈ACK 效果），而不必依赖卡片在被隐藏时仍上报 bounds。
    const panelState = () => ({
      owner: browserPanelOwner ?? null,
      visible: browserVisible && browserPanelOwner !== undefined,
      cardState: browserPanelCardState ?? null,
      session: browserSessionName ?? null,
    })
    if (action === 'list') return { ok: true, active: activeBrowserTabId ?? null, tabs: listing(), ...panelState() }
    if (typeof request.id !== 'string') return { ok: false, error: 'missing id' }
    if (action === 'activate') {
      activateBrowserTab(request.id)
      return { ok: true, active: request.id, tabs: listing() }
    }
    if (action === 'close') {
      closeBrowserTab(request.id)
      return { ok: true, closed: request.id, active: activeBrowserTabId ?? null, tabs: listing() }
    }
    return { ok: false, error: 'unknown action' }
  })
  ipcMain.removeAllListeners(SHELL_IPC.browserPanelBounds)
  ipcMain.on(SHELL_IPC.browserPanelBounds, (event, value: unknown) => {
    if (!mayManageBrowserPanel(shellRendererKind(event.sender))) return
    if (typeof value !== 'object' || value === null || (value as { owner?: unknown }).owner !== browserPanelOwner) return
    const content = mainWindow?.getContentBounds()
    if (content === undefined) return
    const viewport = { width: content.width, height: Math.max(0, content.height - SHELL_BAR_HEIGHT) }
    // **先判 raw ∩ viewport，最后才 clamp**：clamp 会把"已经飞出屏幕"的证据抹掉。
    // 实测例（2026-09-21）：页面收起右栏时宿主 div 被 translateX 推到视口右侧之外，
    // 上报 x≈2589 / width≈1398 / viewport 2560 ⇒ 交集宽 0，应判不可见；若先 clamp 成 x=1162
    // 就变成"完整落在屏幕内"，幽灵面板就再也判不出来。
    const raw = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
    const rawRect = { x: Number(raw.x), y: Number(raw.y), width: Number(raw.width), height: Number(raw.height) }
    if (Number.isFinite(rawRect.x) && Number.isFinite(rawRect.y) && Number.isFinite(rawRect.width) && Number.isFinite(rawRect.height)) {
      browserPanelRawVisible = isPanelRawVisible(rawRect, viewport)
    }
    browserPanelSignalAt = Date.now()
    browserPanelBoundsAt = Date.now()
    const panel = normalizeBrowserPanelBounds(value, content.width, viewport.height, event.sender.getZoomFactor())
    browserPanelBounds = panel
    if (browserVisible) relayout()
  })
  ipcMain.removeAllListeners(SHELL_IPC.dshState)
  ipcMain.on(SHELL_IPC.dshState, (event, state: Partial<DshNavigationState>) => {
    if (!mayReportDshState(shellRendererKind(event.sender))) return
    if (typeof state !== 'object' || state === null) return
    // 只认官方页面的导航状态上报：带 can* 字段才更新，否则会把面板心跳的载荷误当成"全部禁用"
    if ('canBack' in state || 'canForward' in state || 'canNextChat' in state || 'canPreviousChat' in state) {
      dshNavigationState = {
        canBack: state.canBack === true,
        canForward: state.canForward === true,
        canNextChat: state.canNextChat === true,
        canPreviousChat: state.canPreviousChat === true,
      }
    }
    broadcastShellState()
    // 面板生命周期信号（我的插件每秒上报）：卡片可见 / 隐藏 / 缺失 + 心跳时间。
    // 不把官方页面自身的导航状态上报（只带 canBack 等）当成面板心跳。
    const cardState = parsePanelCardSignal(state)
    if (cardState !== undefined) {
      browserPanelCardState = cardState
      browserPanelSignalAt = Date.now()
      if (cardState !== 'visible') {
        // 收起右栏 / 切到没有浏览器卡片的会话：立刻撤销，别让旧会话的面板留在新会话里。
        // 仅当面板由卡片持有时才撤销 —— shell 工作区（无 owner）不因页面报告卡片缺席而被关掉。
        if (browserPanelOwner !== undefined) revokeBrowserPanel(`card-${cardState}`)
      } else if (browserVisible && browserPanelOwner !== undefined) {
        relayout()
      }
    }
    // 补丁 2：活动会话 → 先撤销面板、再换标签桶（浏览器跟着会话走）
    const sessionSignal = parseActiveSessionSignal(state)
    if (sessionSignal !== undefined) onActiveSessionChanged(sessionSignal)
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
      // 只有"新开设置页"才回到被动让位；退出设置页(retrue→false)时保留覆盖标记，
      // 否则刚点链接触发的"要看浏览器"会被自己清掉、面板又消失。
      if (visible) browserPanelRequested = false
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
  if (sender === browserChromeContents()) return 'browser-panel'
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
  void contents.executeJavaScript(DISMISS_DSH_SETTINGS_DIALOG_SCRIPT)
    .then((dismissed) => {
      // 0.2 内核的设置页不是 role=dialog，上面必然落空；回落到「返回应用」这一条真实路径。
      if (dismissed !== true) exitDshSettingsPage()
    })
    .catch(() => exitDshSettingsPage())
}

/** ESC 关设置页的兜底：**以 DOM 为准**判断开合，而不是读 `dshSettingsDialogVisible`。
 *
 *  那个模块级标志位在 0.2 内核下不可靠：唯一的自动校准通道
 *  `dsh-shell:dsh-settings-visibility` 已无发送方（三个 profile 全量静态核实均无引用），
 *  而进程内另有多条写入路径。2026-09-30 实机证据链：
 *  ① 顶栏「设置」把标志位置为 true（asar 内已核实含该赋值）；
 *  ② 同一次会话里 F11 能把窗口切全屏、Ctrl+B 能收起边栏 —— 证明按键确实到达
 *     `before-input-event` 且通过了 `input.type === 'keyDown'` 守卫；
 *  ③ 但 ESC 时 DOM 仍收到 keydown（未被 `preventDefault` 吞掉）⇒ `escapeRoute`
 *     判定 `pass-through` ⇒ 读到的标志位是 false。
 *  即"标志位说没开、DOM 明明开着"。这里改成直接问 DOM，对任何未知的写入者都免疫。
 *
 *  刻意**不** `preventDefault`：ESC 仍照常透传给 DSH 页面，壳只在旁边补一次关闭，
 *  这样设置页没开时 DSH 自身的 ESC 语义（关浮层、退输入态）完全不受影响。 */
async function dismissDshSettingsDialogWhenOpen(): Promise<void> {
  if (!await isDshSettingsPageOpen()) return
  dismissDshSettingsDialog()
}

function installShortcutHandler(contents: Electron.WebContents): void {
  contents.on('before-input-event', (event, input: Input) => {
    if (input.type !== 'keyDown') return
    const browserTab = browserTabs.find(tab => browserTabContents(tab) === contents)
    if (browserTab !== undefined) {
      const command = process.platform === 'darwin' ? input.meta : input.control
      const key = input.key.toLowerCase()
      if (command && key === 'f') {
        event.preventDefault()
        browserChromeContents()?.send(SHELL_IPC.browserOpenFind)
        return
      }
      if (command && key === 'l') {
        event.preventDefault()
        browserChromeContents()?.send(SHELL_IPC.browserFocusAddress)
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
      // 不 preventDefault：ESC 照常透传给 DSH 页面，关闭动作走 DOM 为准的兜底。
      // 详见 dismissDshSettingsDialogWhenOpen 的注释（标志位在 0.2 内核下不可信）。
      runMainTask(dismissDshSettingsDialogWhenOpen())
      return
    }
    // 兜底分支：标志位说"设置页没开"时 escapeRoute 判 pass-through，但 DOM 可能开着。
    // 这里对主壳上的 ESC 无条件补一次 DOM 判定 —— 没开就是空转，开了就关掉。
    if (input.key === 'Escape' && auxiliaryWindow === undefined && contents === mainWindow?.webContents) {
      runMainTask(dismissDshSettingsDialogWhenOpen())
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
  // 设置界面打开时，这些入口的再次点击 = 关闭设置界面（切换行为，用户 2026-09-20 确认期望）。
  // 必须先关桌面端设置窗口：旧实现只退出 DSH 网页内设置页，窗口不关——用户实机反馈"二次点击没有生效"。
  if (id === 'settings' || id === 'find' || id === 'check-updates' || id === 'desktop-settings' || id === 'feature-panels') {
    if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
      settingsWindow.close()
      return
    }
    if (id === 'settings') {
      // 「设置」由壳直接驱动 DSH 页面，不走 dsh-action 通道：0.2 内核的客户端已不监听该
      // 动作的 settings 分支（2026-09-29 实机：toggle-sidebar 仍生效、settings 完全无反应），
      // 沿用通道只会让顶栏按钮彻底失灵。开关都点 DSH 自己的控件，语义与用户所见一致。
      const view = dshView
      if (view === undefined || view.webContents.isDestroyed()) return
      const outcome = await view.webContents.executeJavaScript(TOGGLE_DSH_SETTINGS_PAGE_SCRIPT).catch(() => 'unavailable')
      dshSettingsDialogVisible = outcome === 'closed' || outcome === 'opened'
      relayout()
      return
    }
    if (await isDshSettingsPageOpen()) {
      exitDshSettingsPage()
      return
    }
  }
  if (id === 'toggle-devtools') {
    const target = resolveDevToolsContents()
    if (target?.isDevToolsOpened() === true) target.closeDevTools()
    else target?.openDevTools({ mode: 'detach', activate: true })
    return
  }
  const contents = dshView?.webContents
  if (id === 'new-chat' || id === 'open-folder' || id === 'toggle-sidebar' || id === 'find' || id === 'previous-chat' || id === 'next-chat' || id === 'back' || id === 'forward') {
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
  else if (id === 'zoom-in') { contents.setZoomFactor(Math.min(2, contents.getZoomFactor() + 0.1)); syncBrowserPanelForZoom() }
  else if (id === 'zoom-out') { contents.setZoomFactor(Math.max(0.5, contents.getZoomFactor() - 0.1)); syncBrowserPanelForZoom() }
  else if (id === 'zoom-reset') { contents.setZoomFactor(1); syncBrowserPanelForZoom() }
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
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
  }
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    settingsWindow.webContents.send(SHELL_IPC.settingsSection, section)
    return
  }
  // 创建前先算好居中 bounds 并显式传入：无坐标的窗口会被 OS 按默认/层叠规则摆放，
  // 这正是设置窗口跑到宿主窗口外的根源；显式定位后再由 bindContainedSettingsWindow 持续约束。
  const ownerBounds = mainWindow !== undefined && !mainWindow.isDestroyed()
    ? mainWindow.getContentBounds()
    : screen.getPrimaryDisplay().workArea
  const initialBounds = centeredSettingsBounds(ownerBounds, screen.getDisplayMatching(ownerBounds).workArea)
  const window = new BrowserWindow({
    parent: mainWindow,
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    show: false,
    movable: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: desktopText('桌面端设置', 'Desktop Settings'),
    autoHideMenuBar: true,
    backgroundColor: DESKTOP_THEME_PALETTES[activeDshColorScheme].settingsBackground,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: resolvePreload('shell-preload.cjs'), sandbox: true },
  })
  removeNativeWindowMenu(window)
  settingsWindow = window
  bindContainedSettingsWindow(window, mainWindow, screen)
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
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
    // 都没有时回落自己的便携发布源；官方原版没有保护契约，不是自动更新资产。
    releaseSource: resolvePortableReleaseSource([
      join(portablePaths.root, PORTABLE_RELEASE_SOURCE_OVERRIDE_PATH),
      join(process.resourcesPath, 'release-source.json'),
    ]),
    onState: applyPortableDesktopUpdateState,
    verifyCandidatePreservation: async appDirectory => {
      const pendingRuntime = readRuntimeSlotPointer(join(portablePaths.root, 'Data', 'Runtime', 'dsh-runtime'))
      if (pendingRuntime?.pendingTransactionId !== undefined || isRecycling) throw new Error('DSH 内核或 Profile 事务未结束，桌面候选暂不准备/部署。')
      const manifest = acceptedPreservationManifest()
      const result = checkPreservationManifest(JSON.parse(readFileSync(join(appDirectory, 'resources', 'preservation.json'), 'utf8')), manifest)
      if (!result.ok) throw new Error('候选会丢失已接受定制，已阻止更新：' + result.issues.map(item => item.code + ' ' + (item.path ?? item.pluginName ?? '')).join('; '))
      const snapshot = captureCustomizationState({ portableRoot: portablePaths.root, profileDir: resolveWebProfileDir(), manifest })
      const transactionId = portableDesktopUpdater?.state.transactionId
      if (transactionId !== undefined) {
        const directory = join(portablePaths.root, 'Data', 'Updates', 'Desktop', 'transactions', transactionId)
        mkdirSync(directory, { recursive: true })
        writeTextFileAtomicSync(join(directory, 'customization-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n')
      }
    },
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

function acceptedPreservationManifest(): PreservationManifest {
  if (portablePaths !== undefined && existsSync(join(portablePaths.root, 'customizations', 'preservation.json'))) return readPreservationManifest(portablePaths.root)
  const value: unknown = JSON.parse(readFileSync(join(process.resourcesPath, 'preservation.json'), 'utf8'))
  const result = checkPreservationManifest(value)
  if (!result.ok) throw new Error('定制保护清单缺失或无效，拒绝升级。')
  return value as PreservationManifest
}

function stagedDesktopCustomization(transactionId: string | undefined): CustomizationSnapshot | undefined {
  if (transactionId === undefined || portablePaths === undefined) return undefined
  if (!/^[a-f0-9-]{36}$/i.test(transactionId)) throw new Error('桌面定制保护事务号无效。')
  return JSON.parse(readFileSync(join(portablePaths.root, 'Data', 'Updates', 'Desktop', 'transactions', transactionId, 'customization-snapshot.json'), 'utf8')) as CustomizationSnapshot
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

function scheduleStartupUpdateCheck(delayMs = STARTUP_UPDATE_CHECK_DELAY_MS): void {
  if (startupUpdateTimer !== undefined || !shouldCheckForUpdatesOnStartup(updatePreferences, app.isPackaged)) return
  startupUpdateTimer = setTimeout(() => {
    startupUpdateTimer = undefined
    if (!isQuitting && shouldCheckForUpdatesOnStartup(updatePreferences, app.isPackaged)) {
      runMainTask(checkDesktopUpdate('background').finally(() => {
        if (!isQuitting) scheduleStartupUpdateCheck(desktopUpdateCheckInterval(updatePreferences))
      }))
    }
  }, delayMs)
  startupUpdateTimer.unref?.()
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
    const checked = await checkHarnessUpdate({
      currentVersion,
      policy: harnessUpdatePolicy,
      includePrerelease: updatePreferences.channel !== 'stable',
      resolvePrebuiltRelease: async version => await fetchHarnessPrebuiltRelease({
        version, nodeVersion: context.nodeVersion,
        source: portableDesktopUpdater === undefined ? undefined : resolvePortableReleaseSource([
          join(portablePaths!.root, PORTABLE_RELEASE_SOURCE_OVERRIDE_PATH), join(process.resourcesPath, 'release-source.json'),
        ]),
      }),
    })
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
  await componentUpdateSafety.run('harness', () => deployHarnessCandidateUnlocked(context, release, checkedAt))
}

async function deployHarnessCandidateUnlocked(context: HarnessUpdaterContext, release: HarnessReleaseCandidate, checkedAt: string): Promise<void> {
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
    await setHarnessUpdateState(context, 'building', { transactionId, targetVersion: release.version, lastCheckedAt: checkedAt, detail: '正在下载、校验独立运行环境成品；不会在用户电脑编译或安装依赖。' })
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

    const activationSafety = harnessActivationSafety()
    if (!activationSafety.allowed) {
      await setHarnessUpdateState(context, 'blocked', { transactionId, targetVersion: release.version, detail: activationSafety.reason })
      await event('activation-safety', 'blocked', `${activationSafety.reason} 候选指纹 ${candidate.fingerprint}。`)
      return
    }

    await setHarnessUpdateState(context, 'waiting-idle', { transactionId, targetVersion: release.version, detail: `等待连续 ${harnessUpdatePolicy.idleQuietSeconds} 秒无运行或待审批任务。` })
    if (!await waitForHarnessIdle(harnessUpdatePolicy.idleQuietSeconds * 1_000, HARNESS_IDLE_MAX_WAIT_MS)) {
      await setHarnessUpdateState(context, 'blocked', { transactionId, targetVersion: release.version, detail: '用户任务持续繁忙，本轮不切换；候选槽已保留供下次复用。' })
      await event('idle-gate', 'blocked', '空闲等待超过上限，未中断用户任务。')
      return
    }
    await switchHarnessRuntime(context, candidate, transactionId, release)
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
      if (release.prebuiltRelease !== undefined) {
        return await prepareHarnessPrebuiltCandidate({
          legacyRuntimeDir: context.legacyRuntimeDir, updateRoot: context.updateRoot,
          release: release.prebuiltRelease, nodeVersion: context.nodeVersion,
        })
      }
      if (context.isPackaged) throw new Error('缺少独立运行环境成品，已阻止用户端本地装配；当前版本不变。')
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

async function switchHarnessRuntime(context: HarnessUpdaterContext, candidate: HarnessRuntimeCandidate, transactionId: string, release: HarnessReleaseCandidate): Promise<void> {
  const activationSafety = harnessActivationSafety()
  if (!activationSafety.allowed) throw new Error(activationSafety.reason)
  if (lastStartOptions === undefined || lastSeedOptions === undefined || server === undefined) throw new Error('当前 DSH 服务上下文不完整，不能安全切换。')
  if (activeDshWorkCount > 0 || isRecycling || profileActivationRecyclePending || isDshMarketOperationBusy(await dshMarketOperationStatus())) {
    throw new Error('空闲门禁后检测到新任务，已取消本轮切换。')
  }
  const previousStartOptions = lastStartOptions
  const previousSeedOptions = lastSeedOptions
  if (portablePaths === undefined) throw new Error('缺少便携数据根，不能隔离家园升级。')
  const manifest = acceptedPreservationManifest()
  const customizationSnapshot = captureCustomizationState({ portableRoot: portablePaths.root, profileDir: previousSeedOptions.profileDir, manifest })
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  const previousRuntime = process.env.DSH_DESKTOP_RUNTIME_DIR
  let preparedHome: Awaited<ReturnType<typeof prepareHarnessHome>> | undefined
  let activated = false
  let committed = false
  let observing = true
  let observationReject: ((error: Error) => void) | undefined
  const observationFailure = new Promise<never>((_resolve, reject) => { observationReject = reject })
  isRecycling = true
  broadcastShellState()
  try {
    await setHarnessUpdateState(context, 'switching', { transactionId, targetVersion: candidate.version, detail: '已通过空闲门禁，正在切换 DSH 子服务。' })
    await showStartupWindow(desktopText('正在安全更新 DSH 运行环境…', 'Safely updating the DSH runtime…'))
    profileWatcher?.stop()
    const previousServer = server
    server = undefined
    await previousServer.stop()
    preparedHome = await prepareHarnessHome({
      portableRoot: portablePaths.root, sourceProfileDir: previousSeedOptions.profileDir,
      candidate, transactionId, sourceStopped: true, snapshot: customizationSnapshot,
      profileCompatibility: release.prebuiltRelease?.profileCompatibility,
    })
    assertCustomizationPreserved(customizationSnapshot, { portableRoot: portablePaths.root, profileDir: preparedHome.profileDir, manifest })
    installDesktopBridge(preparedHome.profileDir, resolveDesktopBridgeDir(context))
    const repaired = await repairMisplacedSessionLogs(join(preparedHome.home, 'sessions'), join(context.updateRoot, 'transactions', transactionId, 'session-path-repair'))
    if (repaired.failures.length > 0) throw new Error(`候选家园会话路径检查失败：${repaired.failures.join(' / ')}`)
    await preparedHome.publishBinding()
    const nextStartOptions: Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'> = {
      ...previousStartOptions,
      runtime: resolveDshRuntime({ ...context, profileDir: preparedHome.profileDir, desktopRuntimeDir: candidate.directory }),
      startupTimeoutMs: harnessUpdatePolicy.liveStartupTimeoutSeconds * 1_000,
      environment: { ...previousStartOptions.environment, DSH_HOME: preparedHome.home, DSH_PROFILE_DIR: preparedHome.profileDir, DSH_RUNTIME_DIR: candidate.directory },
    }
    activateRuntimeSlot({
      legacyRuntimeDir: context.legacyRuntimeDir,
      candidateDir: candidate.directory,
      version: candidate.version,
      fingerprint: candidate.fingerprint,
      transactionId,
    })
    activated = true
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
    lastSeedOptions = { ...previousSeedOptions, profileDir: preparedHome.profileDir, desktopRuntimeDir: candidate.directory }
    process.env.DSH_HOME = preparedHome.home
    process.env.DSH_PROFILE_DIR = preparedHome.profileDir
    process.env.DSH_DESKTOP_RUNTIME_DIR = candidate.directory
    await createMainWindow(nextServer.url)
    assertCustomizationPreserved(customizationSnapshot, { portableRoot: portablePaths.root, profileDir: preparedHome.profileDir, manifest })
    // 观察期间不开放新任务界面，避免失败回滚时用户已写入新格式会话。
    await showStartupWindow(desktopText('候选运行环境已启动，正在观察健康状态；完成后自动返回。', 'The candidate runtime started. Observing health before returning to the app.'))

    await setHarnessUpdateState(context, 'observing', { transactionId, targetVersion: candidate.version, detail: `候选已上线，观察 ${harnessUpdatePolicy.observationMinutes} 分钟后提交。` })
    await Promise.race([
      observationFailure,
      waitHarnessObservation(harnessUpdatePolicy.observationMinutes * 60_000),
    ])
    observing = false
    assertCustomizationPreserved(customizationSnapshot, { portableRoot: portablePaths.root, profileDir: preparedHome.profileDir, manifest })
    commitRuntimeSlot(context.legacyRuntimeDir, transactionId)
    committed = true
    harnessUpdaterContext = { ...context, profileDir: preparedHome.profileDir }
    await createMainWindow(nextServer.url)
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
    // 提交是不可逆边界；之后 UI/审计失败不能停掉已提交服务并回滚不存在的 pending。
    if (committed) {
      console.error(`DSH 内核已提交，提交后反馈失败，保持现役服务：${detail}`)
      await setHarnessUpdateState(context, 'succeeded', { transactionId, targetVersion: candidate.version, detail: `内核指针已提交；界面或审计反馈失败，未停止或回滚现役：${detail}` }).catch(() => undefined)
      await appendHarnessUpdateEvent(context.updateRoot, { transactionId, phase: 'post-commit-feedback', outcome: 'failure', timestamp: new Date().toISOString(), currentVersion: candidate.version, targetVersion: candidate.version, detail }).catch(() => undefined)
      return
    }
    // 退出流程不再拉起任何新子进程；未提交指针会在下次启动时自动回滚。
    if (isQuitting) return
    isRecycling = true
    broadcastShellState()
    const failedServer = server
    server = undefined
    await failedServer?.stop().catch(() => undefined)
    if (activated) rollbackRuntimeSlot(context.legacyRuntimeDir, transactionId, detail)
    await preparedHome?.rollbackBinding()
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previousProfile
    if (previousRuntime === undefined) delete process.env.DSH_DESKTOP_RUNTIME_DIR; else process.env.DSH_DESKTOP_RUNTIME_DIR = previousRuntime
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
    profileWatcher?.stop()
    if (!isQuitting && lastSeedOptions !== undefined) profileWatcher = watchProfileActivation(lastSeedOptions.profileDir, scheduleProfileActivationRecycle, { onError: handleUnexpectedMainError })
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
  if (desktopUpdatePreferencesSaving || desktopCandidateMutationPending || ['checking', 'downloading', 'verifying', 'building', 'deploying', 'validating'].includes(updateStatus.kind)) return
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
  if (portableDesktopUpdater.state.phase === 'ready') {
    // A same-process checked candidate is already usable. A restored ready
    // candidate instead needs a fresh channel check; retain its files for the
    // normal prepare path to revalidate/reuse, and never reset pending pointers.
    if (desktopUpdateChannelGate.candidateTicket(updatePreferences) !== undefined) return
    desktopCandidateMutationPending = true
    try {
      const reset = await componentUpdateSafety.run('desktop', () => portableDesktopUpdater!.resetPreparedReleaseForRecheck())
      if (!reset) {
        setDesktopUpdateStatus(preserveDesktopUpdateFailure(updateStatus, '候选已登记激活或状态已变更，不能重置检查；原候选和部署指针保持不变。'))
        return
      }
    } finally {
      desktopCandidateMutationPending = false
    }
    if (desktopUpdatePreferencesSaving) return
  }
  const ticket = desktopUpdateChannelGate.beginCheck(updatePreferences)
  try {
    const checked = await portableDesktopUpdater.check(ticket.channel)
    if (desktopUpdatePreferencesSaving || !desktopUpdateChannelGate.isCurrent(ticket, updatePreferences)) return
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
    if (checked.phase !== 'available' || checked.release === undefined || !desktopUpdateChannelGate.acceptCheck(ticket, updatePreferences, checked)) return
    const available: Extract<DesktopUpdateStatus, { kind: 'available' }> = {
      kind: 'available',
      version: checked.release.version,
      ...(checked.release.releaseNotes === undefined ? {} : { releaseNotes: checked.release.releaseNotes }),
    }
    if (interaction === 'background') {
      if (shouldDownloadUpdateAutomatically(updatePreferences)) await downloadDesktopUpdate('background', ticket)
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
    if (prompt.response === 0) await downloadDesktopUpdate('interactive', ticket)
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

async function downloadDesktopUpdate(interaction: DesktopUpdateInteraction = 'interactive', checkedTicket?: DesktopUpdateChannelTicket): Promise<void> {
  if (desktopUpdatePreferencesSaving || desktopCandidateMutationPending || updateStatus.kind !== 'available' || portableDesktopUpdater === undefined) return
  const ticket = checkedTicket ?? desktopUpdateChannelGate.candidateTicket(updatePreferences)
  if (ticket === undefined || !desktopUpdateChannelGate.mayUseCandidate(ticket, updatePreferences)) {
    // Restored/cache-only availability is not a download authorization. Refresh
    // it and require a new user action rather than downloading an old selection.
    if (interaction !== 'background') await checkDesktopUpdate('settings')
    return
  }
  const version = updateStatus.version
  try {
    desktopCandidateMutationPending = true
    let prepared: PortableDesktopUpdateState
    try {
      prepared = await componentUpdateSafety.run('desktop', async () => {
        if (desktopUpdatePreferencesSaving || !desktopUpdateChannelGate.mayUseCandidate(ticket, updatePreferences)) throw new Error('发布通道或检查许可已变更，旧候选下载已阻止；请重新检查。')
        const updater = portableDesktopUpdater!
        const result = await updater.prepare()
        if (!desktopUpdateChannelGate.mayUseCandidate(ticket, updatePreferences)) throw new Error('候选属于旧发布通道，已阻止登记激活；请重新检查。')
        if (result.phase === 'ready' && interaction === 'background' && !desktopUpdatePreferencesSaving && shouldStageUpdateOnExit(updatePreferences)) await updater.stageActivation()
        return result
      })
    } finally {
      desktopCandidateMutationPending = false
    }
    if (prepared.phase === 'error') {
      if (interaction === 'interactive') await dialog.showMessageBox({ type: 'error', title: DESKTOP_APP_NAME, message: prepared.detail })
      return
    }
    if (prepared.phase !== 'ready') return
    const ready = { kind: 'ready' as const, version }
    if (interaction === 'background') {
      // auto-on-exit 已在同一组件变更租约中仅登记 pending，没有退出或重启。
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
  if (desktopUpdatePreferencesSaving || desktopCandidateMutationPending || portableDesktopUpdater === undefined || portablePaths === undefined || updateStatus.kind !== 'ready') return
  const ticket = desktopUpdateChannelGate.candidateTicket(updatePreferences)
  if (ticket === undefined || !desktopUpdateChannelGate.mayUseCandidate(ticket, updatePreferences)) {
    await checkDesktopUpdate('settings')
    return
  }
  desktopCandidateMutationPending = true
  try {
    await componentUpdateSafety.run('desktop', async () => {
      if (desktopUpdatePreferencesSaving || !desktopUpdateChannelGate.mayUseCandidate(ticket, updatePreferences)) throw new Error('发布通道许可已变更，旧候选激活已阻止。')
      if (isRecycling || readRuntimeSlotPointer(join(portablePaths!.root, 'Data', 'Runtime', 'dsh-runtime'))?.pendingTransactionId !== undefined) throw new Error('内核事务未结束，暂不部署桌面候选。')
      const staged = await portableDesktopUpdater!.stageActivation()
      if (staged.phase === 'error') throw new Error(staged.detail)
      await spawnPortableLauncherForRestart()
      await shutdownDesktop(() => { app.exit(0) })
    })
  } finally {
    desktopCandidateMutationPending = false
  }
}

function showMainWindow(): void {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
