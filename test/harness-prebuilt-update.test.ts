import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'

import { OFFICIAL_LAUNCH_PEERS } from '../src/bundled-plugins.js'
import { DEFAULT_HARNESS_RELEASE_SOURCE, harnessReleaseNames, stampHarnessPrebuiltLockfile, type HarnessPrebuiltRelease } from '../src/harness-release-catalog.js'
import { extractHarnessRuntimeArchive, harnessRuntimeContentSha256, prepareHarnessPrebuiltCandidate, validateHarnessArchivePath } from '../src/harness-prebuilt-update.js'
import { validateHarnessRuntimeCandidate } from '../src/harness-runtime-candidate.js'
import { writeOfficialRuntimeManifest } from '../src/plugin-seed.js'
import { packDirectoryToTarGz } from '../src/runtime-archive.js'
import { makeTrackedTempDir as mkdtemp } from './helpers/tmp.js'

const VERSION = '0.9.0-rc.42'
const NODE = '26.10.0'
const INTEGRITY = `sha512-${Buffer.alloc(64, 17).toString('base64')}`

async function fixture(): Promise<{ root: string; archive: Buffer; release: HarnessPrebuiltRelease; requests: string[]; options: Parameters<typeof prepareHarnessPrebuiltCandidate>[0] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prebuilt-'))
  const runtime = join(root, 'fixture-runtime')
  await mkdir(join(runtime, 'node_modules', '.pnpm'), { recursive: true })
  await writeFile(join(runtime, 'node_modules', '.modules.yaml'), JSON.stringify({ virtualStoreDir: '.pnpm' }))
  writeOfficialRuntimeManifest(runtime, VERSION)
  const packages = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-attachment-local', '@deepseek-ai/dsh-host-apiproxy', '@deepseek-ai/dsh-invariants', ...OFFICIAL_LAUNCH_PEERS.map(peer => peer.packageName)])
  for (const name of packages) {
    const path = join(runtime, 'node_modules', ...name.split('/'))
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: name.startsWith('@deepseek-ai/dsh') ? VERSION : '1.0.4' }))
    if (name === '@deepseek-ai/dsh') {
      await mkdir(join(path, 'lib'))
      await writeFile(join(path, 'lib', 'bin.js'), 'export const installed = true;')
    }
  }
  await writeFile(join(runtime, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npackages:\n  dsh:\n    integrity: ${INTEGRITY}\n`)
  await writeFile(join(runtime, 'padding.bin'), randomBytes(8_192))
  const legacyValidation = await validateHarnessRuntimeCandidate(runtime, VERSION, INTEGRITY)
  await writeFile(join(runtime, 'pnpm-lock.yaml'), stampHarnessPrebuiltLockfile(await readFile(join(runtime, 'pnpm-lock.yaml'), 'utf8'), NODE))
  const validation = await validateHarnessRuntimeCandidate(runtime, VERSION, INTEGRITY)
  assert.notEqual(validation.fingerprint, legacyValidation.fingerprint, 'Prebuilt publishing must not reuse a linked legacy slot identity')
  await writeFile(join(runtime, '.dsh-runtime-fingerprint'), `${validation.fingerprint}\n`)
  let unpackedSize = 0
  const count = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await count(join(path, entry.name))
      else unpackedSize += (await readFile(join(path, entry.name))).length
    }
  }
  await count(runtime)
  const names = harnessReleaseNames(VERSION)
  const archivePath = join(root, names.artifact)
  packDirectoryToTarGz(runtime, archivePath)
  const archive = await readFile(archivePath)
  const release: HarnessPrebuiltRelease = {
    schema: 1, component: 'harness', version: VERSION, platform: 'win32', arch: 'x64', nodeVersion: NODE,
    artifact: names.artifact, size: archive.length, unpackedSize,
    sha256: createHash('sha256').update(archive).digest('hex'), contentSha256: await harnessRuntimeContentSha256(runtime),
    npmIntegrity: INTEGRITY, officialCommit: 'a'.repeat(40), runtimeFingerprint: validation.fingerprint,
    releaseTag: names.tag, source: DEFAULT_HARNESS_RELEASE_SOURCE,
    assetUrl: `https://github.com/hly252397-tech/DSH-3-Portable/releases/download/${names.tag}/${names.artifact}`,
  }
  const requests: string[] = []
  const options = {
    legacyRuntimeDir: join(root, 'runtime', 'dsh-runtime'), updateRoot: join(root, 'updates'), release, nodeVersion: NODE,
    fetch: (async input => { requests.push(String(input)); return new Response(new Uint8Array(archive)) }) as typeof fetch,
  }
  return { root, archive, release, requests, options }
}

test('真实 tgz 成品通过完整摘要与依赖闭包后进入槽；复用不下载、不安装、不改活动指针', async () => {
  const env = await fixture()
  try {
    const active = join(env.root, 'runtime', 'Harness', 'current.json')
    await mkdir(dirname(active), { recursive: true })
    await writeFile(active, 'existing-active-pointer')
    const phases: string[] = []
    const first = await prepareHarnessPrebuiltCandidate({ ...env.options, onProgress: value => phases.push(value.phase) })
    assert.equal(first.reused, false)
    assert.equal(first.version, VERSION)
    assert.equal(first.fingerprint, env.release.runtimeFingerprint)
    assert.equal(env.requests.length, 1)
    assert.equal(await harnessRuntimeContentSha256(first.directory), env.release.contentSha256)
    assert.equal(await readFile(active, 'utf8'), 'existing-active-pointer')
    assert.ok(phases.includes('extracting') && phases.includes('validating'))
    const second = await prepareHarnessPrebuiltCandidate(env.options)
    assert.equal(second.reused, true)
    assert.equal(second.directory, first.directory)
    assert.equal(env.requests.length, 1)
    assert.deepEqual((await readdir(dirname(first.directory))).filter(name => name.startsWith('.prebuilt-staging-')), [])
    // Integrity of an existing slot covers JS bytes, not just package manifests and lockfiles.
    await writeFile(join(first.directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'corrupted')
    await assert.rejects(prepareHarnessPrebuiltCandidate(env.options), /文件内容/)
    assert.equal(env.requests.length, 1)
    assert.equal(await readFile(active, 'utf8'), 'existing-active-pointer')
  } finally { await rm(env.root, { recursive: true, force: true }) }
})

test('经 SHA256 验证的下载缓存可用于重新准备槽，坏缓存必须重新获取', async () => {
  const env = await fixture()
  try {
    const first = await prepareHarnessPrebuiltCandidate(env.options)
    await rm(first.directory, { recursive: true, force: true })
    const second = await prepareHarnessPrebuiltCandidate(env.options)
    assert.equal(second.reused, false)
    assert.equal(env.requests.length, 1)
    await rm(second.directory, { recursive: true, force: true })
    await writeFile(join(env.options.updateRoot, 'downloads', VERSION, env.release.artifact), 'bad-cache')
    await prepareHarnessPrebuiltCandidate(env.options)
    assert.equal(env.requests.length, 2)
  } finally { await rm(env.root, { recursive: true, force: true }) }
})

test('截断、超长、错误 SHA256、HTTP失败和 Node 不符均不触碰现役槽', async () => {
  const env = await fixture()
  try {
    const keeper = join(env.root, 'runtime', 'dsh-runtime', 'keep.txt')
    await mkdir(dirname(keeper), { recursive: true })
    await writeFile(keeper, 'active')
    for (const response of [
      () => new Response(new Uint8Array(env.archive.subarray(0, env.archive.length - 1))),
      () => new Response(Buffer.concat([env.archive, Buffer.from('extra')])),
      () => new Response(Buffer.alloc(env.archive.length)),
      () => new Response('offline', { status: 503 }),
      () => new Response(new Uint8Array(env.archive), { headers: { 'content-length': String(env.archive.length + 1) } }),
    ]) {
      await assert.rejects(prepareHarnessPrebuiltCandidate({ ...env.options, fetch: (async () => response()) as typeof fetch }))
      assert.equal(await readFile(keeper, 'utf8'), 'active')
      const downloads = join(env.options.updateRoot, 'downloads', VERSION)
      assert.ok(!existsSync(downloads) || !(await readdir(downloads)).some(name => name.endsWith('.partial')))
    }
    await assert.rejects(prepareHarnessPrebuiltCandidate({ ...env.options, nodeVersion: '24.21.0' }), /Node/)
    assert.equal(await readFile(keeper, 'utf8'), 'active')
  } finally { await rm(env.root, { recursive: true, force: true }) }
})

test('运行时指纹、文件内容和解压大小必须与契约一致；失败清理暂存', async () => {
  const env = await fixture()
  try {
    for (const patch of [
      { runtimeFingerprint: 'e'.repeat(64) }, { contentSha256: 'f'.repeat(64) },
      { unpackedSize: env.release.unpackedSize - 1 }, { unpackedSize: env.release.unpackedSize + 1 },
      { npmIntegrity: `sha512-${Buffer.alloc(64, 18).toString('base64')}` },
    ]) {
      await assert.rejects(prepareHarnessPrebuiltCandidate({ ...env.options, release: { ...env.release, ...patch } }))
      const slots = join(env.root, 'runtime', 'Harness', 'slots')
      assert.deepEqual((await readdir(slots)).filter(name => name.startsWith('.prebuilt-staging-')), [])
    }
  } finally { await rm(env.root, { recursive: true, force: true }) }
})

function entry(name: string, type = '0', data: Buffer = Buffer.from('x'), link = ''): Buffer {
  const header = Buffer.alloc(512)
  const field = (offset: number, length: number, value: string): void => { header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8') }
  field(0, 100, name)
  field(100, 8, '0000644\0')
  field(124, 12, `${data.length.toString(8).padStart(11, '0')}\0`)
  field(148, 8, '        ')
  field(156, 1, type)
  field(157, 100, link)
  field(257, 6, 'ustar\0')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  field(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)])
}

function paxRecord(key: string, value: string): Buffer {
  const field = ` ${key}=${value}\n`
  let length = Buffer.byteLength(field) + 1
  while (Buffer.byteLength(`${length}${field}`) !== length) length = Buffer.byteLength(`${length}${field}`)
  return Buffer.from(`${length}${field}`)
}

test('安全解包拒绝路径穿越、符号/硬链接、设备、PAX链接及重复文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prebuilt-malicious-'))
  try {
    const bad = [
      entry('../outside.txt'), entry('/outside.txt'), entry('C:/outside.txt'),
      entry('link', '2', Buffer.alloc(0), '../outside'), entry('link', '1', Buffer.alloc(0), '../outside'),
      entry('device', '3', Buffer.alloc(0)), Buffer.concat([entry('same'), entry('SAME')]),
      entry('pax', 'x', paxRecord('linkpath', '../outside')),
    ]
    for (let index = 0; index < bad.length; index += 1) {
      const archive = join(root, `bad-${index}.tgz`)
      const destination = join(root, `staging-${index}`)
      await mkdir(destination)
      await writeFile(archive, gzipSync(Buffer.concat([bad[index]!, Buffer.alloc(1_024)])))
      await assert.rejects(extractHarnessRuntimeArchive(archive, destination, 100))
      assert.equal(existsSync(join(root, 'outside.txt')), false)
    }
    for (const path of ['../x', 'a/../x', '/x', 'C:/x', 'a\\b', 'a:stream', 'aux.txt', 'a/CON', 'x. ', 'x\u0000y']) assert.throws(() => validateHarnessArchivePath(path))
    assert.equal(validateHarnessArchivePath('./node_modules/@deepseek-ai/dsh/lib/bin.js'), 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('安全解包支持 GNU 长文件名及 PAX UTF-8 路径，而不误用扩展头名称', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prebuilt-long-path-'))
  try {
    const long = `node_modules/${'long-'.repeat(23)}/entry.js`
    const unicode = 'node_modules/中文插件/说明.md'
    const archive = join(root, 'long.tgz')
    await writeFile(archive, gzipSync(Buffer.concat([
      entry('././@LongLink', 'L', Buffer.from(`${long}\0`)), entry('short', '0', Buffer.from('long')),
      entry('pax-header', 'x', paxRecord('path', unicode)), entry('short', '0', Buffer.from('utf8')),
      Buffer.alloc(1_024),
    ])))
    const destination = join(root, 'unpacked')
    await extractHarnessRuntimeArchive(archive, destination, 8)
    assert.equal(await readFile(join(destination, ...long.split('/')), 'utf8'), 'long')
    assert.equal(await readFile(join(destination, ...unicode.split('/')), 'utf8'), 'utf8')
    assert.equal(existsSync(join(destination, 'short')), false)
    assert.equal(existsSync(join(destination, 'pax-header')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('已有不完整槽禁止原地修补，更新路径祖先 junction 禁止穿越', async () => {
  const env = await fixture()
  try {
    const slot = join(env.root, 'runtime', 'Harness', 'slots', `${VERSION}-${env.release.runtimeFingerprint.slice(0, 16)}`)
    await mkdir(slot, { recursive: true })
    await writeFile(join(slot, 'keep.txt'), 'do not repair')
    await assert.rejects(prepareHarnessPrebuiltCandidate(env.options), /原地修补/)
    assert.equal(env.requests.length, 0)
    assert.equal(await readFile(join(slot, 'keep.txt'), 'utf8'), 'do not repair')
    await rm(join(env.root, 'runtime'), { recursive: true, force: true })
    const outside = join(env.root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(env.root, 'runtime'), 'junction')
    await assert.rejects(prepareHarnessPrebuiltCandidate(env.options), /普通目录/)
    assert.deepEqual(await readdir(outside), [])
    assert.equal(env.requests.length, 0)
    await assert.rejects(extractHarnessRuntimeArchive(join(env.root, env.release.artifact), join(env.root, 'runtime', 'unsafe-staging'), env.release.unpackedSize), /普通目录/)
    assert.deepEqual(await readdir(outside), [])
  } finally { await rm(env.root, { recursive: true, force: true }) }
})

test('已取消操作不下载、不创建候选；GZIP截断不发布', async () => {
  const env = await fixture()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(prepareHarnessPrebuiltCandidate({ ...env.options, signal: controller.signal }))
    assert.equal(env.requests.length, 0)
    const archive = join(env.root, 'truncated.tgz')
    await writeFile(archive, env.archive.subarray(0, env.archive.length - 10))
    await assert.rejects(extractHarnessRuntimeArchive(archive, join(env.root, 'truncated'), env.release.unpackedSize))
  } finally { await rm(env.root, { recursive: true, force: true }) }
})
