import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  captureCustomizationState, checkPreservationManifest, CustomizationPreservationError,
  readPreservationManifest, verifyCustomizationPreserved, verifyCustomizationSources,
  type PreservationManifest,
} from '../src/customization-preservation.js'
import { makeTrackedTempDirSync } from './helpers/tmp.js'

const digest = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
const put = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
function fixture() {
  const root = makeTrackedTempDirSync(join(tmpdir(), 'preserve-customizations-'))
  const source = join(root, 'customizations/custom'), current = join(root, 'Data/active/profiles/web')
  const candidate = join(root, 'Data/candidate/profiles/web')
  const packageText = JSON.stringify({ name: 'custom', version: '1.0.0', type: 'module', main: 'lib/index.js',
    exports: { '.': './lib/index.js', './client': './lib/client.js' }, files: ['lib', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }, null, 2)
  const payload = {
    'package.json': packageText,
    'lib/index.js': 'export function apply(ctx) { ctx.provide("custom", {}); }\n',
    'lib/client.js': 'export function apply(ctx) { ctx.render("accepted settings"); }\n',
    'cordis.patch.yml': '- insert:\n  - id: custom-stable-id\n    name: custom\n',
  }
  for (const [path, text] of Object.entries(payload)) put(join(source, path), text)
  const manifest: PreservationManifest = { schema: 1, revision: 1, features: ['ui.accepted-settings'], requiredPlugins: ['custom'],
    sources: [{ pluginName: 'custom', sourceDir: 'customizations/custom', files: Object.entries(payload).map(([path, text]) => ({ path, sha256: digest(text) })) }] }
  put(join(root, 'customizations/preservation.json'), JSON.stringify(manifest))
  const create = (profile: string, enabled = true): void => {
    put(join(profile, 'package.json'), JSON.stringify({ dependencies: { custom: 'link:local/custom' }, dsh: { profile: { bundles: enabled ? ['custom'] : [] } } }))
    cpSync(source, join(profile, 'local/custom'), { recursive: true })
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    symlinkSync(join(profile, 'local/custom'), join(profile, 'node_modules/custom'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  create(current); create(candidate)
  return { root, source, current, candidate, manifest, create,
    options: (profileDir: string) => ({ portableRoot: root, profileDir }) }
}

test('captures real local mapping and preserves it across an isolated new home without mutating files', () => {
  const f = fixture()
  const before = readFileSync(join(f.current, 'package.json'), 'utf8')
  const snapshot = captureCustomizationState(f.options(f.current))
  assert.equal(snapshot.plugins.length, 1)
  assert.deepEqual(snapshot.plugins[0]?.files.map(file => file.path), ['cordis.patch.yml', 'lib/client.js', 'lib/index.js'])
  assert.equal(snapshot.plugins[0]?.localPath, 'local/custom')
  assert.equal(snapshot.plugins[0]?.enabled, true)
  assert.equal(verifyCustomizationPreserved(snapshot, f.options(f.candidate)).ok, true)
  assert.equal(captureCustomizationState(f.options(f.candidate)).fingerprint, snapshot.fingerprint)
  assert.equal(JSON.stringify(snapshot).includes(f.root), false, 'snapshot remains portable')
  assert.equal(readFileSync(join(f.current, 'package.json'), 'utf8'), before)
  assert.equal(verifyCustomizationSources(f.root).ok, true)
  put(join(f.source, 'lib/client.js'), 'old original settings\n')
  assert.equal(verifyCustomizationSources(f.root).issues[0]?.code, 'SOURCE_DRIFT')
})

test('rejects the observed regression: plugin remains installed but original client replaces accepted UI', () => {
  const f = fixture(), snapshot = captureCustomizationState(f.options(f.current))
  put(join(f.candidate, 'local/custom/lib/client.js'), 'export function apply(ctx) { ctx.render("original settings"); }\n')
  const result = verifyCustomizationPreserved(snapshot, f.options(f.candidate))
  assert.equal(result.ok, false)
  assert.ok(result.issues.some(item => item.code === 'SOURCE_RUNTIME_DRIFT' && item.path === 'lib/client.js'))
  assert.equal(readFileSync(join(f.current, 'local/custom/lib/client.js'), 'utf8'), readFileSync(join(f.source, 'lib/client.js'), 'utf8'))
})

test('rejects missing declarations, disabled state, registry replacement, and wrong junction destinations', () => {
  const f = fixture(), snapshot = captureCustomizationState(f.options(f.current))
  put(join(f.candidate, 'package.json'), JSON.stringify({ dependencies: { custom: 'link:local/custom' }, dsh: { profile: { bundles: [] } } }))
  assert.ok(verifyCustomizationPreserved(snapshot, f.options(f.candidate)).issues.some(item => item.code === 'PLUGIN_STATE_CHANGED'))
  put(join(f.candidate, 'package.json'), JSON.stringify({ dependencies: { custom: '9.0.0' }, dsh: { profile: { bundles: ['custom'] } } }))
  assert.ok(verifyCustomizationPreserved(snapshot, f.options(f.candidate)).issues.some(item => item.code === 'REQUIRED_PLUGIN_MISSING'))
  put(join(f.candidate, 'package.json'), JSON.stringify({ dependencies: { custom: 'link:local/custom' }, dsh: { profile: { bundles: ['custom'] } } }))
  rmSync(join(f.candidate, 'node_modules/custom'), { recursive: true })
  symlinkSync(join(f.current, 'local/custom'), join(f.candidate, 'node_modules/custom'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(verifyCustomizationPreserved(snapshot, f.options(f.candidate)).issues.some(item => item.code === 'LOCAL_PLUGIN_INVALID'))
})

test('all current local customizations are captured, including packages absent from the fixed source manifest', () => {
  const f = fixture()
  for (const profile of [f.current, f.candidate]) {
    const folder = join(profile, 'local/extra')
    put(join(folder, 'package.json'), JSON.stringify({ name: 'extra', version: '1.0.0', main: 'lib/index.js', files: ['lib'] }))
    put(join(folder, 'lib/index.js'), 'export const accepted = true;\n')
    symlinkSync(folder, join(profile, 'node_modules/extra'), process.platform === 'win32' ? 'junction' : 'dir')
    put(join(profile, 'package.json'), JSON.stringify({ dependencies: { custom: 'link:local/custom', extra: 'link:local/extra' }, dsh: { profile: { bundles: ['custom'] } } }))
  }
  const snapshot = captureCustomizationState(f.options(f.current))
  assert.equal(snapshot.plugins.length, 2)
  assert.equal(snapshot.plugins.find(item => item.name === 'extra')?.enabled, false, 'explicitly disabled plugins stay disabled')
  assert.equal(verifyCustomizationPreserved(snapshot, f.options(f.candidate)).ok, true)
  put(join(f.candidate, 'local/extra/lib/index.js'), 'export const accepted = false;\n')
  assert.ok(verifyCustomizationPreserved(snapshot, f.options(f.candidate)).issues.some(item => item.code === 'PLUGIN_FILE_CHANGED' && item.pluginName === 'extra'))
})

test('remote candidate metadata must preserve accepted feature IDs and source hashes even at a higher revision', () => {
  const f = fixture(), required = readPreservationManifest(f.root)
  assert.equal(checkPreservationManifest(undefined, required).ok, false)
  assert.equal(checkPreservationManifest({ ...required, revision: 2, features: ['ui.other'] }, required).issues[0]?.code, 'FEATURE_MISSING')
  const changed = { ...required, sources: required.sources.map((source, index) => index === 0 ? { ...source,
    files: source.files.map((file, fileIndex) => fileIndex === 0 ? { ...file, sha256: 'a'.repeat(64) } : file) } : source) }
  assert.ok(checkPreservationManifest(changed, required).issues.some(item => item.code === 'SOURCE_HASH_CHANGED'))
  assert.equal(checkPreservationManifest({ ...required, revision: 2, features: [...required.features, 'ui.new'] }, required).ok, true)
  assert.equal(checkPreservationManifest({ ...required, sources: [{ ...required.sources[0], sourceDir: '../outside' }] }, required).ok, false)
})

test('probe output, logs, credentials and newline normalization do not become mutable payload hashes', () => {
  const f = fixture(), local = join(f.current, 'local/custom')
  put(join(local, 'lib/ui-probe.json'), '{"width":800}')
  put(join(local, 'agent-mcp.token'), 'private fixture token')
  put(join(local, 'lib/logs/output.js'), 'volatile log')
  const before = captureCustomizationState(f.options(f.current))
  put(join(local, 'lib/ui-probe.json'), '{"width":1400}')
  put(join(local, 'agent-mcp.token'), 'changed private fixture token')
  put(join(local, 'lib/client.js'), readFileSync(join(local, 'lib/client.js'), 'utf8').replace(/\n/g, '\r\n'))
  const after = captureCustomizationState(f.options(f.current))
  assert.equal(after.fingerprint, before.fingerprint)
  assert.equal(JSON.stringify(after).includes('token'), false)
  assert.equal(JSON.stringify(after).includes('ui-probe'), false)
})

test('explicit embedded build inputs remain source protected without requiring unused original assets in Profile', () => {
  const f = fixture(), asset = 'embedded fixture image'
  put(join(f.source, 'assets/image.webp'), asset)
  const registry = structuredClone(f.manifest) as PreservationManifest
  const withInput: PreservationManifest = { ...registry, sources: registry.sources.map(source => ({ ...source,
    files: [...source.files, { path: 'assets/image.webp', sha256: digest(asset), runtime: false }] })) }
  put(join(f.root, 'customizations/preservation.json'), JSON.stringify(withInput))
  assert.equal(captureCustomizationState(f.options(f.current)).plugins.length, 1)
  put(join(f.source, 'assets/image.webp'), 'changed input')
  assert.equal(verifyCustomizationSources(f.root).issues[0]?.code, 'SOURCE_DRIFT')
  assert.equal(checkPreservationManifest({ ...withInput, sources: withInput.sources.map(source => ({ ...source,
    files: source.files.map(file => ({ ...file, runtime: false })) })) }, registry).ok, false)
})

test('explicit approved snapshot accepts exactly the reviewed new payload while default blocks it', () => {
  const f = fixture(), original = captureCustomizationState(f.options(f.current))
  const updated = 'export function apply(ctx) { ctx.render("reviewed new settings"); }\n'
  put(join(f.source, 'lib/client.js'), updated)
  put(join(f.candidate, 'local/custom/lib/client.js'), updated)
  const registry: PreservationManifest = { ...f.manifest, revision: f.manifest.revision + 1,
    sources: f.manifest.sources.map(source => ({ ...source,
      files: source.files.map(file => file.path === 'lib/client.js' ? { ...file, sha256: digest(updated) } : file) })) }
  put(join(f.root, 'customizations/preservation.json'), JSON.stringify(registry))
  const approved = captureCustomizationState(f.options(f.candidate))
  assert.equal(verifyCustomizationPreserved(original, f.options(f.candidate)).ok, false)
  assert.equal(verifyCustomizationPreserved(original, { ...f.options(f.candidate), approvedSnapshot: approved }).ok, true)
  assert.equal(verifyCustomizationPreserved(original, { ...f.options(f.candidate), approvedSnapshot: { ...approved, fingerprint: '0'.repeat(64) } }).issues[0]?.code, 'SNAPSHOT_INVALID')
})

test('unsafe runtime links and patches without stable IDs fail before candidate acceptance', () => {
  const f = fixture(), original = captureCustomizationState(f.options(f.current))
  const outside = makeTrackedTempDirSync(join(tmpdir(), 'preserve-outside-'))
  put(join(outside, 'client.js'), 'private fixture')
  const target = join(f.candidate, 'local/custom/lib')
  rmSync(target, { recursive: true })
  // Directory junctions work on ordinary Windows installations without file-symlink privileges.
  symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(verifyCustomizationPreserved(original, f.options(f.candidate)).ok, false)
  rmSync(target, { recursive: true })
  cpSync(join(f.source, 'lib'), target, { recursive: true })
  put(join(f.candidate, 'local/custom/cordis.patch.yml'), '- insert:\n  - name: custom\n')
  assert.throws(() => captureCustomizationState(f.options(f.candidate)), CustomizationPreservationError)
})
