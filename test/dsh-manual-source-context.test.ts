import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const { resolveManualSourceContext, discoverLocalSources, sourceId, validateSource, DEFAULT_SOURCES } = await import(pathToFileURL(resolve('plugins/dsh-manual/lib/sources.js')).href)
const { createManualStore } = await import(pathToFileURL(resolve('plugins/dsh-manual/lib/store.js')).href)
const rule = 'docs/03-技术架构/构建更新与定制防回退规则.md'
const identity = 'Data/DSH/profiles/web/local/dsh-example/README.md'
const isCode = (code: string) => (error: any): boolean => error.code === code

async function fixture() {
  const portableRoot = await mkdtemp(join(tmpdir(), 'dsh-manual-source-context-'))
  const home = join(portableRoot, 'Data/DSH-generations/active/home')
  const profileDir = join(home, 'profiles/web')
  const put = async (relative: string, content: string): Promise<void> => {
    const file = join(portableRoot, relative)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await mkdir(profileDir, { recursive: true })
  await put(rule, '# 构建更新与定制防回退规则\n当前规则\n')
  const packageJson = JSON.stringify({ name: 'dsh-example', version: '1.0.0', description: 'active example', token: 'do-not-copy' })
  for (const base of ['Data/DSH/profiles/web', 'Data/DSH-generations/active/home/profiles/web', 'Data/DSH-generations/next/home/profiles/web']) {
    await put(`${base}/local/dsh-example/package.json`, packageJson)
    await put(`${base}/local/dsh-example/README.md`, '# Active handbook\nSame content across generations.\n')
  }
  await put('Data/DSH/profiles/web/local/legacy-only/package.json', JSON.stringify({ name: 'legacy-only' }))
  await put('Data/DSH/profiles/web/local/legacy-only/README.md', '# Must not be discovered\n')
  return { portableRoot, home, profileDir, put }
}

test('manual auto root follows explicit portable environment and active home, not generation depth or legacy', async () => {
  const f = await fixture()
  const context = await resolveManualSourceContext({ portableRoot: f.portableRoot, home: f.home, profileDir: f.profileDir })
  assert.equal(context.sourceRoot, f.portableRoot)
  assert.equal(context.activeProfileDir, f.profileDir)
  const found = await discoverLocalSources(context.localSourceRoot, 128, context.activeProfileDir)
  assert.ok(found.some((entry: any) => entry.identityPath === identity))
  assert.ok(found.every((entry: any) => entry.path.startsWith('Data/DSH-generations/active/home/profiles/web/local/')))
  assert.ok(found.every((entry: any) => !entry.path.includes('legacy-only')))
  assert.ok(DEFAULT_SOURCES.some((entry: any) => entry.path === rule))
  const legacy = join(f.portableRoot, 'Data/DSH')
  const legacyContext = await resolveManualSourceContext({ portableRoot: f.portableRoot, home: legacy, profileDir: join(legacy, 'profiles/web') })
  assert.equal(legacyContext.sourceRoot, f.portableRoot)
})

test('manual explicit sourceRoot including old relative default retains its meaning', async () => {
  const f = await fixture()
  const context = await resolveManualSourceContext({ sourceRoot: '../../../../', portableRoot: f.portableRoot, home: f.home, profileDir: f.profileDir })
  assert.equal(context.sourceRoot, join(f.portableRoot, 'Data/DSH-generations'))
  assert.notEqual(context.sourceRoot, f.portableRoot)
  assert.equal(context.activeProfileDir, f.profileDir)
  await f.put('reference/docs/03-技术架构/00-桌面启动器架构基线.md', '# User configured source\n')
  const explicit = await resolveManualSourceContext({ sourceRoot: join(f.portableRoot, 'reference'), portableRoot: f.portableRoot, home: f.home, profileDir: f.profileDir })
  assert.equal(explicit.sourceRoot, join(f.portableRoot, 'reference'))
  const nonPortable = await resolveManualSourceContext({ sourceRoot: join(f.portableRoot, 'reference'), home: f.home, profileDir: f.profileDir })
  assert.equal(nonPortable.sourceRoot, explicit.sourceRoot)
  assert.equal(nonPortable.activeProfileDir, null)
})

test('manual auto missing environment is diagnosed without guessing a root or losing editable notes', async () => {
  const f = await fixture()
  await assert.rejects(resolveManualSourceContext({ home: f.home, profileDir: f.profileDir }), isCode('INVALID_SOURCE'))
  const store = createManualStore({ root: join(f.home, 'manual'), activeProfileDir: null, sourceResolutionError: { code: 'INVALID_SOURCE' }, seed: false })
  const note = await store.edit({ id: 'notes/user-owned', content: '# Keep my note\n', expectedRevision: null })
  const before = await readFile(join(f.home, 'manual/notes/user-owned.md'), 'utf8')
  const report = await store.sync()
  assert.ok(report.failed.some((entry: any) => entry.source === 'project-root' && entry.code === 'INVALID_SOURCE'))
  assert.equal((await store.read({ id: note.id })).revision, note.revision)
  assert.equal(await readFile(join(f.home, 'manual/notes/user-owned.md'), 'utf8'), before)
})

test('manual source context rejects mismatched homes, external defaults and directory links', async () => {
  const f = await fixture()
  await assert.rejects(resolveManualSourceContext({ portableRoot: f.portableRoot, home: join(f.portableRoot, 'Data/DSH'), profileDir: f.profileDir }), isCode('INVALID_SOURCE'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-manual-source-external-'))
  await mkdir(join(outside, 'profiles/web'), { recursive: true })
  await assert.rejects(resolveManualSourceContext({ portableRoot: f.portableRoot, home: outside, profileDir: join(outside, 'profiles/web') }), isCode('UNSAFE_PATH'))
  await assert.rejects(resolveManualSourceContext({ sourceRoot: outside, portableRoot: f.portableRoot, home: f.home, profileDir: f.profileDir }), isCode('UNSAFE_PATH'))
  await symlink(outside, join(f.portableRoot, 'linked-source'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(resolveManualSourceContext({ sourceRoot: join(f.portableRoot, 'linked-source'), portableRoot: f.portableRoot, home: f.home, profileDir: f.profileDir }), isCode('UNSAFE_PATH'))
  await assert.rejects(resolveManualSourceContext({ portableRoot: 'relative-root', home: f.home, profileDir: f.profileDir }), isCode('INVALID_SOURCE'))
  assert.throws(() => validateSource('Data/DSH-generations/active/home/sessions/private.md'), isCode('SOURCE_NOT_ALLOWED'))
  assert.throws(() => validateSource({ path: 'Data/DSH-generations/active/home/profiles/web/local/dsh-example/README.md', identityPath: 'docs/03-技术架构/other.md' }), isCode('INVALID_SOURCE'))
})

test('manual relocates generated provenance under the same legacy ID, retaining history and notes', async () => {
  const f = await fixture()
  const root = join(f.home, 'manual')
  const legacy = createManualStore({ root, sourceRoot: f.portableRoot, seed: false })
  await legacy.sync()
  const old = await legacy.read({ id: sourceId(identity) })
  const note = await legacy.edit({ id: 'notes/rules', content: '# Editable rules\nMy addition\n', expectedRevision: null })
  const noteBytes = await readFile(join(root, 'notes/rules.md'), 'utf8')
  const context = await resolveManualSourceContext({ portableRoot: f.portableRoot, home: f.home, profileDir: f.profileDir })
  const active = createManualStore({ root, ...context, seed: false })
  assert.equal((await active.read({ id: old.id })).freshnessReason, 'source-relocated')
  const report = await active.sync()
  assert.ok(report.updated.includes(old.id), 'equal hash at a new physical location still commits provenance')
  const moved = await active.read({ id: old.id })
  assert.equal(moved.id, old.id)
  assert.equal(moved.content, old.content)
  assert.equal(moved.source.hash, old.source.hash)
  assert.equal(moved.source.path, 'Data/DSH-generations/active/home/profiles/web/local/dsh-example/README.md')
  assert.equal(moved.source.identityPath, identity)
  assert.equal(moved.freshness, 'current')
  assert.notEqual(moved.revision, old.revision)
  assert.ok((await active.history({ id: old.id })).items.some((entry: any) => entry.revision === old.revision))
  assert.equal((await active.read({ id: note.id })).revision, note.revision)
  assert.equal(await readFile(join(root, 'notes/rules.md'), 'utf8'), noteBytes)
  const nextHome = join(f.portableRoot, 'Data/DSH-generations/next/home')
  const nextContext = await resolveManualSourceContext({ portableRoot: f.portableRoot, home: nextHome, profileDir: join(nextHome, 'profiles/web') })
  const next = createManualStore({ root, ...nextContext, seed: false })
  await next.sync()
  assert.equal((await next.read({ id: old.id })).source.path, 'Data/DSH-generations/next/home/profiles/web/local/dsh-example/README.md')
  assert.equal((await next.list({ kind: 'generated' })).items.filter((entry: any) => entry.id === old.id).length, 1)
  assert.ok((await next.read({ id: sourceId(rule) })).content.includes('当前规则'))
})

test('manual active discovery failure stays partial, never follows links or overwrites edited generated chapters', async () => {
  const f = await fixture()
  const context = await resolveManualSourceContext({ portableRoot: f.portableRoot, home: f.home, profileDir: f.profileDir })
  const root = join(f.home, 'manual')
  const store = createManualStore({ root, ...context, seed: false })
  await store.sync()
  const id = sourceId(identity)
  const generated = join(root, `${id}.md`)
  await writeFile(generated, (await readFile(generated, 'utf8')) + '\nExternally edited\n')
  const before = await readFile(generated, 'utf8')
  assert.ok((await store.sync()).conflicts.some((entry: any) => entry.id === id))
  assert.equal(await readFile(generated, 'utf8'), before)
  await unlink(join(f.profileDir, 'local/dsh-example/README.md'))
  const missing = await store.sync()
  assert.ok(!missing.updated.includes(id))
  assert.equal(await readFile(generated, 'utf8'), before)
  assert.equal((await store.read({ id })).freshness, 'unavailable')
  const external = await mkdtemp(join(tmpdir(), 'dsh-manual-linked-plugin-'))
  await writeFile(join(external, 'package.json'), JSON.stringify({ name: 'external' }))
  await writeFile(join(external, 'README.md'), '# External content must not enter manual\n')
  await symlink(external, join(f.profileDir, 'local/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const report = await store.sync()
  assert.ok(report.failed.some((entry: any) => entry.source === 'active-profile' && entry.code === 'UNSAFE_PATH'))
  assert.equal((await store.search({ query: 'External content must not enter' })).total, 0)
  assert.ok((await readdir(join(root, 'generated'))).every((file: string) => file.endsWith('.md')))
})
