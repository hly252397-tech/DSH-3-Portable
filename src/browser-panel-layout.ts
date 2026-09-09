import type { BrowserPanelBounds } from './shell-contract.js'

const MINIMUM_PANEL_WIDTH = 280
const MINIMUM_PANEL_HEIGHT = 240
const DOWNLOADS_DRAWER_EMPTY_HEIGHT = 112
const DOWNLOADS_DRAWER_MAX_HEIGHT = 248
const DOWNLOADS_DRAWER_HEADER_AND_PADDING = 58
const DOWNLOADS_DRAWER_ROW_HEIGHT = 52

/**
 * Convert an untrusted CSS rectangle reported by the DSH renderer into a clipped,
 * integer rectangle inside the DSH content viewport. Invalid/off-screen
 * rectangles are rejected so a compromised renderer cannot cover the titlebar.
 */
export function normalizeBrowserPanelBounds(
  value: unknown,
  viewportWidth: number,
  viewportHeight: number,
  zoomFactor = 1,
): BrowserPanelBounds | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  const numbers = [input.x, input.y, input.width, input.height]
  if (!numbers.every(item => typeof item === 'number' && Number.isFinite(item))) return
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return

  // Electron bounds are DIP, while getBoundingClientRect reports CSS pixels.
  // Use the trusted sender's zoom, not devicePixelRatio (which also includes DPI).
  const x = Math.round((input.x as number) * zoomFactor)
  const y = Math.round((input.y as number) * zoomFactor)
  const width = Math.round((input.width as number) * zoomFactor)
  const height = Math.round((input.height as number) * zoomFactor)
  if (![x, y, width, height].every(Number.isFinite)) return
  if (width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return

  const left = Math.max(0, x)
  const top = Math.max(0, y)
  const right = Math.min(Math.round(viewportWidth), x + width)
  const bottom = Math.min(Math.round(viewportHeight), y + height)
  const clippedWidth = right - left
  const clippedHeight = bottom - top
  if (clippedWidth < MINIMUM_PANEL_WIDTH || clippedHeight < MINIMUM_PANEL_HEIGHT) return
  return { x: left, y: top, width: clippedWidth, height: clippedHeight }
}

/**
 * Keep an empty downloads drawer compact and grow it only when records exist.
 * The panel height cap prevents the drawer from consuming most of a short
 * browser workspace. This value is shared with the renderer through state so
 * the DOM overlay and native page view always use the same geometry.
 */
export function resolveBrowserDownloadsDrawerHeight(
  open: boolean,
  downloadCount: number,
  panelHeight: number,
): number {
  if (!open) return 0
  const availableHeight = Math.max(0, Math.floor(panelHeight * 0.36))
  const maximumHeight = Math.min(DOWNLOADS_DRAWER_MAX_HEIGHT, availableHeight)
  const desiredHeight = downloadCount <= 0
    ? DOWNLOADS_DRAWER_EMPTY_HEIGHT
    : Math.min(
      DOWNLOADS_DRAWER_MAX_HEIGHT,
      DOWNLOADS_DRAWER_HEADER_AND_PADDING + Math.min(4, Math.floor(downloadCount)) * DOWNLOADS_DRAWER_ROW_HEIGHT,
    )
  return Math.max(0, Math.min(desiredHeight, maximumHeight))
}
