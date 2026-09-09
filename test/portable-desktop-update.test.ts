import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { PortableDesktopUpdater, physicalFileIsRegular, physicalFileSha256, portableDesktopPointerPath, portableDesktopUpdateRoot, prunePortableDesktopSlots, stageLocalDesktopBuild } from '../src/portable-desktop-update.js'

const requiredFiles = [
  'DSH Codex Desktop.exe',
  'resources/app.asar',
  'resources/node/node.exe',
  'resources/dsh-runtime.tgz',
  'resources/dsh-runtime.tgz.sha256',
  'resources/dsh-runtime.tgz.content-sha256',
  'resources/plugins-store.tgz',
  'resources/plugins-store.tgz.sha256',
  'resources/plugins-store.tgz.content-sha256',
  'resources/desktop-bridge/dsh-process.js',
  'resources/desktop-bridge/profile-bundle-health.js',
  'resources/desktop-bridge/profile-quarantine.js',
  'resources/process-control.js',
] as const

async function materializePackagedApp(app: string): Promise<void> {
  for (const name of requiredFiles) {
    const path = join(app, ...name.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, name.endsWith('.content-sha256') ? 'b'.repeat(64) : name.endsWith('.sha256') ? '' : `content:${name}`)
  }
  for (const archiveName of ['dsh-runtime.tgz', 'plugins-store.tgz']) {
    const path = join(app, 'resources', archiveName)
    const digest = createHash('sha256').update(await readFile(path)).digest('hex')
    await writeFile(`${path}.sha256`, `${digest}  ${archiveName}\n`)
  }
}

async function fixture(): Promise<{ archive: Buffer; requestCount: () => number; root: string; updater: PortableDesktopUpdater }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-'))
  await mkdir(join(root, 'App'), { recursive: true })
  await writeFile(join(root, 'App', 'DSH Codex Desktop.exe'), 'legacy')
  const archive = Buffer.alloc(1_000_000, 7)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const contract = Buffer.from(`${JSON.stringify({
    schema: 1,
    edition: 'dsh-3-portable',
    version: '1.1.0',
    artifact: 'dsh-codex-desktop-1.1.0-win-x64.zip',
    sha256,
    capabilities: ['portable-data-v1', 'desktop-ab-v1', 'desktop-update-state-v1', 'embedded-browser-v1', 'runtime-prewarm-v1'],
  })}\n`)
  const contractSha256 = createHash('sha256').update(contract).digest('hex')
  let call = 0
  const updater = new PortableDesktopUpdater({
    portableRoot: root,
    currentVersion: '1.0.0',
    fetch: async input => {
      call += 1
      const url = String(input)
      if (url.includes('/releases/latest')) {
        return Response.json({
          tag_name: 'v1.1.0',
          draft: false,
          prerelease: false,
          body: 'verified release',
          assets: [{
            name: 'dsh-codex-desktop-1.1.0-win-x64.zip',
            browser_download_url: 'https://github.com/MichengAI/dsh-codex-desktop/releases/download/v1.1.0/dsh-codex-desktop-1.1.0-win-x64.zip',
            size: archive.length,
            digest: `sha256:${sha256}`,
          }, {
            name: 'dsh-portable-contract-1.1.0-win-x64.json',
            browser_download_url: 'https://github.com/MichengAI/dsh-codex-desktop/releases/download/v1.1.0/dsh-portable-contract-1.1.0-win-x64.json',
            size: contract.length,
            digest: `sha256:${contractSha256}`,
          }],
        })
      }
      if (url.endsWith('dsh-portable-contract-1.1.0-win-x64.json')) return new Response(contract, { status: 200 })
      return new Response(archive, { status: 200 })
    },
    readProductVersion: async () => '1.1.0.0',
    expandArchive: async (_source, destination) => {
      const app = join(destination, 'package')
      await materializePackagedApp(app)
    },
  })
  await updater.initialize()
  return { archive, requestCount: () => call, root, updater }
}

test('统一更新器完成检测、下载、构建、部署和健康提交', async () => {
  const { root, updater } = await fixture()
  assert.equal((await updater.check()).phase, 'available')
  const ready = await updater.prepare()
  assert.equal(ready.phase, 'ready')
  assert.equal(ready.overallProgress, 90)
  assert.ok(ready.slotRelativePath)
  assert.equal((await updater.stageActivation()).phase, 'deploying')
  const pointerPath = portableDesktopPointerPath(portableDesktopUpdateRoot(root))
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as { pending: { transactionId: string; relativePath: string } }
  const slot = resolve(root, pointer.pending.relativePath)
  const health = join(portableDesktopUpdateRoot(root), 'transactions', pointer.pending.transactionId, 'health.json')
  const completed = await updater.confirmRunningCandidate(pointer.pending.transactionId, slot, health)
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.overallProgress, 100)
  assert.match(await readFile(health, 'utf8'), /"version":"1.1.0"/)
  assert.match(await readFile(join(portableDesktopUpdateRoot(root), 'events.jsonl'), 'utf8'), /"phase":"completed"/)
})

test('候选文件在部署前被篡改时由槽清单门禁拒绝', async () => {
  const { root, updater } = await fixture()
  await updater.check()
  const ready = await updater.prepare()
  assert.ok(ready.slotRelativePath)
  await writeFile(join(resolve(root, ready.slotRelativePath), 'resources', 'app.asar'), 'tampered')
  await assert.rejects(updater.stageActivation(), /候选槽文件摘要不匹配/)
})

test('已验证的 Release 缓存被复用且不会再次访问下载地址', async () => {
  const { archive, requestCount, root, updater } = await fixture()
  assert.equal((await updater.check()).phase, 'available')
  const cache = join(portableDesktopUpdateRoot(root), 'downloads', '1.1.0', 'dsh-codex-desktop-1.1.0-win-x64.zip')
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, archive)

  const ready = await updater.prepare()
  assert.equal(ready.phase, 'ready')
  assert.equal(requestCount(), 2)
  assert.match(ready.detail, /复用|构建和验证/)
})

test('缺少便携兼容契约的上游新版本进入已阻止状态而非更新失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-incompatible-'))
  const archive = Buffer.alloc(1_000_000, 7)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  let requests = 0
  const updater = new PortableDesktopUpdater({
    portableRoot: root,
    currentVersion: '1.0.0',
    fetch: async () => {
      requests += 1
      return Response.json({
        tag_name: 'v1.1.0', draft: false, prerelease: false,
        assets: [{
          name: 'dsh-codex-desktop-1.1.0-win-x64.zip',
          browser_download_url: 'https://github.com/MichengAI/dsh-codex-desktop/releases/download/v1.1.0/dsh-codex-desktop-1.1.0-win-x64.zip',
          size: archive.length,
          digest: `sha256:${sha256}`,
        }],
      })
    },
  })
  await updater.initialize()
  const state = await updater.check()
  assert.equal(state.phase, 'incompatible')
  assert.equal(state.errorCode, 'INCOMPATIBLE_RELEASE')
  assert.equal(state.targetVersion, '1.1.0')
  assert.match(state.detail, /兼容契约|阻止覆盖/)
  assert.equal(requests, 1)
  assert.ok(state.lastCheckedAt)
  // 持久化后重载仍保持已阻止语义，不会退化成 idle。
  const reloaded = await updater.initialize()
  assert.equal(reloaded.phase, 'incompatible')
})

test('被阻止后出现合规 Release 可恢复正常更新流程', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-recovery-'))
  const archive = Buffer.alloc(1_000_000, 7)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const contract = Buffer.from(`${JSON.stringify({
    schema: 1,
    edition: 'dsh-3-portable',
    version: '1.1.0',
    artifact: 'dsh-codex-desktop-1.1.0-win-x64.zip',
    sha256,
    capabilities: ['portable-data-v1', 'desktop-ab-v1', 'desktop-update-state-v1', 'embedded-browser-v1', 'runtime-prewarm-v1'],
  })}\n`)
  const contractSha256 = createHash('sha256').update(contract).digest('hex')
  let includeContract = false
  const updater = new PortableDesktopUpdater({
    portableRoot: root,
    currentVersion: '1.0.0',
    fetch: async input => {
      const url = String(input)
      if (url.includes('/releases/latest')) {
        return Response.json({
          tag_name: 'v1.1.0', draft: false, prerelease: false,
          assets: [{
            name: 'dsh-codex-desktop-1.1.0-win-x64.zip',
            browser_download_url: 'https://github.com/MichengAI/dsh-codex-desktop/releases/download/v1.1.0/dsh-codex-desktop-1.1.0-win-x64.zip',
            size: archive.length,
            digest: `sha256:${sha256}`,
          }, ...(includeContract ? [{
            name: 'dsh-portable-contract-1.1.0-win-x64.json',
            browser_download_url: 'https://github.com/MichengAI/dsh-codex-desktop/releases/download/v1.1.0/dsh-portable-contract-1.1.0-win-x64.json',
            size: contract.length,
            digest: `sha256:${contractSha256}`,
          }] : [])],
        })
      }
      if (url.endsWith('dsh-portable-contract-1.1.0-win-x64.json')) return new Response(contract, { status: 200 })
      return new Response(archive, { status: 200 })
    },
    readProductVersion: async () => '1.1.0.0',
    expandArchive: async (_source, destination) => {
      const app = join(destination, 'package')
      await materializePackagedApp(app)
    },
  })
  await updater.initialize()
  assert.equal((await updater.check()).phase, 'incompatible')
  includeContract = true
  const next = await updater.check()
  assert.equal(next.phase, 'available')
  assert.equal(next.errorCode, undefined)
  assert.equal(next.targetVersion, '1.1.0')
})

test('更新源按构建期配置解析 API 与受信资产域', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-source-'))
  const archive = Buffer.alloc(1_000_000, 7)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const contract = Buffer.from(`${JSON.stringify({
    schema: 1,
    edition: 'dsh-3-portable',
    version: '1.1.0',
    artifact: 'dsh-codex-desktop-1.1.0-win-x64.zip',
    sha256,
    capabilities: ['portable-data-v1', 'desktop-ab-v1', 'desktop-update-state-v1', 'embedded-browser-v1', 'runtime-prewarm-v1'],
  })}\n`)
  const contractSha256 = createHash('sha256').update(contract).digest('hex')
  const urls: string[] = []
  const updater = new PortableDesktopUpdater({
    portableRoot: root,
    currentVersion: '1.0.0',
    releaseSource: { owner: 'example-org', repo: 'custom-desktop', artifactBase: 'dsh-codex-desktop' },
    fetch: async input => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/releases/latest')) {
        return Response.json({
          tag_name: 'v1.1.0', draft: false, prerelease: false,
          assets: [{
            name: 'dsh-codex-desktop-1.1.0-win-x64.zip',
            browser_download_url: 'https://github.com/example-org/custom-desktop/releases/download/v1.1.0/dsh-codex-desktop-1.1.0-win-x64.zip',
            size: archive.length,
            digest: `sha256:${sha256}`,
          }, {
            name: 'dsh-portable-contract-1.1.0-win-x64.json',
            browser_download_url: 'https://github.com/example-org/custom-desktop/releases/download/v1.1.0/dsh-portable-contract-1.1.0-win-x64.json',
            size: contract.length,
            digest: `sha256:${contractSha256}`,
          }],
        })
      }
      if (url.endsWith('dsh-portable-contract-1.1.0-win-x64.json')) return new Response(contract, { status: 200 })
      return new Response(archive, { status: 200 })
    },
    readProductVersion: async () => '1.1.0.0',
    expandArchive: async (_source, destination) => {
      const app = join(destination, 'package')
      await materializePackagedApp(app)
    },
  })
  await updater.initialize()
  assert.equal((await updater.check()).phase, 'available')
  assert.equal(urls[0], 'https://api.github.com/repos/example-org/custom-desktop/releases/latest')
  // 非法更新源被清洗后回退默认源：请求打到默认 API，且期望默认资产名。
  const invalidUrls: string[] = []
  const invalid = new PortableDesktopUpdater({
    portableRoot: root,
    currentVersion: '1.0.0',
    releaseSource: { owner: '../evil', repo: 'custom-desktop', artifactBase: 'x' },
    fetch: async input => {
      invalidUrls.push(String(input))
      return Response.json({ tag_name: 'v1.1.0', draft: false, prerelease: false, assets: [] })
    },
  })
  await invalid.initialize()
  const invalidState = await invalid.check()
  assert.equal(invalidState.phase, 'error')
  assert.equal(invalidState.errorCode, 'ASSET_MISSING')
  assert.equal(invalidUrls[0], 'https://api.github.com/repos/MichengAI/dsh-codex-desktop/releases/latest')
})

test('当前本地版本不低于 Release 时不要求下载兼容契约', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-current-local-'))
  let requests = 0
  const updater = new PortableDesktopUpdater({
    portableRoot: root,
    currentVersion: '1.0.46',
    fetch: async () => {
      requests += 1
      return Response.json({
        tag_name: 'v1.0.46', draft: false, prerelease: false, assets: [],
      })
    },
  })
  await updater.initialize()
  const state = await updater.check()
  assert.equal(state.phase, 'none')
  assert.equal(state.errorCode, undefined)
  assert.match(state.detail, /最新版本/)
  assert.equal(requests, 1)
})

test('槽位回收保留指针引用与最近候选，清理历史槽和下载缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-slot-gc-'))
  const updateRoot = portableDesktopUpdateRoot(root)
  const slotsDir = join(updateRoot, 'slots')
  const downloadsDir = join(updateRoot, 'downloads')
  const sha = 'a'.repeat(64)
  const makeSlot = async (name: string, mtime: number): Promise<void> => {
    const path = join(slotsDir, name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'marker'), name)
    await utimes(path, mtime, mtime)
  }
  await makeSlot('keep-current', 9_000)
  await makeSlot('keep-pending', 8_000)
  for (const [index, mtime] of [[1, 1_000], [2, 2_000], [3, 3_000], [4, 4_000], [5, 5_000]] as const) {
    await makeSlot(`old-${index}`, mtime)
  }
  const makeDownload = async (name: string, mtime: number): Promise<void> => {
    const path = join(downloadsDir, name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'asset.zip'), name)
    await utimes(path, mtime, mtime)
  }
  await makeDownload('0.9.0', 1_000)
  await makeDownload('0.8.0', 9_000)
  await makeDownload('1.0.0', 500)
  await writeFile(portableDesktopPointerPath(updateRoot), `${JSON.stringify({
    schema: 1,
    current: { relativePath: 'Data/Updates/Desktop/slots/keep-current', version: '1.0.0', sha256: sha },
    pending: { relativePath: 'Data/Updates/Desktop/slots/keep-pending', version: '1.1.0-local-abc', sha256: sha, transactionId: '01234567-89ab-cdef-0123-456789abcdef' },
    updatedAt: new Date().toISOString(),
  })}\n`)

  const result = await prunePortableDesktopSlots({ portableRoot: root, keepUnreferencedSlots: 2, now: () => new Date('2026-09-09T00:00:00Z') })
  assert.deepEqual([...result.removedSlots].sort(), ['old-1', 'old-2', 'old-3'])
  assert.deepEqual([...result.removedDownloads].sort(), ['0.9.0'])
  assert.ok(existsSync(join(slotsDir, 'keep-current')))
  assert.ok(existsSync(join(slotsDir, 'keep-pending')))
  assert.ok(existsSync(join(slotsDir, 'old-4')))
  assert.ok(existsSync(join(slotsDir, 'old-5')))
  assert.ok(existsSync(join(downloadsDir, '0.8.0')))
  assert.ok(existsSync(join(downloadsDir, '1.0.0')))
  const events = await readFile(join(updateRoot, 'events.jsonl'), 'utf8')
  assert.match(events, /"source":"slot-gc"/)
  assert.match(events, /指针引用槽不受影响/)

  // 无可回收内容时不追加审计事件。
  const before = (await readFile(join(updateRoot, 'events.jsonl'), 'utf8')).trim().split('\n').length
  const again = await prunePortableDesktopSlots({ portableRoot: root, keepUnreferencedSlots: 2 })
  assert.equal(again.removedSlots.length, 0)
  assert.equal(again.removedDownloads.length, 0)
  const after = (await readFile(join(updateRoot, 'events.jsonl'), 'utf8')).trim().split('\n').length
  assert.equal(after, before)
})

test('本地构建暂存后自动触发回收，历史候选槽收敛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-build-gc-'))
  const source = join(root, 'release', 'app')
  await materializePackagedApp(source)
  await mkdir(join(root, 'App'), { recursive: true })
  await writeFile(join(root, 'App', 'DSH Codex Desktop.exe'), 'legacy-app')
  const slotsDir = join(portableDesktopUpdateRoot(root), 'slots')
  for (const [name, mtime] of [['stale-a', 1_000], ['stale-b', 2_000], ['stale-c', 3_000], ['stale-d', 4_000]] as const) {
    const path = join(slotsDir, name)
    await mkdir(path, { recursive: true })
    await utimes(path, mtime, mtime)
  }
  await stageLocalDesktopBuild({ portableRoot: root, appDirectory: source, version: '1.0.0', readProductVersion: async () => '1.0.0.0' })
  // 指针引用（App 当前槽 + 新 pending 槽）之外保留最近 3 个：stale-a 最旧被回收。
  assert.equal(existsSync(join(slotsDir, 'stale-a')), false)
  assert.ok(existsSync(join(slotsDir, 'stale-b')))
  assert.ok(existsSync(join(slotsDir, 'stale-c')))
  assert.ok(existsSync(join(slotsDir, 'stale-d')))
  const events = await readFile(join(portableDesktopUpdateRoot(root), 'events.jsonl'), 'utf8')
  assert.match(events, /"source":"slot-gc"/)
  assert.match(events, /stale-a/)
})

test('发布流水线生成并上传与 Windows ZIP 摘要绑定的便携兼容契约', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-package.yml', import.meta.url), 'utf8')
  const generator = await readFile(new URL('../../scripts/create-portable-release-contract.mjs', import.meta.url), 'utf8')
  assert.match(workflow, /create-portable-release-contract\.mjs/)
  assert.match(workflow, /dsh-portable-contract-/)
  assert.match(generator, /createReadStream\(archive\)/)
  assert.match(generator, /embedded-browser-v1/)
  assert.match(generator, /runtime-prewarm-v1/)
})

test('缺少 GitHub Release SHA256 时检查失败且保留当前版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-no-digest-'))
  const updater = new PortableDesktopUpdater({
    portableRoot: root,
    currentVersion: '1.0.0',
    fetch: async () => Response.json({
      tag_name: 'v1.1.0', draft: false, prerelease: false,
      assets: [{ name: 'dsh-codex-desktop-1.1.0-win-x64.zip', browser_download_url: 'https://github.com/MichengAI/dsh-codex-desktop/releases/download/v1.1.0/file.zip', size: 1_000_000 }],
    }),
  })
  await updater.initialize()
  const state = await updater.check()
  assert.equal(state.phase, 'error')
  assert.equal(state.errorCode, 'DIGEST_MISSING')
  assert.equal(state.currentVersion, '1.0.0')
  assert.ok(state.lastCheckedAt)
})

test('本地源码构建也只进入统一 A/B 候选槽，不覆盖 App', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-desktop-build-'))
  const source = join(root, 'release', 'win-unpacked')
  await materializePackagedApp(source)
  await mkdir(join(root, 'App'), { recursive: true })
  await writeFile(join(root, 'App', 'DSH Codex Desktop.exe'), 'legacy-app')

  const staged = await stageLocalDesktopBuild({
    portableRoot: root,
    appDirectory: source,
    version: '1.0.0',
    readProductVersion: async () => '1.0.0.0',
  })

  assert.match(staged.slotRelativePath, /^Data\/Updates\/Desktop\/slots\/1\.0\.0-local-/)
  assert.equal(await readFile(join(root, 'App', 'DSH Codex Desktop.exe'), 'utf8'), 'legacy-app')
  const pointer = JSON.parse(await readFile(portableDesktopPointerPath(portableDesktopUpdateRoot(root)), 'utf8')) as { pending: { transactionId: string } }
  assert.equal(pointer.pending.transactionId, staged.transactionId)
})

test('仅修改额外 UI 资源也会产生新候选，相同内容仍复用原槽', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-ui-identity-'))
  const source = join(root, 'release', 'app')
  await materializePackagedApp(source)
  await mkdir(join(root, 'App'), { recursive: true })
  await writeFile(join(root, 'App', 'DSH Codex Desktop.exe'), 'current')
  const options = { portableRoot: root, appDirectory: source, version: '1.0.0', readProductVersion: async () => '1.0.0.0', replacePending: true }
  await writeFile(join(source, 'resources', 'settings.html'), 'old-ui')
  const first = await stageLocalDesktopBuild(options)
  await writeFile(join(source, 'resources', 'settings.html'), 'fixed-ui')
  const second = await stageLocalDesktopBuild(options)
  assert.notEqual(second.slotRelativePath, first.slotRelativePath)
  assert.equal(await readFile(join(root, second.slotRelativePath, 'resources', 'settings.html'), 'utf8'), 'fixed-ui')
  assert.equal(await readFile(join(root, first.slotRelativePath, 'resources', 'settings.html'), 'utf8'), 'old-ui')
  const same = await stageLocalDesktopBuild(options)
  assert.equal(same.slotRelativePath, second.slotRelativePath)
})

test('本地构建只有显式授权时才原子替换尚未激活的候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-replace-pending-'))
  const firstSource = join(root, 'release', 'first')
  const secondSource = join(root, 'release', 'second')
  await materializePackagedApp(firstSource)
  await materializePackagedApp(secondSource)
  await writeFile(join(secondSource, 'resources', 'app.asar'), 'second-candidate')
  await mkdir(join(root, 'App'), { recursive: true })
  await writeFile(join(root, 'App', 'DSH Codex Desktop.exe'), 'legacy-app')
  const readProductVersion = async (): Promise<string> => '1.0.0.0'

  const first = await stageLocalDesktopBuild({ portableRoot: root, appDirectory: firstSource, version: '1.0.0', readProductVersion })
  await assert.rejects(
    stageLocalDesktopBuild({ portableRoot: root, appDirectory: secondSource, version: '1.0.0', readProductVersion }),
    /已有桌面候选/,
  )
  const second = await stageLocalDesktopBuild({
    portableRoot: root,
    appDirectory: secondSource,
    version: '1.0.0',
    readProductVersion,
    replacePending: true,
  })
  const pointer = JSON.parse(await readFile(portableDesktopPointerPath(portableDesktopUpdateRoot(root)), 'utf8')) as {
    current: { relativePath: string }
    pending: { transactionId: string }
  }
  assert.equal(pointer.current.relativePath, 'App')
  assert.equal(pointer.pending.transactionId, second.transactionId)
  assert.notEqual(second.transactionId, first.transactionId)
  const events = await readFile(join(portableDesktopUpdateRoot(root), 'events.jsonl'), 'utf8')
  assert.match(events, new RegExp(`"replacedTransactionId":"${first.transactionId}"`))
})

test('候选提交使用 Electron original-fs 读取物理 app.asar，避免把归档当目录', async () => {
  const source = await readFile(new URL('../../src/portable-desktop-update.ts', import.meta.url), 'utf8')
  assert.match(source, /createRequire\(import\.meta\.url\)\('original-fs'\)/)
  assert.match(source, /createPhysicalReadStream\(path\)/)
  const root = await mkdtemp(join(tmpdir(), 'dsh-physical-asar-'))
  const archive = join(root, 'app.asar')
  await writeFile(archive, 'physical archive bytes')
  assert.equal(await physicalFileIsRegular(archive), true)
  assert.equal(await physicalFileSha256(archive), createHash('sha256').update('physical archive bytes').digest('hex'))
  const smoke = await readFile(new URL('../../scripts/verify-electron-physical-asar.cjs', import.meta.url), 'utf8')
  assert.match(smoke, /physicalFileIsRegular/)
})

test('启动器先持久化回滚再清理失败候选，并阻止同一事务重复启动', async () => {
  const source = await readFile(new URL('../../Start-DSH-Portable.ps1', import.meta.url), 'utf8')
  const failure = source.indexOf('候选槽未通过启动验证')
  const rollback = source.indexOf('Restore-CurrentDesktopPointer', failure)
  const cleanup = source.indexOf('WaitForExit(8000)', failure)
  assert.ok(failure > 0 && rollback > failure && cleanup > rollback)
  assert.match(source, /activation-attempt\.json/)
  assert.match(source, /拒绝重复启动并回退/)
  assert.match(source, /function Get-OptionalProperty/)
  assert.doesNotMatch(source, /if \(\$Pointer\.previous\)/)
})

test('启动器完整性校验不依赖 PowerShell 模块自动加载', async () => {
  const source = await readFile(new URL('../../Start-DSH-Portable.ps1', import.meta.url), 'utf8')
  assert.match(source, /System\.Security\.Cryptography\.SHA256/)
  assert.match(source, /function Get-Sha256Hex/)
  assert.doesNotMatch(source, /Get-FileHash/)
})

test('候选启动用心跳续租且仍受有限绝对超时约束', async () => {
  const launcher = await readFile(new URL('../../Start-DSH-Portable.ps1', import.meta.url), 'utf8')
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  assert.match(launcher, /startup-progress\.json/)
  assert.match(launcher, /\$leaseDeadline = \(Get-Date\)\.AddMinutes\(3\)/)
  assert.match(launcher, /\$hardDeadline = \(Get-Date\)\.AddMinutes\(15\)/)
  assert.match(launcher, /function Get-PortableDesktopProcesses/)
  assert.match(launcher, /\[string\]\$HandoffReadyFile = ''/)
  assert.match(launcher, /function Publish-HandoffReady/)
  assert.match(launcher, /启动器接管握手已就绪/)
  assert.match(launcher, /\$drainDeadline = \(Get-Date\)\.AddSeconds\(20\)/)
  assert.match(launcher, /@\(Get-PortableDesktopProcesses\)\.Count/)
  assert.match(launcher, /\$remainingProcesses = @\(Get-PortableDesktopProcesses\)/)
  assert.match(launcher, /Chromium 的 SingletonLock/)
  assert.match(launcher, /function Start-DesktopApplicationReliable/)
  assert.match(launcher, /if \(-not \$process\.HasExited\)/)
  assert.match(launcher, /桌面进程连续三次未通过启动存活检查/)
  assert.match(launcher, /function Clear-DesktopActivationEnvironment/)
  assert.match(launcher, /Remove-Item Env:DSH_DESKTOP_UPDATE_TRANSACTION -ErrorAction SilentlyContinue/)
  assert.match(launcher, /Remove-Item Env:DSH_DESKTOP_UPDATE_HEALTH_FILE -ErrorAction SilentlyContinue/)
  assert.doesNotMatch(launcher, /\$env:DSH_DESKTOP_UPDATE_TRANSACTION = \$null/)
  assert.match(launcher, /Clear-DesktopActivationEnvironment\s+Start-DesktopApplicationReliable -Executable \$currentApplication/)
  assert.match(main, /startDesktopActivationHeartbeat/)
  assert.match(main, /setInterval\(writeHeartbeat, 5_000\)/)
  assert.match(main, /stopDesktopActivationHeartbeat\(\)\s*\r?\n\s*app\.exit\(1\)/)
})
