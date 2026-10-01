import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_PANEL_MIN_VISIBLE_HEIGHT,
  BROWSER_PANEL_MIN_VISIBLE_WIDTH,
  BROWSER_PANEL_SIGNAL_TTL_MS,
  isPanelRawVisible,
  isPanelSignalFresh,
  panelIntersection,
  parseActiveSessionSignal,
  parsePanelCardSignal,
  shouldAcceptPageToken,
  shouldRevokePanel,
  shouldShowNativePanel,
} from '../src/browser-panel-state.js'

// 场景来源：2026-09-21 用户报「浏览器不跟会话走 / 一块白面板」，以及两轮 Codex 评审
// （见 docs/01-当前工作/20260921-移除原生浏览器面板并移植到完整浏览器-方案.md §9–§12）。
// 这一组断言锁住的核心不变式是：**没有当前页面"卡片可见"的信号，原生面板绝不允许可见。**

test('clamp 之前先判交集：飞出屏幕的 raw bounds 必须判为不可见', () => {
  const viewport = { width: 2560, height: 1348 }
  // 页面收起右栏时的真实上报：宿主 div 被 translateX 推到视口右侧之外
  const raw = { x: 2589, y: 42, width: 1398, height: 1299 }
  // 横向零交集（宽 0），纵向仍在屏幕内 —— 交集本身足以判"不可见"
  assert.deepEqual(panelIntersection(raw, viewport), { width: 0, height: 1299 })
  assert.equal(isPanelRawVisible(raw, viewport), false)
  // 反例（本修复要防的错法）：先 clamp 就变成"完整落在屏幕内"，证据被抹掉
  const clamped = { x: Math.min(raw.x, viewport.width - raw.width), y: raw.y, width: raw.width, height: raw.height }
  assert.equal(clamped.x, 1162)
  assert.equal(isPanelRawVisible(clamped, viewport), true) // 说明"先 clamp 再判"会漏判
})

test('部分可见要按交集阈值判：露出太少的卡片不当作在屏幕上', () => {
  const viewport = { width: 2560, height: 1348 }
  // 只露出 100px 宽的一段
  const sliver = { x: 2460, y: 42, width: 1000, height: 1299 }
  assert.deepEqual(panelIntersection(sliver, viewport), { width: 100, height: 1299 })
  assert.equal(isPanelRawVisible(sliver, viewport), false)
  // 露出宽度刚好到阈值
  const ok = { x: 2560 - BROWSER_PANEL_MIN_VISIBLE_WIDTH, y: 42, width: 1000, height: 1299 }
  assert.equal(isPanelRawVisible(ok, viewport), true)
  // 高度不足
  const shortPanel = { x: 1000, y: 1348 - (BROWSER_PANEL_MIN_VISIBLE_HEIGHT - 1), width: 1000, height: 400 }
  assert.equal(isPanelRawVisible(shortPanel, viewport), false)
})

test('零尺寸 / 缺失 bounds 一律不可见', () => {
  const viewport = { width: 2560, height: 1348 }
  assert.equal(isPanelRawVisible(undefined, viewport), false)
  assert.equal(isPanelRawVisible({ x: 0, y: 0, width: 0, height: 0 }, viewport), false)
  assert.equal(isPanelRawVisible({ x: 100, y: 100, width: 1398, height: 0 }, viewport), false)
})

test('心跳 TTL：从未收到信号 / 静默超时都不新鲜', () => {
  const now = 1_000_000
  assert.equal(isPanelSignalFresh(0, now), false) // 从未收到
  assert.equal(isPanelSignalFresh(now - BROWSER_PANEL_SIGNAL_TTL_MS, now), true) // 刚好在 TTL 上
  assert.equal(isPanelSignalFresh(now - BROWSER_PANEL_SIGNAL_TTL_MS - 1, now), false) // 超时 1ms
  assert.equal(isPanelSignalFresh(now + 5_000, now), true) // 时钟回拨不算超时
})

test('只认显式的卡片可见性字段：官方导航状态上报不得当心跳', () => {
  assert.equal(parsePanelCardSignal({ canBack: true, canForward: false }), undefined)
  assert.equal(parsePanelCardSignal(undefined), undefined)
  assert.equal(parsePanelCardSignal('visible'), undefined)
  assert.equal(parsePanelCardSignal({ browserPanelCard: 'visible' }), 'visible')
  assert.equal(parsePanelCardSignal({ browserPanelCard: 'hidden' }), 'hidden')
  assert.equal(parsePanelCardSignal({ browserPanelCard: 'absent' }), 'absent')
  assert.equal(parsePanelCardSignal({ browserPanelCard: 'whatever' }), undefined)
})

test('主进程唯一判据：owner + 卡片可见 + raw 可见 + 信号新鲜，四者缺一不可', () => {
  const now = 2_000_000
  const base = {
    ownerPresent: true,
    cardState: 'visible' as const,
    rawVisible: true,
    lastSignalAt: now - 500,
    now,
  }
  assert.equal(shouldShowNativePanel(base), true)
  assert.equal(shouldShowNativePanel({ ...base, ownerPresent: false }), false)
  assert.equal(shouldShowNativePanel({ ...base, cardState: 'hidden' as const }), false)
  assert.equal(shouldShowNativePanel({ ...base, cardState: 'absent' as const }), false)
  assert.equal(shouldShowNativePanel({ ...base, cardState: undefined }), false)
  assert.equal(shouldShowNativePanel({ ...base, rawVisible: false }), false)
  assert.equal(shouldShowNativePanel({ ...base, lastSignalAt: 0 }), false)
  assert.equal(shouldShowNativePanel({ ...base, lastSignalAt: now - BROWSER_PANEL_SIGNAL_TTL_MS - 1 }), false)
})

test('撤销判据：卡片隐藏 / 缺失 / 信号超时都要撤销，健康态不撤销', () => {
  const now = 3_000_000
  const healthy = { ownerPresent: true, cardState: 'visible' as const, lastSignalAt: now - 100, now }
  assert.equal(shouldRevokePanel(healthy), false)
  assert.equal(shouldRevokePanel({ ...healthy, cardState: 'hidden' as const }), true) // 收起右栏
  assert.equal(shouldRevokePanel({ ...healthy, cardState: 'absent' as const }), true) // 切到没有浏览器卡的会话
  assert.equal(shouldRevokePanel({ ...healthy, lastSignalAt: now - 60_000 }), true) // 页面重载/崩溃
  assert.equal(shouldRevokePanel({ ...healthy, ownerPresent: false }), false) // 没有 owner 无从撤销
})

test('迟到 IPC 判据：旧页面实例的令牌不得重新占住面板', () => {
  // 导航/重载后主进程清空令牌 ⇒ 新页面实例的第一条 claim 建立它
  assert.equal(shouldAcceptPageToken('page-B', undefined), true)
  assert.equal(shouldAcceptPageToken('page-A', 'page-A'), true) // 同一页面实例的后续 claim（切标签/重报）
  assert.equal(shouldAcceptPageToken('page-A', 'page-B'), false) // 僵尸 renderer 的迟到 claim ⇒ 拒绝
  assert.equal(shouldAcceptPageToken(undefined, 'page-B'), true) // 兼容未带令牌的旧客户端
})

test('活动会话信号：只接受合法字符串，越界/空/非字符串一律忽略', () => {
  assert.equal(parseActiveSessionSignal({ activeSessionId: 'session-abc' }), 'session-abc')
  assert.equal(parseActiveSessionSignal({ activeSessionId: '' }), undefined)
  assert.equal(parseActiveSessionSignal({ activeSessionId: 42 }), undefined)
  assert.equal(parseActiveSessionSignal({ activeSessionId: 'x'.repeat(121) }), undefined)
  assert.equal(parseActiveSessionSignal({ browserPanelCard: 'visible' }), undefined)
  assert.equal(parseActiveSessionSignal(undefined), undefined)
})
