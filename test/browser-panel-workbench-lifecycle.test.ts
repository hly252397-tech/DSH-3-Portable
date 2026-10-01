import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const clientPath = new URL('../../Data/DSH/profiles/web/local/dsh-hj-workbench/lib/client.js', import.meta.url)

test('a delayed hidden-card lookup cannot hide a newly visible browser card', async t => {
  if (!existsSync(clientPath)) return t.skip('实机 workbench 客户端缺失（CI 全新检出）')
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('const hideNow = () => {')
  const end = source.indexOf('const push = () => {', start)
  assert.ok(start >= 0 && end > start, 'browser lifecycle hide implementation is present')
  assert.match(source, /window\.__dshHjBrowserLifecycle !== true/, 'lifecycle guard must not be stored on frozen contextBridge object')
  assert.match(source, /!Object\.isFrozen\(BP\)/, 'frozen contextBridge methods must not be monkey-patched')

  let card: 'visible' | 'hidden' = 'hidden'
  let resolveTabs!: (value: { owner: string }) => void
  const hiddenOwners: string[] = []
  const context: any = {
    cardState: () => card,
    lease: null,
    origHide: async (owner: string) => { hiddenOwners.push(owner) },
    BP: { tabs: () => new Promise(resolve => { resolveTabs = resolve }) },
    Promise,
  }
  runInNewContext(source.slice(start, end) + '\nthis.hideNow = hideNow;', context)
  context.hideNow()
  card = 'visible'
  resolveTabs({ owner: 'new-browser-owner' })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(hiddenOwners, [], 'the old hidden decision must not revoke the new owner')

  card = 'hidden'
  context.hideNow()
  resolveTabs({ owner: 'stale-browser-owner' })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(hiddenOwners, ['stale-browser-owner'], 'a still-hidden card must release its owner')
})
