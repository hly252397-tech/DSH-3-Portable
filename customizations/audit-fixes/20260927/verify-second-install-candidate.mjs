import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '../../..')
const { extractFile } = await import(pathToFileURL(join(root, 'node_modules/.pnpm/@electron+asar@4.1.1/node_modules/@electron/asar/lib/asar.js')).href)
const originalPointer = await readFile(join(root, 'Data/Updates/Desktop/pointer.json'), 'utf8')
const pointer = JSON.parse(originalPointer)
assert.equal(pointer.current.relativePath, 'Data/Updates/Desktop/slots/1.0.76-local-9ea0cb9f0a866321')
assert.ok(pointer.pending && pointer.pending.relativePath !== pointer.current.relativePath)
const candidate = join(root, pointer.pending.relativePath)
const asar = join(candidate, 'resources/app.asar')
const files = ['main.js', 'shell-input.js', 'shell-preload.cjs', 'shell-contract.js', 'mcp-scope-refresh.js', 'plugin-toolchain.js', 'plugin-seed.js', 'desktop-host.js']
const modules = []
for (const file of files) {
  const name = join('dist', 'src', file)
  const matches = extractFile(asar, name).equals(await readFile(join(root, name)))
  assert.ok(matches, name)
  modules.push({ file: name, matches })
}
async function hash(path) {
  const result = createHash('sha256')
  for await (const chunk of createReadStream(path)) result.update(chunk)
  return result.digest('hex')
}
const artifacts = []
for (const file of ['app.asar', 'node/node.exe', 'plugins-store.tgz', 'dsh-runtime.tgz']) {
  const candidateHash = await hash(join(candidate, 'resources', file))
  assert.equal(candidateHash, await hash(join(root, 'release/win-unpacked/resources', file)), file)
  artifacts.push({ file, sha256: candidateHash })
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(artifacts.find(item => item.file === 'node/node.exe').sha256.toUpperCase(), manifest.config.bundledNodeSha256['win32-x64'].toUpperCase())
const scans = []
for (let i = 0; i < 3; i++) {
  const entries = await readdir(join(root, 'Data/Temp/prepare-recycle'))
  assert.deepEqual(entries, [], 'recycler must be empty before activation can be proposed')
  scans.push(new Date().toISOString())
  if (i < 2) await setTimeout(3000)
}
assert.equal(await readFile(join(root, 'Data/Updates/Desktop/pointer.json'), 'utf8'), originalPointer, 'pointer changed; review before activation')
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), current: pointer.current, pending: pointer.pending, modules, artifacts, recyclerEmptyScans: scans, restarted: false }, null, 2))
