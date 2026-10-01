import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  DEFAULT_HARNESS_RELEASE_SOURCE, fetchHarnessPrebuiltRelease, fetchHarnessReleaseAsset,
  harnessReleaseNames, parseHarnessReleaseContract, stampHarnessPrebuiltLockfile, type HarnessReleaseContract,
} from '../src/harness-release-catalog.js'

const VERSION = '0.9.0-rc.42'
const NODE = '26.10.0'
const INTEGRITY = `sha512-${Buffer.alloc(64, 17).toString('base64')}`
const COMMIT = 'a'.repeat(40)
const names = harnessReleaseNames(VERSION)
const source = DEFAULT_HARNESS_RELEASE_SOURCE
const assetUrl = (name: string) => `https://github.com/${source.owner}/${source.repo}/releases/download/${names.tag}/${name}`

function contractFixture(patch: Record<string, unknown> = {}): HarnessReleaseContract {
  return {
    schema: 1, component: 'harness', version: VERSION, platform: 'win32', arch: 'x64', nodeVersion: NODE,
    artifact: names.artifact, size: 10_000, unpackedSize: 20_000,
    sha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64), runtimeFingerprint: 'd'.repeat(64),
    npmIntegrity: INTEGRITY, officialCommit: COMMIT, ...patch,
  }
}

function publisher(options: {
  patch?: Record<string, unknown>; assetPatch?: Record<string, unknown>; manifestBytes?: Buffer;
  provenancePatch?: Record<string, unknown>; missing?: boolean; annotated?: boolean
} = {}): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = []
  const contract = contractFixture(options.patch)
  const bytes = Buffer.from(JSON.stringify(contract))
  const fetchImpl: typeof fetch = async input => {
    const url = String(input)
    requests.push(url)
    if (url.includes(`/releases/tags/${names.tag}`)) {
      if (options.missing) return new Response('', { status: 404 })
      return Response.json({ tag_name: names.tag, draft: false, prerelease: true, assets: [
        { name: names.artifact, size: contract.size, digest: `sha256:${contract.sha256}`, browser_download_url: assetUrl(names.artifact), ...options.assetPatch },
        { name: names.contract, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: assetUrl(names.contract) },
      ] })
    }
    if (url === assetUrl(names.contract)) return new Response(new Uint8Array(options.manifestBytes ?? bytes))
    if (url.startsWith('https://registry.npmjs.org/')) return Response.json({
      name: '@deepseek-ai/dsh', version: VERSION, dist: {
        integrity: INTEGRITY, tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${VERSION}.tgz`,
        signatures: [{ keyid: 'SHA256:registry-key' }], ...options.provenancePatch,
      },
    })
    if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: options.annotated ? 'tag' : 'commit', sha: COMMIT } })
    if (url.includes('/git/tags/')) return Response.json({ object: { type: 'commit', sha: COMMIT } })
    throw new Error('Unexpected request')
  }
  return { fetch: fetchImpl, requests }
}

test('独立预发布清单不依赖编译受信版本；同时核对官方 npm 与 commit', async () => {
  const remote = publisher()
  const release = await fetchHarnessPrebuiltRelease({ version: VERSION, nodeVersion: `v${NODE}`, fetch: remote.fetch })
  assert.equal(release?.version, VERSION)
  assert.equal(release?.nodeVersion, NODE)
  assert.equal(release?.assetUrl, assetUrl(names.artifact))
  assert.equal(release?.npmIntegrity, INTEGRITY)
  assert.equal(release?.officialCommit, COMMIT)
  assert.deepEqual({ ...release?.profileCompatibility }, {})
  assert.equal(remote.requests.length, 4)
  assert.ok(remote.requests.every(url => url.startsWith('https://api.github.com/') || url.startsWith('https://github.com/') || url.startsWith('https://registry.npmjs.org/')))
})

test('独立包不存在时返回明确缺包，不触发 npm 安装或探测外部地址', async () => {
  const remote = publisher({ missing: true })
  assert.equal(await fetchHarnessPrebuiltRelease({ version: VERSION, nodeVersion: NODE, fetch: remote.fetch }), undefined)
  assert.equal(remote.requests.length, 1)
})

test('发布身份分离旧本地槽并包含精确 Node；重复制作标记保持确定性', () => {
  const old = "lockfileVersion: '9.0'\npackages:\n"
  const next = stampHarnessPrebuiltLockfile(old, `v${NODE}`)
  assert.notEqual(next, old)
  assert.ok(next.endsWith(old))
  assert.equal(stampHarnessPrebuiltLockfile(next, NODE), next)
  assert.notEqual(stampHarnessPrebuiltLockfile(old, '26.10.1'), next)
  assert.throws(() => stampHarnessPrebuiltLockfile(old, '26.x'))
})

test('官方 annotated tag 必须解析到 commit', async () => {
  const remote = publisher({ annotated: true })
  const release = await fetchHarnessPrebuiltRelease({ version: VERSION, nodeVersion: NODE, fetch: remote.fetch })
  assert.equal(release?.officialCommit, COMMIT)
  assert.equal(remote.requests.length, 5)
})

test('兼容契约拒绝错误 schema、版本、平台、Node、大小、摘要及制品名称', () => {
  const patches = [
    { schema: 2 }, { version: '0.8.0' }, { platform: 'linux' }, { arch: 'arm64' },
    { nodeVersion: '24.21.0' }, { size: 0 }, { size: 1_500_000_001 }, { unpackedSize: 8 * 1024 ** 3 + 1 },
    { sha256: 'bad' }, { contentSha256: 'bad' }, { runtimeFingerprint: 'bad' }, { artifact: '../evil.tgz' },
    { npmIntegrity: 'sha512-short' }, { officialCommit: 'bad' },
  ]
  for (const patch of patches) assert.throws(() => parseHarnessReleaseContract(contractFixture(patch), VERSION, NODE))
  assert.throws(() => harnessReleaseNames('../version'))
})

test('插件授权精确限定包版本与目标内核；不接受通配或继承其他内核授权', () => {
  const parsed = parseHarnessReleaseContract(contractFixture({
    profileCompatibility: { '@michengai/dsh-codex-ui@1.1.18': [VERSION], 'dsh-local@1.0.0-alpha.2': [VERSION] },
    dataCompatibilityGroup: 'session-v2',
  }), VERSION, NODE)
  assert.deepEqual(parsed.profileCompatibility?.['@michengai/dsh-codex-ui@1.1.18'], [VERSION])
  assert.equal(parsed.dataCompatibilityGroup, 'session-v2')
  for (const patch of [
    { profileCompatibility: { 'pkg@*': [VERSION] } },
    { profileCompatibility: { 'pkg@1.0.0': ['*'] } },
    { profileCompatibility: { 'pkg@1.0.0': ['0.8.0'] } },
    { profileCompatibility: { 'pkg@1.0.0': [VERSION, VERSION] } },
    { profileCompatibility: { '../pkg@1.0.0': [VERSION] } },
    { profileCompatibility: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`pkg${index}@1.0.0`, [VERSION]])) },
    { dataCompatibilityGroup: '../old-home' },
  ]) assert.throws(() => parseHarnessReleaseContract(contractFixture(patch), VERSION, NODE))
})

test('清单和 GitHub 资产双摘要、大小及官方来源必须一致', async () => {
  for (const remote of [
    publisher({ manifestBytes: Buffer.from('{}') }),
    publisher({ assetPatch: { digest: undefined } }),
    publisher({ assetPatch: { size: 10_001 } }),
    publisher({ provenancePatch: { integrity: `sha512-${Buffer.alloc(64, 18).toString('base64')}` } }),
    publisher({ provenancePatch: { signatures: [] } }),
    publisher({ provenancePatch: { tarball: 'https://evil.invalid/dsh.tgz' } }),
  ]) await assert.rejects(fetchHarnessPrebuiltRelease({ version: VERSION, nodeVersion: NODE, fetch: remote.fetch }))
})

test('伪造资产地址在请求前拒绝，拒绝跨仓库、HTTP、凭据和查询参数', async () => {
  for (const address of [
    'https://evil.invalid/dsh.tgz', assetUrl(names.artifact).replace(source.owner, 'evil'),
    assetUrl(names.artifact).replace('https:', 'http:'), assetUrl(names.artifact).replace('github.com', 'user:secret@github.com'),
    `${assetUrl(names.artifact)}?override=1`,
  ]) {
    const remote = publisher({ assetPatch: { browser_download_url: address } })
    await assert.rejects(fetchHarnessPrebuiltRelease({ version: VERSION, nodeVersion: NODE, fetch: remote.fetch }))
    assert.equal(remote.requests.length, 1)
  }
})

test('制品重定向仅接受 GitHub CDN，不跟随本机或任意远端地址', async () => {
  const requests: string[] = []
  const fetchImpl: typeof fetch = async input => {
    requests.push(String(input))
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9801/private' } })
  }
  await assert.rejects(fetchHarnessReleaseAsset(assetUrl(names.artifact), source, names.tag, names.artifact, { fetch: fetchImpl }))
  assert.equal(requests.length, 1)
  const approved: typeof fetch = async input => String(input).includes('github.com/')
    ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/asset?signature=cdn' } })
    : new Response('verified')
  assert.equal(await (await fetchHarnessReleaseAsset(assetUrl(names.artifact), source, names.tag, names.artifact, { fetch: approved })).text(), 'verified')
})
