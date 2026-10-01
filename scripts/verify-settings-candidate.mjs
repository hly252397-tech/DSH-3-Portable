// Read-only candidate verification. Does not change desktop pointers or launch it.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const builder = createRequire(require.resolve('electron-builder'))
const builderLib = createRequire(builder.resolve('app-builder-lib'))
const asar = await import(pathToFileURL(builderLib.resolve('@electron/asar')))
const pointer = JSON.parse(readFileSync(join(root, 'Data/Updates/Desktop/pointer.json'), 'utf8'))
assert.equal(pointer.current.relativePath, 'Data/Updates/Desktop/slots/1.0.76-local-9ea0cb9f0a866321', 'Active slot changed; review concurrent deployment')
assert.ok(pointer.pending?.relativePath, 'No pending candidate')
const candidate = resolve(root, pointer.pending.relativePath)
assert.ok(candidate.startsWith(join(root, 'Data/Updates/Desktop/slots') + sep))
const resources = join(candidate, 'resources'), results = []
for (const file of ['shell.html', 'settings.html', 'theme.css', 'theme.js', 'shell-icons/chevron-down.svg']) {
  assert.ok(readFileSync(join(root, 'assets', file)).equals(readFileSync(join(resources, file))), file)
  results.push({ name: `candidate asset matches verified source: ${file}`, pass: true })
}
const archive = join(resources, 'app.asar')
for (const name of ['main.js', 'embedded-desktop-settings.js', 'desktop-bridge-client-source.js', 'dsh-view-preload.cjs', 'shell-preload.cjs', 'shell-contract.js', 'bundled-plugins.js']) {
  // @electron/asar resolves archive segments with the host path separator.
  const file = join('dist', 'src', name)
  assert.ok(readFileSync(join(root, file)).equals(asar.extractFile(archive, file)), file)
  results.push({ name: `candidate ASAR matches compiled source: ${name}`, pass: true })
}
for (const name of ['desktop-bridge-client-source.js', 'bundled-plugins.js']) {
  assert.ok(readFileSync(join(root, 'dist/src', name)).equals(readFileSync(join(resources, 'desktop-bridge', name))))
  results.push({ name: `candidate bridge seed matches compiled source: ${name}`, pass: true })
}
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString())
assert.equal(packaged.version, pointer.pending.version)
results.push({ name: 'package and candidate pointer versions match', pass: true })
const report = { status: 'pass', scope: 'packaged-bytes-and-pointers-only; activation pending', current: pointer.current.relativePath, candidate, results }
writeFileSync(join(root, 'customizations/audit-fixes/20260927/settings-entry/candidate-verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`PASS ${results.length} candidate content checks; active slot unchanged`)
