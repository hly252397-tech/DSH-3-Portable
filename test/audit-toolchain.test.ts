import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { verifyPrepareRuntimeNode } from '../scripts/prepare-runtime.js'

test('builder v27 configuration does not retain removed Linux desktop-name switch', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(Object.hasOwn(manifest.build.linux, 'syncDesktopName'), false)
  assert.equal(manifest.build.linux.executableName, 'dsh-codex-desktop')
  assert.equal(manifest.build.executableName, 'DSH Codex Desktop')
})

test('prepare-runtime rejects wrong version/hash without modifying fixture files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-node-preflight-'))
  try {
    const executable = join(root, 'fake-node')
    await writeFile(executable, 'node-fixture')
    const checksum = createHash('sha256').update('node-fixture').digest('hex').toUpperCase()
    const manifest = { config: { bundledNodeVersion: process.version, bundledNodeSha256: { [`${process.platform}-${process.arch}`]: checksum } } }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const before = await readFile(join(root, 'package.json'), 'utf8')
    assert.equal((await verifyPrepareRuntimeNode(root, executable)).sha256, checksum)
    await assert.rejects(verifyPrepareRuntimeNode(root, executable, 'v0.0.0'), /版本不匹配/)
    await writeFile(executable, 'wrong binary')
    await assert.rejects(verifyPrepareRuntimeNode(root, executable), /SHA256 不匹配/)
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('gate-node validates CI process executable and fails closed on a mismatched manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gate-node-'))
  try {
    await mkdir(join(root, 'scripts', 'lib'), { recursive: true })
    await copyFile(resolve('scripts/lib/gate-node.mjs'), join(root, 'scripts', 'lib', 'gate-node.mjs'))
    const executableHash = createHash('sha256').update(await readFile(process.execPath)).digest('hex')
    const manifest = { config: { bundledNodeSha256: { [`${process.platform}-${process.arch}`]: executableHash } } }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const run = () => spawnSync(process.execPath, [join(root, 'scripts', 'lib', 'gate-node.mjs')], { encoding: 'utf8', windowsHide: true })
    assert.equal(run().status, 0)
    manifest.config.bundledNodeSha256[`${process.platform}-${process.arch}`] = '0'.repeat(64)
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const rejected = run()
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /拒绝未校验/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('diagnostic and cmd entrypoints use manifest checked Node while pnpm stays separate', async () => {
  for (const name of ['diag-profile-web', 'diagnostic-web', 'probe-shadow-start']) {
    const source = await readFile(`scripts/${name}.mjs`, 'utf8')
    assert.match(source, /import \{ GATE_NODE \} from '\.\/lib\/gate-node\.mjs'/)
    assert.doesNotMatch(source, /const node(?:Exe|Executable) = join\(/)
    if (name !== 'diagnostic-web') {
      assert.match(source, /const pnpmEntry = resolveGatePnpm\(root\)/)
      assert.doesNotMatch(source, /'App', 'resources', 'node', 'pnpm-package'/)
    }
  }
  for (const name of ['Install-P3-Tiny-Watch.cmd', 'Test-P3-Tiny-Watch.cmd', '重建技能链接.cmd']) {
    const source = await readFile(name, 'utf8')
    assert.match(source, /Tools\\node\\node\.exe/)
    assert.match(source, /scripts\\gate-node-run\.mjs/)
    assert.doesNotMatch(source, /App\\resources\\node\\node\.exe/)
  }
  const prepare = await readFile('scripts/prepare-runtime.ts', 'utf8')
  const main = prepare.slice(prepare.indexOf('async function main()'))
  assert.ok(main.indexOf('await verifyPrepareRuntimeNode()') < main.indexOf('await removePreparedPath(target)'))
  assert.ok(main.indexOf("process.argv.includes('--check-node')") < main.indexOf('await writeReleaseSourceManifest'))
})
