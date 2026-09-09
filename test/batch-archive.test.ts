import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = readFileSync(join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js'), 'utf8')
function extract(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0)
  const end = source.indexOf('\n\t\t}', start)
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end + 5)
}
const api = runInNewContext(`
  const isChannelSession = id => id.startsWith('im:');
  const isScheduleSession = id => id.startsWith('schedule:');
  ${['isTaskSession', 'visibleSessionIds', 'visiblePendingKind', 'pendingInteractionForSession', 'batchArchiveCandidates', 'archiveSelectedSessions'].map(extract).join('\n')}
  ({batchArchiveCandidates, archiveSelectedSessions})
`)
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

test('batch archive excludes archived, running, pending, blank and non-task sessions', () => {
  const byId = {
    safe: {}, running: { running: true }, archived: {}, blank: { blank: true },
    child: { origin: 'subagent' }, channel: { origin: 'im' },
    approval: { pendingInteraction: 'approval' }, question: {}, plan: { pendingInteraction: 'plan-review' },
  }
  assert.deepEqual(plain(api.batchArchiveCandidates({ ids: [...Object.keys(byId), 'safe', 'missing'], byId }, ['archived'], new Map([['question', { kind: 'question' }]]))), ['safe'])
})

test('batch archive is sequential, deduplicated and preserves failed items for retry', async () => {
  const calls: string[] = []
  let active = 0
  const result = await api.archiveSelectedSessions(['a', 'bad', 'a', 'b'], () => ['a', 'bad', 'b'], async (id: string) => {
    assert.equal(active++, 0)
    calls.push(id)
    await Promise.resolve()
    active--
    if (id === 'bad') throw new Error('offline')
  })
  assert.deepEqual(calls, ['a', 'bad', 'b'])
  assert.deepEqual(plain(result), { archived: ['a', 'b'], failed: ['bad'], skipped: [] })
})

test('batch archive rechecks eligibility between operations and does not call skipped IDs', async () => {
  let eligible = ['a', 'b']
  const result = await api.archiveSelectedSessions(['a', 'b', 'removed'], () => eligible, async () => { eligible = [] })
  assert.deepEqual(plain(result), { archived: ['a'], failed: [], skipped: ['b', 'removed'] })
})

test('batch archive exposes confirmation and uses existing archive service, not deletion', () => {
  const component = source.slice(source.indexOf('function BatchArchivePanel('), source.indexOf('function CodexWorkspaceTree('))
  assert.match(component, /data-batch-archive-confirm/)
  assert.match(component, /activeRef\.current/)
  assert.match(component, /setSelected\(outcome\.failed\)/)
  assert.doesNotMatch(component, /deleteSession|localStorage|fetch\(/)
  assert.equal((source.match(/"sessions.batchArchiveHint":/g) ?? []).length, 2)
})
