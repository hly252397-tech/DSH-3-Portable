import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const catalogModule = import(pathToFileURL(resolve('plugins/dsh-system-awareness/lib/catalog.js')).href)
const options = { metadataRefreshMs: 0, maxManifestBytes: 4096, maxModules: 10 }
const schema = (name: string, description = name) => ({ name, description, parameters: { type: 'object', properties: { input: { type: 'string' } } } })

async function profile() {
  const dir = await mkdtemp(join(tmpdir(), 'system-awareness-catalog-'))
  const moduleDir = join(dir, 'node_modules', 'example-module')
  await mkdir(moduleDir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['example-module', '../secrets', 'missing-module'] } } }))
  await writeFile(join(moduleDir, 'package.json'), JSON.stringify({ name: 'example-module', version: '1.0.0', description: 'Example browser module' }))
  await writeFile(join(moduleDir, 'dsh-capabilities.json'), JSON.stringify({ title: '浏览器', whenToUse: ['读取网页'], tools: [{ name: 'read_page', whenToUse: ['打开并读取网页内容'] }, { name: 'hidden_tool', whenToUse: ['hidden_tool_secret'] }] }))
  await writeFile(join(dir, '.credentials.yaml'), 'NEVER_READ_CREDENTIAL_SENTINEL')
  return { dir, moduleDir, context: { dir, name: 'test', installAnchor: join(dir, 'installation', 'package.json') } }
}

test('catalog filters tool hints by scope, records honest module state, and ignores arbitrary profile files', async () => {
  const { createCatalog } = await catalogModule
  const p = await profile()
  const catalog = createCatalog(p.context, options)
  const snapshot = catalog.snapshot([schema('read_page')], [schema('read_page')], [{ options: { id: 'example', name: 'example-module' }, fiber: { state: 2 } }])
  assert.equal(snapshot.modules.length, 2)
  assert.equal(snapshot.modules[0].installed, true)
  assert.equal(snapshot.modules[1].installed, false)
  assert.deepEqual(snapshot.modules[0].loadEvidence, [{ id: 'example', state: 'active' }])
  assert.deepEqual(snapshot.tools[0].whenToUse, ['打开并读取网页内容'])
  assert.doesNotMatch(JSON.stringify(snapshot), /hidden_tool|NEVER_READ_CREDENTIAL_SENTINEL|secrets/)
})

test('catalog revision changes with visible schemas, metadata and loader state, but not hidden tools', async () => {
  const { createCatalog } = await catalogModule
  const p = await profile()
  const catalog = createCatalog(p.context, options)
  const first = catalog.snapshot([schema('read_page')], [schema('read_page')])
  const repeat = catalog.snapshot([schema('read_page')], [schema('read_page')])
  assert.equal(repeat.revision, first.revision)
  const changed = catalog.snapshot([schema('read_page', 'changed description')], [schema('read_page')])
  assert.notEqual(changed.revision, first.revision)
  await writeFile(join(p.moduleDir, 'package.json'), JSON.stringify({ version: '2.0.0' }))
  assert.notEqual(catalog.snapshot([schema('read_page')], [schema('read_page')]).revision, first.revision)
  const failed = catalog.snapshot([schema('read_page')], [schema('read_page')], [{ options: { id: 'example', name: 'example-module' }, fiber: { state: 3 } }])
  assert.equal(failed.modules[0].loadEvidence[0].state, 'failed')
})

test('catalog distinguishes PTC wire entry from callable tools and preserves whole schemas under byte limits', async () => {
  const { createCatalog, queryCatalog, renderAwareness } = await catalogModule
  const p = await profile()
  const catalog = createCatalog(p.context, options)
  const snapshot = catalog.snapshot([schema('read_page'), schema('dsh_capabilities')], [schema('run_code')])
  assert.equal(snapshot.mode, 'ptc')
  assert.equal(snapshot.tools.find((tool: any) => tool.name === 'read_page').invocation, 'run_code-sdk')
  const result = queryCatalog(snapshot, { mode: 'detail', query: 'read_page' }, 65536)
  assert.equal(result.tools[0].parameters.type, 'object')
  assert.match(renderAwareness(snapshot, 4096), /仅直接调用 run_code/)
  const before = JSON.stringify(snapshot)
  snapshot.tools[0].parameters = { description: '中文'.repeat(20000) }
  const giant = queryCatalog(snapshot, { mode: 'detail' }, 2048)
  assert.ok(Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(giant) }])) <= 2048)
  assert.equal(giant.truncated, true)
  assert.deepEqual(snapshot.wireTools, ['run_code'])
  assert.notEqual(JSON.stringify(snapshot), before, 'only the test schema mutation should change the snapshot')
  for (const args of [{ limit: 0 }, { offset: -1 }, { mode: 'execute' }]) assert.throws(() => queryCatalog(snapshot, args, 4096))
  const page = queryCatalog(snapshot, { mode: 'tools', limit: 1, offset: 1 }, 65536)
  assert.equal(page.tools.length, 1)
  const exactBytes = Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(page) }]))
  assert.deepEqual(queryCatalog(snapshot, { mode: 'tools', limit: 1, offset: 1 }, exactBytes), page)
  assert.ok(Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(queryCatalog(snapshot, { mode: 'tools', limit: 1, offset: 1 }, exactBytes - 1)) }])) <= exactBytes - 1)
})

test('bounded metadata failures remain visible without loading plugin source', async () => {
  const { createCatalog } = await catalogModule
  const p = await profile()
  await writeFile(join(p.moduleDir, 'package.json'), 'x'.repeat(5000))
  const snapshot = createCatalog(p.context, options).snapshot([], [])
  assert.equal(snapshot.modules[0].installed, true)
  assert.equal(snapshot.modules[0].metadataReadable, false)
  assert.equal(snapshot.modules[0].metadataStatus, 'metadata-too-large-or-not-file')
  assert.equal(createCatalog(undefined, options).snapshot([], []).profileStatus, 'no-profile-context')
})
