import type { MouseInputEvent, MouseWheelInputEvent, KeyboardInputEvent } from 'electron'

/** Legacy coordinates are already content-view-local DIPs, not shell/window coordinates. */
export function parseForwardedInput(payload: unknown, width: number, height: number): MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as Record<string, unknown>
  if (value.type === 'keydown' || value.type === 'keyup' || value.type === 'char') {
    if (typeof value.keyCode !== 'string' || value.keyCode.length === 0 || value.keyCode.length > 64) return undefined
    return { type: value.type === 'keydown' ? 'keyDown' : value.type === 'keyup' ? 'keyUp' : 'char', keyCode: value.keyCode }
  }
  const { x, y } = value
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || y < 0 || x >= width || y >= height) return undefined
  const point = { x: Math.min(width - 1, Math.round(x)), y: Math.min(height - 1, Math.round(y)) }
  if (value.type === 'wheel') {
    const deltaY = value.deltaY ?? 120
    if (typeof deltaY !== 'number' || !Number.isFinite(deltaY) || Math.abs(deltaY) > 10000) return undefined
    return { type: 'mouseWheel', ...point, deltaX: 0, deltaY }
  }
  if (value.type === 'mousedown' || value.type === 'mouseup' || value.type === 'mousemove') {
    return { type: value.type === 'mousedown' ? 'mouseDown' : value.type === 'mouseup' ? 'mouseUp' : 'mouseMove', ...point, button: 'left', clickCount: 1 }
  }
  return undefined
}
