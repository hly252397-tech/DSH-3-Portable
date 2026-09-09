import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const { createBrowserLibrary } = createRequire(import.meta.url)(resolve('browser-library.cjs'))

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-extension-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const browserDataRoot = join(root, 'browser')
  mkdirSync(browserDataRoot)
  const extensionPath = join(browserDataRoot, 'extensions', 'managed')
  writeFileSync(join(browserDataRoot, 'library.json'), JSON.stringify({ extensions: [{ id: 'managed', path: extensionPath, enabled: true }] }))
  const library = createBrowserLibrary({ browserDataRoot, stateRoot: root, safeStorage: { isEncryptionAvailable: () => false }, appendLog() {} })
  const loaded = new Map([['foreign', { id: 'foreign', path: join(root, 'foreign') }]])
  let attempts = 0
  let fail = false
  const native = {
    getAllExtensions: () => [...loaded.values()],
    removeExtension: (id: string) => { loaded.delete(id) },
    loadExtension: async (path: string) => {
      attempts++
      if (fail) throw new Error('invalid manifest')
      const entry = { id: 'native-managed', path }
      loaded.set(entry.id, entry)
      return entry
    },
  }
  return { library, loaded, session: { extensions: native }, attempts: () => attempts, fail: (value: boolean) => { fail = value } }
}

test('extension toggles reconcile native state immediately and preserve unrelated extensions', async t => {
  const f = fixture(t)
  await Promise.all([f.library.loadExtensions(f.session), f.library.loadExtensions(f.session)])
  assert.equal(f.attempts(), 1)
  assert.ok(f.loaded.has('native-managed'))
  f.library.toggleExtension('managed', false)
  await f.library.loadExtensions(f.session)
  assert.deepEqual([...f.loaded.keys()], ['foreign'])
  f.library.toggleExtension('managed', true)
  await f.library.loadExtensions(f.session)
  assert.ok(f.loaded.has('native-managed'))
  f.library.setSettings({ loadExtensions: false })
  await f.library.loadExtensions(f.session)
  assert.deepEqual([...f.loaded.keys()], ['foreign'])
  f.library.setSettings({ loadExtensions: true })
  await f.library.loadExtensions(f.session)
  assert.ok(f.loaded.has('native-managed'))
})

test('failed native extension loading reports the error and can recover on retry', async t => {
  const f = fixture(t)
  f.fail(true)
  const failed = await f.library.loadExtensions(f.session)
  assert.equal(failed[0].loaded, false)
  assert.match(f.library.publicSnapshot().extensions[0].error, /invalid manifest/)
  f.fail(false)
  const retried = await f.library.loadExtensions(f.session)
  assert.equal(retried[0].loaded, true)
  assert.equal(f.library.publicSnapshot().extensions[0].error, '')
})
