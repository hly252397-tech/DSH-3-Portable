import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { checkPreservationManifest, CustomizationPreservationError, type PreservationManifest } from '../src/customization-preservation.js'
import { PortableDesktopUpdater, portableDesktopPointerPath, portableDesktopUpdateRoot, type PortableDesktopPointer } from '../src/portable-desktop-update.js'
import { packDirectoryToTarGz, writeDirectoryContentSha256, writeFileSha256 } from '../src/runtime-archive.js'
import { makeTrackedTempDir } from './helpers/tmp.js'

// Only transport and the fake executable's product version are simulated. ZIP
// extraction uses the production PowerShell default; the preservation callback
// uses the same manifest validator as main. No EXE, Profile or prewarm is started.
const run = promisify(execFile)
const version = '1.2.3-rc.2+build.3'
const artifact = `dsh-codex-desktop-${version}-win-x64.zip`
const contractName = `dsh-portable-contract-${version}-win-x64.json`
const releaseRoot = `https://github.com/hly252397-tech/DSH-3-Portable/releases/download/v${encodeURIComponent(version)}/`
const requiredFiles = [
  'DSH Codex Desktop.exe', 'resources/app.asar', 'resources/node/node.exe',
  'resources/dsh-runtime.tgz', 'resources/dsh-runtime.tgz.sha256', 'resources/dsh-runtime.tgz.content-sha256',
  'resources/plugins-store.tgz', 'resources/plugins-store.tgz.sha256', 'resources/plugins-store.tgz.content-sha256',
  'resources/desktop-bridge/dsh-process.js', 'resources/desktop-bridge/profile-bundle-health.js',
  'resources/desktop-bridge/profile-quarantine.js', 'resources/process-control.js',
] as const
const shellAssets = {
  'resources/settings.html': '<!doctype html><meta charset="utf-8"><title>DSH 桌面设置</title>',
  'resources/shell.html': '<!doctype html><meta charset="utf-8"><main>已接受的桌面壳布局</main>',
  'resources/shell-icons/download.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M4 1v6"/></svg>',
  'resources/中文静态资源/手册入口.html': '<!doctype html><meta charset="utf-8"><a>DSH 可编辑手册</a>',
}
const sentinels = {
  'App/DSH Codex Desktop.exe': 'isolated current app - never execute',
  'App/resources/settings.html': '<main>现役桌面设置，不覆盖</main>',
  'Data/DSH-handbook/模型自我感知手册.md': '# DSH 手册\n用户可编辑内容必须保留。\n',
  'Data/user-preferences.json': '{"fixture":"用户已保存的本地设置"}\n',
}
const accepted: PreservationManifest = {
  schema: 1, revision: 2,
  features: ['ui.accepted-settings', 'plugins.accepted-local'],
  requiredPlugins: ['dsh-fixture-feature'],
  sources: [{
    pluginName: 'dsh-fixture-feature', sourceDir: 'customizations/fixture-feature',
    files: [{ path: 'index.js', sha256: createHash('sha256').update('export const fixture = true;\n').digest('hex') }],
  }],
}
type FixtureOptions = {
  missingFile?: typeof requiredFiles[number]
  badTgzSidecar?: boolean
  missingPreservationManifest?: boolean
  manifest?: PreservationManifest
  corruptDownload?: boolean
}
type Asset = { name: string; browser_download_url: string; size: number; digest: string }
type Fixture = {
  root: string
  packageDirectory: string
  archive: Buffer
  contract: Buffer
  requests: string[]
  preservationChecks: string[]
  initialPointer: PortableDesktopPointer
  initialPointerBytes: Buffer
  updater: PortableDesktopUpdater
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
async function put(root: string, relativePath: string, bytes: string | Buffer): Promise<void> {
  const path = join(root, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const workspace = await makeTrackedTempDir(join(tmpdir(), 'dsh-desktop-release-roundtrip-'))
  const root = join(workspace, 'portable')
  const packageDirectory = join(workspace, 'payload', 'package')
  for (const [path, bytes] of Object.entries(sentinels)) await put(root, path, bytes)
  await put(root, 'customizations/preservation.json', JSON.stringify(accepted))
  await put(root, 'customizations/fixture-feature/index.js', 'export const fixture = true;\n')
  for (const name of requiredFiles) {
    if (name.includes('.tgz')) continue
    await put(packageDirectory, name, `isolated non-executable fixture: ${name}\n`)
  }
  for (const [path, bytes] of Object.entries(shellAssets)) await put(packageDirectory, path, bytes)
  // Real ZIP must meet the production 1,000,000-byte asset minimum. Repetitive
  // padding could compress below it; do not weaken the consumer's size gate.
  await put(packageDirectory, 'resources/fixture-padding.bin', randomBytes(2 * 1024 * 1024))
  for (const name of ['dsh-runtime.tgz', 'plugins-store.tgz']) {
    const source = join(workspace, name + '-source')
    await put(source, 'fixture.txt', `真实微型 tar.gz：${name}\n`)
    const path = join(packageDirectory, 'resources', name)
    packDirectoryToTarGz(source, path)
    writeFileSha256(path)
    writeDirectoryContentSha256(source, path)
  }
  if (!options.missingPreservationManifest) {
    await put(packageDirectory, 'resources/preservation.json', JSON.stringify(options.manifest ?? accepted))
  }
  if (options.missingFile !== undefined) {
    const missing = join(packageDirectory, ...options.missingFile.split('/'))
    assert.ok(missing.startsWith(packageDirectory + '\\') || missing.startsWith(packageDirectory + '/'))
    await rm(missing) // A single exact fixture file; never a directory or production path.
  }
  if (options.badTgzSidecar) await put(packageDirectory, 'resources/dsh-runtime.tgz.sha256', '0'.repeat(64) + '\n')
  const archivePath = join(workspace, artifact)
  await run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:DSH_TEST_RELEASE_PACKAGE -DestinationPath $env:DSH_TEST_RELEASE_ARCHIVE -CompressionLevel Optimal",
  ], {
    windowsHide: true, timeout: 60_000,
    env: { ...process.env, DSH_TEST_RELEASE_PACKAGE: packageDirectory, DSH_TEST_RELEASE_ARCHIVE: archivePath },
  })
  const archive = await readFile(archivePath)
  assert.ok(archive.length >= 1_000_000, `Real ZIP too small: ${archive.length}`)
  const contractPath = join(workspace, contractName)
  const generator = fileURLToPath(new URL('../../scripts/create-portable-release-contract.mjs', import.meta.url))
  await run(process.execPath, [generator, version, archivePath, contractPath], { windowsHide: true, timeout: 20_000 })
  const contract = await readFile(contractPath)
  const generated = JSON.parse(contract.toString('utf8')) as { version: string; revision: number; sha256: string }
  assert.equal(generated.version, version)
  assert.equal(generated.revision, 3)
  assert.equal(generated.sha256, digest(archive))
  const assets: Asset[] = [
    { name: artifact, browser_download_url: releaseRoot + encodeURIComponent(artifact), size: archive.length, digest: `sha256:${digest(archive)}` },
    { name: contractName, browser_download_url: releaseRoot + encodeURIComponent(contractName), size: contract.length, digest: `sha256:${digest(contract)}` },
  ]
  const metadata = { tag_name: `v${version}`, draft: false, prerelease: true, body: 'Local real-ZIP fixture; no runtime boot.', assets }
  const initialPointer: PortableDesktopPointer = {
    schema: 1,
    current: { relativePath: 'App', version: '1.0.0', sha256: digest(Buffer.from(sentinels['App/DSH Codex Desktop.exe'])) },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const pointerPath = portableDesktopPointerPath(portableDesktopUpdateRoot(root))
  await mkdir(dirname(pointerPath), { recursive: true })
  await writeFile(pointerPath, JSON.stringify(initialPointer) + '\n')
  const initialPointerBytes = await readFile(pointerPath)
  const requests: string[] = []
  const preservationChecks: string[] = []
  const updater = new PortableDesktopUpdater({
    portableRoot: root, currentVersion: '1.0.0',
    fetch: async input => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://api.github.com/repos/hly252397-tech/DSH-3-Portable/releases?per_page=50') return Response.json([metadata])
      if (url === assets[1]!.browser_download_url) return new Response(new Uint8Array(contract))
      if (url === assets[0]!.browser_download_url) {
        const downloaded = Buffer.from(archive)
        if (options.corruptDownload) downloaded[downloaded.length - 1] = downloaded[downloaded.length - 1]! ^ 1
        return new Response(new Uint8Array(downloaded))
      }
      // Never use a real network fallback, even for a mistyped fixture URL.
      throw new Error(`Unexpected isolated release request: ${url}`)
    },
    readProductVersion: async executable => {
      assert.ok(executable.startsWith(root + '\\') || executable.startsWith(root + '/'))
      assert.equal(await readFile(executable, 'utf8'), 'isolated non-executable fixture: DSH Codex Desktop.exe\n')
      return version.split('+')[0]!
    },
    // This is a real production validator, not a callback returning success.
    // Full live Profile/customization snapshot and runtime prewarm are excluded.
    verifyCandidatePreservation: async directory => {
      preservationChecks.push(directory)
      const value: unknown = JSON.parse(await readFile(join(directory, 'resources', 'preservation.json'), 'utf8'))
      const report = checkPreservationManifest(value, accepted)
      if (!report.ok) throw new CustomizationPreservationError(report.issues)
    },
  })
  await updater.initialize()
  return { root, packageDirectory, archive, contract, requests, preservationChecks, initialPointer, initialPointerBytes, updater }
}

async function assertSentinelsIntact(state: Fixture): Promise<void> {
  for (const [path, bytes] of Object.entries(sentinels)) {
    assert.deepEqual(await readFile(join(state.root, ...path.split('/'))), Buffer.from(bytes), path)
  }
}
async function assertPointerUnchanged(state: Fixture): Promise<void> {
  assert.deepEqual(await readFile(portableDesktopPointerPath(portableDesktopUpdateRoot(state.root))), state.initialPointerBytes)
}

test('本地真实 ZIP/契约/default 解压/生产保留校验往返只登记 pending；不执行 EXE 或 runtime prewarm', { skip: process.platform !== 'win32', timeout: 120_000 }, async t => {
  const state = await fixture()
  assert.equal((await state.updater.check('preview')).phase, 'available', state.updater.state.detail)
  const ready = await state.updater.prepare()
  assert.equal(ready.phase, 'ready', ready.detail)
  assert.equal(state.preservationChecks.length, 1)
  await assertSentinelsIntact(state)
  await assertPointerUnchanged(state)
  assert.ok(ready.slotRelativePath)
  const slot = resolve(state.root, ready.slotRelativePath)
  assert.notEqual(slot, join(state.root, 'App'))
  for (const name of requiredFiles) {
    assert.deepEqual(await readFile(join(slot, ...name.split('/'))), await readFile(join(state.packageDirectory, ...name.split('/'))), name)
  }
  for (const [name, bytes] of Object.entries(shellAssets)) assert.deepEqual(await readFile(join(slot, ...name.split('/'))), Buffer.from(bytes), name)
  assert.deepEqual(JSON.parse(await readFile(join(slot, 'resources', 'preservation.json'), 'utf8')), accepted)
  const manifestBytes = await readFile(join(slot, 'slot-manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { version: string; sourceArchiveSha256: string; files: Record<string, string> }
  assert.equal(manifest.version, version)
  assert.equal(manifest.sourceArchiveSha256, digest(state.archive))
  for (const name of requiredFiles) assert.equal(manifest.files[name], digest(await readFile(join(slot, ...name.split('/')))), name)
  assert.equal((await state.updater.stageActivation()).phase, 'deploying', state.updater.state.detail)
  const pointer = JSON.parse(await readFile(portableDesktopPointerPath(portableDesktopUpdateRoot(state.root)), 'utf8')) as PortableDesktopPointer
  assert.deepEqual(pointer.current, state.initialPointer.current)
  assert.equal(pointer.previous, undefined)
  assert.equal(pointer.pending?.relativePath, ready.slotRelativePath)
  assert.equal(pointer.pending?.transactionId, ready.transactionId)
  assert.equal(pointer.pending?.sha256, digest(manifestBytes))
  assert.equal(state.preservationChecks.length, 2, 'Preservation must run again immediately before staging')
  await assertSentinelsIntact(state)
  assert.equal(state.requests.filter(url => url === releaseRoot + encodeURIComponent(artifact)).length, 1)
  t.diagnostic('REAL Windows Compress-Archive + production Expand-Archive + generated release contract + manifest preservation callback; only fetch/productVersion simulated; no prewarm, EXE, DSH/Profile boot or activation health acceptance.')
})

test('真实 ZIP 负例拒绝摘要、必需文件、tgz sidecar 与保护清单丢失；现役 App/Data/current 不变', { skip: process.platform !== 'win32', timeout: 600_000 }, async t => {
  const cases: Array<{ name: string; options: FixtureOptions; errorCode: string; preservationChecks: number; detail?: RegExp }> = [
    { name: '下载 bytes 与真实契约 SHA256 不同', options: { corruptDownload: true }, errorCode: 'HASH_MISMATCH', preservationChecks: 0 },
    { name: '真实 ZIP 缺生产 required 文件', options: { missingFile: 'resources/desktop-bridge/profile-bundle-health.js' }, errorCode: 'PACKAGE_INCOMPLETE', preservationChecks: 0 },
    { name: '真实 tgz 字节 sidecar 不匹配', options: { badTgzSidecar: true }, errorCode: 'SIDECAR_MISMATCH', preservationChecks: 0 },
    { name: 'ZIP 缺保留清单', options: { missingPreservationManifest: true }, errorCode: 'PREPARE_FAILED', preservationChecks: 1 },
    { name: 'ZIP 清单丢失已接受功能', options: { manifest: { ...accepted, features: ['ui.accepted-settings'] } }, errorCode: 'PREPARE_FAILED', preservationChecks: 1, detail: /FEATURE_MISSING/ },
    { name: 'ZIP 清单丢失必需插件', options: { manifest: { ...accepted, requiredPlugins: [] } }, errorCode: 'PREPARE_FAILED', preservationChecks: 1, detail: /PLUGIN_REQUIREMENT_MISSING/ },
  ]
  for (const scenario of cases) await t.test(scenario.name, { timeout: 100_000 }, async () => {
    const state = await fixture(scenario.options)
    assert.equal((await state.updater.check('preview')).phase, 'available', state.updater.state.detail)
    const result = await state.updater.prepare()
    assert.equal(result.phase, 'error', result.detail)
    assert.equal(result.errorCode, scenario.errorCode, result.detail)
    assert.equal(state.preservationChecks.length, scenario.preservationChecks, result.detail)
    if (scenario.detail !== undefined) assert.match(result.detail, scenario.detail)
    assert.equal(result.slotRelativePath, undefined)
    await assertSentinelsIntact(state)
    await assertPointerUnchanged(state)
    const pointer = JSON.parse(await readFile(portableDesktopPointerPath(portableDesktopUpdateRoot(state.root)), 'utf8')) as PortableDesktopPointer
    assert.equal(pointer.pending, undefined)
    assert.equal(existsSync(join(state.root, 'App', 'DSH Codex Desktop.exe')), true)
  })
})
