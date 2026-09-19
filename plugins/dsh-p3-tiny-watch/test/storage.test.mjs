import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WatchStore } from '../lib/storage.js'

test('persists state and append-only audit files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'p3-watch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new WatchStore(root)
  const listing = {
    key: 'example:1', title: 'P3 Tiny', capturedAt: '2026-09-13T00:00:00.000Z',
    unitCny: 1200, flags: [], confidence: 1,
  }
  const alert = { key: listing.key, listing, reasons: ['price'], createdAt: '2026-09-13T00:00:01.000Z' }
  const run = { runId: 'run-1', completedAt: '2026-09-13T00:00:02.000Z', status: 'success' }
  await store.recordRun(run, [listing], [alert])
  const state = await store.load()
  assert.equal(state.lastRun.runId, 'run-1')
  assert.equal(state.listings['example:1'].seenCount, 1)
  assert.equal(state.alerts['example:1'].unitCny, 1200)
  assert.match(await readFile(join(root, 'runs.jsonl'), 'utf8'), /run-1/)
  assert.match(await readFile(join(root, 'alerts.jsonl'), 'utf8'), /example:1/)
})

test('returns an empty state for a missing state file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'p3-watch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = await new WatchStore(root).load()
  assert.equal(state.schemaVersion, 1)
  assert.deepEqual(state.listings, {})
})
