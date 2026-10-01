import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
const { auditPluginDependencies } = await import(pathToFileURL(resolve('scripts/lib/plugin-deps-audit.mjs')).href)

test('dependency audit ignores disabled archives, checks real links and prerelease semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-audit-'))
  const profile = join(root, 'profile'), runtime = join(root, 'runtime')
  const put = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }
  const pkg = { name: 'local-one', main: 'lib/index.js', exports: { './client': { types: './missing.d.ts', default: './lib/client.js' } }, peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.2-alpha.2' } }
  put(join(profile, 'package.json'), { dependencies: { 'local-one': 'link:./local/local-one' }, dsh: { profile: { bundles: ['local-one'] } } })
  put(join(profile, 'local/local-one/package.json'), pkg)
  put(join(profile, 'local/local-one/lib/index.js'), {})
  put(join(profile, 'local/local-one/lib/client.js'), {})
  put(join(profile, 'local/disabled/package.json'), { name: 'disabled', dependencies: { '@deepseek-ai/bad': '*' } })
  put(join(runtime, 'node_modules/@deepseek-ai/dsh-agent/package.json'), { name: '@deepseek-ai/dsh-agent', version: '0.1.7-rc.2' })
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(join(profile, 'local/local-one'), join(profile, 'node_modules/local-one'), 'junction')
  let result = auditPluginDependencies(profile, runtime)
  assert.deepEqual(result.plugins, ['local-one'])
  assert.deepEqual(result.links, [])
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.dependencies, [])
  assert.equal(result.peers.length, 1, 'Different prerelease tuples cannot bypass review')
  pkg.peerDependencies['@deepseek-ai/dsh-agent'] += ' || 0.1.7-rc.2'
  put(join(profile, 'local/local-one/package.json'), pkg)
  assert.deepEqual(auditPluginDependencies(profile, runtime).peers, [])
  put(join(profile, 'package.json'), { dependencies: { 'local-one': 'file:./local/local-one' }, dsh: { profile: { bundles: [] } } })
  result = auditPluginDependencies(profile, runtime)
  assert.equal(result.links.length, 2)
  pkg.exports['./client'].default = './missing.js'
  put(join(profile, 'local/local-one/package.json'), pkg)
  assert.equal(auditPluginDependencies(profile, runtime).entries.length, 1)
})

const RUNTIME = '0.2.0-rc.2'
const PLUGIN = 'local-one'
const VERSION = '0.18.0-alpha.0'
const CORE_PEER = '@deepseek-ai/dsh-agent'
const LEGACY_RANGE = '^0.1.2-alpha.2 || 0.1.7-rc.2 || 0.2.0-rc.1'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-grant-audit-'))
  const profile = join(root, 'profile'), runtime = join(root, 'runtime')
  const put = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }
  const local = join(profile, 'local', PLUGIN)
  const pkg = { name: PLUGIN, version: VERSION, main: 'lib/index.js', peerDependencies: { [CORE_PEER]: LEGACY_RANGE } }
  put(join(profile, 'package.json'), { dependencies: { [PLUGIN]: 'link:./local/' + PLUGIN }, dsh: { profile: { bundles: [PLUGIN] } } })
  put(join(local, 'package.json'), pkg)
  put(join(local, 'lib/index.js'), {})
  const peer = (name: string, version = RUNTIME): void => put(join(runtime, 'node_modules', name, 'package.json'), { name, version })
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', CORE_PEER]) peer(name)
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(local, join(profile, 'node_modules', PLUGIN), 'junction')
  const approve = (value: unknown = { [`${PLUGIN}@${VERSION}`]: [RUNTIME] }): void => put(join(profile, 'compatibility.json'), value)
  const audit = (): any => auditPluginDependencies(profile, runtime)
  return { root, profile, runtime, local, pkg, put, peer, approve, audit }
}

test('existing exact approval fixes the reproduced peer failure without changing either manifest', () => {
  const f = fixture()
  assert.equal(f.audit().peers.length, 1, 'The unapproved fixture reproduces the original failure')
  assert.deepEqual(f.audit().approved, [])
  f.approve()
  const result = f.audit()
  assert.deepEqual(result.peers, [])
  assert.deepEqual(result.links, [])
  assert.deepEqual(result.approved, [{ packageVersion: `${PLUGIN}@${VERSION}`, runtimeVersion: RUNTIME,
    peers: [{ name: CORE_PEER, installedVersion: RUNTIME, range: LEGACY_RANGE }] }])
  assert.deepEqual(result.compatibilityWarnings, [])
})

test('a naturally satisfied peer is not presented as exempted even when a grant exists', () => {
  const f = fixture()
  f.approve()
  f.pkg.peerDependencies[CORE_PEER] = RUNTIME
  f.put(join(f.local, 'package.json'), f.pkg)
  assert.deepEqual(f.audit().peers, [])
  assert.deepEqual(f.audit().approved, [])
})

for (const [label, value] of [
  ['wrong plugin version', { [`${PLUGIN}@0.18.1`]: [RUNTIME] }],
  ['wrong plugin identity', { [`other@${VERSION}`]: [RUNTIME] }],
  ['wrong target runtime', { [`${PLUGIN}@${VERSION}`]: ['0.2.0-rc.1'] }],
  ['different runtime build metadata', { [`${PLUGIN}@${VERSION}`]: [RUNTIME + '+other'] }],
  ['wildcard plugin version', { [`${PLUGIN}@*`]: [RUNTIME] }],
  ['wildcard runtime version', { [`${PLUGIN}@${VERSION}`]: ['*'] }],
  ['runtime range', { [`${PLUGIN}@${VERSION}`]: ['^0.2.0-rc.2'] }],
  ['noncanonical plugin version', { [`${PLUGIN}@v${VERSION}`]: [RUNTIME] }],
  ['noncanonical runtime version', { [`${PLUGIN}@${VERSION}`]: ['v' + RUNTIME] }],
  ['invalid versions array', { [`${PLUGIN}@${VERSION}`]: [RUNTIME, 42] }],
  ['invalid root shape', []],
] as const) {
  test('exact approvals cannot waive ' + label, () => {
    const f = fixture()
    f.approve(value)
    assert.equal(f.audit().peers.length, 1)
    assert.deepEqual(f.audit().approved, [])
  })
}

test('malformed compatibility JSON is a friendly diagnostic, not a wrapper exception or grant', () => {
  const f = fixture()
  writeFileSync(join(f.profile, 'compatibility.json'), '{invalid')
  const result = f.audit()
  assert.equal(result.peers.length, 1)
  assert.deepEqual(result.approved, [])
  assert.match(result.compatibilityWarnings[0], /invalid JSON/)
})

test('nonordinary or linked approval metadata never authorizes a plugin', () => {
  const f = fixture()
  const external = join(f.root, 'external-permissions')
  f.put(join(external, 'allow.json'), { [`${PLUGIN}@${VERSION}`]: [RUNTIME] })
  symlinkSync(external, join(f.profile, 'compatibility.json'), 'junction')
  const result = f.audit()
  assert.equal(result.peers.length, 1)
  assert.deepEqual(result.approved, [])
  assert.match(result.compatibilityWarnings[0], /ordinary metadata/)
})

test('only the valid exact record is consumed when another record is malformed', () => {
  const f = fixture()
  f.approve({ [`${PLUGIN}@${VERSION}`]: [RUNTIME], '*': ['*'] })
  assert.deepEqual(f.audit().peers, [])
  assert.equal(f.audit().approved.length, 1)
  assert.equal(f.audit().compatibilityWarnings.length, 1)
})

test('a missing required core peer cannot be hidden by an exact approval', () => {
  const f = fixture()
  f.approve()
  unlinkSync(join(f.runtime, 'node_modules', CORE_PEER, 'package.json'))
  assert.equal(f.audit().peers.length, 1)
  assert.deepEqual(f.audit().approved, [])
})

for (const range of ['', 'not-a-range', 42, { toString: 'invalid' }]) {
  test('an exact approval never repairs an invalid peer range: ' + JSON.stringify(range), () => {
    const f = fixture()
    f.approve()
    f.put(join(f.local, 'package.json'), { ...f.pkg, peerDependencies: { [CORE_PEER]: range } })
    assert.equal(f.audit().peers.length, 1)
    assert.deepEqual(f.audit().approved, [])
  })
}

test('one invalid required peer blocks consumption of grants for the whole plugin', () => {
  const f = fixture()
  f.approve()
  f.put(join(f.local, 'package.json'), { ...f.pkg, peerDependencies: { ...f.pkg.peerDependencies, '@deepseek-ai/dsh-missing': RUNTIME } })
  assert.equal(f.audit().peers.length, 2)
  assert.deepEqual(f.audit().approved, [])
})

test('canonical build metadata is preserved in both exact grant identities', () => {
  const f = fixture()
  const pluginVersion = VERSION + '+portable.1', runtimeVersion = RUNTIME + '+reviewed.1'
  f.put(join(f.local, 'package.json'), { ...f.pkg, version: pluginVersion })
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', CORE_PEER]) f.peer(name, runtimeVersion)
  f.approve({ [`${PLUGIN}@${pluginVersion}`]: [runtimeVersion] })
  assert.deepEqual(f.audit().peers, [])
  assert.equal(f.audit().approved[0].packageVersion, `${PLUGIN}@${pluginVersion}`)
  assert.equal(f.audit().approved[0].runtimeVersion, runtimeVersion)
})

for (const [label, mutation] of [
  ['missing runtime identity', (f: ReturnType<typeof fixture>) => unlinkSync(join(f.runtime, 'node_modules/@deepseek-ai/dsh/package.json'))],
  ['incorrect runtime name', (f: ReturnType<typeof fixture>) => f.put(join(f.runtime, 'node_modules/@deepseek-ai/dsh/package.json'), { name: 'fake-runtime', version: RUNTIME })],
  ['mismatched app-boot version', (f: ReturnType<typeof fixture>) => f.peer('@deepseek-ai/dsh-app-boot', '0.2.0-rc.1')],
  ['mixed unrelated family version', (f: ReturnType<typeof fixture>) => f.peer('@deepseek-ai/dsh-session', '0.2.0-rc.1')],
  ['incorrect installed peer identity', (f: ReturnType<typeof fixture>) => f.put(join(f.runtime, 'node_modules', CORE_PEER, 'package.json'), { name: 'fake-peer', version: RUNTIME })],
  ['noncanonical installed peer version', (f: ReturnType<typeof fixture>) => f.peer(CORE_PEER, 'v' + RUNTIME)],
] as const) {
  test('exact approvals require trustworthy installed runtime: ' + label, () => {
    const f = fixture()
    f.approve()
    mutation(f)
    assert.equal(f.audit().peers.length, 1)
    assert.deepEqual(f.audit().approved, [])
  })
}

test('DSH runtime grants never waive a non-DSH singleton peer', () => {
  const f = fixture()
  f.approve()
  f.peer('@deepseek-ai/cordis', '4.0.4')
  f.put(join(f.local, 'package.json'), { ...f.pkg, peerDependencies: { '@deepseek-ai/cordis': '3.0.0' } })
  assert.equal(f.audit().peers.length, 1)
  assert.deepEqual(f.audit().approved, [])
})

test('bad installed links remain failures and cannot acquire exact approvals', () => {
  const f = fixture()
  f.approve()
  f.put(join(f.profile, 'local/other/package.json'), f.pkg)
  f.put(join(f.profile, 'local/other/lib/index.js'), {})
  f.put(join(f.profile, 'package.json'), { dependencies: { [PLUGIN]: 'link:./local/other' }, dsh: { profile: { bundles: [PLUGIN] } } })
  assert.equal(f.audit().links.length, 1)
  assert.equal(f.audit().peers.length, 1)
  assert.deepEqual(f.audit().approved, [])
})
