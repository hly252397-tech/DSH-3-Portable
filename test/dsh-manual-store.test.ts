import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, unlink, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const entry = new URL('../../plugins/dsh-manual/lib/store.js', import.meta.url).href
const sourceEntry = new URL('../../plugins/dsh-manual/lib/sources.js', import.meta.url).href
const run = promisify(execFile)
const { createManualStore } = await import(entry) as any
const { sourceId, digest } = await import(sourceEntry) as any

async function fixture(options: Record<string, unknown> = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-manual-'))
  const root = path.join(base, 'manual')
  const sourceRoot = path.join(base, 'project')
  await mkdir(sourceRoot)
  const store = createManualStore({ root, sourceRoot, sources: [], seed: false, ...options })
  await store.initialize()
  return { base, root, sourceRoot, store }
}

const isCode = (code: string) => (error: any) => error.code === code

test('manual seed is installed once and readable as actual Markdown', async () => {
  const { root, sourceRoot } = await fixture()
  const store = createManualStore({ root, sourceRoot, sources: [] })
  assert.equal((await store.initialize()).seedsCreated, 1)
  const original = await store.read({ id: 'generated/overview' })
  assert.match(original.content, /dsh_manual（operation: search）/u)
  assert.equal(original.status, 'reference')
  assert.equal(original.freshness, 'bundled')
  assert.equal(original.editedExternally, false)
  const restarted = createManualStore({ root, sourceRoot, sources: [] })
  assert.equal((await restarted.initialize()).seedsCreated, 0)
  assert.equal((await restarted.read({ id: original.id })).revision, original.revision)
  assert.match(await readFile(path.join(root, 'generated', 'overview.md'), 'utf8'), /^<!-- dsh-manual:/u)
})

test('manual edits use CAS; models remain draft and generated chapters are protected', async () => {
  const { store } = await fixture()
  const first = await store.edit({ id: 'notes/browser', title: '浏览器', content: '# 浏览器\n保存经验', expectedRevision: null, author: 'model' })
  assert.equal(first.status, 'draft')
  const next = await store.edit({ id: first.id, content: '更新经验', expectedRevision: first.revision, author: 'user', status: 'verified' })
  assert.equal(next.status, 'draft')
  await assert.rejects(store.edit({ id: first.id, content: '覆盖', expectedRevision: first.revision }), (error: any) => error.code === 'REVISION_CONFLICT' && error.currentRevision === next.revision)
  await assert.rejects(store.edit({ id: 'generated/overview', content: 'fake', expectedRevision: null }), isCode('READ_ONLY'))
  await assert.rejects(store.edit({ id: 'notes/missing-revision', content: 'fake' }), isCode('INVALID_ARGUMENT'))
})

test('external Markdown edits immediately affect revision and full-text fallback search', async () => {
  const { root, store } = await fixture()
  const first = await store.edit({ id: 'notes/external', content: 'initial', expectedRevision: null })
  await writeFile(path.join(root, 'notes', 'external.md'), '# 外部编辑\n索引服务不可用时仍然可以检索。', 'utf8')
  const external = await store.read({ id: first.id })
  assert.notEqual(external.revision, first.revision)
  assert.equal(external.title, '外部编辑')
  assert.equal(external.author, 'external')
  assert.equal((await store.search({ query: '索引服务' })).items[0].id, first.id)
  await assert.rejects(store.edit({ id: first.id, content: 'lost update', expectedRevision: first.revision }), isCode('REVISION_CONFLICT'))
  const next = await store.edit({ id: first.id, content: 'combined', expectedRevision: external.revision })
  const restored = await store.restore({ id: first.id, revision: external.revision, expectedRevision: next.revision })
  assert.equal(restored.content, external.content)
})

test('history is append-only; restore creates a new revision and preserves previous records', async () => {
  const { root, store } = await fixture()
  const first = await store.edit({ id: 'notes/history', content: 'one', expectedRevision: null, reason: 'first' })
  const second = await store.edit({ id: first.id, content: 'two', expectedRevision: first.revision, reason: 'second' })
  const before = await store.history({ id: first.id })
  assert.equal(before.total, 2)
  assert.ok(before.items.every((item: any) => item.committed))
  const snapshotDir = path.join(root, 'history', digest(first.id), 'snapshots')
  const saved = await readFile(path.join(snapshotDir, `${first.revision}.json`), 'utf8')
  const restored = await store.restore({ id: first.id, revision: first.revision, expectedRevision: second.revision, author: 'user' })
  assert.equal(restored.content, 'one')
  assert.notEqual(restored.revision, first.revision)
  assert.equal((await store.history({ id: first.id })).total, 3)
  assert.equal(await readFile(path.join(snapshotDir, `${first.revision}.json`), 'utf8'), saved)
  await assert.rejects(store.restore({ id: first.id, revision: second.revision, expectedRevision: second.revision }), isCode('REVISION_CONFLICT'))
})

test('failed atomic rename leaves the old file and recoverable history intact', async () => {
  let fail = false
  const { root, store } = await fixture({ io: { rename: async (from: string, to: string) => {
    if (fail) throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' })
    return rename(from, to)
  } } })
  const first = await store.edit({ id: 'notes/atomic', content: 'keep me', expectedRevision: null })
  const bytes = await readFile(path.join(root, 'notes', 'atomic.md'), 'utf8')
  fail = true
  await assert.rejects(store.edit({ id: first.id, content: 'do not commit', expectedRevision: first.revision }), isCode('EACCES'))
  assert.equal(await readFile(path.join(root, 'notes', 'atomic.md'), 'utf8'), bytes)
  assert.equal((await store.read({ id: first.id })).revision, first.revision)
  assert.deepEqual(await readdir(path.join(root, 'notes')), ['atomic.md'])
  const histories = await store.history({ id: first.id })
  assert.equal(histories.items.filter((item: any) => !item.committed).length, 1)
  fail = false
  assert.equal((await store.edit({ id: first.id, content: 'recovered', expectedRevision: first.revision })).content, 'recovered')
})

test('missing post-rename commit marker is recovered before the next edit', async () => {
  const { root, store } = await fixture()
  const first = await store.edit({ id: 'notes/crash', content: 'saved before crash', expectedRevision: null })
  const events = path.join(root, 'history', digest(first.id), 'events')
  const marker = (await readdir(events)).find((name) => name.endsWith('.commit.json'))!
  await unlink(path.join(events, marker))
  assert.equal((await store.history({ id: first.id })).items[0].committed, true)
  await store.edit({ id: first.id, content: 'after restart', expectedRevision: first.revision })
  assert.ok((await store.history({ id: first.id })).items.every((item: any) => item.committed && !item.historyPending))
})

test('separate processes cannot silently overwrite the same expected revision', async () => {
  const { root, store } = await fixture()
  const first = await store.edit({ id: 'notes/concurrent', content: 'initial', expectedRevision: null })
  const worker = `const {createManualStore}=await import(process.argv[1]);const s=createManualStore({root:process.argv[2],sources:[],seed:false});try{const r=await s.edit({id:'notes/concurrent',content:process.argv[4],expectedRevision:process.argv[3]});console.log(JSON.stringify({ok:true,revision:r.revision}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}`
  const outputs = await Promise.all(['worker-a', 'worker-b'].map((text) => run(process.execPath, ['--input-type=module', '-e', worker, entry, root, first.revision, text], { windowsHide: true })))
  const results = outputs.map((output) => JSON.parse(output.stdout.trim()))
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(results.find((result) => !result.ok).code, 'REVISION_CONFLICT')
  assert.equal((await store.history({ id: first.id })).total, 2)
})

test('traversal, drive paths, ADS and generated restore never cross the manual root', async () => {
  const { store } = await fixture()
  for (const id of ['notes/../outside', '../notes/a', 'notes\\bad', 'C:/secret', '/notes/a', 'notes/a:stream', 'notes/%2e%2e/out', 'notes/a.md']) {
    await assert.rejects(store.read({ id }), isCode('INVALID_ID'))
    await assert.rejects(store.edit({ id, content: 'bad', expectedRevision: null }), isCode('INVALID_ID'))
  }
  await assert.rejects(store.restore({ id: 'generated/overview', revision: '0'.repeat(64), expectedRevision: null }), isCode('READ_ONLY'))
})

test('junction ancestors and hard-linked documents cannot escape or alias outside data', async () => {
  const { base, root, store } = await fixture()
  const outside = path.join(base, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'target.md'), 'outside private content', 'utf8')
  await symlink(outside, path.join(root, 'notes', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(store.read({ id: 'notes/escape/target' }), isCode('UNSAFE_PATH'))
  await assert.rejects(store.edit({ id: 'notes/escape/target', content: 'overwrite', expectedRevision: null }), isCode('UNSAFE_PATH'))
  await link(path.join(outside, 'target.md'), path.join(root, 'notes', 'hard.md'))
  await assert.rejects(store.read({ id: 'notes/hard' }), isCode('UNSAFE_PATH'))
  assert.equal(await readFile(path.join(outside, 'target.md'), 'utf8'), 'outside private content')
  const aliased = createManualStore({ root: path.join(root, 'notes', 'escape', 'new-manual'), seed: false, sources: [] })
  await assert.rejects(aliased.initialize(), isCode('UNSAFE_PATH'))
})

test('bounded results count UTF-8 including wrapper and metadata', async () => {
  const { root } = await fixture()
  const store = createManualStore({ root, sources: [], seed: false, maxResultBytes: 1600, maxDocumentBytes: 30000 })
  const content = '手册😀含义'.repeat(1200)
  await store.edit({ id: 'notes/multibyte', content, expectedRevision: null })
  const result = await store.read({ id: 'notes/multibyte', limit: 30000 })
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1600)
  assert.equal(result.totalLength, content.length)
  assert.equal(result.truncated, true)
  assert.ok(result.nextOffset > 0)
  assert.equal(result.content, content.slice(0, result.nextOffset))
  assert.ok(!/[\uD800-\uDBFF]$/u.test(result.content), 'do not split an emoji surrogate pair')
  assert.ok(Buffer.byteLength(JSON.stringify(await store.list())) <= 1600)
  await assert.rejects(store.edit({ id: 'notes/huge', content: '汉'.repeat(10000), expectedRevision: null }), isCode('DOCUMENT_TOO_LARGE'))
})

test('incremental source sync updates only changed generated files and preserves author notes', async () => {
  const { root, sourceRoot } = await fixture()
  const relative = 'docs/03-技术架构/example.md'
  await mkdir(path.join(sourceRoot, 'docs', '03-技术架构'), { recursive: true })
  await writeFile(path.join(sourceRoot, ...relative.split('/')), '# 操作说明\n第一版', 'utf8')
  const store = createManualStore({ root, sourceRoot, sources: [{ path: relative, title: '操作说明' }], seed: false })
  const note = await store.edit({ id: 'notes/private-note', content: '人工解释不被覆盖', expectedRevision: null })
  const report = await store.sync()
  assert.deepEqual(report.updated, [sourceId(relative)])
  const first = await store.read({ id: sourceId(relative) })
  assert.equal(first.source.path, relative)
  assert.equal(first.freshness, 'current')
  assert.equal(first.source.hash, digest('# 操作说明\n第一版'))
  assert.deepEqual((await store.sync()).unchanged, [first.id])
  assert.equal((await store.read({ id: first.id })).revision, first.revision)
  await writeFile(path.join(sourceRoot, ...relative.split('/')), '# 操作说明\n第二版', 'utf8')
  assert.equal((await store.read({ id: first.id })).freshness, 'stale')
  assert.deepEqual((await store.sync()).updated, [first.id])
  assert.match((await store.read({ id: first.id })).content, /第二版/u)
  assert.equal((await store.read({ id: note.id })).revision, note.revision)
  await unlink(path.join(sourceRoot, ...relative.split('/')))
  assert.equal((await store.sync()).stale.length, 1)
  const stale = await store.read({ id: first.id })
  assert.equal(stale.freshness, 'stale')
  assert.match(stale.content, /第二版/u)
  const restoredSource = createManualStore({ root, sourceRoot, sources: [], seed: false })
  assert.equal((await restoredSource.read({ id: first.id })).freshness, 'unavailable')
})

test('generated external changes become explicit conflicts, never overwritten by sync', async () => {
  const { root, sourceRoot } = await fixture()
  const relative = 'docs/03-技术架构/example.md'
  await mkdir(path.join(sourceRoot, 'docs', '03-技术架构'), { recursive: true })
  await writeFile(path.join(sourceRoot, ...relative.split('/')), '# 原说明', 'utf8')
  const store = createManualStore({ root, sourceRoot, sources: [relative], seed: false })
  await store.sync()
  const id = sourceId(relative)
  const file = path.join(root, `${id}.md`)
  await writeFile(file, `${await readFile(file, 'utf8')}\n人工补充`, 'utf8')
  await writeFile(path.join(sourceRoot, ...relative.split('/')), '# 新说明', 'utf8')
  assert.equal((await store.sync()).conflicts[0].id, id)
  assert.match((await store.read({ id })).content, /人工补充/u)
})

test('allowlist rejects private trees; package projection and markdown redaction omit credentials', async () => {
  const { root, sourceRoot } = await fixture()
  for (const relative of ['Data/DSH/.credentials.yaml', 'Data/DSH/sessions/a.md', '工作空间/company.md', 'docs/01-当前工作/private.md', '../docs/03-技术架构/a.md', 'plugins/demo/credentials.json']) {
    assert.throws(() => createManualStore({ root, sourceRoot, sources: [relative], seed: false }), (error: any) => ['SOURCE_NOT_ALLOWED', 'UNSAFE_PATH'].includes(error.code))
  }
  await mkdir(path.join(sourceRoot, 'plugins', 'demo'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'plugins', 'demo', 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3', description: 'demo plugin', password: 'dont-copy', scripts: { build: 'SECRET_SCRIPT' } }), 'utf8')
  await writeFile(path.join(sourceRoot, 'plugins', 'demo', 'README.md'), '# Demo\napiKey: SECRET_VALUE\nAuthorization: Bearer abcdefg\n', 'utf8')
  const store = createManualStore({ root, sourceRoot, sources: ['plugins/demo/package.json', 'plugins/demo/README.md'], seed: false })
  assert.equal((await store.sync()).updated.length, 2)
  const pkg = await store.read({ id: sourceId('plugins/demo/package.json') })
  assert.match(pkg.content, /1\.2\.3/u)
  assert.doesNotMatch(pkg.content, /dont-copy|SECRET_SCRIPT/u)
  const readme = await store.read({ id: sourceId('plugins/demo/README.md') })
  assert.doesNotMatch(readme.content, /SECRET_VALUE|abcdefg/u)
  assert.match(readme.content, /REDACTED/u)
})

test('one missing or unreadable source does not suppress successfully synced sources', async () => {
  const { root, sourceRoot } = await fixture()
  await mkdir(path.join(sourceRoot, 'plugins', 'ok'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'plugins', 'ok', 'README.md'), '# Working source', 'utf8')
  const store = createManualStore({ root, sourceRoot, sources: ['plugins/absent/README.md', 'plugins/ok/README.md'], seed: false })
  const report = await store.sync()
  assert.equal(report.failed.length, 1)
  assert.equal(report.updated.length, 1)
  assert.equal((await store.search({ query: 'Working' })).items.length, 1)
})

test('one malformed Markdown document does not suppress healthy list/search results', async () => {
  const { root } = await fixture()
  await mkdir(path.join(root, 'notes'), { recursive: true })
  await writeFile(path.join(root, 'notes', 'healthy.md'), '# Healthy\nworking body', 'utf8')
  await writeFile(path.join(root, 'notes', 'broken.md'), 'x'.repeat(256 * 1024 + 1), 'utf8')
  const store = createManualStore({ root, sources: [], seed: false })
  const listed = await store.list()
  assert.ok(listed.items.some((item: any) => item.id === 'notes/healthy'))
  assert.ok(listed.issues?.some((issue: any) => issue.id === 'notes/broken'))
  const searched = await store.search({ query: 'working' })
  assert.equal(searched.items.length, 1)
  assert.equal(searched.items[0].id, 'notes/healthy')
  assert.ok(searched.issues?.some((issue: any) => issue.id === 'notes/broken'))
})

test('default sync discovers bounded local plugin README and package metadata', async () => {
  const { root } = await fixture()
  const local = path.join(root, 'Data', 'DSH', 'profiles', 'web', 'local', '@demo', 'dsh-module')
  await mkdir(local, { recursive: true })
  await writeFile(path.join(local, 'package.json'), JSON.stringify({ name: '@demo/dsh-module', version: '1.2.3', description: 'A local module' }), 'utf8')
  await writeFile(path.join(local, 'README.md'), '# Module guide\nUse this module for bounded tasks.', 'utf8')
  const store = createManualStore({ root, sourceRoot: root, seed: false })
  const report = await store.sync()
  assert.ok(report.updated.some((id: string) => id === sourceId('Data/DSH/profiles/web/local/@demo/dsh-module/README.md')))
  assert.ok(report.updated.some((id: string) => id === sourceId('Data/DSH/profiles/web/local/@demo/dsh-module/package.json')))
  const found = await store.search({ query: 'bounded' })
  assert.equal(found.items.length, 1)
  assert.equal(found.items[0].module, '@demo/dsh-module')
})

test('live lock waits are bounded and never steal an active writer lock', async () => {
  const { root, store } = await fixture({ lockTimeoutMs: 50 })
  const lock = path.join(root, 'state', 'write.lock')
  const bytes = JSON.stringify({ pid: process.pid, token: 'other-writer' })
  await writeFile(lock, bytes, 'utf8')
  await assert.rejects(store.edit({ id: 'notes/locked', content: 'no', expectedRevision: null }), isCode('LOCK_TIMEOUT'))
  assert.equal(await readFile(lock, 'utf8'), bytes)
  await unlink(lock)
  assert.equal((await store.edit({ id: 'notes/locked', content: 'yes', expectedRevision: null })).content, 'yes')
})
