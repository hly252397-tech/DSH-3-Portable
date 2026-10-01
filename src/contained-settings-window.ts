import type { BrowserWindow, Rectangle, Screen } from 'electron'

/** Electron bounds use DIP, including negative coordinates on secondary displays. */
export function centeredSettingsBounds(parent: Rectangle, workArea: Rectangle): Rectangle {
  const left = Math.max(parent.x, workArea.x)
  const top = Math.max(parent.y, workArea.y)
  const right = Math.min(parent.x + parent.width, workArea.x + workArea.width)
  const bottom = Math.min(parent.y + parent.height, workArea.y + workArea.height)
  // A completely off-screen owner has no visible intersection; keep settings reachable.
  const area = right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : workArea
  const insetX = Math.min(16, Math.floor((area.width - 1) / 2))
  const insetY = Math.min(16, Math.floor((area.height - 1) / 2))
  const width = Math.min(760, area.width - 2 * insetX)
  const height = Math.min(620, area.height - 2 * insetY)
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  }
}

export interface ContainedSettingsWindowOptions {
  /**
   * Windows 会在 show 之后对带父窗口（owner）的窗口再做一次系统级摆放，
   * 可能覆盖 show 前的编程定位。show 触发同步后按这些延时（毫秒）再次校正，
   * 确保 OS 摆放尘埃落定后窗口仍居中于宿主窗口。
   */
  settleDelays?: readonly number[]
}

const DEFAULT_SETTLE_DELAYS: readonly number[] = [80, 400]

/** One binding per settings window; reopening uses `show`, not another subscription. */
export function bindContainedSettingsWindow(
  child: BrowserWindow,
  parent: BrowserWindow | undefined,
  displays: Screen,
  options: ContainedSettingsWindowOptions = {},
): () => void {
  const settleDelays = options.settleDelays ?? DEFAULT_SETTLE_DELAYS
  const settleTimers: ReturnType<typeof setTimeout>[] = []
  const sync = () => {
    if (child.isDestroyed() || parent?.isDestroyed() || parent?.isMinimized()) return
    const owner = parent?.getContentBounds() ?? displays.getPrimaryDisplay().workArea
    const bounds = centeredSettingsBounds(owner, displays.getDisplayMatching(owner).workArea)
    const current = child.getBounds()
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) {
      child.setBounds(bounds)
    }
  }
  // OS 对 owner 子窗口的事后摆放会以 child 自身 move 事件浮出水面，据此拉回。
  const syncAfterSettle = () => {
    sync()
    for (const delay of settleDelays) settleTimers.push(setTimeout(sync, delay))
  }
  parent?.on('move', sync)
  parent?.on('resize', sync)
  parent?.on('restore', sync)
  parent?.on('show', sync)
  child.on('show', syncAfterSettle)
  child.on('move', sync)
  displays.on('display-metrics-changed', sync)
  displays.on('display-removed', sync)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const timer of settleTimers) clearTimeout(timer)
    parent?.removeListener('move', sync)
    parent?.removeListener('resize', sync)
    parent?.removeListener('restore', sync)
    parent?.removeListener('show', sync)
    child.removeListener('show', syncAfterSettle)
    child.removeListener('move', sync)
    child.removeListener('closed', dispose)
    parent?.removeListener('closed', dispose)
    displays.removeListener('display-metrics-changed', sync)
    displays.removeListener('display-removed', sync)
  }
  child.once('closed', dispose)
  parent?.once('closed', dispose)
  sync()
  return dispose
}
