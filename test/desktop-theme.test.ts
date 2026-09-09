import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_DESKTOP_THEME_PREFERENCES, DESKTOP_THEME_PALETTES, loadDesktopThemePreferences, normalizeDesktopThemeSnapshot, sanitizeDesktopThemePreferences, saveDesktopThemePreferences } from '../src/desktop-theme.js'

test('桌面主题只接受 light/dark 解析结果和内置偏好', () => {
  assert.deepEqual(normalizeDesktopThemeSnapshot('light'), { colorScheme: 'light' })
  assert.deepEqual(normalizeDesktopThemeSnapshot({ colorScheme: 'dark', preference: 'system' }), { colorScheme: 'dark', preference: 'system' })
  assert.deepEqual(normalizeDesktopThemeSnapshot({ colorScheme: 'light', preference: 'custom' }), { colorScheme: 'light' })
  assert.equal(normalizeDesktopThemeSnapshot({ colorScheme: 'sepia', preference: 'dark' }), undefined)
})

test('桌面主题预设跨持久化边界只接受内置值', () => {
  assert.deepEqual(DEFAULT_DESKTOP_THEME_PREFERENCES, { schema: 1, preset: 'qoder' })
  assert.deepEqual(sanitizeDesktopThemePreferences({ schema: 1, preset: 'qoder' }), { schema: 1, preset: 'qoder' })
  assert.deepEqual(sanitizeDesktopThemePreferences({ schema: 1, preset: 'deep-sea' }), { schema: 1, preset: 'deep-sea' })
  assert.deepEqual(sanitizeDesktopThemePreferences({ preset: 'unknown' }), DEFAULT_DESKTOP_THEME_PREFERENCES)
  assert.deepEqual(sanitizeDesktopThemePreferences(null), DEFAULT_DESKTOP_THEME_PREFERENCES)
})

test('桌面主题预设原子保存到便携用户数据子目录并可重新载入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-theme-'))
  const path = join(root, 'shell', 'theme.json')
  try {
    assert.deepEqual(await loadDesktopThemePreferences(path), DEFAULT_DESKTOP_THEME_PREFERENCES)
    assert.deepEqual(await saveDesktopThemePreferences(path, { preset: 'slate' }), { schema: 1, preset: 'slate' })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { schema: 1, preset: 'slate' })
    assert.deepEqual(await loadDesktopThemePreferences(path), { schema: 1, preset: 'slate' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('浅色和深色桌面调色板提供所有原生窗口背景', () => {
  assert.equal(DESKTOP_THEME_PALETTES.light.titleBarBackground, '#ffffff')
  assert.equal(DESKTOP_THEME_PALETTES.light.settingsBackground, '#ffffff')
  assert.equal(DESKTOP_THEME_PALETTES.dark.titleBarBackground, '#181818')
  assert.equal(DESKTOP_THEME_PALETTES.dark.shortcutsBackground, '#1f1f1f')
})
