/**
 * 浏览器面板的**呈现状态判定**（纯逻辑，便于单测）。
 *
 * 背景（2026-09-21，事故与评审记录见
 * `docs/01-当前工作/20260921-移除原生浏览器面板并移植到完整浏览器-方案.md` §9–§12）：
 * 原生浏览器面板由主进程持有，而"拥有"它的卡片在页面里、**按会话**存在；两边各自维护
 * "面板可见性"且没有握手 ⇒ 切会话 / 页面重载 / 收起侧栏 / 卡片卸载 任一条路径失配，外壳就会
 * 继续画自己那层面板底（白 / 幽灵面板），并出现"浏览器不跟会话走、上个会话内容串到新会话"。
 *
 * 修法的核心不变式：**没有来自当前页面的"卡片可见"信号，原生面板绝不允许可见。**
 * 判定全部收归主进程；页面只提供它能看到的事实（卡片是否可见），不反向纠正主进程状态。
 */

export interface PanelRect {
  x: number
  y: number
  width: number
  height: number
}

/** 面板心跳 TTL：页面每秒上报一次卡片可见性，静默超过该值即视为页面/卡片已消失。 */
export const BROWSER_PANEL_SIGNAL_TTL_MS = 4000

/** raw bounds 与视口的交集下限：小于该值即当作"卡片不在屏幕上"。 */
export const BROWSER_PANEL_MIN_VISIBLE_WIDTH = 200
export const BROWSER_PANEL_MIN_VISIBLE_HEIGHT = 160

/** `rawBounds ∩ viewport` 的交集尺寸。 */
export function panelIntersection(
  raw: PanelRect,
  viewport: { width: number; height: number },
): { width: number; height: number } {
  const left = Math.max(0, Math.min(raw.x, viewport.width))
  const right = Math.max(0, Math.min(raw.x + raw.width, viewport.width))
  const top = Math.max(0, Math.min(raw.y, viewport.height))
  const bottom = Math.max(0, Math.min(raw.y + raw.height, viewport.height))
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * 卡片是否真的在屏幕上。
 *
 * **顺序不能反：先算 raw ∩ viewport，最后才允许 clamp。**
 * clamp 会把"已经飞出屏幕"的证据抹掉——实测例：raw `x=2589 / width=1000`、viewport `2560`
 * （页面把右栏收起时的真实值）交集为 0，应判不可见；若先 clamp 成 `x=1560` 就变成"完整落在屏幕内"。
 */
export function isPanelRawVisible(
  raw: PanelRect | undefined,
  viewport: { width: number; height: number },
  min: { width: number; height: number } = { width: BROWSER_PANEL_MIN_VISIBLE_WIDTH, height: BROWSER_PANEL_MIN_VISIBLE_HEIGHT },
): boolean {
  if (raw === undefined) return false
  if (!(raw.width > 0) || !(raw.height > 0)) return false
  const hit = panelIntersection(raw, viewport)
  return hit.width >= min.width && hit.height >= min.height
}

/** 页面信号是否还新鲜（`lastSignalAt <= 0` 表示从未收到过信号 ⇒ 不新鲜）。 */
export function isPanelSignalFresh(lastSignalAt: number, now: number, ttl: number = BROWSER_PANEL_SIGNAL_TTL_MS): boolean {
  return lastSignalAt > 0 && now - lastSignalAt <= ttl
}

/** 页面上报的卡片可见性。 */
export type PanelCardState = 'visible' | 'hidden' | 'absent'

/**
 * 解析页面上报里的卡片可见性。
 * 未提供该字段时返回 `undefined` —— 官方页面自身的导航状态上报（只带 canBack 等）**不得**被当成面板心跳。
 */
export function parsePanelCardSignal(value: unknown): PanelCardState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as { browserPanelCard?: unknown }).browserPanelCard
  return raw === 'visible' || raw === 'hidden' || raw === 'absent' ? raw : undefined
}

/**
 * 原生面板是否允许可见——主进程的唯一判据（生命周期三项）。
 * `occluded` / `settingsYields` / 视口让位等既有开关由调用方另行参与，这里只回答：
 * ① 有 owner；② 卡片明确可见；③ raw bounds 与视口交集够大；④ 信号新鲜（TTL）。
 */
export function shouldShowNativePanel(input: {
  ownerPresent: boolean
  cardState: PanelCardState | undefined
  rawVisible: boolean
  lastSignalAt: number
  now: number
  ttl?: number
}): boolean {
  if (input.ownerPresent !== true) return false
  if (input.cardState !== 'visible') return false
  if (input.rawVisible !== true) return false
  return isPanelSignalFresh(input.lastSignalAt, input.now, input.ttl)
}

/** 需要撤销（hide + 清 owner/bounds）的状态。 */
export function shouldRevokePanel(input: {
  ownerPresent: boolean
  cardState: PanelCardState | undefined
  lastSignalAt: number
  now: number
  ttl?: number
}): boolean {
  if (input.ownerPresent !== true) return false
  return !shouldShowNativePanel({ ...input, rawVisible: true })
}

/**
 * 是否接受这条 claim 携带的"页面实例令牌"。
 *
 * 目的：拒绝**迟到 IPC**——旧页面实例（僵尸 renderer / 上一次加载）晚到的 `show` 不得重新占住面板。
 * 约定：页面每次加载生成一个令牌；`currentToken === undefined` 表示"本页面实例还没有人 claim 过"
 * （导航/重载后由主进程清空，见 `onRendererLifecycle`），这时第一条 claim 建立令牌；此后必须一致。
 * 未携带令牌的旧客户端（兼容窗口）放行。
 */
export function shouldAcceptPageToken(claimToken: string | undefined, currentToken: string | undefined): boolean {
  if (claimToken === undefined) return true
  if (currentToken === undefined) return true
  return claimToken === currentToken
}

/** 从页面上报里解析活动会话 id（页面侧只认 `aria-selected="true"` 那条会话项）。 */
export function parseActiveSessionSignal(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as { activeSessionId?: unknown }).activeSessionId
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 120) return undefined
  return raw
}
