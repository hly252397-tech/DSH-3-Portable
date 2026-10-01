import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isScheduledCheckDue, P3TinyMonitor } from '../lib/market.js'
import { WatchStore } from '../lib/storage.js'

function createMonitor(root, overrides = {}) {
  return new P3TinyMonitor({
    store: new WatchStore(root),
    config: {
      sourceUrls: ['mock://fixed'],
      sourceAllowlist: [],
      enableMockSource: true,
      thresholdCny: 1500,
      maxResultsPerRun: 30,
      retryCount: 0,
      timeoutMs: 5_000,
      currencyRates: { CNY: 1 },
      ...overrides,
    },
  })
}

test('mock source drives the full pipeline to exactly one threshold alert', async t => {
  const root = await mkdtemp(join(tmpdir(), 'p3-watch-pipeline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const monitor = createMonitor(root)
  const result = await monitor.check('command')
  assert.equal(result.run.status, 'success')
  assert.equal(result.run.sampleCount, 3)
  assert.equal(result.run.trustedCount, 3)
  assert.equal(result.run.alertCount, 1)
  assert.equal(result.alerts[0].listing.price, 1200)
  assert.equal(result.alerts[0].listing.unitCny, 1200)
  assert.ok(result.alerts[0].reasons.some(reason => reason.includes('1500')))
  const state = await monitor.status()
  assert.equal(Object.keys(state.state.listings).length, 3)
  assert.ok(Object.keys(state.state.listings).every(key => key.startsWith('mock:')))
  assert.equal(Object.keys(state.state.alerts).length, 1)
})

test('the same listing does not alert again on the next weekly (168h) cycle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'p3-watch-cycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const monitor = createMonitor(root)
  const first = await monitor.check('schedule')
  assert.equal(first.alerts.length, 1)
  const second = await monitor.check('schedule')
  assert.equal(second.run.sampleCount, 3)
  assert.equal(second.alerts.length, 0)
  const state = await monitor.status()
  assert.equal(Object.keys(state.state.alerts).length, 1)
})

test('a cheaper price for the same listing alerts again after the prior alert', async t => {
  const root = await mkdtemp(join(tmpdir(), 'p3-watch-drop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const monitor = createMonitor(root)
  await monitor.check('schedule')
  const state = await monitor.status()
  const droppedKey = 'mock:mock-below-threshold'
  assert.equal(state.state.listings[droppedKey].unitCny, 1200)
  const { evaluateAlerts } = await import('../lib/core.js')
  const lowered = { ...state.state.listings[droppedKey], unitCny: 900, totalCny: 900, price: 900 }
  const evaluation = evaluateAlerts([lowered], state.state, { thresholdCny: 1500 })
  assert.equal(evaluation.alerts.length, 1)
  assert.ok(evaluation.alerts[0].reasons.some(reason => reason.includes('下降')))
})

test('scheduled check becomes due only after the configured interval has elapsed', () => {
  const now = Date.parse('2026-09-19T12:00:00Z')
  const hours = 3_600_000
  const config = { checkIntervalHours: 168 }
  assert.equal(isScheduledCheckDue({}, config, now), true)
  const recentState = { lastRun: { completedAt: new Date(now - 100 * hours).toISOString() } }
  assert.equal(isScheduledCheckDue(recentState, config, now), false)
  const dueState = { lastRun: { completedAt: new Date(now - 169 * hours).toISOString() } }
  assert.equal(isScheduledCheckDue(dueState, config, now), true)
  const boundaryState = { lastRun: { completedAt: new Date(now - 168 * hours).toISOString() } }
  assert.equal(isScheduledCheckDue(boundaryState, config, now), true)
  const startedOnly = { lastRun: { startedAt: new Date(now - 169 * hours).toISOString() } }
  assert.equal(isScheduledCheckDue(startedOnly, config, now), true)
})
