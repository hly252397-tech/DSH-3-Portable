import type { BrowserPanelBounds } from './shell-contract.js'

const MINIMUM_PANEL_WIDTH = 280
const MINIMUM_PANEL_HEIGHT = 240
const DOWNLOADS_DRAWER_MAX_HEIGHT = 248
/** 浏览器工作台面板的绝对宽度上限：无论比例被拖到多大，面板都不得吃掉
 * 对话区的舒适宽度。
 * 🔴 2026-09-14 与页面侧统一：`assets/theme.css` 对 `body .nArs4W_panel` 的钳制
 * 依据的是**官方内容下限 680px**（`clamp(680, 64%, 920)` 的下限），即"视口 − 1040px"
 * （图标轨 40 + 侧栏 252 + 对话 680 + 间距），该值同时被 `test/workbench-panel-clamp.test.ts`
 * 与 `codex-ui-style-ownership` 系列钉住。此前这里写 900，页面写 1040，**而且一个在 DIP、
 * 一个在 CSS px**——缩放下两者会差出上百像素：卡片比原生视图宽就是用户看到的右侧空白
 * （卡片白底露出），反过来视图会压住对话列。现由外壳按此常量算出上限、折成 CSS px 后
 * 经 `--dsh-browser-panel-max-width` 下发，页面只认这一个值，策略只剩一处。 */
export const MAXIMUM_PANEL_WIDTH_MARGIN = 1040

/** 面板被页面整块隐藏的视口阈值（**CSS px**），与 `assets/theme.css` 的
 *  `@media (max-width: 1100px) { body .nArs4W_panel { display: none !important } }` 同值。
 *  页面在窄视口选择"面板先让位、对话独占"；外壳若不知道这件事，就会继续按最小宽度
 *  画原生浏览器视图 —— 用户看到的是「一条 280px 的浏览器 + 右边一片白」（2026-09-14 实机截图）。
 *  两者必须共用同一把尺子，由 `browser-panel-layout.test.ts` 的跨模块一致性用例钉住。 */
export const MINIMUM_PANEL_VIEWPORT_CSS = 1100

/**
 * 视口窄到页面会隐藏面板时，外壳是否也应停止绘制浏览器面板。
 * 比较在 **CSS px** 坐标系里做（与页面的媒体查询同一坐标系）：`视口 DIP ÷ 网页缩放`。
 * 输入不可信（非有限数、非正数）时返回 false —— 宁可不隐藏，也不要因坏数据把面板关掉。
 */
export function shouldHideBrowserPanel(viewportDip: number, zoomFactor: number): boolean {
  if (!Number.isFinite(viewportDip) || !Number.isFinite(zoomFactor) || viewportDip <= 0 || zoomFactor <= 0) return false
  return viewportDip / zoomFactor < MINIMUM_PANEL_VIEWPORT_CSS
}

/**
 * Cap a requested browser workspace panel width so the panel never consumes
 * the conversation area: at most `viewportWidth - MAXIMUM_PANEL_WIDTH_MARGIN`
 * (the remainder keeps the icon rail, the 252px sidebar and the official 680px
 * conversation floor), and never below the panel's own 280px minimum (very
 * narrow windows hide the panel instead — the page through its media query,
 * the shell through `shouldHideBrowserPanel`).
 */
export function capBrowserWorkspacePanelWidth(viewportWidth: number, requestedWidth: number): number {
  const maximum = Math.max(280, viewportWidth - MAXIMUM_PANEL_WIDTH_MARGIN)
  return Math.min(requestedWidth, maximum, Math.max(280, viewportWidth))
}

/**
 * 面板宽度上限换算到**页面 CSS px**：`assets/theme.css` 用它钳住页面侧的面板占位
 * （`body .nArs4W_panel`），使其与原生视图/chrome 用同一把尺子。
 * 背景（2026-09-14 实机截图实证）：页面侧原先自带一条 `calc(100vw - 1040px)` 的钳制，
 * 外壳侧却是 `viewport - 900px` 的 DIP 钳制 —— 两把尺子、两个数、还差一个缩放因子，
 * 于是"卡片宽度"与"原生视图宽度"可以差出上百像素：差出来的那条就是用户看到的
 * 右侧空白（卡片白底露出），反过来视图也会压住对话列。
 * 改成单一来源后，页面只认外壳下发的值，`viewport - MAXIMUM_PANEL_WIDTH_MARGIN` 是唯一的策略常量。
 */
export function browserPanelMaxWidthCss(panelWidthDip: number, zoomFactor: number): number {
  if (!Number.isFinite(panelWidthDip) || !Number.isFinite(zoomFactor) || zoomFactor <= 0 || panelWidthDip <= 0) return 0
  return Math.max(MINIMUM_PANEL_WIDTH, Math.round(panelWidthDip / zoomFactor))
}

const DOWNLOADS_DRAWER_EMPTY_HEIGHT = 112
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
  // 对话保护钳制：页面报告的占位矩形可能太宽（页面内钳制只改了 .nArs4W_panel 的
  // max-width，但页面 reportBounds 时用的是 clip 前的 offsetWidth），原生视图按此
  // 定位就会比对话列底线更宽。用同一把尺子裁到 viewport − 900px 后再返回。
  const maximumWidth = Math.max(MINIMUM_PANEL_WIDTH, viewportWidth - MAXIMUM_PANEL_WIDTH_MARGIN)
  const clampedRight = Math.min(right, left + maximumWidth)
  const clippedWidth = clampedRight - left
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
