import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
test('retired automation layouts close only matching tabs across panes and session changes', t => {
  const file = resolve('Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js')
  if (!existsSync(file)) return t.skip('实机本地插件缺失')
  const source = readFileSync(file, 'utf8')
  const start = source.indexOf('function retireAutomationTabs(')
  const end = source.indexOf('let standaloneHost', start)
  const retire = new Function(source.slice(start, end) + '; return retireAutomationTabs;')()
  let listener: (() => void) | undefined
  let state: any = { splits: { kind: 'split', children: [{ kind: 'leaf', tabs: [{ id: 'a', type: 'space-automation' }, { id: 'git', type: 'git' }] }] }, bottomSplits: { kind: 'leaf', tabs: [{ id: 'b', type: 'space-automation' }, { id: 'diff', type: 'diff' }] }, floats: [{ tab: { id: 'c', type: 'space-automation' } }] }
  const closed: string[] = []
  const off = retire({ getSnapshot: () => ({ state }), subscribeState: (fn: () => void) => { listener = fn; return () => { listener = undefined } }, closeTab: (id: string) => { closed.push(id); listener?.() } })
  assert.deepEqual(closed, ['a', 'b', 'c'])
  state = { splits: { kind: 'leaf', tabs: [{ id: 'next', type: 'space-automation' }, { id: 'terminal', type: 'terminal' }] } }
  listener?.(); assert.deepEqual(closed, ['a', 'b', 'c', 'next'])
  off(); assert.equal(listener, undefined)
})
