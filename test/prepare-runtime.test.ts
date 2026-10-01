import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { assertBundledPluginMetadataComplete, assertPreparedRemovalTarget, assertRecycleRootPhysical, completeBundledPluginMetadata, copyWorkspacePackages, officialRuntimeGlobalNodeModulesRoot, officialRuntimeNpmDependencies, officialRuntimeNpmInstallArgs, pruneStoreForPackaging, publishBundledLockfile, removePreparedPath, resolveBundledNodeSha256, validateOfficialRuntimeLayout, verifyBundledPluginStore, writePnpmShims, writeReleaseSourceManifest } from '../scripts/prepare-runtime.js'
import { STORE_PACKAGES } from '../src/bundled-plugins.js'
import { DEFAULT_DESKTOP_RELEASE_SOURCE } from '../src/portable-desktop-update.js'
import { DESKTOP_BRIDGE_FILES } from '../src/desktop-host.js'

test('桌面源码跟随已吸收 v1.0.78 基座并保持 rc.2 启动依赖一致', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
    config: { bundledDshVersion: string }
  }
  assert.match(manifest.version, /^1\.0\.78\+build\.[1-9]\d*$/)
  assert.equal(manifest.config.bundledDshVersion, '0.2.0-rc.2')
  const dependencies = officialRuntimeNpmDependencies()
  for (const name of ['dsh', 'dsh-scope', 'dsh-timeout', 'dsh-invariants']) {
    assert.equal(dependencies[`@deepseek-ai/${name}`], manifest.config.bundledDshVersion)
  }
})

test('按目标平台选择随包 Node 的 SHA256', () => {
  const checksums = {
    'win32-x64': 'WINDOWS',
    'darwin-arm64': 'APPLE_SILICON',
    'darwin-x64': 'INTEL',
    'linux-arm64': 'LINUX_ARM64',
    'linux-x64': 'LINUX',
  }
  assert.equal(resolveBundledNodeSha256(checksums, 'darwin', 'arm64'), 'APPLE_SILICON')
  assert.equal(resolveBundledNodeSha256(checksums, 'darwin', 'x64'), 'INTEL')
  assert.equal(resolveBundledNodeSha256(checksums, 'linux', 'arm64'), 'LINUX_ARM64')
  assert.equal(resolveBundledNodeSha256(checksums, 'linux', 'x64'), 'LINUX')
})

test('项目配置包含 Linux x64 与 ARM64 的随包 Node SHA256', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    config?: { bundledNodeSha256?: unknown }
  }
  assert.equal(
    resolveBundledNodeSha256(manifest.config?.bundledNodeSha256, 'linux', 'x64'),
    'AB9C8EECF9F82D6693CDC3ACCCED17034065C8D96213B0AA76A7E803D20AE1DA',
  )
  assert.equal(
    resolveBundledNodeSha256(manifest.config?.bundledNodeSha256, 'linux', 'arm64'),
    '71B004F18A82F3EA8F26109798564A12E5E4C7989A4C35B93851830B5815DD03',
  )
})

test('跳过指向普通文件的工作区链接', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
  try {
    const packagesRoot = join(root, 'packages')
    const packageRoot = join(packagesRoot, 'fixture', 'package')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/fixture' }), 'utf8')
    const sourceFile = join(root, 'CLAUDE.md')
    await writeFile(sourceFile, '无关文件', 'utf8')
    try {
      await symlink(sourceFile, join(packagesRoot, 'CLAUDE.md'), 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') t.skip('当前环境不允许创建文件链接')
      else throw error
      return
    }

    const runtimeRoot = join(root, 'runtime')
    await copyWorkspacePackages(packagesRoot, 2, runtimeRoot)
    assert.equal(existsSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'fixture', 'package.json')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('只把官方包复制进安装目录，社区插件不走这条路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
  try {
    const packagesRoot = join(root, 'packages')
    const official = join(packagesRoot, 'official', 'package')
    const community = join(packagesRoot, 'community', 'package')
    await mkdir(official, { recursive: true })
    await mkdir(community, { recursive: true })
    await writeFile(join(official, 'package.json'), JSON.stringify({ name: '@deepseek-ai/fixture' }), 'utf8')
    await writeFile(join(community, 'package.json'), JSON.stringify({ name: '@michengai/dsh-codex-ui' }), 'utf8')
    const runtimeRoot = join(root, 'runtime')
    await copyWorkspacePackages(packagesRoot, 2, runtimeRoot)
    assert.equal(existsSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'fixture', 'package.json')), true)
    assert.equal(existsSync(join(runtimeRoot, 'node_modules', '@michengai', 'dsh-codex-ui', 'package.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('打包配置把离线插件仓库放到 extraResources', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: { from?: string; to?: string }[] }
  }
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'runtime-plugins/store.tgz' && item.to === 'plugins-store.tgz'),
    true,
  )
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'runtime-plugins/store.tgz.content-sha256' && item.to === 'plugins-store.tgz.content-sha256'),
    true,
  )
})

test('Windows 根目录图标不会进入 macOS 应用包', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: {
      extraFiles?: unknown
      win?: { extraFiles?: { from?: string; to?: string }[] }
    }
  }
  assert.equal(manifest.build?.extraFiles, undefined)
  assert.equal(
    manifest.build?.win?.extraFiles?.some(item => item.from === 'assets/icons/icon.ico' && item.to === 'DSH Codex Desktop.ico'),
    true,
  )
})

test('第一版鲸鱼作为任务栏与托盘专用资源进入应用包', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: { from?: string; to?: string }[] }
  }
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'assets/icons/taskbar.png' && item.to === 'taskbar.png'),
    true,
  )
})

test('Windows 只写 pnpm.cmd，避免和 pnpm 包装目录撞名', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pnpm-'))
  try {
    await mkdir(join(root, 'pnpm-package'), { recursive: true })
    await writePnpmShims(root, 'bin/pnpm.cjs', 'win32')
    assert.equal(existsSync(join(root, 'pnpm.cmd')), true)
    assert.equal(existsSync(join(root, 'pnpm')), false)
    const shim = await readFile(join(root, 'pnpm.cmd'), 'utf8')
    assert.match(shim, /pnpm-package\\bin\\pnpm.cjs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('打包前删除 pnpm store 的 projects 链接，避免 7zip 扫到断裂路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-store-prune-'))
  const previousNoRecycle = process.env.DSH_PREPARE_NO_RECYCLE
  process.env.DSH_PREPARE_NO_RECYCLE = '1'
  try {
    const projects = join(root, 'v11', 'projects', 'broken')
    const files = join(root, 'v11', 'files')
    await mkdir(projects, { recursive: true })
    await mkdir(files, { recursive: true })
    await writeFile(join(files, 'keep.txt'), 'ok', 'utf8')
    await pruneStoreForPackaging(root)
    assert.equal(existsSync(projects), false)
    assert.equal(existsSync(join(files, 'keep.txt')), true)
  } finally {
    if (previousNoRecycle === undefined) delete process.env.DSH_PREPARE_NO_RECYCLE
    else process.env.DSH_PREPARE_NO_RECYCLE = previousNoRecycle
    await rm(root, { recursive: true, force: true })
  }
})

test('安装器产品名、进程名和安装目录都使用 DSH Codex Desktop', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    desktopName?: string
    build?: { productName?: string, executableName?: string, nsis?: { include?: string, shortcutName?: string, uninstallDisplayName?: string } }
  }
  assert.equal(manifest.build?.productName, 'DSH Codex Desktop')
  assert.equal(manifest.desktopName, 'DSH Codex Desktop')
  assert.equal(manifest.build?.executableName, 'DSH Codex Desktop')
  assert.equal(manifest.build?.nsis?.include, 'build/installer.nsh')
  assert.equal(manifest.build?.nsis?.shortcutName, 'DSH Codex Desktop')
  assert.equal(manifest.build?.nsis?.uninstallDisplayName, 'DSH Codex Desktop')
  const installer = await readFile(new URL('../../build/installer.nsh', import.meta.url), 'utf8')
  assert.match(installer, /APP_FILENAME/)
  assert.match(installer, /onVerifyInstDir/)
})

test('打包配置把预装官方运行时放到 extraResources', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: { from?: string; to?: string }[] }
  }
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'runtime-dsh.tgz' && item.to === 'dsh-runtime.tgz'),
    true,
  )
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'runtime-dsh.tgz.content-sha256' && item.to === 'dsh-runtime.tgz.content-sha256'),
    true,
  )
})

test('清理运行时目录必须可重试，避免 Windows ENOTEMPTY', async () => {
  const source = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /export async function removePreparedPath/)
  assert.match(source, /await rm\(target, \{ force: true, maxRetries: 10, recursive: true, retryDelay: 200 \}\)/)
  assert.match(source, /target = assertPreparedRemovalTarget\(target\)/)
  assert.match(source, /assertPreparedRemovalTarget\(target\)\s+await rm\(target/)
  assert.doesNotMatch(source, /NODE_OPTIONS\s*[:=]\s*['"]{2}|CODEBUDDY_SAFE_DELETE_[A-Z_]+\s*[:=]/)
  assert.doesNotMatch(source, /rmdir\s+\/s|del\s+\/f|spawnSync\(process\.env\.ComSpec/i)
  assert.match(source, /await removePreparedPath\(target\)/)
  const root = await mkdtemp(join(tmpdir(), 'dsh-rm-'))
  const previousNoRecycle = process.env.DSH_PREPARE_NO_RECYCLE
  process.env.DSH_PREPARE_NO_RECYCLE = '1'
  try {
    const nested = join(root, 'pnpm-package', 'artifacts', 'exe', 'dist', 'node_modules', 'undici', 'lib')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'keep.txt'), 'x', 'utf8')
    assert.equal(assertPreparedRemovalTarget(root), root)
    await removePreparedPath(root)
    assert.equal(existsSync(root), false)
  } finally {
    if (previousNoRecycle === undefined) delete process.env.DSH_PREPARE_NO_RECYCLE
    else process.env.DSH_PREPARE_NO_RECYCLE = previousNoRecycle
    await rm(root, { recursive: true, force: true })
  }
})

test('项目内待清理目录改走同卷回收，避免慢盘同步删除把构建挂成假死', async () => {
  const source = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  // 机械盘上 4.4 万个小文件同步删除要 20–50 分钟（实测 G: 盘 50.4ms/个、C: 盘 0.3ms/个），
  // 期间 CPU≈0 且无输出，与进程卡死外观一致 —— 所以项目内路径必须先尝试同卷改名。
  assert.match(source, /async function recyclePreparedPath/)
  assert.match(source, /await rename\(target, bucket\)/)
  assert.match(source, /function startRecycleSweeper/)
  assert.match(source, /DSH_PREPARE_NO_RECYCLE/)
  // 跨卷或显式关闭回收时只走同一 Node API，保护拒绝不能换 shell 放行。
  assert.match(source, /await rm\(target, \{ force: true, maxRetries: 10, recursive: true/)
  assert.doesNotMatch(source, /spawnSync\(process\.env\.ComSpec/)

  const previous = process.env.DSH_PREPARE_NO_RECYCLE
  const previousRoot = process.env.DSH_RECYCLE_ROOT
  delete process.env.DSH_PREPARE_NO_RECYCLE
  // 回收区指到本次运行的临时目录：这条用例会 spawn 一个**脱离进程树**的真清理器，
  // 若让它对着实机 Data\Temp\prepare-recycle 跑，它会比测试进程活得久；一旦撞上被
  // 杀软锁住的文件就无限自旋、持续烧 G: 盘 I/O（2026-09-30 实测，测试污染了机器真实状态）。
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-recycle-root-'))
  process.env.DSH_RECYCLE_ROOT = sandbox
  const probe = join(sandbox, `recycle-probe-${Date.now()}`)
  await mkdir(join(probe, 'nested'), { recursive: true })
  await writeFile(join(probe, 'nested', 'file.txt'), 'x', 'utf8')
  try {
    await removePreparedPath(probe)
    assert.equal(existsSync(probe), false, '回收后原路径必须消失')
    const buckets = await readdir(sandbox).catch(() => [] as string[])
    assert.ok(buckets.some(name => name.startsWith('recycle-probe-')), '应出现同名回收桶')
    // 护栏：回收根可被 DSH_RECYCLE_ROOT 覆盖，否则测试无法与实机状态隔离。
    assert.match(source, /DSH_RECYCLE_ROOT/)
  } finally {
    if (previous !== undefined) process.env.DSH_PREPARE_NO_RECYCLE = previous
    else delete process.env.DSH_PREPARE_NO_RECYCLE
    if (previousRoot !== undefined) process.env.DSH_RECYCLE_ROOT = previousRoot
    else delete process.env.DSH_RECYCLE_ROOT
    await rm(probe, { force: true, maxRetries: 10, recursive: true }).catch(() => undefined)
    await rm(sandbox, { force: true, maxRetries: 10, recursive: true }).catch(() => undefined)
  }
})

test('回收清理器：失败计数在子进程退出时立即生效，不会被 pending 清空架空', async () => {
  // P2 回归护栏。上一版把「失败 3 次改名 .failed」的计数放在一个 15 秒后的 setTimeout 里、
  // 判据是 `if(pending&&…)`，而同一条语句里还有个 exit 回调 `if(code!==0)pending=null`。
  // 被杀软锁住的文件让 rmSync 瞬间抛错退出 ⇒ pending 先被清空 ⇒ 计数永远到不了 3
  // ⇒ 桶永远不被隔离 ⇒ 每 5 秒重试一次、心跳常新而删除量为 0。
  // 断言两条结构性事实：①计数发生在 exit 回调里（不再有 15 秒 setTimeout 计时器）；
  // ②exit 回调按桶名累计、达到阈值才改名 .failed。
  const source = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  const cleaner = source.slice(source.indexOf('const RECYCLE_CLEANER'))
  assert.doesNotMatch(cleaner, /setTimeout\(\(\)=>\{if\(pending&&/, '失败计数不得放在延迟计时器里（pending 可能已被清空）')
  assert.match(cleaner, /c\.on\('exit',code=>\{const b=pending;pending=null;/, '失败计数必须在 exit 回调里当场完成')
  assert.match(cleaner, /if\(\+\+failCount>=3\)\{try\{fs\.renameSync\(path\.join\(root,b\),path\.join\(root,b\+'\.failed'\)\)\}/, '连续失败 3 次必须改名 .failed 移出队列')
  assert.match(cleaner, /if\(code===0\)\{failName='';failCount=0;return\}/, '成功一次即清零失败计数')
  assert.match(cleaner, /skipped\.add\(b\)/, '隔离改名或诊断写入被拒时仍需内存跳过，不无限重试')
  assert.match(cleaner, /n\+'\.failed\.json'/, '诊断标记使失败桶在下一次启动仍能被排除')
})

test('回收与同步删除完整继承保护环境，不允许跨 shell 破坏性回退', async () => {
  const source = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /NODE_OPTIONS\s*[:=]\s*['"]{2}/)
  assert.doesNotMatch(source, /CODEBUDDY_SAFE_DELETE_[A-Z_]+\s*[:=]/)
  assert.doesNotMatch(source, /rmdir\s+\/s|del\s+\/f|spawnSync\(process\.env\.ComSpec/i)
  assert.match(source, /env:\{\.\.\.process\.env\}/)
})

test('清理边界拒绝工作区、家园、临时根、活动 App 和槽路径（只读检查）', () => {
  const root = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))
  for (const target of [root, homedir(), tmpdir(), join(root, 'App'), join(root, 'src'), join(root, 'Data', 'DSH'), join(root, 'Data', 'Runtime', 'Harness', 'slots', 'active'), join(root, 'Data', 'Updates', 'Desktop', 'slots', 'active')]) {
    assert.throws(() => assertPreparedRemovalTarget(target), /拒绝清理/)
  }
})

test('清理边界拒绝测试目录内经 junction 指向外部的普通文件夹', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cleanup-boundary-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-cleanup-outside-'))
  try {
    await mkdir(join(outside, 'payload'))
    await writeFile(join(outside, 'payload', 'keep.txt'), 'must remain')
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(removePreparedPath(join(root, 'linked', 'payload')), /目录链接|外部路径/)
    assert.equal(await readFile(join(outside, 'payload', 'keep.txt'), 'utf8'), 'must remain')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('显式回收根不能指向 App 或装配产物，拒绝后原目标保留', async () => {
  const portableRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))
  const root = await mkdtemp(join(tmpdir(), 'dsh-invalid-recycle-'))
  const previousRoot = process.env.DSH_RECYCLE_ROOT, previousDisabled = process.env.DSH_PREPARE_NO_RECYCLE
  const target = join(root, 'ordinary-generated-test-output')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'still present')
  delete process.env.DSH_PREPARE_NO_RECYCLE
  try {
    for (const invalid of [join(portableRoot, 'App'), join(portableRoot, 'runtime-node')]) {
      process.env.DSH_RECYCLE_ROOT = invalid
      await assert.rejects(removePreparedPath(target), /拒绝清理/)
      assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'still present')
    }
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_RECYCLE_ROOT
    else process.env.DSH_RECYCLE_ROOT = previousRoot
    if (previousDisabled === undefined) delete process.env.DSH_PREPARE_NO_RECYCLE
    else process.env.DSH_PREPARE_NO_RECYCLE = previousDisabled
    await rm(root, { recursive: true, force: true })
  }
})

test('回收根和祖先在首轮验证后换成 junction 必须再次拒绝，外部文件不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recycle-drift-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-recycle-outside-'))
  try {
    await writeFile(join(outside, 'keep.txt'), 'external unchanged')
    const spool = join(root, 'spool')
    await mkdir(spool)
    assert.equal(assertRecycleRootPhysical(spool), spool)
    await rename(spool, join(root, 'original-spool'))
    await symlink(outside, spool, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => assertRecycleRootPhysical(spool), /链接|外部路径/)
    await mkdir(join(outside, 'spool-child'))
    assert.throws(() => assertRecycleRootPhysical(join(spool, 'spool-child')), /链接|外部路径/)
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'external unchanged')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('清理器每 tick/worker 和失败隔离回调都重新核对真实回收根', async () => {
  const source = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /const tick=\(\)=>\{requireRoot\(\);/)
  assert.match(source, /const requireRoot=\(\)=>\{try\{assertRoot\(\)\}catch\{process\.exit\(1\)\}\}/)
  assert.match(source, /s\.isDirectory\(\).*s\.isSymbolicLink\(\).*path\.relative\(path\.resolve\(root\),fs\.realpathSync\(root\)\)/)
  assert.match(source, /assertRoot\(\);fs\.rmSync\(target/)
  assert.match(source, /c\.on\('exit',code=>\{const b=pending;pending=null;requireRoot\(\);/)
})

test('打包配置显式映射完整编译产物', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { files?: Array<string | { from?: string; to?: string; filter?: string[] }> }
  }
  assert.equal(
    manifest.build?.files?.some(item => typeof item !== 'string'
      && item.from === 'dist'
      && item.to === 'dist'
      && item.filter?.includes('**/*')),
    true,
  )
})

test('Windows 冒烟检查使用实际产品可执行文件名', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-package.yml', import.meta.url), 'utf8')
  assert.match(workflow, /release\\win-unpacked\\DSH Codex Desktop\.exe/)
})

test('官方运行时使用 npm 安装以兼容预发布 peer 依赖', () => {
  assert.deepEqual(officialRuntimeNpmInstallArgs('D:\\runtime'), [
    'install',
    '--global',
    '--prefix=D:\\runtime',
    '--omit=dev',
    '--package-lock=false',
    '--no-audit',
    '--no-fund',
    '--allow-scripts=@deepseek-ai/dsh-subprocess-local,@google/genai,koffi,node-pty,protobufjs',
    '--registry=https://registry.npmjs.org/',
    '@deepseek-ai/dsh@0.2.0-rc.2',
    '@deepseek-ai/cordis-plugin-group@1.0.4',
    '@deepseek-ai/dsh-scope@0.2.0-rc.2',
    '@deepseek-ai/dsh-timeout@0.2.0-rc.2',
    '@deepseek-ai/dsh-invariants@0.2.0-rc.2',
  ])
})

test('npm 全局安装目录按平台归一化', () => {
  assert.equal(officialRuntimeGlobalNodeModulesRoot('runtime', 'win32'), join('runtime', 'node_modules'))
  assert.equal(officialRuntimeGlobalNodeModulesRoot('runtime', 'linux'), join('runtime', 'lib', 'node_modules'))
})

test('官方运行时把 DSH 和启动 peer 一起装成 npm 顶层依赖', () => {
  assert.deepEqual(officialRuntimeNpmDependencies(), {
    '@deepseek-ai/dsh': '0.2.0-rc.2',
    '@deepseek-ai/cordis-plugin-group': '1.0.4',
    '@deepseek-ai/dsh-scope': '0.2.0-rc.2',
    '@deepseek-ai/dsh-timeout': '0.2.0-rc.2',
    '@deepseek-ai/dsh-invariants': '0.2.0-rc.2',
  })
})

test('打包校验拒绝只嵌套在 DSH 内部的启动 peer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-layout-'))
  try {
    const dependencies = officialRuntimeNpmDependencies()
    for (const [packageName, version] of Object.entries(dependencies)) {
      const base = packageName === '@deepseek-ai/dsh'
        ? join(root, 'node_modules', ...packageName.split('/'))
        : join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', ...packageName.split('/'))
      await mkdir(base, { recursive: true })
      await writeFile(join(base, 'package.json'), JSON.stringify({ name: packageName, version }), 'utf8')
    }
    assert.throws(() => validateOfficialRuntimeLayout(root), /缺少顶层依赖：@deepseek-ai\/cordis-plugin-group/)

    for (const [packageName, version] of Object.entries(dependencies)) {
      const base = join(root, 'node_modules', ...packageName.split('/'))
      await mkdir(base, { recursive: true })
      await writeFile(join(base, 'package.json'), JSON.stringify({ name: packageName, version }), 'utf8')
    }
    assert.doesNotThrow(() => validateOfficialRuntimeLayout(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('alpha.2+ 已内置权限本地化，不再应用旧 rc.2 桌面补丁', async () => {
  const prepare = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(prepare, /applyOfficialRuntimePatch/)
  assert.equal(existsSync(new URL('../../patches/dsh-0.1.1-rc.2-permission-localization.patch', import.meta.url)), false)
})

test('Windows 冒烟保留便携版冷启动路径并检查窗口响应', async () => {
  const script = await readFile(new URL('../../scripts/smoke-package.ps1', import.meta.url), 'utf8')
  const verifier = await readFile(new URL('../../scripts/smoke-packaged-plugins.mts', import.meta.url), 'utf8')
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(script, /extract-runtime\.mjs/)
  assert.match(script, /\.Responding/)
  assert.match(script, /连续 10 秒未响应/)
  assert.match(script, /startupTimeoutSeconds = 900/)
  assert.match(script, /npm_config_offline = 'true'/)
  assert.match(script, /smoke-packaged-plugins\.mjs/)
  assert.doesNotMatch(script, /expectedPlugins/)
  assert.doesNotMatch(script, /@michengai\/dsh-codex-ui/)
  assert.match(verifier, /BUNDLED_PLUGINS/)
  assert.match(verifier, /强制离线首启缺少插件/)
  assert.match(script, /--user-data-dir=/)
  assert.match(main, /const extraction = extractPackagedRuntimesInChild/)
  assert.match(main, /signal: controller\.signal/)
  assert.match(main, /await extraction/)
  assert.match(main, /runtimeExtractionAbortController\?\.abort\(\)/)
  assert.doesNotMatch(main, /\bextractPackagedRuntimes\(/)
  assert.match(main, /--user-data-dir=/)
})

test('便携构建依赖安装显式使用非交互 CI 模式并恢复调用方环境', async () => {
  const script = await readFile(new URL('../../Build-DSH-Portable.ps1', import.meta.url), 'utf8')
  const workspace = await readFile(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8')
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts?: Record<string, string> }
  assert.match(script, /\$previousCi = \$env:CI/)
  assert.match(script, /\$env:CI = 'true'/)
  assert.match(script, /install --frozen-lockfile/)
  assert.match(script, /\$env:CI = \$previousCi/)
  assert.match(script, /Get-DshBuildFileSha256 -LiteralPath \$nodeExecutable/)
  assert.match(script, /Get-DshBuildFileSha256 -LiteralPath \$extractedNode/)
  assert.doesNotMatch(script, /Get-FileHash|\$env:PSModulePath\s*=/)
  assert.match(script, /\$nodeNeedsInstall/)
  assert.match(script, /node_modules\\electron\\install\.js/)
  assert.match(script, /Electron 安装脚本未生成开发态可执行文件/)
  assert.match(workspace, /^\s{2}electron: true$/m)
  assert.match(manifest.scripts?.pack ?? '', /electron-builder --dir --publish never/)
})

test('便携构建 SHA256 不依赖 PowerShell 模块路径，并拒绝缺失文件且释放句柄', { skip: process.platform !== 'win32' }, async () => {
  const script = await readFile(new URL('../../Build-DSH-Portable.ps1', import.meta.url), 'utf8')
  const helper = script.match(/^function Get-DshBuildFileSha256 \{[\s\S]*?^\}/m)?.[0]
  assert.ok(helper, '只抽取纯哈希 helper，禁止执行整个构建脚本')
  assert.match(helper, /\[System\.IO\.File\]::OpenRead\(\$LiteralPath\)/)
  assert.match(helper, /finally[\s\S]*\$sha\.Dispose\(\)[\s\S]*\$stream\.Dispose\(\)/)
  assert.doesNotMatch(helper, /Get-FileHash|Import-Module|\$env:|SetEnvironmentVariable/)
  const root = await mkdtemp(join(tmpdir(), 'dsh-build-hash-'))
  try {
    const file = join(root, 'input.bin')
    const missing = join(root, 'missing.bin')
    const contents = Buffer.concat([Buffer.from([0, 1, 127, 255]), Buffer.from('\r\n中文 SHA256\n', 'utf8')])
    await writeFile(file, contents)
    const expected = createHash('sha256').update(contents).digest('hex').toUpperCase()
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
    const code = [
      '$ErrorActionPreference="Stop"',
      helper,
      '[Console]::WriteLine((Get-DshBuildFileSha256 -LiteralPath ' + quote(file) + '))',
      '$exclusive=[System.IO.File]::Open(' + quote(file) + ',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)',
      '$exclusive.Dispose()',
      '$rejected=$false; try { Get-DshBuildFileSha256 -LiteralPath ' + quote(missing) + ' } catch { $rejected=$true }',
      'if (-not $rejected -or [System.IO.File]::Exists(' + quote(missing) + ')) { throw "Missing file must fail without creating it" }',
      '[Console]::WriteLine("MISSING_REJECTED")',
    ].join('\n')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // Keep inherited PSModulePath: this is the Node → CMD → WinPS build failure case.
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      env: { ...process.env }, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [expected, 'MISSING_REJECTED'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('桌面候选在切换前后台预热共享环境，重启只消费完整缓存', async () => {
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  const updater = await readFile(new URL('../../src/portable-desktop-update.ts', import.meta.url), 'utf8')
  const stage = await readFile(new URL('../../scripts/stage-local-desktop-candidate.ts', import.meta.url), 'utf8')
  const build = await readFile(new URL('../../Build-DSH-Portable.ps1', import.meta.url), 'utf8')
  const receiptCli = await readFile(new URL('../../scripts/build-input-receipt.mjs', import.meta.url), 'utf8')
  const receipt = await readFile(new URL('../../scripts/lib/build-input-receipt.mjs', import.meta.url), 'utf8')
  const prepare = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  assert.match(main, /prepareCandidateRuntime:/)
  assert.match(main, /preparePackagedRuntimeCacheInChild/)
  assert.match(updater, /当前桌面保持运行，正在后台准备候选共享环境/)
  assert.match(stage, /preparePackagedRuntimeCacheInChild/)
  assert.ok(stage.indexOf('const preparation = await preparePackagedRuntimeCacheInChild') < stage.indexOf('const staged = await stageLocalDesktopBuild'))
  const buildLines = build.split(/\r?\n/).map(line => line.trim())
  const buildCommands = [
    '& $nodeExecutable $buildInputReceiptScript capture $portableRoot $buildInputSnapshot',
    "& $nodeExecutable (Join-Path $portableRoot 'node_modules\\typescript\\bin\\tsc')",
    '& $nodeExecutable $buildInputReceiptScript pin-compiled $portableRoot $buildInputSnapshot',
    "& $nodeExecutable (Join-Path $portableRoot 'scripts\\run-tests.mjs')",
    "& $nodeExecutable (Join-Path $portableRoot 'dist\\scripts\\prepare-runtime.js')",
    '& $pnpmCommand exec electron-builder --dir --publish never',
    '& $nodeExecutable $buildInputReceiptScript stage $portableRoot $builtApp $buildInputSnapshot ([string]$manifest.version) full',
  ]
  let priorCommand = -1
  for (const command of buildCommands) {
    const position = buildLines.indexOf(command)
    assert.ok(position > priorCommand, `构建顺序或接线错误：${command}`)
    assert.match(buildLines[position + 1] ?? '', /^if \(\$LASTEXITCODE -ne 0\) \{ throw /)
    priorCommand = position
  }
  assert.match(build, /if \(-not \$SkipTests\) \{/)
  assert.match(receiptCli, /const staged = await stageBuildWithReceipt\(/)
  assert.match(receiptCli, /mode === 'full' \? \{ compiledSnapshot: await readCompiledSnapshot\(root, snapshotArg\) \}/)
  assert.match(receiptCli, /spawn\(process\.execPath, \[join\(root, 'dist\/scripts\/stage-local-desktop-candidate\.js'\), root, appOrSnapshot, version, '--replace-pending'\]/)
  assert.match(receiptCli, /windowsHide: true, env: \{ \.\.\.process\.env, DSH_BUILD_RECEIPT_INTENT: JSON\.stringify\(intent\) \}/)
  assert.match(stage, /if \(!receiptIntentRaw\) throw new Error\(/)
  assert.match(stage, /replacePending: replaceOption === '--replace-pending'/)
  assert.match(receipt, /if \(mode === 'full'\) await assertCompiledInputsUnchanged\(root, snapshot, compiledSnapshot\)/)
  assert.match(receipt, /if \(!ownPending\(pointer, staged\)\) throw error\('BUILD_PENDING_CHANGED'/)
  const receiptStage = receipt.slice(receipt.indexOf('export async function stageBuildWithReceipt('))
  const payloadValidation = receiptStage.indexOf('await verifyReceiptSlotPayload(root, staged.slotRelativePath, staged.transactionId)')
  const finalizedProof = receiptStage.indexOf("await atomicJson(join(transaction, 'build-finalized.json')")
  assert.ok(payloadValidation >= 0 && finalizedProof > payloadValidation)
  assert.doesNotMatch([build, receiptCli, stage].join('\n'), /\b(?:Stop-Process|taskkill(?:\.exe)?)\b|\bprocess\.kill\s*\(/i)
  assert.match(prepare, /writeDirectoryContentSha256/)
  assert.match(prepare, /writePnpmStoreContentSha256/)
  assert.match(prepare, /BUNDLED_LOCKFILE_NAME/)
  assert.match(updater, /resources\/dsh-runtime\.tgz\.content-sha256/)
  assert.match(updater, /resources\/plugins-store\.tgz\.content-sha256/)
})

test('首启页面会向辅助技术播报初始化阶段', async () => {
  const startup = await readFile(new URL('../../assets/startup.html', import.meta.url), 'utf8')
  const particles = await readFile(new URL('../../assets/whale-particles.js', import.meta.url), 'utf8')
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: { from?: string; to?: string }[] }
  }
  assert.match(startup, /role="status"/)
  assert.match(startup, /aria-live="polite"/)
  assert.match(startup, /aria-atomic="true"/)
  assert.match(startup, /<h1>DSH Codex Desktop<\/h1>/)
  assert.match(startup, /<canvas class="icon" id="whaleParticles"/)
  assert.match(startup, /id="startupProgress" role="progressbar"/)
  assert.match(startup, /aria-valuemin="0" aria-valuemax="100"/)
  assert.match(startup, /id="progressValue"/)
  assert.match(startup, /<script src="\.\/whale-particles\.js"><\/script>/)
  assert.doesNotMatch(startup, /<img class="icon"/)
  assert.match(main, /advanceStartupProgress\(startupProgress, progress\)/)
  assert.match(main, /indicator\.setAttribute\('aria-valuenow', String\(next\.progress\)\)/)
  assert.match(main, /value\.textContent = next\.progress \+ '%'/)
  assert.match(particles, /prefers-reduced-motion: reduce/)
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'assets/whale-particles.js' && item.to === 'whale-particles.js'),
    true,
  )
})

test('Windows 冒烟兼容 alpha.2+ 启动 token 鉴权', async () => {
  const scriptBytes = await readFile(new URL('../../scripts/smoke-package.ps1', import.meta.url))
  assert.deepEqual([...scriptBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF])
  const script = scriptBytes.toString('utf8')
  assert.match(script, /function Invoke-SmokeWebRequest/)
  assert.match(script, /Add-Type -AssemblyName System\.Net\.Http/)
  assert.match(script, /System\.Net\.Http\.HttpClient/)
  assert.match(script, /TimeSpan\]::FromSeconds\(\$TimeoutSec\)/)
  assert.match(script, /GetAsync\(\$Uri\)\.GetAwaiter\(\)\.GetResult\(\)/)
  assert.match(script, /ReadAsStringAsync\(\)\.GetAwaiter\(\)\.GetResult\(\)/)
  assert.doesNotMatch(script, /Invoke-WebRequest\s+-Uri/)
  assert.match(script, /function Remove-SmokeDirectory/)
  assert.match(script, /EnumerateFileSystemInfos/)
  assert.match(script, /System\.IO\.Directory\]::Delete/)
  assert.match(script, /\$attempt -le 3/)
  assert.match(script, /SMOKE_PACKAGE_PASS/)
  assert.match(script, /dsh web authentication required/)
  assert.match(script, /startup-error\.log/)
  assert.match(script, /DSH_DESKTOP_SMOKE_READY_FILE/)
  assert.match(script, /\$env:DSH_PORTABLE_ROOT = \$tempRoot/)
  assert.match(script, /\[string\]\$PortableRoot/)
  assert.match(script, /Data\\Updates\\Desktop\\diagnostics/)
  assert.match(script, /Data\\Electron\\UserData/)
  assert.match(script, /startup-ready/)
  assert.match(script, /Start-Process[^\r\n]+-WindowStyle Hidden/)
  assert.match(script, /\$startupTimeoutSeconds = 900/)
  assert.match(script, /function Get-AvailableLoopbackPort/)
  assert.match(script, /\$env:DSH_DESKTOP_WEB_PORT = \[string\]\$smokePort/)
  assert.match(script, /http:\/\/127\.0\.0\.1:\$smokePort\//)
  assert.match(script, /\$env:DSH_DESKTOP_WEB_PORT = \$previousDesktopWebPort/)
  assert.ok(script.indexOf('Test-Path -LiteralPath $startupError') < script.indexOf('if (-not $serviceReady)'))
  const httpSuccessBranch = script.indexOf("if ($page.StatusCode -ne 200)")
  const readyWait = script.indexOf('while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $smokeReadyFile))', httpSuccessBranch)
  const pluginVerification = script.indexOf('smoke-packaged-plugins.mjs')
  assert.ok(httpSuccessBranch >= 0 && readyWait > httpSuccessBranch && pluginVerification > readyWait)
  assert.doesNotMatch(script, /Get-NetTCPConnection/)
  assert.match(script, /\$candidate\.StatusCode -eq 200 -or \(\$candidate\.StatusCode -eq 401/)
  assert.match(script, /function Find-SmokeBootstrapProcess/)
  assert.match(script, /\$descendantIds -contains \[int\]\$process\.ParentProcessId/)
  assert.match(script, /\$expectedNodeExecutable/)
  assert.match(script, /\.Equals\(\$ExpectedNodeExecutable, \[System\.StringComparison\]::OrdinalIgnoreCase\)/)
  assert.doesNotMatch(script, /\$_\.ParentProcessId -eq \$application\.Id/)
  assert.doesNotMatch(script, /Select-Object -First 1\s*\r?\n\s*if \(\$null -ne \$listener\)/)
})

test('正式标签缺少签名凭据时仍允许生成带 ad-hoc 签名的多平台测试版', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-package.yml', import.meta.url), 'utf8')
  const jobs = parseYaml(workflow).jobs
  const steps = Object.values(jobs).flatMap((job: any) => job.steps ?? [])
  const nodeSteps = steps.filter((step: any) => step.uses?.startsWith('actions/setup-node@'))
  assert.equal(nodeSteps.length, 2)
  for (const step of nodeSteps) {
    assert.equal(step.with['node-version-file'], 'package.json')
    assert.equal(step.with['node-version'], undefined, 'CI must not override the manifest Node')
  }
  const pnpmStep = steps.find((step: any) => step.uses?.startsWith('pnpm/action-setup@'))
  assert.ok(pnpmStep)
  assert.equal(pnpmStep.with?.version, undefined, 'pnpm action must read packageManager')
  assert.match(workflow, /actions\/checkout@v7/)
  assert.match(workflow, /actions\/setup-node@v7/)
  assert.match(workflow, /actions\/upload-artifact@v7/)
  assert.match(workflow, /actions\/download-artifact@v8/)
  assert.match(workflow, /pnpm\/action-setup@v6/)
  assert.match(workflow, /未配置 Windows 代码签名凭据，继续生成未签名测试版/)
  assert.match(workflow, /未配置 macOS 签名证书，将生成 ad-hoc 签名测试版/)
  assert.doesNotMatch(workflow, /正式标签发布必须配置 (?:Windows|macOS)/)
  assert.match(workflow, /\$env:CSC_LINK = \$env:WINDOWS_CERTIFICATE/)
  assert.doesNotMatch(workflow, /CSC_LINK: \$\{\{ startsWith\(matrix\.platform/)
  assert.match(workflow, /\$env:DSH_MACOS_ADHOC_SIGN = 'true'/)
  assert.match(workflow, /\$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'/)
  assert.doesNotMatch(workflow, /--config\.mac\.identity=-/)
  assert.doesNotMatch(workflow, /--config\.mac\.hardenedRuntime=false/)
  assert.match(workflow, /codesign --verify --deep --strict --verbose=2/)
  const packagingStep = steps.find((step: any) => step.run?.includes('pnpm run prepare-runtime:built'))
  assert.ok(packagingStep, '打包必须消费本轮唯一编译的制品')
  const run = String(packagingStep.run)
  const lines = run.split(/\r?\n/).map(line => line.trim())
  const commands = ['pnpm run build', 'pnpm run test:built', 'pnpm run preserve:check', 'pnpm run prepare-runtime:built']
  let preceding = -1
  for (const command of commands) {
    const index = lines.indexOf(command)
    assert.ok(index > preceding, '顺序必须为单次编译 → 测试 → 定制保留门禁 → 装配')
    assert.match(lines[index + 1] ?? '', /^if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}$/, '每步下一行必须检查并传播退出码')
    preceding = index
  }
  assert.equal((run.match(/^\s*pnpm run build\s*$/gm) ?? []).length, 1)
  assert.doesNotMatch(run, /^\s*pnpm (?:test|run prepare-runtime)\s*$/m, '禁止通过旧入口重复编译')
  assert.doesNotMatch(workflow, /pnpm run dist -- @buildArguments/)
  assert.match(workflow, /pnpm exec electron-builder --publish never @buildArguments\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/)
})

test('打包态从 desktop-bridge 加载 DSH 主进程模块', async () => {
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  const host = await readFile(new URL('../../src/desktop-host.ts', import.meta.url), 'utf8')
  assert.match(main, /desktop-bridge.*dsh-process\.js/)
  assert.doesNotMatch(host, /from '\.\/dsh-process\.js'/)
})

function extractionScriptExtraResources(manifest: {
  build?: { extraResources?: Array<{ from?: string; to?: string; filter?: string[] }> }
}): Array<{ from: string; to: string }> {
  return (manifest.build?.extraResources ?? []).flatMap((item) => {
    if (typeof item.from !== 'string' || typeof item.to !== 'string' || item.filter !== undefined) return []
    if (!item.from.startsWith('dist/src/')) return []
    return [{ from: item.from, to: item.to }]
  })
}

test('安装阶段解压脚本带上自己的运行依赖', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: Array<{ from?: string; to?: string; filter?: string[] }> }
  }
  const extra = extractionScriptExtraResources(manifest)
  assert.equal(extra.some(item => item.from === 'dist/src/extract-runtime.js' && item.to === 'extract-runtime.mjs'), true)
  assert.equal(extra.some(item => item.from === 'dist/src/runtime-archive.js' && item.to === 'runtime-archive.js'), true)
  assert.equal(extra.some(item => item.from === 'dist/src/process-control.js' && item.to === 'process-control.js'), true)
})

test('安装阶段解压脚本独立目录可以完成 ESM 导入', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: Array<{ from?: string; to?: string; filter?: string[] }> }
  }
  const extra = extractionScriptExtraResources(manifest)
  const root = await mkdtemp(join(tmpdir(), 'dsh-extract-import-'))
  try {
    for (const item of extra) {
      await copyFile(new URL(`../../${item.from}`, import.meta.url), join(root, item.to))
    }
    await import(`${pathToFileURL(join(root, 'extract-runtime.mjs')).href}?test=${Date.now()}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('desktop-bridge 资源清单包含完整运行依赖闭包', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: Array<{ to?: string; filter?: string[] }> }
  }
  const filter = manifest.build?.extraResources?.find(item => item.to === 'desktop-bridge')?.filter
  assert.deepEqual([...(filter ?? [])].sort(), [...DESKTOP_BRIDGE_FILES].sort())
})

test('desktop-bridge 独立目录可以完成 ESM 导入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-import-'))
  try {
    for (const file of DESKTOP_BRIDGE_FILES) {
      await copyFile(new URL(`../../dist/src/${file}`, import.meta.url), join(root, file))
    }
    await import(`${pathToFileURL(join(root, 'desktop-host.js')).href}?test=${Date.now()}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('更新产物使用不会被 GitHub 改写的固定文件名', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: {
      win?: { artifactName?: string }
      mac?: { artifactName?: string }
      linux?: { artifactName?: string }
    }
  }
  assert.equal(manifest.build?.win?.artifactName, 'dsh-codex-desktop-${version}-win-${arch}.${ext}')
  assert.equal(manifest.build?.mac?.artifactName, 'dsh-codex-desktop-${version}-mac-${arch}.${ext}')
  assert.equal(manifest.build?.linux?.artifactName, 'dsh-codex-desktop-${version}-linux-${arch}.${ext}')
})

test('打包把 DSH_PORTABLE_RELEASE_SOURCE 烘焙进 resources，未注入时写内置默认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-source-bake-'))
  try {
    // 未注入环境变量：写内置默认（上游仓库），应用端仍可被 Data/config 覆盖。
    await writeReleaseSourceManifest(root, {})
    assert.deepEqual(JSON.parse(await readFile(join(root, 'release-source.json'), 'utf8')), DEFAULT_DESKTOP_RELEASE_SOURCE)
    // 注入有效 JSON：按注入值烘焙，供 CI/本地构建指向自有发布仓库。
    await writeReleaseSourceManifest(root, { DSH_PORTABLE_RELEASE_SOURCE: '{"owner":"hly252397-tech","repo":"DSH-3-Portable","artifactBase":"dsh-codex-desktop"}' })
    assert.deepEqual(JSON.parse(await readFile(join(root, 'release-source.json'), 'utf8')), { owner: 'hly252397-tech', repo: 'DSH-3-Portable', artifactBase: 'dsh-codex-desktop' })
    // 非法注入直接失败，禁止带着坏发布源出包。
    await assert.rejects(writeReleaseSourceManifest(root, { DSH_PORTABLE_RELEASE_SOURCE: '{"owner":"bad owner"}' }), /不是有效的发布源/)
    // 打包配置确实把烘焙产物映射进 resources。
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      build?: { extraResources?: Array<{ from?: string, to?: string }> }
    }
    assert.ok(manifest.build?.extraResources?.some(item => item.from === 'dist/release-source.json' && item.to === 'release-source.json'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('macOS 双架构使用各自的更新通道元数据', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-package.yml', import.meta.url), 'utf8')
  assert.match(workflow, /latest-arm64-mac\.yml/)
  assert.match(workflow, /latest-x64-mac\.yml/)
})

test('Linux ARM64 使用原生 runner、独立更新元数据与双格式制品', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-package.yml', import.meta.url), 'utf8')
  assert.match(workflow, /platform: linux-arm64/)
  assert.match(workflow, /runner: ubuntu-24\.04-arm/)
  assert.match(workflow, /buildArguments: --linux --arm64/)
  assert.match(workflow, /unpackedDirectory: linux-arm64-unpacked/)
  assert.match(workflow, /updateMetadata: latest-linux-arm64\.yml/)

  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { linux?: { target?: string[] } }
  }
  assert.deepEqual(manifest.build?.linux?.target, ['AppImage', 'deb'])
})

test('装配锁文件会放进随包仓库', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-publish-lock-'))
  try {
    const staging = join(root, 'staging')
    const store = join(root, 'store')
    await mkdir(staging)
    await mkdir(store)
    await writeFile(join(staging, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
    await publishBundledLockfile(staging, store)
    assert.equal(await readFile(join(store, 'bundled-lock.yaml'), 'utf8'), 'lockfileVersion: 9.0\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('打包离线门禁传播安装失败并清理临时 Profile', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-offline-gate-'))
  try {
    await mkdir(join(root, 'store'), { recursive: true })
    await writeFile(join(root, 'store', 'bundled-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
    let calls=0
    await assert.rejects(verifyBundledPluginStore(root,'unused',args=>{
      calls++
      assert.ok(args.includes('--offline'))
      assert.ok(args.includes('--frozen-lockfile'))
      throw new Error('ERR_PNPM_NO_OFFLINE_META')
    }),/ERR_PNPM_NO_OFFLINE_META/)
    assert.equal(calls,1)
    assert.deepEqual(await readdir(root), ['store'])
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('pnpm 返回成功但未装全插件时打包门禁仍拒绝', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-offline-incomplete-'))
  try {
    await mkdir(join(root, 'store'), { recursive: true })
    await writeFile(join(root, 'store', 'bundled-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
    await assert.rejects(verifyBundledPluginStore(root,'unused',()=>{}),/ENOENT/)
    assert.deepEqual(await readdir(root), ['store'])
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('离线安装返回错误插件版本时阻止打包', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-offline-version-'))
  try {
    await mkdir(join(root, 'store'), { recursive: true })
    await writeFile(join(root, 'store', 'bundled-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
    await assert.rejects(verifyBundledPluginStore(root,'unused',args=>{
      const profile = args.find(arg => arg.startsWith('--dir='))?.slice('--dir='.length)
      if (profile === undefined) throw new Error('缺少安装目录')
      for (const plugin of STORE_PACKAGES) {
        const dir = join(profile, 'node_modules', ...plugin.packageName.split('/'))
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: plugin.packageName, version: '0.0.0' }), 'utf8')
      }
    }),/版本不匹配/)
    assert.deepEqual(await readdir(root), ['store'])
  } finally {await rm(root,{recursive:true,force:true})}
})

test('缺少 metadata-full 时打包门禁拒绝随包仓库', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-meta-incomplete-'))
  try {
    const metadata=join(root,'store','cache','v11','metadata','registry.npmjs.org')
    await mkdir(metadata,{recursive:true})
    await writeFile(join(metadata,'node-sdk.jsonl'),'{"modified":"2026-09-04T00:00:00.000Z"}\n{"name":"node-sdk","versions":{"1.0.0":{"version":"1.0.0"}}}\n','utf8')
    await assert.rejects(assertBundledPluginMetadataComplete(join(root,'store')),/完整元数据/)
  } finally {await rm(root,{recursive:true,force:true})}
})

test('缺失的 metadata-full 会用缩写元数据补上路径，已有文件不改写', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-meta-complete-'))
  try {
    const store=join(root,'store')
    const metadata=join(store,'cache','v11','metadata','registry.npmjs.org','@scope')
    const full=join(store,'cache','v11','metadata-full','registry.npmjs.org')
    const abbreviated='{"modified":"2026-09-04T00:00:00.000Z"}\n{"name":"@scope/pkg","versions":{"1.0.0":{"version":"1.0.0"}}}\n'
    const existing='{"modified":"2026-01-01T00:00:00.000Z"}\n{"name":"debug","time":{"1.0.0":"2026-01-01T00:00:00.000Z"}}\n'
    await mkdir(metadata,{recursive:true})
    await mkdir(full,{recursive:true})
    await writeFile(join(metadata,'pkg.jsonl'),abbreviated,'utf8')
    await writeFile(join(full,'debug.jsonl'),existing,'utf8')
    await writeFile(join(store,'cache','v11','metadata','registry.npmjs.org','debug.jsonl'),'{"modified":"2026-09-04T00:00:00.000Z"}\n{"name":"debug"}\n','utf8')
    await completeBundledPluginMetadata(store)
    await assertBundledPluginMetadataComplete(store)
    assert.equal(await readFile(join(store,'cache','v11','metadata-full','registry.npmjs.org','@scope','pkg.jsonl'),'utf8'),abbreviated)
    assert.equal(await readFile(join(full,'debug.jsonl'),'utf8'),existing)
  } finally {await rm(root,{recursive:true,force:true})}
})
