import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_UPDATE_PREFERENCES, DesktopUpdateChannelGate, buildDesktopTrayItems, DESKTOP_UPDATE_WARNING, desktopReleaseChannel, desktopUpdateChannel, desktopUpdateCheckInterval, desktopUpdatePrompt, formatDesktopReleaseNotes, loadUpdatePreferences, preserveDesktopUpdateFailure, publicDesktopUpdateError, sanitizeUpdatePreferences, saveUpdatePreferences, shouldCheckForUpdatesOnStartup, shouldDownloadUpdateAutomatically, shouldStageUpdateOnExit } from '../src/desktop-updater.js'

test('更新策略使用安全默认值并持久化', async () => {
  assert.deepEqual(sanitizeUpdatePreferences(undefined), DEFAULT_UPDATE_PREFERENCES)
  assert.deepEqual(sanitizeUpdatePreferences({ policy: 'unexpected' }), DEFAULT_UPDATE_PREFERENCES)
  assert.deepEqual(sanitizeUpdatePreferences({ policy: 'auto-download' }), { policy: 'auto-download' })
  assert.equal(shouldCheckForUpdatesOnStartup({ policy: 'notify' }, true), true)
  assert.equal(shouldCheckForUpdatesOnStartup({ policy: 'auto-download' }, true), true)
  assert.equal(shouldCheckForUpdatesOnStartup({ policy: 'manual' }, true), false)
  assert.equal(shouldCheckForUpdatesOnStartup({ policy: 'notify' }, false), false)
  assert.equal(shouldDownloadUpdateAutomatically({ policy: 'auto-download' }), true)

  const root = await mkdtemp(join(tmpdir(), 'dsh-update-preferences-'))
  const path = join(root, 'settings.json')
  try {
    assert.deepEqual(await loadUpdatePreferences(path), DEFAULT_UPDATE_PREFERENCES)
    assert.deepEqual(await saveUpdatePreferences(path, { policy: 'manual' }), { policy: 'manual' })
    assert.deepEqual(await loadUpdatePreferences(path), { policy: 'manual' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('开发态和空闲态都提供手动检查，不自动下载', () => {
  const idle = buildDesktopTrayItems({ status: { kind: 'idle' }, currentVersion: '0.1.4', packaged: true })
  assert.equal(idle.some(item => item.id === 'check' && item.enabled), true)
  assert.equal(idle.some(item => item.id === 'check' && item.label === '检查更新…'), true)
  assert.equal(idle.some(item => item.id === 'download'), false)
  assert.equal(idle.some(item => item.id === 'reload' && item.label === '重新加载'), true)
  const dev = buildDesktopTrayItems({ status: { kind: 'idle' }, currentVersion: '0.1.4', packaged: false })
  assert.equal(dev.some(item => item.id === 'check' && item.enabled), true)
  assert.equal(dev.some(item => item.id === 'check' && item.label === '检查更新…'), true)
  assert.equal(dev.some(item => item.id === 'reload' && item.enabled), true)
})

test('独立桌面更新可自动准备后等正常退出，预发布与定期间隔持久化', async () => {
  const preferences = { policy: 'auto-on-exit', channel: 'preview', checkIntervalHours: 3 } as const
  assert.deepEqual(sanitizeUpdatePreferences(preferences), preferences)
  assert.equal(shouldDownloadUpdateAutomatically(preferences), true)
  assert.equal(shouldStageUpdateOnExit(preferences), true)
  assert.equal(shouldStageUpdateOnExit({ policy: 'auto-download' }), false)
  assert.equal(shouldStageUpdateOnExit({ policy: 'notify' }), false)
  assert.equal(shouldCheckForUpdatesOnStartup(preferences, true), true)
  assert.equal(shouldCheckForUpdatesOnStartup(preferences, false), false)
  assert.equal(desktopUpdateCheckInterval(preferences), 3 * 60 * 60_000)
  assert.equal(desktopUpdateCheckInterval({ policy: 'notify' }), 6 * 60 * 60_000)
  assert.equal(sanitizeUpdatePreferences({ policy: 'notify', checkIntervalHours: -1 }).checkIntervalHours, 1)
  assert.equal(sanitizeUpdatePreferences({ policy: 'notify', checkIntervalHours: 200 }).checkIntervalHours, 168)
  assert.equal(sanitizeUpdatePreferences({ policy: 'notify', checkIntervalHours: NaN }).checkIntervalHours, 6)
  assert.equal(sanitizeUpdatePreferences({ policy: 'notify', channel: 'invalid' }).channel, 'stable')
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-update-preferences-'))
  try {
    const path = join(root, 'settings.json')
    assert.deepEqual(await saveUpdatePreferences(path, preferences), preferences)
    assert.deepEqual(await loadUpdatePreferences(path), preferences)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('切换发布通道撤销旧 available 的自动与手动下载许可', () => {
  const gate = new DesktopUpdateChannelGate()
  const preview = { policy: 'auto-on-exit', channel: 'preview' } as const
  const stable = { policy: 'auto-on-exit', channel: 'stable' } as const
  assert.equal(desktopReleaseChannel({ policy: 'manual' }), 'preview')
  assert.equal(gate.candidateTicket(preview), undefined)
  const oldTicket = gate.beginCheck(preview)
  assert.equal(gate.acceptCheck(oldTicket, preview, { phase: 'available' }), true)
  assert.equal(gate.mayUseCandidate(oldTicket, preview), true)
  gate.invalidate()
  assert.equal(gate.candidateTicket(stable), undefined)
  assert.equal(gate.mayUseCandidate(oldTicket, stable), false)
  // Returning to preview must not revive the previous cached release.
  assert.equal(gate.mayUseCandidate(oldTicket, preview), false)
  const stableTicket = gate.beginCheck(stable)
  assert.equal(gate.acceptCheck(stableTicket, stable, { phase: 'available' }), true)
  assert.equal(gate.candidateTicket(stable), stableTicket)
  assert.equal(gate.mayUseCandidate(stableTicket, stable), true)
})

test('旧通道晚到结果与限流缓存不能授予新通道许可', () => {
  const gate = new DesktopUpdateChannelGate()
  const preview = { policy: 'auto-download', channel: 'preview' } as const
  const stable = { policy: 'auto-download', channel: 'stable' } as const
  const oldTicket = gate.beginCheck(preview)
  gate.invalidate()
  assert.equal(gate.acceptCheck(oldTicket, stable, { phase: 'available' }), false)
  const stableTicket = gate.beginCheck(stable)
  assert.equal(gate.acceptCheck(stableTicket, stable, { phase: 'available', errorCode: 'RELEASE_RATE_LIMITED' }), false)
  assert.equal(gate.candidateTicket(stable), undefined)
  assert.equal(gate.acceptCheck(stableTicket, stable, { phase: 'error' }), false)
  assert.equal(gate.acceptCheck(stableTicket, stable, { phase: 'none' }), false)
})

test('下载期间通道往返变化仍阻止旧候选自动 stage', async () => {
  const gate = new DesktopUpdateChannelGate()
  const preview = { policy: 'auto-on-exit', channel: 'preview' } as const
  const stable = { policy: 'auto-on-exit', channel: 'stable' } as const
  const ticket = gate.beginCheck(preview)
  assert.equal(gate.acceptCheck(ticket, preview, { phase: 'available' }), true)
  let finishDownload: (() => void) | undefined
  const download = new Promise<void>(resolve => { finishDownload = resolve })
  let preferences: typeof preview | typeof stable = preview
  let staged = 0
  const preparation = (async () => {
    assert.equal(gate.mayUseCandidate(ticket, preferences), true)
    await download
    if (gate.mayUseCandidate(ticket, preferences) && shouldStageUpdateOnExit(preferences)) staged += 1
  })()
  gate.invalidate()
  preferences = stable
  gate.invalidate()
  preferences = preview
  finishDownload!()
  await preparation
  assert.equal(staged, 0)
  assert.equal(gate.candidateTicket(preferences), undefined)
})

test('发现新版本后托盘只出现下载安装，不出现自动安装文案', () => {
  const items = buildDesktopTrayItems({
    status: { kind: 'available', version: '0.1.5' },
    currentVersion: '0.1.4',
    packaged: true,
  })
  assert.equal(items.some(item => item.id === 'download' && item.label === '下载并安装 0.1.5'), true)
  assert.equal(items.some(item => item.id === 'check'), false)
})

test('候选构建完成后托盘改为部署并重启', () => {
  const items = buildDesktopTrayItems({
    status: { kind: 'ready', version: '0.1.5' },
    currentVersion: '0.1.4',
    packaged: true,
  })
  assert.equal(items.some(item => item.id === 'install' && item.label === '部署并重启 0.1.5'), true)
})

test('缺契约被阻止时托盘展示说明且不提供下载', () => {
  const items = buildDesktopTrayItems({
    status: { kind: 'incompatible', version: '1.0.51', message: '桌面端 1.0.51 没有 DSH 便携版 3 兼容契约，已阻止覆盖当前定制功能。', errorCode: 'INCOMPATIBLE_RELEASE' },
    currentVersion: '1.0.46',
    packaged: true,
  })
  assert.equal(items.some(item => item.id === 'blocked' && item.label.includes('1.0.51') && item.label.includes('便携兼容契约') && !item.enabled), true)
  assert.equal(items.some(item => item.id === 'download'), false)
  assert.equal(items.some(item => item.id === 'install'), false)
  assert.equal(items.some(item => item.id === 'check' && item.enabled), true)
})

test('托盘和更新提示可跟随 DSH 英文 locale', () => {
  const items = buildDesktopTrayItems({ status: { kind: 'idle' }, currentVersion: '0.1.4', packaged: true, locale: 'en' })
  assert.equal(items.some(item => item.id === 'show' && item.label === 'Show Window'), true)
  assert.equal(items.some(item => item.id === 'check' && item.label === 'Check for Updates…'), true)
  assert.match(desktopUpdatePrompt({ kind: 'ready', version: '0.1.5' }, 'en'), /restart for validation/)
  assert.match(publicDesktopUpdateError(new Error('getaddrinfo ENOTFOUND github.com'), 'en'), /Unable to check/)
})

test('更新说明描述桌面应用更新，不混用官方运行时警告', () => {
  const text = desktopUpdatePrompt({ kind: 'available', version: '0.1.5', releaseNotes: '修复托盘' })
  assert.match(text, /0\.1\.5/)
  assert.match(text, new RegExp(DESKTOP_UPDATE_WARNING))
  assert.match(text, /修复托盘/)
})

test('更新说明将 GitHub 的 HTML 和 Markdown 转为支持中英文的纯文本', () => {
  const notes = formatDesktopReleaseNotes('<p><strong>更新说明</strong></p><ul><li>修复中文显示</li><li><a href="https://github.com/MichengAI/dsh-codex-desktop/compare/v1.0.13...v1.0.14">Full Changelog</a></li></ul>\n\n## English\n- [Install guide](https://example.com/install)')
  assert.equal(notes, '更新说明\n- 修复中文显示\n- Full Changelog\nEnglish\n- Install guide: https://example.com/install')
})

test('macOS 更新通道按 CPU 架构隔离', () => {
  assert.equal(desktopUpdateChannel('darwin', 'arm64'), 'latest-arm64')
  assert.equal(desktopUpdateChannel('darwin', 'x64'), 'latest-x64')
  assert.equal(desktopUpdateChannel('win32', 'x64'), undefined)
})

test('更新错误不得回传本地路径', () => {
  assert.equal(publicDesktopUpdateError(new Error('ENOENT: D:\\Tools\\DSH Codex Desktop\\latest.yml')), '桌面端更新失败，请查看桌面日志。')
  assert.match(publicDesktopUpdateError(new Error('getaddrinfo ENOTFOUND github.com')), /无法检查/)
})

test('外层异常包装保留底层进度、错误码和事务号', () => {
  const failure = preserveDesktopUpdateFailure({
    kind: 'error',
    message: '候选槽失败',
    detail: '候选槽缺少 resources/app.asar。',
    overallProgress: 78,
    stageProgress: 0,
    errorCode: 'PACKAGE_INCOMPLETE',
    transactionId: '1142e462-d602-4a80-8fdf-839bf3801285',
  }, '桌面更新失败')
  assert.equal(failure.overallProgress, 78)
  assert.equal(failure.errorCode, 'PACKAGE_INCOMPLETE')
  assert.equal(failure.transactionId, '1142e462-d602-4a80-8fdf-839bf3801285')
})

test('打包配置保留 GitHub 发布源且不再携带旧更新器', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
    repository?: { url?: string }
    build?: { publish?: { provider?: string; owner?: string; repo?: string } | Array<{ provider?: string }> }
  }
  assert.equal(manifest.dependencies?.['electron-updater'], undefined)
  assert.match(String(manifest.repository?.url), /MichengAI\/dsh-codex-desktop/)
  const publish = Array.isArray(manifest.build?.publish) ? manifest.build?.publish[0] : manifest.build?.publish
  assert.equal(publish?.provider, 'github')
})

test('主进程只使用便携 A/B 控制器并在窗口稳定后按策略安排检查', async () => {
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /buildDesktopTrayItems/)
  assert.match(main, /new PortableDesktopUpdater/)
  assert.doesNotMatch(main, /electron-updater|autoUpdater/)
  assert.match(main, /confirmRunningCandidate/)
  assert.match(main, /function checkDesktopUpdate/)
  const startupView = main.indexOf('await createMainWindow(server.url)')
  const startupCheck = main.indexOf('scheduleStartupUpdateCheck()', startupView)
  assert.equal(startupView >= 0 && startupCheck > startupView, true)
  assert.match(main, /shouldCheckForUpdatesOnStartup\(updatePreferences, app\.isPackaged\)/)
  assert.match(main, /checkDesktopUpdate\('background'\)/)
})
