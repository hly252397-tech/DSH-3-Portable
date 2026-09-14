import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { writeTextFileAtomic } from './atomic-file.js'

export type DesktopColorScheme = 'light' | 'dark'
export type DesktopThemePreference = DesktopColorScheme | 'system'
export type DesktopThemePreset = 'deep-sea' | 'lake' | 'verde' | 'vermilion' | 'slate' | 'gold'

export interface DesktopThemePreferences {
  readonly schema: 1
  readonly preset: DesktopThemePreset
}

export interface DesktopThemeSnapshot {
  readonly colorScheme: DesktopColorScheme
  readonly preference?: DesktopThemePreference
}

export interface DesktopThemePalette {
  readonly aboutBackground: string
  readonly settingsBackground: string
  readonly shellBackground: string
  readonly shortcutsBackground: string
  readonly titleBarBackground: string
  readonly titleBarSymbol: string
}

export const DEFAULT_DESKTOP_THEME_PREFERENCES: DesktopThemePreferences = {
  schema: 1,
  preset: 'deep-sea',
}

export const DESKTOP_THEME_PRESETS: readonly DesktopThemePreset[] = [
  'deep-sea', 'lake', 'verde', 'vermilion', 'slate', 'gold',
]

export const DESKTOP_THEME_PALETTES: Readonly<Record<DesktopColorScheme, DesktopThemePalette>> = {
  light: {
    aboutBackground: '#ffffff',
    settingsBackground: '#ffffff',
    shellBackground: '#ffffff',
    shortcutsBackground: '#ffffff',
    titleBarBackground: '#ffffff',
    titleBarSymbol: '#202020',
  },
  dark: {
    aboutBackground: '#1f1f1f',
    settingsBackground: '#181818',
    shellBackground: '#181818',
    shortcutsBackground: '#1f1f1f',
    titleBarBackground: '#181818',
    titleBarSymbol: '#cccccc',
  },
}

export function normalizeDesktopThemePreset(value: unknown): DesktopThemePreset | undefined {
  return typeof value === 'string' && DESKTOP_THEME_PRESETS.includes(value as DesktopThemePreset)
    ? value as DesktopThemePreset
    : undefined
}

export function sanitizeDesktopThemePreferences(value: unknown): DesktopThemePreferences {
  if (typeof value !== 'object' || value === null) return DEFAULT_DESKTOP_THEME_PREFERENCES
  const preset = normalizeDesktopThemePreset((value as { preset?: unknown }).preset)
  return { schema: 1, preset: preset ?? DEFAULT_DESKTOP_THEME_PREFERENCES.preset }
}

export async function loadDesktopThemePreferences(path: string): Promise<DesktopThemePreferences> {
  try {
    return sanitizeDesktopThemePreferences(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return DEFAULT_DESKTOP_THEME_PREFERENCES
  }
}

export async function saveDesktopThemePreferences(path: string, value: unknown): Promise<DesktopThemePreferences> {
  const preferences = sanitizeDesktopThemePreferences(value)
  await mkdir(dirname(path), { recursive: true })
  await writeTextFileAtomic(path, JSON.stringify(preferences, null, 2) + '\n')
  return preferences
}

export function normalizeDesktopColorScheme(value: unknown): DesktopColorScheme | undefined {
  return value === 'light' || value === 'dark' ? value : undefined
}

export function normalizeDesktopThemeSnapshot(value: unknown): DesktopThemeSnapshot | undefined {
  const legacyColorScheme = normalizeDesktopColorScheme(value)
  if (legacyColorScheme !== undefined) return { colorScheme: legacyColorScheme }
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { colorScheme?: unknown; preference?: unknown }
  const colorScheme = normalizeDesktopColorScheme(candidate.colorScheme)
  if (colorScheme === undefined) return undefined
  const preference = candidate.preference === 'light' || candidate.preference === 'dark' || candidate.preference === 'system'
    ? candidate.preference
    : undefined
  return preference === undefined ? { colorScheme } : { colorScheme, preference }
}
