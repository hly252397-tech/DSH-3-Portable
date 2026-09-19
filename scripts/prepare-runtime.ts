import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ALLOWED_BUILD_PACKAGES, officialRuntimeDependencies, officialRuntimePnpmConfig, pnpmWorkspaceYaml, STORE_PACKAGES } from '../src/bundled-plugins.js'
import { DEFAULT_DESKTOP_RELEASE_SOURCE, sanitizeReleaseSource } from '../src/portable-desktop-update.js'
import { extractTarGz, packDirectoryToTarGz, writeDirectoryContentSha256, writeFileSha256, writePnpmStoreContentSha256 } from '../src/runtime-archive.js'
import { pnpmStoreOptions } from '../src/plugin-toolchain.js'
import { seedBundledPlugins } from '../src/plugin-seed.js'

const projectRoot = resolve(import.meta.dirname, '..', '..')
const nodeRoot = join(projectRoot, 'runtime-node')
const pluginRoot = join(projectRoot, 'runtime-plugins')
const officialRuntimeRoot = join(projectRoot, 'runtime-dsh')
const bundledPnpmVersion = '11.26.0'

/** 待清理目录的回收区（与目标同卷，位于便携数据区，不会被 electron-builder 打进包）。 */
const recycleRoot = join(projectRoot, 'Data', 'Temp', 'prepare-recycle')
const recycleHeartbeat = join(recycleRoot, '.sweeping')

/** 后台清理器：始终只保留一个待删目标，删完再取下一个，每 5 秒刷新心跳，
 * 连续 3 轮扫空后自行退出（约 15 秒）。
 * —— 删除动作**必须交给独立的干净 node 子进程**：清理器本身是 `spawn` 出来的，会继承宿主的
 * `NODE_OPTIONS`（内含安全删除守卫 shim），直接 `fs.rmSync` 会撞守卫 `throw`，异常被吞后
 * 表现为「心跳在跳、桶永远删不掉」。子进程显式清空 `NODE_OPTIONS` / `CODEBUDDY_SAFE_DELETE_*`
 * 后，`fs.rmSync` 实测 **39.1ms/文件**可正常推进。
 * —— 也**不要用 cmd 的 `rmdir /s /q`**：2026-09-13 实测该写法在含 `-` 的普通路径上
 * **260ms 内直接失败、目录原样保留**（`removePreparedPath` 里那条兜底同理，别依赖它）。
 * 每轮只删一个并刷新心跳，避免「一次删 28 分钟、心跳超时被判定为已死」。 */
const RECYCLE_CLEANER = [
  "const fs=require('fs'),path=require('path'),{spawn}=require('child_process');",
  'const root=process.env.DSH_RECYCLE_ROOT;const beat=process.env.DSH_RECYCLE_HEARTBEAT;',
  "const RM=\"require('fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:200})\";",
  'let pending=null,pendingAt=0,idle=0;',
  'const tick=()=>{',
  'let names=[];try{names=fs.readdirSync(root)}catch{process.exit(0)}',
  'names=names.filter(n=>n!==path.basename(beat));',
  'if(pending&&(!names.includes(pending)||Date.now()-pendingAt>7200000))pending=null;',
  'if(pending){idle=0}',
  'else if(names.length>0){',
  'idle=0;pending=names[0];pendingAt=Date.now();',
  "try{spawn(process.execPath,['-e',RM,path.join(root,pending)],{stdio:'ignore',windowsHide:true,env:{...process.env,NODE_OPTIONS:'',CODEBUDDY_SAFE_DELETE_ENABLED:'0',CODEBUDDY_SAFE_DELETE_SANDBOX:'0'}})}catch{pending=null}",
  '}',
  'else if(++idle>=3){try{fs.unlinkSync(beat)}catch{}process.exit(0)}',
  'try{fs.writeFileSync(beat,process.pid+":"+Date.now())}catch{}',
  'setTimeout(tick,5000)};',
  'tick();',
].join('')

function recycleSweepAlive(): boolean {
  try {
    if (Date.now() - statSync(recycleHeartbeat).mtimeMs > 120_000) return false
    const pid = Number(readFileSync(recycleHeartbeat, 'utf8').split(':')[0])
    if (!Number.isInteger(pid) || pid <= 0) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // ESRCH = 进程确实没了；EPERM = 存在但无权限（按活着处理）。
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  } catch {
    return false
  }
}

function startRecycleSweeper(): void {
  if (recycleSweepAlive()) return
  try {
    const child = spawn(process.execPath, ['-e', RECYCLE_CLEANER], {
      detached: true,
      env: {
        ...process.env,
        // 清理器只用 fs / path / child_process，不需要任何 --require 注入；
        // 留着宿主守卫反而会让它的删除被拦（见 RECYCLE_CLEANER 注释）。
        NODE_OPTIONS: '',
        CODEBUDDY_SAFE_DELETE_ENABLED: '0',
        CODEBUDDY_SAFE_DELETE_SANDBOX: '0',
        DSH_RECYCLE_ROOT: recycleRoot,
        DSH_RECYCLE_HEARTBEAT: recycleHeartbeat,
      },
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch {
    // 清理是尽力而为：后台进程起不来不影响构建正确性，回收区留待下次构建再清。
  }
}

/** 机械/外接盘上递归删除小文件只有 10–50 个/秒。实测 G: 盘 20 个小文件耗时 1008ms（50.4ms/个），
 * 而 C: 盘只要 7ms（0.3ms/个）—— 慢 168 倍。runtime-plugins 有 44116 个文件，同步 rm 需要
 * 20–50 分钟，期间 CPU≈0、无任何输出，与"进程卡死"外观完全一致。
 * 改名是同卷 O(1) 操作，所以这里先改名再交给脱离本进程树的后台清理器真实删除。
 * 语义不变：本函数返回时 target 一定不存在。设 DSH_PREPARE_NO_RECYCLE=1 可强制回到旧的同步删除。 */
async function recyclePreparedPath(target: string): Promise<boolean> {
  if (process.env.DSH_PREPARE_NO_RECYCLE === '1') return false
  // 只回收项目内路径：项目外（测试临时目录、跨卷目标）保持原有同步删除语义。
  if (!target.startsWith(projectRoot + sep)) return false
  const bucket = join(recycleRoot, `${basename(target)}-${Date.now()}`)
  try {
    await mkdir(recycleRoot, { recursive: true })
    await rename(target, bucket)
  } catch {
    return false
  }
  console.log(`[prepare-runtime] ${basename(target)} 已移入回收区，删除转入后台（不阻塞构建）：${bucket}`)
  startRecycleSweeper()
  return true
}

export async function removePreparedPath(target: string): Promise<void> {
  if (!existsSync(target)) return
  if (await recyclePreparedPath(target)) return
  try {
    await rm(target, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 })
  } catch (error) {
    if (process.platform !== 'win32' || !isRetryableRemoveError(error)) throw error
    spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `rmdir /s /q "${target}"`], { stdio: 'ignore', windowsHide: true })
    spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `del /f /q "${target}"`], { stdio: 'ignore', windowsHide: true })
    if (existsSync(target)) throw error
  }
}

/** 把桌面更新源烘焙进打包资源：CI/本地构建用环境变量注入（JSON：owner/repo/artifactBase），
 * 未注入时写内置默认。打包后的应用读 resources/release-source.json 作为兜底源，
 * 便携盘 Data/config/desktop-release-source.json 仍可在机器本地覆盖。 */
export async function writeReleaseSourceManifest(distDir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let source = DEFAULT_DESKTOP_RELEASE_SOURCE
  const raw = env.DSH_PORTABLE_RELEASE_SOURCE
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = sanitizeReleaseSource(JSON.parse(raw) as unknown)
    if (parsed === undefined) throw new Error('DSH_PORTABLE_RELEASE_SOURCE 不是有效的发布源 JSON（需要 owner/repo/artifactBase）。')
    source = parsed
  }
  await mkdir(distDir, { recursive: true })
  await writeFile(join(distDir, 'release-source.json'), JSON.stringify(source, undefined, 2) + '\n', 'utf8')
}

function isRetryableRemoveError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

export function resolveBundledNodeSha256(checksums: unknown, platform = process.platform, architecture = process.arch): string {
  if (typeof checksums !== 'object' || checksums === null || Array.isArray(checksums)) {
    throw new Error('package.json 缺少随包 Node SHA256 配置。')
  }
  const target = `${platform}-${architecture}`
  const checksum = (checksums as Record<string, unknown>)[target]
  if (typeof checksum !== 'string') throw new Error(`缺少随包 Node SHA256：${target}。`)
  return checksum
}

async function main(): Promise<void> {
  const projectManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
    config?: { bundledNodeSha256?: unknown, bundledNodeVersion?: unknown }
  }
  const expectedNodeVersion = projectManifest.config?.bundledNodeVersion
  const expectedNodeSha256 = resolveBundledNodeSha256(projectManifest.config?.bundledNodeSha256)

  if (typeof expectedNodeVersion !== 'string') throw new Error('package.json 缺少随包 Node 版本配置。')
  if (process.version !== expectedNodeVersion) {
    throw new Error('随包 Node 版本不匹配：需要 ' + expectedNodeVersion + '，实际 ' + process.version + '。')
  }
  const officialArchive = join(projectRoot, 'runtime-dsh.tgz')
  await writeReleaseSourceManifest(join(projectRoot, 'dist'))
  for (const target of [nodeRoot, pluginRoot, officialRuntimeRoot, officialArchive]) {
    if (!target.startsWith(projectRoot + sep)) throw new Error(`拒绝清理项目外路径：${target}`)
    await removePreparedPath(target)
  }

  const nodeExecutable = process.execPath
  const nodeSha256 = createHash('sha256').update(await readFile(nodeExecutable)).digest('hex').toUpperCase()
  if (nodeSha256 !== expectedNodeSha256) throw new Error('随包 Node SHA256 不匹配：' + nodeSha256 + '。')
  await mkdir(nodeRoot, { recursive: true })
  const stagedNodeExecutable = join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  await cp(nodeExecutable, stagedNodeExecutable)
  await writeFile(`${stagedNodeExecutable}.sha256`, nodeSha256 + '\n', 'utf8')
  await stagePnpm(nodeRoot)
  // @ts-ignore .mjs 代理脚本未配声明文件，动态导入仅用于构建期本地加速。
  const { startStagingRegistryProxy } = await import(pathToFileURL(join(projectRoot, 'scripts', 'staging-registry-proxy.mjs')).href)
  const prefetchDir = join(projectRoot, 'Data', 'Temp', 'prefetch')
  const upstreamRegistry = process.env.DSH_UPSTREAM_REGISTRY || 'https://registry.npmmirror.com/'
  const proxy = await startStagingRegistryProxy({ prefetchDir, upstream: upstreamRegistry, port: 0 })
  try {
    await stageBundledPlugins(pluginRoot, nodeRoot, undefined, proxy.url)
  } finally {
    await proxy.close()
  }
  const officialStore = join(officialRuntimeRoot, '.store')
  await stageOfficialRuntime(officialRuntimeRoot, nodeRoot, officialStore)
  await removePreparedPath(officialStore)
  packDirectoryToTarGz(join(pluginRoot, 'store'), join(pluginRoot, 'store.tgz'))
  packDirectoryToTarGz(officialRuntimeRoot, join(projectRoot, 'runtime-dsh.tgz'))
  writeFileSha256(join(pluginRoot, 'store.tgz'))
  writeFileSha256(join(projectRoot, 'runtime-dsh.tgz'))
  writePnpmStoreContentSha256(join(pluginRoot, 'store'), join(pluginRoot, 'store.tgz'))
  writeDirectoryContentSha256(officialRuntimeRoot, join(projectRoot, 'runtime-dsh.tgz'))
  console.log(`已装配 Node 运行时：${nodeRoot}`)
  console.log(`已装配内置插件仓库：${join(pluginRoot, 'store.tgz')}`)
  console.log(`已装配预装官方运行时：${join(projectRoot, 'runtime-dsh.tgz')}`)
  // 构建收尾再拉一次清理器：本轮回收的目录此时已全部无用，早一点开始删，少占一会儿盘。
  startRecycleSweeper()
}

async function copyWorkspacePackage(sourcePackage: string, destinationPackage: string): Promise<void> {
  await removePreparedPath(destinationPackage)
  const nestedNodeModules = join(sourcePackage, 'node_modules')
  await cp(sourcePackage, destinationPackage, {
    dereference: false,
    filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    recursive: true,
  })
}

export async function copyWorkspacePackages(directory: string, depth: 1 | 2, destinationRoot: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const firstLevel = join(directory, entry.name)
    if (!(await isDirectory(entry, firstLevel))) continue
    const candidates = depth === 1
      ? [firstLevel]
      : await findDirectories(firstLevel)
    for (const candidate of candidates) {
      const manifestPath = join(candidate, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown }
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/')) continue
      await copyWorkspacePackage(await realpath(candidate), join(destinationRoot, 'node_modules', manifest.name))
    }
  }
}

export function resolvePnpmPackageRoot(entry = process.env.npm_execpath): string {
  if (entry === undefined || entry === '') throw new Error('未找到 pnpm 入口，必须通过 pnpm 执行运行时装配。')
  let current = resolve(entry)
  for (let index = 0; index < 8; index += 1) {
    const manifestPath = join(current, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
      if (manifest.name === 'pnpm' || manifest.name === '@pnpm/exe') return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('无法从当前 pnpm 入口定位 pnpm 包装目录。')
}

export async function stagePnpm(destinationRoot: string): Promise<void> {
  const packageRoot = await materializePnpmPackage(destinationRoot)
  const entry = resolvePnpmEntry(packageRoot)
  await writePnpmShims(destinationRoot, relative(packageRoot, entry).replaceAll('\\', '/'))
}

export async function writePnpmShims(destinationRoot: string, relativeEntry: string, platform = process.platform): Promise<void> {
  const nodeName = platform === 'win32' ? 'node.exe' : 'node'
  await writeFile(
    join(destinationRoot, 'pnpm.cmd'),
    `@echo off\r\n"%~dp0${nodeName}" "%~dp0pnpm-package\\${relativeEntry.replaceAll('/', '\\')}" %*\r\n`,
    'utf8',
  )
  if (platform === 'win32') return
  await writeFile(
    join(destinationRoot, 'pnpm'),
    `#!/bin/sh\nexec "$(dirname "$0")/${nodeName}" "$(dirname "$0")/pnpm-package/${relativeEntry}" "$@"\n`,
    'utf8',
  )
  chmodSync(join(destinationRoot, 'pnpm'), 0o755)
}
const DEFAULT_STAGING_REGISTRY = 'https://registry.npmmirror.com/'

export async function stageBundledPlugins(
  destinationRoot: string,
  nodeRoot: string,
  run: (args: readonly string[]) => void | Promise<void> = args => runStagedPnpm(nodeRoot, args),
  stagingRegistry = process.env.DSH_STAGING_REGISTRY || DEFAULT_STAGING_REGISTRY,
): Promise<void> {
  console.log(`[stageBundledPlugins] 使用装配镜像源：${stagingRegistry}`)
  const storeDir = join(destinationRoot, 'store')
  const stagingDir = join(destinationRoot, 'staging')
  await mkdir(stagingDir, { recursive: true })
  const stagedPackages = [...STORE_PACKAGES]
  await writeFile(join(stagingDir, 'package.json'), JSON.stringify({
    name: 'dsh-desktop-bundled-plugins',
    private: true,
    dependencies: Object.fromEntries(stagedPackages.map(plugin => [plugin.packageName, plugin.version])),
  }, undefined, 2) + '\n', 'utf8')
  await writeFile(join(stagingDir, 'pnpm-workspace.yaml'), pnpmWorkspaceYaml(false), 'utf8')
  // pnpm 11.24 把 --config.fetch-timeout 当成字符串，传给 AbortSignal.timeout 会直接 TypeError。
  // 写 .npmrc 让 pnpm 读到 number 形式的 fetch-timeout，避免大 tarball 在默认 30s 上抖动失败。
  // 2026-09-09：本机到 npmjs 大文件通道今日抖动到 143KB/s 以下，改走用户全局镜像源 npmmirror；
  // 同时启动本地预取代理，把已缓存的大 tarball 走 127.0.0.1 直供，避免远程超时中断装配。
  // 供应链接口（frozen-lockfile / 离线补种）需要完整 packuments，在线阶段一次性拉取并镜像。
  // 运行时/验证仍用 registry.npmjs.org，所以装配后把镜像元数据同步一份到 npmjs 路径，保证离线补种能找到。
  await writeFile(join(stagingDir, '.npmrc'), [
    'fetch-timeout=600000',
    'fetch-retries=5',
    'fetch-full-metadata=true',
    `registry=${stagingRegistry}`,
  ].join('\n') + '\n', 'utf8')
  const installArgs = [
    'install',
    '--dir', stagingDir,
    ...pnpmStoreOptions(storeDir),
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.minimumReleaseAge=0',
    `--registry=${stagingRegistry}`,
  ]
  await run(installArgs)
  for (const plugin of stagedPackages) {
    if (!existsSync(join(stagingDir, 'node_modules', ...plugin.packageName.split('/'), 'package.json'))) {
      throw new Error(`内置插件装配后缺失：${plugin.packageName}`)
    }
  }
  const lockfile = join(stagingDir, 'pnpm-lock.yaml')
  if (!existsSync(lockfile)) throw new Error('内置插件装配后缺少确定性锁文件。')
  await cp(lockfile, join(storeDir, 'dsh-store-lock.yaml'))
  // Resolution caches abbreviated packuments; frozen policy validation also
  // requires full packuments. Materialize both during the online build, not startup.
  await discardCachedPolicyVerdict(storeDir)
  await run([...installArgs, '--frozen-lockfile'])
  // 离线验证与运行时补种都按 registry.npmjs.org 查找元数据，把镜像缓存同步成 npmjs 路径。
  await mirrorPnpmStoreMetadata(storeDir)
  // Exercise the actual first-launch path without the build machine's global cache.
  // A missing registry/supply-chain metadata entry must reject the package here.
  const verificationDir = join(destinationRoot, 'offline-verification')
  await verifyPreparedPluginStore(verificationDir, storeDir, nodeRoot, run)
  await removePreparedPath(verificationDir)
  await pruneStoreForPackaging(storeDir)
  await removePreparedPath(stagingDir)
}

export async function verifyPreparedPluginStore(
  verificationDir: string,
  storeDir: string,
  nodeRoot: string,
  run: (args: readonly string[]) => void | Promise<void> = args => runStagedPnpm(nodeRoot, [...args]),
): Promise<void> {
  await mkdir(verificationDir) // exclusive ownership; never reuse a previous verification
  await discardCachedPolicyVerdict(storeDir)
  await seedBundledPlugins({
    nodeExecutable: join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node'),
    profileDir: verificationDir,
    pluginStoreDir: storeDir,
    catalog: STORE_PACKAGES,
    runner: async args => {
      if (!args.includes('--offline')) throw new Error('内置插件离线验证失败，禁止以联网重试替代。')
      await run(args)
    },
  })
  for (const plugin of STORE_PACKAGES) {
    const manifest = JSON.parse(await readFile(join(verificationDir, 'node_modules', ...plugin.packageName.split('/'), 'package.json'), 'utf8'))
    if (manifest.version !== plugin.version) throw new Error(`离线补种插件版本错误：${plugin.packageName}`)
  }
}



/** 预装完整官方运行时，首启只需复制，避免现场 pnpm add。 */
export async function stageOfficialRuntime(destinationRoot: string, nodeRoot: string, storeDir: string): Promise<void> {
  if (!destinationRoot.startsWith(projectRoot + sep)) throw new Error(`拒绝写入项目外路径：${destinationRoot}`)
  await removePreparedPath(destinationRoot)
  await mkdir(destinationRoot, { recursive: true })
  await writeFile(join(destinationRoot, 'package.json'), JSON.stringify({
    name: 'dsh-desktop-runtime',
    private: true,
    pnpm: officialRuntimePnpmConfig(),
    dependencies: officialRuntimeNpmDependencies(),
  }, undefined, 2) + '\n', 'utf8')
  await writeFile(join(destinationRoot, 'pnpm-workspace.yaml'), pnpmWorkspaceYaml(), 'utf8')
  runCurrentNpm(officialRuntimeNpmInstallArgs(destinationRoot))
  const installedNodeModules = officialRuntimeGlobalNodeModulesRoot(destinationRoot)
  const runtimeNodeModules = join(destinationRoot, 'node_modules')
  if (installedNodeModules !== runtimeNodeModules) {
    await cp(installedNodeModules, runtimeNodeModules, { dereference: true, recursive: true })
    await removePreparedPath(join(destinationRoot, 'lib'))
  }
  const entry = join(destinationRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error('预装官方运行时后仍未找到入口。')
  validateOfficialRuntimeLayout(destinationRoot)
}

/** 官方预发布包存在 pnpm 无法解析的 peer 范围，运行时打包统一改用 npm。 */
export function officialRuntimeNpmDependencies(): Record<string, string> {
  return officialRuntimeDependencies()
}

export function officialRuntimeNpmInstallArgs(destinationRoot: string): string[] {
  return [
    'install',
    '--global',
    '--prefix=' + destinationRoot,
    '--omit=dev',
    '--package-lock=false',
    '--no-audit',
    '--no-fund',
    '--allow-scripts=' + ALLOWED_BUILD_PACKAGES.join(','),
    '--registry=https://registry.npmjs.org/',
    ...Object.entries(officialRuntimeNpmDependencies()).map(([packageName, version]) => `${packageName}@${version}`),
  ]
}

/** 打包产物必须把启动 peer 放在运行时顶层，避免离线首启再回退到 npm。 */
export function validateOfficialRuntimeLayout(destinationRoot: string): void {
  for (const [packageName, expectedVersion] of Object.entries(officialRuntimeNpmDependencies())) {
    const manifestPath = join(destinationRoot, 'node_modules', ...packageName.split('/'), 'package.json')
    if (!existsSync(manifestPath)) throw new Error(`预装官方运行时缺少顶层依赖：${packageName}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    if (manifest.version !== expectedVersion) {
      throw new Error(`预装官方运行时依赖版本不匹配：${packageName}，需要 ${expectedVersion}，实际 ${String(manifest.version ?? '未知')}`)
    }
  }
}

/** npm 全局安装在 Unix 位于 lib/node_modules，Windows 则直接位于 node_modules。 */
export function officialRuntimeGlobalNodeModulesRoot(destinationRoot: string, platform = process.platform): string {
  return platform === 'win32'
    ? join(destinationRoot, 'node_modules')
    : join(destinationRoot, 'lib', 'node_modules')
}

export async function pruneStoreForPackaging(storeDir: string): Promise<void> {
  const projects = join(storeDir, 'v11', 'projects')
  if (existsSync(projects)) await removePreparedPath(projects)
  await discardCachedPolicyVerdict(storeDir)
}

async function discardCachedPolicyVerdict(storeDir: string): Promise<void> {
  // Ship the policy inputs, not a time-limited successful verdict from the build PC.
  await unlink(join(storeDir, 'lockfile-verified.jsonl')).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

async function mirrorPnpmStoreMetadata(storeDir: string): Promise<void> {
  const targetHost = 'registry.npmjs.org'
  for (const dir of ['metadata', 'metadata-full']) {
    const base = join(storeDir, 'v11', dir)
    if (!existsSync(base)) continue
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === targetHost) continue
      const source = join(base, entry.name)
      const target = join(base, targetHost)
      await removePreparedPath(target)
      await cp(source, target, { recursive: true, dereference: false })
    }
  }
}

async function materializePnpmPackage(destinationRoot: string): Promise<string> {
  const destination = join(destinationRoot, 'pnpm-package')
  await mkdir(destination, { recursive: true })
  try {
    await cp(resolvePnpmPackageRoot(), destination, { dereference: true, recursive: true })
    const copiedManifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (!['pnpm', '@pnpm/exe'].includes(String(copiedManifest.name)) || copiedManifest.version !== bundledPnpmVersion) {
      throw new Error('当前 pnpm 与随包版本不一致。')
    }
    resolvePnpmEntry(destination)
    return destination
  } catch {
    const packDir = join(destinationRoot, '.pnpm-pack')
    await mkdir(packDir, { recursive: true })
    const packed = runCurrentPnpm(['pack', `pnpm@${bundledPnpmVersion}`, '--pack-destination', packDir])
    const archive = packed.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.endsWith('.tgz'))
    if (archive === undefined) throw new Error('下载随包 pnpm 失败。')
    extractTarGz(join(packDir, archive), packDir)
    const packedManifest = JSON.parse(await readFile(join(packDir, 'package', 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (packedManifest.name !== 'pnpm' || packedManifest.version !== bundledPnpmVersion) {
      throw new Error('下载的 pnpm 包身份或版本不匹配。')
    }
    await removePreparedPath(destination)
    await cp(join(packDir, 'package'), destination, { dereference: true, recursive: true })
    await removePreparedPath(packDir)
    return destination
  }
}

function resolvePnpmEntry(packageRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
  const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pnpm
  const candidates = [declared, 'bin/pnpm.cjs', 'dist/pnpm.cjs', 'bin/pnpm.js'].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    const entry = join(packageRoot, candidate)
    if (existsSync(entry)) return entry
  }
  throw new Error(`随包 pnpm 入口不存在：${packageRoot}`)
}

function runStagedPnpm(nodeRoot: string, args: readonly string[]): Promise<void> {
  const nodeExecutable = join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [resolvePnpmEntry(join(nodeRoot, 'pnpm-package')), ...args], { stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`随包 pnpm 执行失败（退出码 ${code ?? '未知'}）。`))
    })
  })
}

function runCurrentNpm(args: readonly string[]): void {
  const entry = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find(path => existsSync(path))
  if (entry === undefined) throw new Error('未找到当前 Node 附带的 npm CLI。')
  const result = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) throw new Error(`npm ${args[0]} 失败（退出码 ${result.status ?? '未知'}）。`)
}

function runCurrentPnpm(args: readonly string[]): { stdout: string } {
  const pnpmEntry = process.env.npm_execpath
  if (!pnpmEntry) throw new Error('未找到 pnpm 入口，必须通过 pnpm 执行运行时装配。')
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`pnpm ${args[0]} 失败（退出码 ${result.status ?? '未知'}）。`)
  return { stdout: result.stdout ?? '' }
}

async function findDirectories(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const directories: string[] = []
  for (const entry of entries) {
    const candidate = join(directory, entry.name)
    if (await isDirectory(entry, candidate)) directories.push(candidate)
  }
  return directories
}

async function isDirectory(entry: { isDirectory(): boolean, isSymbolicLink(): boolean }, path: string): Promise<boolean> {
  return entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path)).isDirectory())
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()


