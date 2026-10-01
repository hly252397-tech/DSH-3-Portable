import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const html = readFileSync('assets/shell.html', 'utf8')
const render = html.match(/function renderDesktopUpdate\(value\)\{[\s\S]*?\n    \}/)?.[0]
assert.ok(render)
// renderDesktopUpdate delegates the rollback capsule to renderRollbackCapsule
// (see rollback-notice.test.ts). This harness only exercises the settings
// button, so it stubs that collaborator instead of pulling in its DOM.
function sandbox(target: unknown) {
  return runInNewContext(`(${render})`, { document: { getElementById: () => target }, shellZh: () => true, renderRollbackCapsule: () => {} })
}
function fixture() {
  const properties = new Map<string, string>()
  const button = { dataset: {} as Record<string, string>, disabled: false, title: '', ariaLabel: '',
    style: { setProperty: (key: string, value: string) => properties.set(key, value) } }
  const apply = sandbox(button)
  return { button, properties, apply: (kind: string, overallProgress: unknown = 0, packaged = true) => apply({ packaged, status: { kind, overallProgress } }) }
}

test('indeterminate update stages spin instead of displaying a tiny progress wedge', () => {
  const f = fixture()
  for (const phase of ['checking', 'verifying', 'building', 'deploying', 'validating']) {
    f.apply(phase, 1)
    assert.equal(f.button.dataset.indicator, 'spinner', phase)
    assert.equal(f.button.disabled, false, 'settings remain accessible while updates run')
  }
})
test('download progress is finite and clamped; unknown progress spins', () => {
  const f = fixture()
  for (const [input, expected] of [[0, '0'], [1, '0.01'], [50, '0.5'], [100, '1'], [-5, '0'], [130, '1']] as const) {
    f.apply('downloading', input)
    assert.equal(f.button.dataset.indicator, 'progress')
    assert.equal(f.properties.get('--update-progress'), expected)
  }
  for (const input of [undefined, null, 'invalid', Infinity]) {
    // Call the real renderer directly so undefined is not replaced by the fixture default.
    const apply = sandbox(f.button)
    apply({ packaged: true, status: { kind: 'downloading', overallProgress: input } })
    assert.equal(f.button.dataset.indicator, 'spinner')
    assert.equal(f.properties.get('--update-progress'), '0')
  }
})
test('terminal states clear progress and recover button availability', () => {
  const f = fixture()
  for (const phase of ['idle', 'none', 'available', 'ready', 'completed', 'error', 'rolled-back']) {
    f.apply('downloading', 70)
    f.apply(phase, 100)
    assert.equal(f.button.dataset.indicator, 'none', phase)
    assert.equal(f.button.dataset.busy, 'false')
    assert.equal(f.properties.get('--update-progress'), '0')
    assert.equal(f.button.disabled, false)
    assert.equal(f.button.title, f.button.ariaLabel)
  }
  f.apply('idle', 0, false)
  assert.equal(f.button.disabled, false, 'unpackaged builds can still open settings')
})
test('ring is hollow, non-interactive, motion-aware and does not leave completed badge', () => {
  assert.match(html, /mask:radial-gradient\(closest-side,transparent calc\(100% - 2px\)/)
  assert.match(html, /\.nav\.update-indicator::before\{[^}]*pointer-events:none/)
  assert.match(html, /prefers-reduced-motion:reduce\)\{\.nav\.update-indicator\[data-indicator="spinner"\]::before\{animation:none/)
  assert.doesNotMatch(html, /data-phase="completed"\]::after/)
  assert.match(html, /data-phase="error"\]::after/)
  assert.match(html, /data-phase="available"\]::after/)
  assert.match(html, /id="settings-btn"[^>]*data-action="settings"/)
  assert.doesNotMatch(html, /id="update-btn"|data-action="check-updates"/)
})
