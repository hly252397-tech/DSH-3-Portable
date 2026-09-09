import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { SHELL_IPC } from '../src/shell-contract.js'

function channelLiterals(source: string): string[] {
  return [...source.matchAll(/'([^']+)'/g)]
    .map(match => match[1]!)
    .filter(value => value.startsWith('dsh-shell:'))
    .sort()
}

test('sandbox preload 的 IPC 字面量与主契约保持一致', async () => {
  const shell = await readFile(new URL('../../src/shell-preload.cts', import.meta.url), 'utf8')
  const browserPanel = await readFile(new URL('../../src/browser-panel-preload.cts', import.meta.url), 'utf8')
  const dsh = await readFile(new URL('../../src/dsh-view-preload.cts', import.meta.url), 'utf8')
  assert.deepEqual(channelLiterals(shell), [
    SHELL_IPC.action, SHELL_IPC.bootstrap, SHELL_IPC.browserActivateTab, SHELL_IPC.browserAutofillPage,
    SHELL_IPC.browserBack, SHELL_IPC.browserBookmarkCurrent, SHELL_IPC.browserClearData,
    SHELL_IPC.browserClearDownloads, SHELL_IPC.browserCloseTab, SHELL_IPC.browserDevTools,
    SHELL_IPC.browserFillCredential, SHELL_IPC.browserFind, SHELL_IPC.browserFindResult,
    SHELL_IPC.browserFindStop, SHELL_IPC.browserFocusAddress, SHELL_IPC.browserForward,
    SHELL_IPC.browserGetLibrary, SHELL_IPC.browserOpenFind,
    SHELL_IPC.browserImportProfile, SHELL_IPC.browserLibraryClear, SHELL_IPC.browserLibraryRemove,
    SHELL_IPC.browserNavigate, SHELL_IPC.browserNewTab, SHELL_IPC.browserOpenDownload,
    SHELL_IPC.browserOpenDownloadsFolder, SHELL_IPC.browserOpenExternal, SHELL_IPC.browserOpenHomepages,
    SHELL_IPC.browserPageZoom, SHELL_IPC.browserPrint, SHELL_IPC.browserReload,
    SHELL_IPC.browserRuntimeCheck, SHELL_IPC.browserRuntimeInfo, SHELL_IPC.browserSaveCredential,
    SHELL_IPC.browserSaveSettings, SHELL_IPC.browserScreenshot, SHELL_IPC.browserSetRatio,
    SHELL_IPC.browserShowDownload, SHELL_IPC.browserToggle, SHELL_IPC.browserToggleDownloads,
    SHELL_IPC.browserToggleExtension, SHELL_IPC.browserToggleManager, SHELL_IPC.browserToggleMaximize,
    SHELL_IPC.browserPrepareMenuSnapshot,
    SHELL_IPC.browserToggleMenu, SHELL_IPC.closeDesktopSettings, SHELL_IPC.desktopUpdateAction,
    SHELL_IPC.desktopUpdateState, SHELL_IPC.featurePanelsCopy, SHELL_IPC.getBootstrap, SHELL_IPC.getDesktopUpdateState,
    SHELL_IPC.getHarnessUpdateState, SHELL_IPC.getNotificationPreferences, SHELL_IPC.getUpdatePreferences,
    SHELL_IPC.harnessUpdateAction, SHELL_IPC.harnessUpdateState, SHELL_IPC.popupMenu,
    SHELL_IPC.settingsSection, SHELL_IPC.state, SHELL_IPC.updateHarnessUpdatePolicy,
    SHELL_IPC.updateNotificationPreferences, SHELL_IPC.updateUpdatePreferences,
    SHELL_IPC.updateThemePreferences,
  ].sort())
  assert.deepEqual(channelLiterals(browserPanel), [
    SHELL_IPC.bootstrap, SHELL_IPC.browserActivateTab, SHELL_IPC.browserAutofillPage,
    SHELL_IPC.browserBack, SHELL_IPC.browserBookmarkCurrent, SHELL_IPC.browserClearData,
    SHELL_IPC.browserClearDownloads, SHELL_IPC.browserCloseTab, SHELL_IPC.browserDevTools,
    SHELL_IPC.browserFillCredential, SHELL_IPC.browserFind, SHELL_IPC.browserFindResult,
    SHELL_IPC.browserFindStop, SHELL_IPC.browserFocusAddress, SHELL_IPC.browserForward,
    SHELL_IPC.browserGetLibrary, SHELL_IPC.browserImportProfile, SHELL_IPC.browserLibraryClear,
    SHELL_IPC.browserLibraryRemove, SHELL_IPC.browserNavigate, SHELL_IPC.browserNewTab,
    SHELL_IPC.browserOpenDownload, SHELL_IPC.browserOpenDownloadsFolder, SHELL_IPC.browserOpenExternal,
    SHELL_IPC.browserOpenFind, SHELL_IPC.browserOpenHomepages, SHELL_IPC.browserPageZoom,
    SHELL_IPC.browserPrint, SHELL_IPC.browserReload, SHELL_IPC.browserRuntimeCheck,
    SHELL_IPC.browserRuntimeInfo, SHELL_IPC.browserSaveCredential, SHELL_IPC.browserSaveSettings,
    SHELL_IPC.browserScreenshot, SHELL_IPC.browserShowDownload, SHELL_IPC.browserToggle,
    SHELL_IPC.browserToggleDownloads, SHELL_IPC.browserToggleExtension, SHELL_IPC.browserToggleManager,
    SHELL_IPC.browserPrepareMenuSnapshot,
    SHELL_IPC.browserToggleMenu, SHELL_IPC.getBootstrap, SHELL_IPC.state,
  ].sort())
  assert.deepEqual(channelLiterals(dsh), [
    SHELL_IPC.action, SHELL_IPC.browserPanelBounds, SHELL_IPC.browserPanelHide, SHELL_IPC.browserPanelOccluded, SHELL_IPC.browserPanelPrepareOcclusion, SHELL_IPC.browserPanelShow,
    SHELL_IPC.dshAction, SHELL_IPC.dshBrowserCloseRequest, SHELL_IPC.dshLocale, SHELL_IPC.dshNotification,
    SHELL_IPC.dshNotificationReply, SHELL_IPC.dshOpenSession, SHELL_IPC.dshSettingsVisibility,
    SHELL_IPC.dshState, SHELL_IPC.dshTheme,
    SHELL_IPC.desktopTheme,
  ].sort())
})
