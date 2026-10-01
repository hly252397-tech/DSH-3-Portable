import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync('assets/whale-particles.js', 'utf8')
const html = readFileSync('assets/startup.html', 'utf8')

test('startup fallback and particles share image coordinates including transparent margins', () => {
  const motion: Record<string, number> = {}
  const code = source.slice(source.indexOf('  function updateMotion('), source.indexOf('  function addParticleShape('))
  const api = vm.runInNewContext(code + '; ({updateMotion, updateParticlePosition})', {
    motion, cssWidth: 316, cssHeight: 237,
    imageBounds: { minX: 6, minY: 36, width: 246, height: 184 }, maskSize: 256,
    fallback: { naturalWidth: 512, naturalHeight: 512 },
    reducedMotion: { matches: false },
    clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
  })
  api.updateMotion(0)
  assert.equal(motion.drawWidth, 316 * .94 * 246 / 256)
  assert.equal(motion.left, 316 * .03 + 316 * .94 * 6 / 256)
  assert.equal(motion.top, (237 - 316 * .94) / 2 + 316 * .94 * 36 / 256)
  const points = [0, 1].flatMap(nx => [0, 1].map(ny => ({
    nx, ny, depth: .5, tail: nx, radius: 1, edge: true,
    waveSin: 0, waveCos: 1, shimmerSin: 0, shimmerCos: 1,
    // Legacy entry offsets deliberately remain in the fixture: they must have no effect.
    arrivalDelay: 100, entryX: (nx - .5) * 38, entryY: (ny - .5) * 29,
    x: 0, y: 0, drawRadius: 0,
  })))
  const widths = [0, 100, 250, 500, 1000, 1500].map(elapsed => {
    api.updateMotion(elapsed)
    for (const point of points) api.updateParticlePosition(point, elapsed)
    return Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))
  })
  assert.ok(widths.every(Number.isFinite))
  assert.ok(Math.max(...widths) - Math.min(...widths) < 3, widths.join(', '))
})

test('startup mark is stable across ordinary window sizes and retains fallback and reduced motion', () => {
  assert.match(html, /width: min\(316px, calc\(100vw - 48px\), calc\(100vh - 160px\)\)/)
  assert.match(html, /inset: 50% auto auto 3%;\s*width: 94%;\s*height: auto;/)
  assert.doesNotMatch(source, /particle\.entry[XY]|arrivalDelay/)
  assert.match(source, /function handleFallbackError\(/)
  assert.match(source, /prefers-reduced-motion: reduce/)
  assert.match(source, /progressObserver\?\.disconnect\(\)/)
})
