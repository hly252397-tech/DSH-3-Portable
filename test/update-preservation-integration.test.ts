import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { compareReleaseVersions } from '../src/bundled-plugins.js'
import { checkPreservationManifest, CustomizationPreservationError, type PreservationManifest } from '../src/customization-preservation.js'
import { compareDesktopReleaseIdentities, desktopReleaseRevision, PortableDesktopUpdater, portableDesktopPointerPath, portableDesktopStatePath, portableDesktopUpdateRoot } from '../src/portable-desktop-update.js'
import { makeTrackedTempDir } from './helpers/tmp.js'

// 全链路只使用隔离的假制品与真实校验控制器，不访问现役 Profile、发布服务或进程。
const sourcePrefix = 'https://github.com/hly252397-tech/DSH-3-Portable/releases/download/'

test('ordinary startup preserves an installed Profile without treating in-flight developer sources as an update', async () => {
  const source = await readFile(resolve('src/main.ts'), 'utf8')
  const startup = source.slice(source.indexOf('const profileDir = resolveWebProfileDir()'), source.indexOf('const legacyDesktopRuntimeDir', source.indexOf('const profileDir = resolveWebProfileDir()')))
  assert.match(startup, /const preserveInstalledProfile = portablePaths !== undefined && existsSync/)
  assert.doesNotMatch(startup, /captureCustomizationState/)
  assert.match(startup, /stagedCustomizations !== undefined.*\n\s*assertCustomizationPreserved/)
  assert.match(source, /preserveInstalledProfile \? \{ seeded: \[\] \} : await seedBundledPlugins/)
  assert.match(source, /preserveInstalledProfile \? \[\] : await applyPendingProfileUpdates/)
  assert.match(source, /const started = preserveInstalledProfile/)
  // Candidate commit must still compare its original snapshot, not a new capture.
  assert.match(source, /assertCustomizationPreserved\(stagedCustomizations,[\s\S]*?confirmRunningCandidate/)
})

const accepted: PreservationManifest = {
  schema: 1,
  revision: 2,
  features: ['ui.accepted-settings', 'plugins.accepted-local'],
  requiredPlugins: ['dsh-local-feature'],
  sources: [{ pluginName: 'dsh-local-feature', sourceDir: 'customizations/local-feature', files: [{ path: 'index.js', sha256: 'a'.repeat(64) }] }],
}
const requiredFiles = [
  'DSH Codex Desktop.exe', 'resources/app.asar', 'resources/node/node.exe',
  'resources/dsh-runtime.tgz', 'resources/dsh-runtime.tgz.sha256', 'resources/dsh-runtime.tgz.content-sha256',
  'resources/plugins-store.tgz', 'resources/plugins-store.tgz.sha256', 'resources/plugins-store.tgz.content-sha256',
  'resources/desktop-bridge/dsh-process.js', 'resources/desktop-bridge/profile-bundle-health.js',
  'resources/desktop-bridge/profile-quarantine.js', 'resources/process-control.js',
] as const

type Asset = { name: string; browser_download_url: string; size: number; digest?: string }
type Metadata = { tag_name: string; draft: boolean; prerelease: boolean; body: string; assets: Asset[] }
type FixtureOptions = {
  version?: string
  currentVersion?: string
  manifest?: unknown
  missingManifest?: boolean
  contractRevision?: number
}

async function fixture(options: FixtureOptions = {}) {
  const root = await makeTrackedTempDir(join(tmpdir(), 'dsh-update-preservation-'))
  await mkdir(join(root, 'App'), { recursive: true })
  await writeFile(join(root, 'App', 'DSH Codex Desktop.exe'), 'accepted-active-app')
  const version = options.version ?? '1.1.0'
  const currentVersion = options.currentVersion ?? '1.0.0'
  const archive = Buffer.alloc(1_000_000, 19)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const artifact = `dsh-codex-desktop-${version}-win-x64.zip`
  const contractName = `dsh-portable-contract-${version}-win-x64.json`
  const contract = Buffer.from(JSON.stringify({
    schema: 1, edition: 'dsh-3-portable', version, artifact, sha256,
    revision: options.contractRevision ?? desktopReleaseRevision(version),
    capabilities: ['portable-data-v1', 'desktop-ab-v1', 'desktop-update-state-v1', 'embedded-browser-v1', 'runtime-prewarm-v1', 'customization-preservation-v1'],
  }))
  const metadata: Metadata = {
    tag_name: `v${version}`, draft: false, prerelease: version.split('+')[0].includes('-'), body: 'isolated portable release',
    assets: [
      { name: artifact, browser_download_url: `${sourcePrefix}v${encodeURIComponent(version)}/${encodeURIComponent(artifact)}`, size: archive.length, digest: `sha256:${sha256}` },
      { name: contractName, browser_download_url: `${sourcePrefix}v${encodeURIComponent(version)}/${encodeURIComponent(contractName)}`, size: contract.length, digest: `sha256:${createHash('sha256').update(contract).digest('hex')}` },
    ],
  }
  const releases = [metadata]
  const requests: string[] = []
  const preservationChecks: string[] = []
  let rejectCandidate = false
  const createUpdater = (): PortableDesktopUpdater => new PortableDesktopUpdater({
    portableRoot: root, currentVersion,
    fetch: async input => {
      const url = String(input)
      requests.push(url)
      if (url.includes('api.github.com')) return Response.json(url.includes('?per_page=50') ? releases : metadata)
      if (decodeURIComponent(url).endsWith(contractName)) return new Response(contract)
      if (decodeURIComponent(url).endsWith(artifact)) return new Response(archive)
      throw new Error(`Unexpected fixture request: ${url}`)
    },
    readProductVersion: async () => version.split('+')[0].includes('-') ? version.split('+')[0] : `${version.split('+')[0]}.0`,
    expandArchive: async (_archive, destination) => {
      const app = join(destination, 'package')
      for (const name of requiredFiles) {
        const path = join(app, ...name.split('/'))
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, name.endsWith('.content-sha256') ? 'b'.repeat(64) : `isolated:${name}`)
      }
      for (const name of ['dsh-runtime.tgz', 'plugins-store.tgz']) {
        const path = join(app, 'resources', name)
        await writeFile(`${path}.sha256`, createHash('sha256').update(await readFile(path)).digest('hex'))
      }
      if (!options.missingManifest) await writeFile(join(app, 'resources', 'preservation.json'), JSON.stringify(options.manifest ?? accepted))
    },
    verifyCandidatePreservation: async app => {
      preservationChecks.push(app)
      if (rejectCandidate) throw new Error('Fixture preservation gate rejected changed candidate')
      const manifest: unknown = JSON.parse(await readFile(join(app, 'resources', 'preservation.json'), 'utf8'))
      const result = checkPreservationManifest(manifest, accepted)
      if (!result.ok) throw new CustomizationPreservationError(result.issues)
    },
  })
  const updater = createUpdater()
  await updater.initialize()
  return { root, updater, metadata, releases, requests, preservationChecks, createUpdater, rejectCandidate: (): void => { rejectCandidate = true } }
}

test('桌面默认读取自家发布源，preview 按版本而不是 API 顺序选择且跳过草稿/无效标签', async () => {
  const state = await fixture({ version: '1.2.0-rc.2+build.3' })
  state.releases.unshift(
    { ...state.metadata, tag_name: 'v9.0.0', draft: true },
    { ...state.metadata, tag_name: 'not-a-version' },
    { ...state.metadata, tag_name: 'v1.2.0-rc.1+build.9' },
  )
  const available = await state.updater.check('preview')
  assert.equal(available.phase, 'available')
  assert.equal(available.release?.version, '1.2.0-rc.2+build.3')
  assert.equal(available.release?.revision, 3)
  assert.equal(state.requests[0], 'https://api.github.com/repos/hly252397-tech/DSH-3-Portable/releases?per_page=50')
  assert.equal((await state.updater.prepare()).phase, 'ready')
  assert.equal(state.preservationChecks.length, 1)
})

test('stable 拒绝预发布或草稿，preview 可以接收同一已验证预发布', async t => {
  await t.test('预发布仅 preview 接收', async () => {
    const state = await fixture({ version: '1.1.0-beta.1' })
    assert.equal((await state.updater.check('stable')).errorCode, 'UNTRUSTED_RELEASE')
    assert.equal((await state.updater.check('preview')).phase, 'available')
  })
  await t.test('stable 不接收草稿', async () => {
    const state = await fixture()
    state.metadata.draft = true
    assert.equal((await state.updater.check('stable')).errorCode, 'UNTRUSTED_RELEASE')
    assert.equal((await state.updater.check('preview')).phase, 'none')
    assert.equal(state.preservationChecks.length, 0)
  })
  await t.test('metadata 错误标成稳定也不能放过预发布标签', async () => {
    const state = await fixture({ version: '1.1.0-rc.1' })
    state.metadata.prerelease = false
    assert.equal((await state.updater.check('stable')).errorCode, 'UNTRUSTED_RELEASE')
  })
  await t.test('preview 没有公开发布时无更新', async () => {
    const state = await fixture()
    state.releases.length = 0
    assert.equal((await state.updater.check('preview')).phase, 'none')
    assert.equal(state.requests.length, 1)
  })
})

test('preview 不放宽摘要或便携兼容契约门禁', async t => {
  for (const missing of ['archive-digest', 'contract-asset', 'contract-digest'] as const) {
    await t.test(missing, async () => {
      const state = await fixture({ version: '1.2.0-rc.1' })
      if (missing === 'archive-digest') delete state.metadata.assets[0].digest
      else if (missing === 'contract-asset') state.metadata.assets.pop()
      else delete state.metadata.assets[1].digest
      const checked = await state.updater.check('preview')
      assert.equal(checked.errorCode, missing === 'archive-digest' ? 'DIGEST_MISSING' : missing === 'contract-asset' ? 'INCOMPATIBLE_RELEASE' : 'CONTRACT_DIGEST_MISSING')
      assert.equal(checked.release, undefined)
      assert.equal(state.preservationChecks.length, 0)
    })
  }
})

test('定制 build revision 影响桌面更新身份但不污染通用 SemVer', async () => {
  assert.equal(compareReleaseVersions('1.1.0+build.2', '1.1.0+build.1'), 0)
  assert.ok(compareDesktopReleaseIdentities('1.1.0+build.2', '1.1.0+build.1') > 0)
  assert.ok(compareDesktopReleaseIdentities('1.2.0-rc.2+build.1', '1.2.0-rc.1+build.9') > 0)
  assert.equal(desktopReleaseRevision('1.1.0'), 0)
  assert.equal(desktopReleaseRevision('1.1.0+build.23'), 23)
  const state = await fixture({ version: '1.1.0+build.2', currentVersion: '1.1.0+build.1' })
  assert.equal((await state.updater.check('stable')).phase, 'available')
  assert.equal((await state.updater.prepare()).phase, 'ready')
  assert.equal((await state.updater.stageActivation()).phase, 'deploying')
})

test('发布契约生成器接收预发布+build.N，但拒绝超出安全整数的 revision', async () => {
  const root = await makeTrackedTempDir(join(tmpdir(), 'dsh-contract-revision-'))
  const generator = fileURLToPath(new URL('../../scripts/create-portable-release-contract.mjs', import.meta.url))
  const run = promisify(execFile)
  const version = '1.2.0-rc.2+build.3'
  const archive = join(root, `dsh-codex-desktop-${version}-win-x64.zip`)
  const contract = join(root, 'contract.json')
  await writeFile(archive, 'isolated archive bytes')
  await run(process.execPath, [generator, version, archive, contract], { windowsHide: true })
  const generated = JSON.parse(await readFile(contract, 'utf8')) as { version: string; revision: number; sha256: string; capabilities: string[] }
  assert.equal(generated.version, version)
  assert.equal(generated.revision, 3)
  assert.equal(generated.sha256, createHash('sha256').update('isolated archive bytes').digest('hex'))
  assert.ok(generated.capabilities.includes('customization-preservation-v1'))
  const unsafeVersion = '1.2.0+build.9007199254740992'
  const unsafeArchive = join(root, `dsh-codex-desktop-${unsafeVersion}-win-x64.zip`)
  const unsafeContract = join(root, 'unsafe-contract.json')
  await writeFile(unsafeArchive, 'isolated archive bytes')
  await assert.rejects(run(process.execPath, [generator, unsafeVersion, unsafeArchive, unsafeContract], { windowsHide: true }))
  assert.equal(existsSync(unsafeContract), false)
})

test('相同或落后的定制 revision 不下载，契约 revision 不一致则拒绝', async t => {
  for (const version of ['1.1.0+build.2', '1.1.0+build.1', '1.1.0']) {
    await t.test(version, async () => {
      const state = await fixture({ version, currentVersion: '1.1.0+build.2' })
      assert.equal((await state.updater.check('preview')).phase, 'none')
      assert.equal(state.requests.length, 1)
    })
  }
  await t.test('错误 revision 不能冒充相同包', async () => {
    const state = await fixture({ version: '1.1.0+build.2', currentVersion: '1.1.0+build.1', contractRevision: 3 })
    assert.equal((await state.updater.check('preview')).errorCode, 'INCOMPATIBLE_RELEASE')
    assert.equal(state.updater.state.release, undefined)
  })
  await t.test('超出安全整数的 revision 不能降成 0 后放行', async () => {
    const state = await fixture({ version: '1.1.0+build.9007199254740992', contractRevision: 0 })
    assert.equal((await state.updater.check('stable')).errorCode, 'INVALID_VERSION')
    assert.equal(state.requests.length, 1)
    assert.equal(state.updater.state.release, undefined)
  })
})

test('预发布与 revision 资产只接受受信仓库 URL，合同 URL 同样校验', async t => {
  const badUrls = [
    'http://github.com/hly252397-tech/DSH-3-Portable/releases/download/v1.1.0/file.zip',
    'https://github.com.evil.example/hly252397-tech/DSH-3-Portable/releases/download/v1.1.0/file.zip',
    'https://user:password@github.com/hly252397-tech/DSH-3-Portable/releases/download/v1.1.0/file.zip',
    'https://github.com/hly252397-tech/DSH-3-Portable-evil/releases/download/v1.1.0/file.zip',
    'https://github.com/hly252397-tech/DSH-3-Portable/releases/download/../../other/file.zip',
  ]
  for (const url of badUrls) await t.test(url, async () => {
    const state = await fixture({ version: '1.1.0-rc.1+build.2' })
    state.metadata.assets[0].browser_download_url = url
    assert.equal((await state.updater.check('preview')).errorCode, 'ASSET_SOURCE')
    assert.equal(state.requests.length, 1)
  })
  await t.test('合同 URL 不能转向另一仓库', async () => {
    const state = await fixture()
    state.metadata.assets[1].browser_download_url = 'https://github.com/other/repository/releases/download/v1.1.0/contract.json'
    assert.equal((await state.updater.check('preview')).errorCode, 'ASSET_SOURCE')
    assert.equal(state.requests.length, 1)
  })
})

test('下载摘要正确但缺少/丢失定制仍拒绝准备，现役文件与激活指针不变', async t => {
  const candidates: Array<{ name: string; options: FixtureOptions }> = [
    { name: '缺少保护清单', options: { missingManifest: true } },
    { name: '保护清单无效', options: { manifest: { schema: 1 } } },
    { name: '删除已接受功能', options: { manifest: { ...accepted, features: ['ui.accepted-settings'] } } },
    { name: '删除必需插件', options: { manifest: { ...accepted, requiredPlugins: [] } } },
    { name: '增加 revision 不能豁免源码替换', options: { manifest: { ...accepted, revision: 3, sources: [{ ...accepted.sources[0], files: [{ path: 'index.js', sha256: 'b'.repeat(64) }] }] } } },
  ]
  for (const candidate of candidates) await t.test(candidate.name, async () => {
    const state = await fixture(candidate.options)
    assert.equal((await state.updater.check('preview')).phase, 'available')
    const failed = await state.updater.prepare()
    assert.equal(failed.phase, 'error')
    assert.equal(failed.errorCode, 'PREPARE_FAILED')
    assert.equal(state.preservationChecks.length, 1)
    assert.equal(await readFile(join(state.root, 'App', 'DSH Codex Desktop.exe'), 'utf8'), 'accepted-active-app')
    assert.equal(existsSync(portableDesktopPointerPath(portableDesktopUpdateRoot(state.root))), false)
  })
})

test('通过保护清单才可准备与登记，登记前再次检查防止 ready 后漂移', async () => {
  const state = await fixture()
  assert.equal((await state.updater.check('preview')).phase, 'available')
  assert.equal((await state.updater.prepare()).phase, 'ready')
  state.rejectCandidate()
  await assert.rejects(state.updater.stageActivation(), /preservation gate/)
  assert.equal(state.updater.state.phase, 'ready')
  assert.equal(state.preservationChecks.length, 2)
  assert.equal(existsSync(portableDesktopPointerPath(portableDesktopUpdateRoot(state.root))), false)
})

test('ready 状态保留跨周期检查及进程恢复，验证成功后只登记 pending 不覆盖现役', async () => {
  const state = await fixture()
  await state.updater.check('preview')
  const ready = await state.updater.prepare()
  const requestCount = state.requests.length
  for (const channel of ['preview', 'stable'] as const) assert.deepEqual(await state.updater.check(channel), ready)
  const resumed = state.createUpdater()
  assert.equal((await resumed.initialize()).phase, 'ready')
  assert.deepEqual(await resumed.check('preview'), ready)
  assert.equal(state.requests.length, requestCount)
  assert.equal((await resumed.stageActivation()).phase, 'deploying')
  assert.equal(state.preservationChecks.length, 2)
  const pointer = JSON.parse(await readFile(portableDesktopPointerPath(portableDesktopUpdateRoot(state.root)), 'utf8')) as { current: { relativePath: string }; pending: { transactionId: string; relativePath: string } }
  assert.equal(pointer.current.relativePath, 'App')
  assert.equal(pointer.pending.transactionId, ready.transactionId)
  assert.equal(pointer.pending.relativePath, ready.slotRelativePath)
  assert.equal(await readFile(join(state.root, 'App', 'DSH Codex Desktop.exe'), 'utf8'), 'accepted-active-app')
})

test('另一事务已待激活时拒绝覆盖，保留其指针和本次 ready 候选', async () => {
  const state = await fixture()
  await state.updater.check('preview')
  const ready = await state.updater.prepare()
  const otherPending = {
    schema: 1,
    current: { relativePath: 'App', version: '1.0.0', sha256: 'a'.repeat(64) },
    pending: { relativePath: ready.slotRelativePath, version: '1.1.0', sha256: 'b'.repeat(64), transactionId: '11111111-1111-4111-8111-111111111111' },
    updatedAt: new Date().toISOString(),
  }
  const path = portableDesktopPointerPath(portableDesktopUpdateRoot(state.root))
  await writeFile(path, JSON.stringify(otherPending))
  await assert.rejects(state.updater.stageActivation(), /其他待激活/)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), otherPending)
  assert.equal(state.updater.state.phase, 'ready')
  assert.equal(existsSync(resolve(state.root, ready.slotRelativePath!)), true)
})

test('双击准备或后台/手动重叠必须共享同一次下载和同一事务', async () => {
  const state = await fixture()
  await state.updater.check('preview')
  const [first, second] = await Promise.all([state.updater.prepare(), state.updater.prepare()])
  assert.equal(first.phase, 'ready')
  assert.deepEqual(second, first)
  assert.equal(state.preservationChecks.length, 1)
  assert.equal(state.requests.filter(url => decodeURIComponent(url).endsWith('.zip')).length, 1)
})

test('跨控制器同时 stage 只允许一笔 pending，另一笔不能覆盖', async t => {
  const state = await fixture()
  await state.updater.check('preview')
  const firstReady = await state.updater.prepare()
  assert.equal(firstReady.phase, 'ready', firstReady.detail)
  const alternateTransaction = '22222222-2222-4222-8222-222222222222'
  await writeFile(portableDesktopStatePath(portableDesktopUpdateRoot(state.root)), JSON.stringify({ ...firstReady, transactionId: alternateTransaction }))
  const secondUpdater = state.createUpdater()
  await secondUpdater.initialize()
  const started = performance.now()
  const results = await Promise.allSettled([state.updater.stageActivation(), secondUpdater.stageActivation()])
  t.diagnostic(`pointer lock/cross-stage took ${Math.round(performance.now() - started)} ms (${process.platform})`)
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, results.map(result => result.status === 'rejected' ? String(result.reason) : result.status).join('; '))
  const rejected = results.find(result => result.status === 'rejected')
  assert.ok(rejected?.status === 'rejected')
  assert.match(String(rejected.reason), /其他待激活|其他桌面事务/)
  const pointer = JSON.parse(await readFile(portableDesktopPointerPath(portableDesktopUpdateRoot(state.root)), 'utf8')) as { pending: { transactionId: string } }
  const winner = results[0].status === 'fulfilled' ? firstReady.transactionId : alternateTransaction
  assert.equal(pointer.pending.transactionId, winner)
})

test('主进程必须真正接入保真回调，构建打包必须包含保护清单', async () => {
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /verifyCandidatePreservation:\s*async/)
  assert.match(main, /checkPreservationManifest\(/)
  assert.match(main, /assertCustomizationPreserved\(/)
  const packageJson = await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  assert.match(packageJson, /customizations\/preservation\.json/)
  assert.match(packageJson, /preservation\.json/)
})
