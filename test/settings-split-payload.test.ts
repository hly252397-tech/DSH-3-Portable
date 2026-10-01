import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { makeTrackedTempDir } from './helpers/tmp.js'

// The verifier is a delivery tool, not another updater. Tiny ASAR fixtures exercise its reader and drift checks.
const verifier = await import(new URL('../../scripts/verify-settings-split-payload.mjs', import.meta.url).href) as {
  readAsarEntry(path: string, entry: string): Buffer
  verifySettingsSplitPayload(app: string, options: { sourceRoot: string; profileDir?: string }): { status: string; results: { name: string; status: string }[] }
}
const module = `export function desktopBridgeClientFactory() {
    return [{ id: 'desktop-notifications' }, { id: 'desktop-updates' }, { id: 'desktop-appearance', order: 10.5 }];
}
export function desktopBridgeClientBundle() {}
`
const html = 'html[data-dsh-section] aside{display:none!important} dataset.dshSection api.desktopUpdateAction api.harnessUpdateAction'
const manifest = { schema: 1, revision: 3, features: ['ui.desktop-settings-integrated', 'ui.settings-split-sections', 'ui.appearance-general-extension'] }

function archive(data: string, offset = '0'): Buffer {
  const bytes = Buffer.from(data)
  const header = Buffer.from(JSON.stringify({ files: { dist: { files: { src: { files: { 'desktop-bridge-client-source.js': { size: bytes.length, offset } } } } } } }))
  const padding = Buffer.alloc((4 - header.length % 4) % 4)
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(header.length + padding.length + 8, 4)
  prefix.writeUInt32LE(header.length + padding.length + 4, 8); prefix.writeUInt32LE(header.length, 12)
  return Buffer.concat([prefix, header, padding, bytes])
}
async function fixture() {
  const root = await makeTrackedTempDir(join(tmpdir(), 'dsh-settings-payload-'))
  const app = join(root, 'app'), profile = join(root, 'profile')
  for (const name of ['dist/src', 'assets', 'customizations', 'app/resources/desktop-bridge', 'profile/node_modules/dsh-desktop-bridge']) await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, 'dist/src/desktop-bridge-client-source.js'), module)
  await writeFile(join(root, 'assets/settings.html'), html)
  await writeFile(join(root, 'customizations/preservation.json'), JSON.stringify(manifest))
  await writeFile(join(app, 'resources/app.asar'), archive(module))
  await writeFile(join(app, 'resources/desktop-bridge/desktop-bridge-client-source.js'), module)
  await writeFile(join(app, 'resources/settings.html'), html)
  await writeFile(join(app, 'resources/preservation.json'), JSON.stringify(manifest))
  const factory = module.slice('export '.length, module.indexOf('\nexport function desktopBridgeClientBundle')).trimEnd()
  await writeFile(join(profile, 'node_modules/dsh-desktop-bridge/desktop-bridge-client.js'), `window.__ModuleLoader__.load({id:'dsh-desktop-bridge',factory:${factory}});\n`)
  return { root, app, profile }
}

test('delivery verifier requires ASAR, external bridge, resources, capabilities, and generated client to agree', async () => {
  const f = await fixture()
  assert.equal(verifier.verifySettingsSplitPayload(f.app, { sourceRoot: f.root, profileDir: f.profile }).status, 'pass')
  await writeFile(join(f.profile, 'node_modules/dsh-desktop-bridge/desktop-bridge-client.js'), 'old generated client')
  assert.equal(verifier.verifySettingsSplitPayload(f.app, { sourceRoot: f.root, profileDir: f.profile }).status, 'fail')
})

test('old monolith and duplicate appearance cannot be accepted even with matching resource bytes', async () => {
  for (const stale of [module.replace('desktop-notifications', 'desktop-settings'), module.replace('desktop-appearance', 'appearance')]) {
    const f = await fixture()
    await writeFile(join(f.app, 'resources/app.asar'), archive(stale))
    await writeFile(join(f.app, 'resources/desktop-bridge/desktop-bridge-client-source.js'), stale)
    await writeFile(join(f.root, 'dist/src/desktop-bridge-client-source.js'), stale)
    const report = verifier.verifySettingsSplitPayload(f.app, { sourceRoot: f.root })
    assert.equal(report.status, 'fail')
    assert.equal(report.results.find(row => row.name.startsWith('Independent sections'))?.status, 'fail')
  }
})

test('material-only changes, a stale external bridge, or lost capabilities are rejected', async () => {
  for (const relative of ['resources/app.asar', 'resources/desktop-bridge/desktop-bridge-client-source.js', 'resources/settings.html', 'resources/preservation.json']) {
    const f = await fixture()
    const content = relative.endsWith('asar') ? archive(module + '// stale') : relative.endsWith('json') ? JSON.stringify({ ...manifest, features: [] }) : 'stale'
    await writeFile(join(f.app, relative), content)
    assert.equal(verifier.verifySettingsSplitPayload(f.app, { sourceRoot: f.root }).status, 'fail', relative)
  }
})

test('ASAR reader rejects malformed lengths, out-of-bounds offsets, missing entries, and traversal', async () => {
  const f = await fixture(), path = join(f.app, 'resources/app.asar')
  assert.equal(verifier.readAsarEntry(path, 'dist/src/desktop-bridge-client-source.js').toString(), module)
  for (const entry of ['../x', '/x', 'dist/missing.js']) assert.throws(() => verifier.readAsarEntry(path, entry))
  const wrongPickle = archive(module), wrongAlignment = archive(module), wrongJsonLength = archive(module)
  wrongPickle.writeUInt32LE(1, 8)
  wrongAlignment.writeUInt32LE(wrongAlignment.readUInt32LE(4) - 1, 4)
  wrongJsonLength.writeUInt32LE(0xffff_ffff, 12)
  for (const bytes of [Buffer.from('bad'), archive(module, '9007199254740992'), archive(module, '-1'), wrongPickle, wrongAlignment, wrongJsonLength]) {
    await writeFile(path, bytes)
    assert.throws(() => verifier.readAsarEntry(path, 'dist/src/desktop-bridge-client-source.js'))
  }
})
