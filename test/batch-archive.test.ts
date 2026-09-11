import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

// 用例针对的是实机 profile 里已构建的 codex-ui 产物；全新检出（如 CI）没有这份文件，
// 缺失时整组跳过而不是失败——本地实机仍然全量受保护。
const liveClientPath = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js')
const haveLiveClient = existsSync(liveClientPath)
const source = haveLiveClient ? readFileSync(liveClientPath, 'utf8') : ''
function extract(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0)
  const end = source.indexOf('\n\t\t}', start)
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end + 5)
}
let api: Record<string, (...args: never[]) => unknown> | undefined
function liveApi(): Record<string, (...args: never[]) => unknown> {
  api ??= runInNewContext(`
  const isChannelSession = id => id.startsWith('im:');
  const isScheduleSession = id => id.startsWith('schedule:');
  ${['isTaskSession', 'visibleSessionIds', 'visiblePendingKind', 'pendingInteractionForSession', 'batchArchiveCandidates', 'archiveSelectedSessions'].map(extract).join('\n')}
  ({batchArchiveCandidates, archiveSelectedSessions})
`) as Record<string, (...args: never[]) => unknown>
  return api
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

test('batch archive excludes archived, running, pending, blank and non-task sessions', t => {
  if (!haveLiveClient) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  const byId = {
    safe: {}, running: { running: true }, archived: {}, blank: { blank: true },
    child: { origin: 'subagent' }, channel: { origin: 'im' },
    approval: { pendingInteraction: 'approval' }, question: {}, plan: { pendingInteraction: 'plan-review' },
  }
  const api = liveApi()
  const batchArchiveCandidates = api.batchArchiveCandidates as (
    input: { ids: string[]; byId: Record<string, unknown> },
    selected: string[],
    interactions: Map<string, { kind: string }>,
  ) => string[]
  assert.deepEqual(plain(batchArchiveCandidates({ ids: [...Object.keys(byId), 'safe', 'missing'], byId }, ['archived'], new Map([['question', { kind: 'question' }]]))), ['safe'])
})

test('batch archive is sequential, deduplicated and preserves failed items for retry', async t => {
  if (!haveLiveClient) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  const calls: string[] = []
  let active = 0
  const archiveSelectedSessions = liveApi().archiveSelectedSessions as (ids: string[], eligible: () => string[], archive: (id: string) => Promise<void>) => Promise<{ archived: string[]; failed: string[]; skipped: string[] }>
  const result = await archiveSelectedSessions(['a', 'bad', 'a', 'b'], () => ['a', 'bad', 'b'], async (id: string) => {
    assert.equal(active++, 0)
    calls.push(id)
    await Promise.resolve()
    active--
    if (id === 'bad') throw new Error('offline')
  })
  assert.deepEqual(calls, ['a', 'bad', 'b'])
  assert.deepEqual(plain(result), { archived: ['a', 'b'], failed: ['bad'], skipped: [] })
})

test('batch archive rechecks eligibility between operations and does not call skipped IDs', async t => {
  if (!haveLiveClient) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  let eligible = ['a', 'b']
  const archiveSelectedSessions = liveApi().archiveSelectedSessions as (ids: string[], eligible: () => string[], archive: () => Promise<void>) => Promise<{ archived: string[]; failed: string[]; skipped: string[] }>
  const result = await archiveSelectedSessions(['a', 'b', 'removed'], () => eligible, async () => { eligible = [] })
  assert.deepEqual(plain(result), { archived: ['a'], failed: [], skipped: ['b', 'removed'] })
})

test('batch archive exposes confirmation and uses existing archive service, not deletion', t => {
  if (!haveLiveClient) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  const component = source.slice(source.indexOf('function BatchArchivePanel('), source.indexOf('function CodexWorkspaceTree('))
  assert.match(component, /data-batch-archive-confirm/)
  assert.match(component, /activeRef\.current/)
  assert.match(component, /setSelected\(outcome\.failed\)/)
  assert.doesNotMatch(component, /deleteSession|localStorage|fetch\(/)
  assert.equal((source.match(/"sessions.batchArchiveHint":/g) ?? []).length, 2)
})
