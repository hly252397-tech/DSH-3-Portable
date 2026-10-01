import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'

import { captureCustomizationState, type PreservationManifest } from '../src/customization-preservation.js'
import { prepareHarnessHome, type PrepareHarnessHomeOptions } from '../src/harness-home-preparation.js'
import { makeTrackedTempDirSync } from './helpers/tmp.js'

const digest = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
const put = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const link = (target: string, path: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}
const satisfies = (version: string, range: string): boolean => range === '*' || version === range
  || range.startsWith('^') && version.split('.').slice(0, 2).join('.') === range.slice(1).split('.').slice(0, 2).join('.')

function fixture(peerRange = '*', unrelatedPeer = false) {
  const root = makeTrackedTempDirSync(join(tmpdir(), 'prepare-harness-home-'))
  const version = '0.3.0-rc.1', fingerprint = 'b'.repeat(64)
  const oldVersion = '0.2.0-rc.2', oldFingerprint = 'a'.repeat(64)
  const sourceHome = join(root, 'Data/DSH-generations/active/home'), profile = join(sourceHome, 'profiles/web')
  const runtime = (runtimeVersion: string, hash: string): string => {
    const directory = join(root, 'Data/Runtime/Harness/slots', runtimeVersion + '-' + hash.slice(0, 16))
    for (const name of ['dsh', 'dsh-base', 'dsh-web']) {
      put(join(directory, 'node_modules/@deepseek-ai', name, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/' + name, version: runtimeVersion, main: 'lib/' + (name === 'dsh' ? 'bin' : 'index') + '.js',
        ...(name === 'dsh-web' ? { peerDependencies: { '@deepseek-ai/dsh-base': '*' } } : {}),
      }))
      put(join(directory, 'node_modules/@deepseek-ai', name, 'lib/' + (name === 'dsh' ? 'bin' : 'index') + '.js'), 'export const fixture = true;\n')
    }
    put(join(directory, '.dsh-runtime-fingerprint'), hash)
    put(join(directory, 'immutable-marker.txt'), runtimeVersion)
    return directory
  }
  const oldRuntime = runtime(oldVersion, oldFingerprint), candidate = { directory: runtime(version, fingerprint), version, fingerprint }
  const source = join(root, 'customizations/custom')
  const payload = {
    'package.json': JSON.stringify({ name: 'custom', version: '1.0.0', type: 'module', main: 'lib/index.js', files: ['lib', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh-base': peerRange,
        ...(unrelatedPeer ? { 'legacy-helper': '1.0.0' } : {}) } }, null, 2),
    'lib/index.js': 'export const acceptedCustomization = true;\n',
    'cordis.patch.yml': '- insert:\n  - id: custom-persistent-id\n    name: custom\n',
  }
  for (const [path, value] of Object.entries(payload)) put(join(source, path), value)
  const manifest: PreservationManifest = { schema: 1, revision: 1, features: ['ui.accepted-customization'], requiredPlugins: ['custom'],
    sources: [{ pluginName: 'custom', sourceDir: 'customizations/custom', files: Object.entries(payload).map(([path, value]) => ({ path, sha256: digest(value) })) }] }
  put(join(root, 'customizations/preservation.json'), JSON.stringify(manifest))
  cpSync(source, join(profile, 'local/custom'), { recursive: true })
  link(join(profile, 'local/custom'), join(profile, 'node_modules/custom'))
  for (const name of ['dsh-base', 'dsh-web']) link(join(oldRuntime, 'node_modules/@deepseek-ai', name), join(profile, 'node_modules/@deepseek-ai', name))
  if (unrelatedPeer) put(join(profile, 'node_modules/legacy-helper/package.json'), JSON.stringify({ name: 'legacy-helper', version: '2.0.0' }))
  put(join(profile, 'package.json'), JSON.stringify({ dependencies: { custom: 'link:local/custom', '@deepseek-ai/dsh-web': oldVersion },
    dsh: { profile: { bundles: ['custom', '@deepseek-ai/dsh-web'] } } }))
  put(join(sourceHome, 'data/sessions/latest.json'), '{"message":"latest active conversation"}')
  put(join(sourceHome, 'config.yml'), 'language: zh-CN\n')
  link(join(sourceHome, 'data'), join(sourceHome, 'data-alias'))
  const bindingPath = join(root, 'Data/Updates/Harness/homes', version + '.json')
  const options = (transactionId: string): PrepareHarnessHomeOptions => ({ portableRoot: root, sourceProfileDir: profile,
    candidate, transactionId, sourceStopped: true, satisfies, snapshot: captureCustomizationState({ portableRoot: root, profileDir: profile }) })
  return { root, source, sourceHome, profile, oldRuntime, candidate, bindingPath, options }
}

test('prepares the explicit active home without runtime copies or publishing, then remaps real junctions', async () => {
  const f = fixture(), snapshot = f.options('fresh').snapshot!
  const prepared = await prepareHarnessHome(f.options('fresh'))
  assert.notEqual(prepared.home, f.sourceHome)
  assert.equal(existsSync(f.bindingPath), false, 'binding is published last by the caller')
  assert.equal(prepared.binding.schema, 2)
  assert.equal(prepared.binding.runtimeRelativePath, relative(f.root, f.candidate.directory).replaceAll('\\', '/'))
  assert.equal(existsSync(join(dirname(prepared.home), 'runtime')), false)
  assert.equal(readFileSync(join(prepared.home, 'data/sessions/latest.json'), 'utf8'), '{"message":"latest active conversation"}')
  assert.equal(readFileSync(join(prepared.home, 'config.yml'), 'utf8'), 'language: zh-CN\n')
  assert.equal(realpathSync(join(prepared.home, 'data-alias')), realpathSync(join(prepared.home, 'data')))
  assert.equal(realpathSync(join(prepared.profileDir, 'node_modules/custom')), realpathSync(join(prepared.profileDir, 'local/custom')))
  const __a = realpathSync(join(prepared.profileDir, 'node_modules/@deepseek-ai/dsh-base')), __b = realpathSync(join(f.candidate.directory, 'node_modules/@deepseek-ai/dsh-base'))
    // win32：junction 目标串拼写与磁盘规范拼写可能不同（同一路径两种大小写），按平台语义比较
    assert.ok(process.platform === 'win32' ? __a.toLowerCase() === __b.toLowerCase() : __a === __b, `dsh-base 链接目标不一致: ${__a} vs ${__b}`)
  assert.equal(captureCustomizationState({ portableRoot: f.root, profileDir: prepared.profileDir }).fingerprint, snapshot.fingerprint)
  await prepared.publishBinding()
  assert.deepEqual(JSON.parse(readFileSync(f.bindingPath, 'utf8')), prepared.binding)
  await prepared.publishBinding()
  assert.equal(readFileSync(join(f.candidate.directory, 'immutable-marker.txt'), 'utf8'), f.candidate.version)
})

test('never reuses a stale target home, backs up binding bytes, and restores only its own publication', async () => {
  const f = fixture()
  const staleHome = join(f.root, 'Data/DSH-generations/stale/home')
  put(join(staleHome, 'data/sessions/latest.json'), 'stale conversation')
  const original = '{ "schema": 1, "runtimeVersion": "' + f.candidate.version + '", "generation": "stale" }\n'
  put(f.bindingPath, original)
  const prepared = await prepareHarnessHome(f.options('backup'))
  assert.equal(readFileSync(f.bindingPath, 'utf8'), original)
  assert.equal(readFileSync(join(dirname(prepared.home), 'binding-before.json'), 'utf8'), original)
  assert.equal(readFileSync(join(prepared.home, 'data/sessions/latest.json'), 'utf8'), '{"message":"latest active conversation"}')
  await prepared.publishBinding()
  await prepared.rollbackBinding()
  await prepared.rollbackBinding()
  assert.equal(readFileSync(f.bindingPath, 'utf8'), original)
  assert.equal(readFileSync(join(f.sourceHome, 'data/sessions/latest.json'), 'utf8'), '{"message":"latest active conversation"}')
  assert.equal(readFileSync(join(staleHome, 'data/sessions/latest.json'), 'utf8'), 'stale conversation')
  assert.equal(existsSync(dirname(prepared.home)), false)
  assert.ok(readdirSync(join(f.root, 'Data/DSH-generations')).some(name => name.startsWith(prepared.binding.generation + '.incomplete-')))
  await assert.rejects(prepareHarnessHome(f.options('backup')), /already attempted/)
  await assert.rejects(prepared.publishBinding(), /Rolled-back/)
})

test('each transaction gets fresh latest conversations and rollback removes only a newly-created binding', async () => {
  const f = fixture(), first = await prepareHarnessHome(f.options('first'))
  put(join(f.sourceHome, 'data/sessions/latest.json'), '{"message":"next active conversation"}')
  const second = await prepareHarnessHome(f.options('second'))
  assert.notEqual(first.home, second.home)
  assert.equal(readFileSync(join(first.home, 'data/sessions/latest.json'), 'utf8'), '{"message":"latest active conversation"}')
  assert.equal(readFileSync(join(second.home, 'data/sessions/latest.json'), 'utf8'), '{"message":"next active conversation"}')
  await second.publishBinding()
  await second.rollbackBinding()
  assert.equal(existsSync(f.bindingPath), false)
  assert.equal(existsSync(first.home), true)
})

test('requires an actually stopped source and refuses noncanonical candidates before copying', async () => {
  const f = fixture()
  await assert.rejects(prepareHarnessHome({ ...f.options('running'), sourceStopped: false } as unknown as PrepareHarnessHomeOptions), /must be stopped/)
  const alias = join(f.root, 'Data/runtime-alias')
  link(f.candidate.directory, alias)
  await assert.rejects(prepareHarnessHome({ ...f.options('alias'), candidate: { ...f.candidate, directory: alias } }), /canonical immutable slot/)
  assert.deepEqual(readdirSync(join(f.root, 'Data/DSH-generations')), ['active'])
  assert.equal(existsSync(f.bindingPath), false)
})

test('unknown external junctions fail closed, preserve diagnostic copies, and never prune source data', async () => {
  const f = fixture(), external = join(f.root, 'Data/unowned')
  put(join(external, 'important.txt'), 'not updater-owned')
  link(external, join(f.sourceHome, 'foreign-link'))
  await assert.rejects(prepareHarnessHome(f.options('external')), /unowned external link/)
  assert.equal(realpathSync(join(f.sourceHome, 'foreign-link')), realpathSync(external))
  assert.equal(readFileSync(join(external, 'important.txt'), 'utf8'), 'not updater-owned')
  assert.equal(existsSync(f.bindingPath), false)
  const incomplete = readdirSync(join(f.root, 'Data/DSH-generations')).find(name => name.includes('.incomplete-'))!
  assert.equal(JSON.parse(readFileSync(join(f.root, 'Data/DSH-generations', incomplete, 'failure.json'), 'utf8')).stage, 'prepare')
})

test('missing candidate official packages are rejected instead of silently skipping or dropping bundles', async () => {
  const f = fixture()
  rmSync(join(f.candidate.directory, 'node_modules/@deepseek-ai/dsh-web'), { recursive: true })
  await assert.rejects(prepareHarnessHome(f.options('missing')), /drops an installed official package/)
  assert.ok(existsSync(join(f.profile, 'node_modules/@deepseek-ai/dsh-web/package.json')))
  assert.equal(existsSync(f.bindingPath), false)
})

test('only exact installed-version grants for the target runtime authorize incompatible official peers', async () => {
  const f = fixture('^0.2.0')
  put(join(f.profile, 'compatibility.json'), JSON.stringify({ 'custom@1.0.0': ['0.2.0-rc.2'], 'historic@1.0.0': ['0.1.0'] }))
  await assert.rejects(prepareHarnessHome(f.options('unapproved')), /no exact approved grant/)
  const prepared = await prepareHarnessHome({ ...f.options('approved'), profileCompatibility: { 'custom@1.0.0': [f.candidate.version] } })
  assert.deepEqual(JSON.parse(readFileSync(join(prepared.profileDir, 'compatibility.json'), 'utf8')), {
    'custom@1.0.0': ['0.2.0-rc.2', f.candidate.version], 'historic@1.0.0': ['0.1.0'],
  })
  assert.deepEqual(JSON.parse(readFileSync(join(f.profile, 'compatibility.json'), 'utf8')), {
    'custom@1.0.0': ['0.2.0-rc.2'], 'historic@1.0.0': ['0.1.0'],
  }, 'source compatibility is never retargeted')
  put(join(f.profile, 'compatibility.json'), JSON.stringify({ 'custom@1.0.0': [f.candidate.version] }))
  assert.ok((await prepareHarnessHome(f.options('existing-exact'))).home)
})

test('release grants cannot authorize a different plugin version, disabled bundle, or other target runtime', async () => {
  const f = fixture('^0.2.0')
  const rejectedGrants: Readonly<Record<string, readonly string[]>>[] = [
    { 'custom@1.0.1': [f.candidate.version] },
    { 'disabled@1.0.0': [f.candidate.version] },
    { 'custom@1.0.0': ['0.3.0'] },
    { 'custom@1.0.0': [f.candidate.version, '0.4.0'] },
  ]
  for (const [index, grants] of rejectedGrants.entries()) {
    await assert.rejects(prepareHarnessHome({ ...f.options('bad-grant-' + index), profileCompatibility: grants }), /only the target runtime/)
  }
  assert.equal(existsSync(f.bindingPath), false)
})

test('runtime compatibility grants do not waive missing or incompatible unrelated library peers', async () => {
  const f = fixture('*', true)
  await assert.rejects(prepareHarnessHome({ ...f.options('unrelated-mismatch'), profileCompatibility: { 'custom@1.0.0': [f.candidate.version] } }), /no exact approved grant/)
  rmSync(join(f.profile, 'node_modules/legacy-helper'), { recursive: true })
  await assert.rejects(prepareHarnessHome({ ...f.options('unrelated-missing'), profileCompatibility: { 'custom@1.0.0': [f.candidate.version] } }), /lacks a required plugin peer/)
  assert.equal(existsSync(f.bindingPath), false)
})

test('candidate semver must be provided by the candidate, not resolved through workspace fallback', async () => {
  const f = fixture()
  const { satisfies: _unused, ...options } = f.options('no-semver')
  await assert.rejects(prepareHarnessHome(options), /semver|outside its owned root/)
  assert.deepEqual(readdirSync(join(f.root, 'Data/DSH-generations')), ['active'])
})

test('binding changes by another transaction are never overwritten during publish or rollback', async () => {
  const f = fixture(), prepared = await prepareHarnessHome(f.options('publish-conflict'))
  const other = JSON.stringify({ schema: 2, runtimeVersion: f.candidate.version, generation: 'other-transaction', runtimeRelativePath: 'Data/Runtime/Harness/slots/other' })
  put(f.bindingPath, other)
  await assert.rejects(prepared.publishBinding(), /refusing to overwrite/)
  assert.equal(readFileSync(f.bindingPath, 'utf8'), other)
  await prepared.rollbackBinding()
  assert.equal(readFileSync(f.bindingPath, 'utf8'), other)
  const second = await prepareHarnessHome(f.options('rollback-conflict'))
  await second.publishBinding()
  put(f.bindingPath, other)
  await assert.rejects(second.rollbackBinding(), /no longer owned/)
  assert.equal(readFileSync(f.bindingPath, 'utf8'), other)
  assert.equal(existsSync(second.home), true, 'home still referenced by unknown coordination is retained')
})

test('snapshot drift is rejected without touching source or publishing a stale home', async () => {
  const f = fixture(), options = f.options('changed-payload')
  put(join(f.profile, 'local/custom/lib/index.js'), 'export const acceptedCustomization = false;\n')
  await assert.rejects(prepareHarnessHome(options), /preserv|drift|changed/i)
  assert.equal(readFileSync(join(f.profile, 'local/custom/lib/index.js'), 'utf8'), 'export const acceptedCustomization = false;\n')
  assert.equal(existsSync(f.bindingPath), false)
  assert.deepEqual(readdirSync(join(f.root, 'Data/DSH-generations')), ['active'])
})
