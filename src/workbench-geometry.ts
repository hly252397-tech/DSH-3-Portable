/** One result for rendered width, drag frames and conversation reservation.
 * maximumWidth is supplied in CSS pixels by the desktop layout owner.
 * A hidden/closed panel must never acquire the positive minimum width.
 */
export function resolveWorkbenchWidth(requested: number, viewport: number, maximumWidth: number, compact: boolean): number {
  if (compact || !Number.isFinite(requested) || requested <= 0 || !Number.isFinite(viewport) || viewport <= 0) return 0
  const maximum = Math.min(Math.max(0, viewport - 400), Number.isFinite(maximumWidth) && maximumWidth > 0 ? maximumWidth : Math.max(0, viewport - 640))
  return Math.min(maximum, Math.max(Math.min(286, maximum), Math.round(requested)))
}
