import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

// 实机 profile 里的 sidebar-spaces 产物；全新检出（如 CI）缺失时相关用例跳过。
const spacesClientPath = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js')
const haveLiveSpacesClient = existsSync(spacesClientPath)

async function harness(fetcher?: typeof fetch) {
  let api: any
  const source = (await readFile(spacesClientPath, 'utf8'))
    .replace('exports.apply = apply;', 'exports.test = { normalizeExtensionCatalog, filterExtensions, readExtensionData }; exports.apply = apply;')
  runInNewContext(source, { URL, AbortSignal, fetch: fetcher, window: { __ModuleLoader__: { load(def: any) { api = def.factory(() => ({})).test } } } })
  return api
}
const row = (name: string, category: string | string[], added = '2026-09-01') => ({ name, category, owner: 'author', url: `https://github.com/test/${name}`, description: { zh: `${name} 中文说明` }, added })
const fixture = { registry: { categories: { skill: { zh: '技能包' }, tools: { en: 'Tools' } }, plugins: [row('alpha', 'skill'), row('beta', ['tools', 'notify'], '2026-09-04'), row('gamma', 'remote')] } }

test('catalog preserves genuine categories, copy and package metadata', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await harness(), data = h.normalizeExtensionCatalog(fixture)
  assert.equal(data.rows.length, 3)
  assert.equal(data.rows[0].description, 'alpha 中文说明')
  assert.equal(data.rows[0].category[0], 'skill')
  assert.equal(data.categories.tools.zh, 'tools')
})

test('malformed catalogs and unsafe external links are rejected', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await harness()
  for (const value of [{}, { registry: { plugins: [], categories: null } }, { registry: { ...fixture.registry, plugins: [null] } }]) {
    assert.throws(() => h.normalizeExtensionCatalog(value))
  }
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com']) {
    assert.throws(() => h.normalizeExtensionCatalog({ registry: { ...fixture.registry, plugins: [{ ...row('test', []), url }] } }))
  }
})

test('search combines all words and category and group filters; sorting does not mutate catalog', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await harness(), { rows } = h.normalizeExtensionCatalog(fixture)
  const filtered = (group: string, category: string, query: string, sort = 'latest') => Array.from(h.filterExtensions(rows, group, category, query, sort), (r: any) => r.name)
  assert.deepEqual(filtered('plugins', 'all', ''), ['beta', 'alpha', 'gamma'])
  assert.deepEqual(filtered('plugins', 'all', '', 'name'), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(filtered('skill', 'all', ''), ['alpha'])
  assert.deepEqual(filtered('connections', 'all', ''), ['beta', 'gamma'])
  assert.deepEqual(filtered('connections', 'tools', 'BETA author'), ['beta'])
  assert.deepEqual(filtered('plugins', 'all', '中文 no-match'), [])
  assert.equal(rows[0].name, 'alpha')
})

test('catalog reads use same-origin GET without caching or mutations', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  let options: RequestInit | undefined
  const h = await harness((async (_url: any, init: RequestInit) => { options = init; return new Response(JSON.stringify(fixture)) }) as typeof fetch)
  const result = await h.readExtensionData('/dsh-market/registry', new AbortController().signal)
  assert.equal(result.registry.plugins.length, 3)
  assert.equal(options?.credentials, 'same-origin')
  assert.equal(options?.cache, 'no-store')
  assert.equal(options?.body, undefined)
  assert.equal(options?.method, undefined)
})

test('HTTP failures and aborted requests never return a fake successful catalog', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const failing = await harness((async () => new Response('unavailable', { status: 502 })) as typeof fetch)
  await assert.rejects(failing.readExtensionData('/dsh-market/registry', new AbortController().signal), /502/)
  const controller = new AbortController(); controller.abort()
  const aborted = await harness((async (_url: any, options: RequestInit) => { options.signal!.throwIfAborted(); return new Response('{}') }) as typeof fetch)
  await assert.rejects(aborted.readExtensionData('/dsh-market/registry', controller.signal))
})

test('extension surface has distinct content and does not install or reload on entry', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const source = await readFile(join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js'), 'utf8')
  const component = source.slice(source.indexOf('function ExtensionApp()'), source.indexOf('function StandaloneWorkbench('))
  assert.match(component, /AbortController/)
  assert.match(component, /return \(\) => controller.abort\(\)/)
  assert.match(component, /dss-extension-page/)
  assert.match(component, /filterExtensions/)
  assert.match(component, /openExtensionManager/)
  assert.doesNotMatch(component, /\/dsh-market\/(install|restart|update)["']|location.reload|method: "POST"/)
})
