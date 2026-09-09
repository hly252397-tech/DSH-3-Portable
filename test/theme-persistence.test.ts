import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

async function themeHarness(save: (value: unknown) => Promise<unknown>) {
  const source = await readFile(resolve('assets/theme.js'), 'utf8')
  const stored = new Map<string, string>()
  const document = { documentElement: { dataset: { colorScheme: 'light' }, style: { setProperty() {} } } }
  const window: Record<string, any> = {
    location: { search: '' }, addEventListener() {}, dispatchEvent() {},
    dshShell: { updateThemePreferences: save },
  }
  runInNewContext(source, { window, document, URLSearchParams, location: window.location,
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    MutationObserver: class { observe() {} },
  })
  return { api: window.DshThemes, stored }
}

test('theme stays at the committed preset while persistence is pending or rejected', async () => {
  let rejectSave!: (reason: Error) => void
  const h = await themeHarness(() => new Promise((_resolve, reject) => { rejectSave = reject }))
  const saving = h.api.set('lake')
  assert.equal(h.api.saved(), 'qoder')
  assert.equal(h.stored.size, 0)
  rejectSave(new Error('disk unavailable'))
  await assert.rejects(saving, /disk unavailable/)
  assert.equal(h.api.saved(), 'qoder')
  assert.equal(h.stored.size, 0)
})

test('theme becomes visible and locally cached after native persistence commits', async () => {
  const requests: unknown[] = []
  const h = await themeHarness(async value => { requests.push(value) })
  assert.equal(await h.api.set('lake'), 'lake')
  assert.equal(h.api.saved(), 'lake')
  assert.equal(h.stored.get('dshShellTheme'), 'lake')
  assert.equal(JSON.stringify(requests), '[{"preset":"lake"}]')
})
