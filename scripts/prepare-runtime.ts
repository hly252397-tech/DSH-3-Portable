import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { ALLOWED_BUILD_PACKAGES, officialRuntimeDependencies, officialRuntimePnpmConfig, pnpmWorkspaceYaml, STORE_PACKAGES } from '../src/bundled-plugins.js'
import { BUNDLED_LOCKFILE_NAME, applyPendingProfileUpdates, buildFrozenSeedInstallArgs, buildSeedPluginArgs, seedBundledPlugins } from '../src/plugin-seed.js'
import { DEFAULT_DESKTOP_RELEASE_SOURCE, sanitizeReleaseSource } from '../src/portable-desktop-update.js'
import { assertPnpmStorePackagesPreserved, cloneTreeForArchive, extractTarGz, materializeHardlinks, packDirectoryToTarGz, writeDirectoryContentSha256, writeFileSha256, writePnpmStoreContentSha256 } from '../src/runtime-archive.js'
import { copyExtractedTree } from '../src/extract-runtime.js'
import { pnpmStoreOptions, preparePnpmInvocation, resolvePnpmNodeEntry } from '../src/plugin-toolchain.js'
import { acquireBuildCacheLock, buildCacheDirectory, checkBuildArtifactCache, commitBuildArtifactCache, runtimeAssemblyArtifacts, runtimeAssemblyInput } from '../src/build-cache.js'

const projectRoot = resolve(import.meta.dirname, '..', '..')
const nodeRoot = join(projectRoot, 'runtime-node')
const pluginRoot = join(projectRoot, 'runtime-plugins')
const officialRuntimeRoot = join(projectRoot, 'runtime-dsh')
const bundledPnpmVersion = (JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { packageManager: string }).packageManager.split('@').at(-1)!

/** 待清理目录的回收区（与目标同卷，位于便携数据区，不会被 electron-builder 打进包）。
 *
 * 可用 `DSH_RECYCLE_ROOT` 覆盖：**测试必须**指向临时目录。
 * 2026-09-30 实测事故：本文件原先硬编码回收区，`test/prepare-runtime.test.ts` 里那条
 * 「回收路径必须走改名」用例调用真实 `removePreparedPath` 时，会在实机
 * `Data\Temp\prepare-recycle\` 里留下真桶、并 spawn 一个**脱离进程树**的真清理器。
 * 该清理器比测试进程活得久；一旦撞上被杀毒软件持句柄锁的 PE 文件，就进入
 * 「心跳在跳、桶永远删不掉」的自旋（见 RECYCLE_CLEANER 的 P2 缺陷），
 * 一直烧 G: 盘 I/O 直到人工介入 —— 测试污染了机器的真实状态。
 * 覆盖后测试只在自己的 tmpdir 里回收，清理器随 tmpdir 消失而自行退出。
 *
 * 惰性求值（函数而非模块级 const）：测试是在**模块已被 import 之后**才设这个环境变量的，
 * 若在模块加载时求值，测试设了也来不及生效。 */
function recycleRoot(): string {
  return process.env.DSH_RECYCLE_ROOT ?? join(projectRoot, 'Data', 'Temp', 'prepare-recycle')
}
function recycleHeartbeat(): string {
  return join(recycleRoot(), '.sweeping')
}

function within(root: string, path: string): boolean {
  const tail = relative(resolve(root), resolve(path))
  return tail === '' || tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail)
}

/** Only generated assembly outputs and named, isolated test directories may
 * be removed. Check physical ancestry before any rename or recursive API. */
function assertOwnedCleanupPath(target: string, recycle = false): string {
  const path = resolve(target), temporary = resolve(tmpdir()), portableTemp = join(projectRoot, 'Data', 'Temp')
  if ([projectRoot, homedir(), temporary, dirname(path)].some(root => relative(resolve(root), path) === '')) throw new Error('拒绝清理根目录、家园或临时根目录。')
  for (const protectedPath of ['App', 'Data/DSH', 'Data/DSH-generations', 'Data/Home', 'Data/Runtime', 'Data/Updates']) {
    if (within(join(projectRoot, protectedPath), path)) throw new Error('拒绝清理活动应用、数据家园或运行时槽。')
  }
  const generated = [nodeRoot, pluginRoot, officialRuntimeRoot, join(projectRoot, 'runtime-dsh.tgz')].some(root => within(root, path))
  const firstTemporarySegment = relative(temporary, path).split(sep)[0] ?? ''
  const temporaryRootIsBounded = within(portableTemp, temporary) || /^(?:_?temp|tmp|run-[a-z0-9]+)$/i.test(basename(temporary))
  const isolated = temporaryRootIsBounded && within(temporary, path) && /^dsh[-_]/i.test(firstTemporarySegment)
    && (!within(projectRoot, path) || within(portableTemp, path))
  const recycleDirectory = recycle && relative(join(portableTemp, 'prepare-recycle'), path) === ''
  if (recycle ? !isolated && !recycleDirectory : !generated && !isolated) throw new Error('拒绝清理非构建生成目录或隔离测试目录。')
  const anchor = generated || recycleDirectory ? projectRoot : temporary
  let existing = path
  while (!existsSync(existing)) {
    // lstat also catches a dangling link; existsSync alone would miss it.
    try { if (lstatSync(existing).isSymbolicLink()) throw new Error('拒绝清理目录链接。') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(existing)
    if (parent === existing) throw new Error('无法确认清理路径边界。')
    existing = parent
  }
  const info = lstatSync(existing)
  if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()
    || relative(resolve(realpathSync(anchor), relative(anchor, existing)), realpathSync(existing)) !== '') {
    throw new Error('拒绝清理非普通路径或经过目录链接的外部路径。')
  }
  return path
}

export function assertPreparedRemovalTarget(target: string): string {
  return assertOwnedCleanupPath(target)
}

/** Recheck the root itself, including every ancestor, after creation and again
 * before asynchronous workers mutate it. A prior check does not bless a later
 * junction replacement. Strict realpath equality intentionally rejects aliases. */
export function assertRecycleRootPhysical(target: string): string {
  const root = assertOwnedCleanupPath(target, true)
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink() || relative(root, realpathSync(root)) !== '') {
    throw new Error('回收根或祖先已变为目录链接，停止清理。')
  }
  return root
}

const RECYCLE_ROOT_GUARD = "const assertRoot=()=>{const s=fs.lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(path.resolve(root),fs.realpathSync(root))!=='')throw Error('unsafe recycle root or ancestor')};"
const RECYCLE_REMOVE_WORKER = [
  "const fs=require('fs'),path=require('path');const root=path.resolve(process.argv[1]);",
  RECYCLE_ROOT_GUARD,
  "assertRoot();const name=process.argv[2];if(!name||name!==path.basename(name)||name==='.'||name==='..')throw Error('invalid recycle leaf');",
  "const target=path.join(root,name),s=fs.lstatSync(target);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||path.relative(target,fs.realpathSync(target))!=='')throw Error('unsafe recycle target');",
  'assertRoot();fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:200})',
].join('')

/** 后台清理器：始终只保留一个待删目标，删完再取下一个，每 5 秒刷新心跳，
 * 连续 3 轮扫空后自行退出（约 15 秒）。
 * 清理器和删除子进程完整继承宿主环境；删除保护拒绝时保持保护并隔离失败桶，
 * 不切换 shell、不清空守卫环境，也不通过外部命令继续删除。
 * 每轮只删一个并刷新心跳，避免「一次删 28 分钟、心跳超时被判定为已死」。
 * —— 2026-09-29 卡死修复（两次复现：心跳在跳、两小时零删除）：构建的 pack 与
 * prepare-runtime 并行启动时会**竞态各 spawn 一个清理器**，双实例对同一桶并发 rmSync
 * 互踩（EBUSY/ENOENT 竞态）后子进程静默退出（stdio ignore、无 exit 监听），sweeper
 * 只能干等 pending 的 2 小时超时。三处修复：①启动时心跳抢占让位（后到实例自杀）；
 * ②rm 子进程退出立即换目标（不再等 2 小时）；③同一桶连续失败 3 次改名为
 * `<桶>.failed` 移出队列（人工可查、不再阻塞后续桶）。
 * —— 2026-09-30 **②与③自相矛盾、③从未生效**（P2 真正的根因）：上一版把 ② 写成
 * `c.on('exit',code=>{if(code!==0)pending=null})`，而 ③ 的计数放在一个 15 秒后的
 * setTimeout 里、判据是 `if(pending&&…)`。被第三方杀软持句柄锁的 PE 文件（如 node.exe）
 * 让 rmSync **瞬间**抛错退出 ⇒ exit 回调先把 pending 清空 ⇒ 15 秒后判假 ⇒
 * failCount 永远归不了 1 ⇒ 桶永远进不了 .failed ⇒ 每 5 秒重新 spawn 一次 rmSync
 * 去打同一个锁死的文件，**心跳永远新鲜、删除量恒为 0**。
 * 实测本场构建全程自旋（心跳 10:53→10:57 持续刷新），只能人工 kill。
 * 现改为：失败计数就在 exit 回调里按桶名累计，成功即清零，②③不再互相拆台。
 * 拒绝或失败保留诊断，不通过修改保护设置放行。 */
const RECYCLE_CLEANER = [
  "const fs=require('fs'),path=require('path'),{spawn}=require('child_process');",
  "if(!process.env.DSH_RECYCLE_ROOT)process.exit(1);const root=path.resolve(process.env.DSH_RECYCLE_ROOT);const beat=path.join(root,'.sweeping');",
  RECYCLE_ROOT_GUARD,
  'const requireRoot=()=>{try{assertRoot()}catch{process.exit(1)}};',
  `const RM=${JSON.stringify(RECYCLE_REMOVE_WORKER)};`,
  'let pending=null,pendingAt=0,idle=0,failName=\'\',failCount=0,started=false;const skipped=new Set();',
  'const tick=()=>{requireRoot();',
  // ① 实例抢占：首个 tick 先抢心跳；若已有活实例则后到者立即让位退出。
  'if(!started){started=true;',
  "  try{const prev=fs.readFileSync(beat,'utf8');const pid0=Number(prev.split(':')[0]);",
  "    if(Number.isInteger(pid0)&&pid0!==process.pid){try{process.kill(pid0,0);process.exit(0)}catch(e){if(e.code==='EPERM')process.exit(0)}}",
  '  }catch{}',
  "  requireRoot();try{fs.writeFileSync(beat,process.pid+':'+Date.now())}catch{}",
  '}',
  'let names=[];try{names=fs.readdirSync(root)}catch{process.exit(0)}',
  'names=names.filter(n=>n!==path.basename(beat));',
  // ④ 已隔离的桶必须真正移出队列。2026-09-30 实测：`.failed` 改名只把桶换个名字留在原地，
  // 而上面这行只过滤心跳文件，于是改完名的桶下一轮又被当成新目标捡起来、再失败三次、
  // 再追加一层 `.failed` —— 实测叠到第 9 层仍在原地打转。它还按名字排在真桶前面
  // （同前缀 + 更长的字典序未必，但真桶常被挤到后面），把 7.9 万文件的真桶彻底饿死，
  // 清理器每 5 秒空转一次 rmSync、心跳永远新鲜、删除量恒为 0。
  "names=names.filter(n=>!n.includes('.failed')&&!skipped.has(n)&&!fs.existsSync(path.join(root,n+'.failed.json')));",
  'if(pending&&(!names.includes(pending)||Date.now()-pendingAt>7200000)){pending=null;failName=\'\';failCount=0}',
  'if(pending){idle=0}',
  'else if(names.length>0){',
  'idle=0;pending=names[0];pendingAt=Date.now();',
  // ② 子进程退出即换目标 —— 无论成功还是失败都不再干等 2 小时。
  "try{requireRoot();const c=spawn(process.execPath,['-e',RM,root,pending],{stdio:'ignore',windowsHide:true,env:{...process.env}});",
  "c.on('error',()=>{const b=pending;pending=null;requireRoot();if(b){skipped.add(b);try{fs.writeFileSync(path.join(root,b+'.failed.json'),JSON.stringify({bucket:b,reason:'remove-process-failed'}))}catch{}}});",
  // ③ 失败计数必须记在**这里**（子进程退出即知），不能放在下面的 setTimeout 里。
  // 2026-09-30 P2 根因：原实现是 `c.on('exit',code=>{if(code!==0)pending=null})` 加一个
  // 15 秒后才检查的 setTimeout。被杀毒软件持句柄锁的 PE 文件让 rmSync **立刻**抛错退出，
  // exit 回调先把 pending 清空，15 秒后 setTimeout 里的 `if(pending&&…)` 判假 —— 计数永远
  // 归不了 1，桶也就永远进不了 .failed 隔离，于是每 5 秒重新 spawn 一次 rmSync 打同一个
  // 锁死的文件，心跳一直新鲜、删除量恒为 0（本次会话实测自旋了整场构建）。
  // 改为按桶名累计：同一个桶连续失败 3 次改名为 `<桶>.failed` 移出队列，
  // 既保留 ② 的「不等 2 小时」，也让 ③ 真正生效；成功一次即清零。
  "c.on('exit',code=>{const b=pending;pending=null;requireRoot();if(code===0){failName='';failCount=0;return}if(!b)return;",
  "if(b===failName){if(++failCount>=3){try{fs.renameSync(path.join(root,b),path.join(root,b+'.failed'))}catch{}skipped.add(b);try{fs.writeFileSync(path.join(root,b+'.failed.json'),JSON.stringify({bucket:b,reason:'remove-rejected-or-failed',at:new Date().toISOString()}))}catch{}failName='';failCount=0}}",
  "else{failName=b;failCount=1}});",
  "}catch{if(pending)skipped.add(pending);pending=null}",
  '}',
  'else if(++idle>=3){requireRoot();try{fs.unlinkSync(beat)}catch{}process.exit(0)}',
  "requireRoot();try{fs.writeFileSync(beat,process.pid+':'+Date.now())}catch{}",
  'setTimeout(tick,5000)};',
  'tick();',
].join('')

function recycleSweepAlive(): boolean {
  try {
    if (Date.now() - statSync(recycleHeartbeat()).mtimeMs > 120_000) return false
    const pid = Number(readFileSync(recycleHeartbeat(), 'utf8').split(':')[0])
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
  const root = assertOwnedCleanupPath(recycleRoot(), true)
  if (!existsSync(root)) return
  assertRecycleRootPhysical(root)
  if (recycleSweepAlive()) return
  try {
    const child = spawn(process.execPath, ['-e', RECYCLE_CLEANER], {
      detached: true,
      env: {
        ...process.env,
        DSH_RECYCLE_ROOT: root,
        DSH_RECYCLE_HEARTBEAT: recycleHeartbeat(),
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
  // 默认只回收项目内路径：项目外的测试临时目录、跨卷目标保持原有同步删除语义。
  // 但调用方**显式**指定 DSH_RECYCLE_ROOT 时（测试、诊断脚本）由它接管语义 ——
  // 否则测试把回收区指到 tmpdir(C:) 而目标在 G:，跨卷 rename 必失败、那条用例永远红。
  if (!process.env.DSH_RECYCLE_ROOT && !target.startsWith(projectRoot + sep)) return false
  const root = assertOwnedCleanupPath(recycleRoot(), true)
  const bucket = join(root, `${basename(target)}-${Date.now()}`)
  try {
    await mkdir(root, { recursive: true })
    assertRecycleRootPhysical(root)
    assertPreparedRemovalTarget(target)
    await rename(target, bucket)
  } catch {
    return false
  }
  console.log(`[prepare-runtime] ${basename(target)} 已移入回收区，删除转入后台（不阻塞构建）：${bucket}`)
  startRecycleSweeper()
  return true
}

export async function removePreparedPath(target: string): Promise<void> {
  target = assertPreparedRemovalTarget(target)
  if (!existsSync(target)) return
  if (await recyclePreparedPath(target)) return
  assertPreparedRemovalTarget(target)
  await rm(target, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 })
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

export function resolveBundledNodeSha256(checksums: unknown, platform = process.platform, architecture = process.arch): string {
  if (typeof checksums !== 'object' || checksums === null || Array.isArray(checksums)) {
    throw new Error('package.json 缺少随包 Node SHA256 配置。')
  }
  const target = `${platform}-${architecture}`
  const checksum = (checksums as Record<string, unknown>)[target]
  if (typeof checksum !== 'string') throw new Error(`缺少随包 Node SHA256：${target}。`)
  return checksum
}

/** Read-only preflight, shared by real assembly and CI/local --check-node. */
export async function verifyPrepareRuntimeNode(root = projectRoot, executable = process.execPath, version = process.version): Promise<{ executable: string, version: string, sha256: string }> {
  const projectManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    config?: { bundledNodeSha256?: unknown, bundledNodeVersion?: unknown }
  }
  const expectedNodeVersion = projectManifest.config?.bundledNodeVersion
  const expectedNodeSha256 = resolveBundledNodeSha256(projectManifest.config?.bundledNodeSha256)

  if (typeof expectedNodeVersion !== 'string') throw new Error('package.json 缺少随包 Node 版本配置。')
  if (version !== expectedNodeVersion) {
    throw new Error('随包 Node 版本不匹配：需要 ' + expectedNodeVersion + '，实际 ' + version + '。')
  }
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex').toUpperCase()
  if (sha256 !== expectedNodeSha256) throw new Error('随包 Node SHA256 不匹配：' + sha256 + '。')
  return { executable, version, sha256 }
}

async function main(): Promise<void> {
  // Both checks must finish before writing manifests or recycling any existing build.
  const verifiedNode = await verifyPrepareRuntimeNode()
  if (process.argv.includes('--check-node')) {
    console.log(JSON.stringify({ status: 'passed', ...verifiedNode, assemblyStarted: false }))
    return
  }
  const cacheDir = buildCacheDirectory(projectRoot)
  const release = await acquireBuildCacheLock(cacheDir, {
    onWait: () => console.log('[prepare-runtime] 另一进程正在装配，等待其完成。'),
  })
  const phases: { name: string; durationMs: number; succeeded: boolean }[] = []
  const timed = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const started = performance.now()
    let succeeded = false
    console.log(`[prepare-runtime] 开始：${name}`)
    try {
      const result = await action()
      succeeded = true
      return result
    } finally {
      const durationMs = Math.round(performance.now() - started)
      phases.push({ name, durationMs, succeeded })
      console.log(`[prepare-runtime] ${name}：${durationMs}ms${succeeded ? '' : '（失败）'}`)
    }
  }
  let cacheHit = false
  let completed = false
  try {
    await writeReleaseSourceManifest(join(projectRoot, 'dist'))
    const input = await timed('输入指纹', () => runtimeAssemblyInput(projectRoot, verifiedNode))
    const artifacts = runtimeAssemblyArtifacts()
    const record = join(cacheDir, 'runtime-assembly.json')
    const cached = process.env.DSH_BUILD_NO_CACHE === '1'
      ? { hit: false, reason: '显式要求重新装配' }
      : await timed('制品完整校验', () => checkBuildArtifactCache(projectRoot, record, input, artifacts))
    console.log(`[prepare-runtime] 缓存${cached.hit ? '命中' : '未命中'}：${cached.reason}`)
    cacheHit = cached.hit
    if (cacheHit) { completed = true; return }
    await timed('运行时与插件装配', () => assembleRuntime(verifiedNode, timed))
    if (await runtimeAssemblyInput(projectRoot, verifiedNode) !== input) {
      throw new Error('构建期间装配输入发生变化，禁止提交缓存；请待其他修改完成后重试。')
    }
    await timed('提交制品缓存', () => commitBuildArtifactCache(projectRoot, record, input, artifacts))
    completed = true
  } finally {
    try {
      await writeFile(join(cacheDir, 'runtime-assembly-metrics.json'), JSON.stringify({
        schema: 1, completedAt: new Date().toISOString(), completed, cacheHit, phases,
      }, undefined, 2) + '\n', 'utf8')
    } finally {
      await release()
    }
  }
}

async function assembleRuntime(
  verifiedNode: { executable: string; sha256: string },
  timed: <T>(name: string, action: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const officialArchive = join(projectRoot, 'runtime-dsh.tgz')
  for (const target of [nodeRoot, pluginRoot, officialRuntimeRoot, officialArchive]) {
    if (!target.startsWith(projectRoot + sep)) throw new Error(`拒绝清理项目外路径：${target}`)
    await removePreparedPath(target)
  }

  const nodeExecutable = verifiedNode.executable
  const nodeSha256 = verifiedNode.sha256
  await mkdir(nodeRoot, { recursive: true })
  const stagedNodeExecutable = join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  await cp(nodeExecutable, stagedNodeExecutable)
  await writeFile(`${stagedNodeExecutable}.sha256`, nodeSha256 + '\n', 'utf8')
  await timed('Node/pnpm 装配', () => stagePnpm(nodeRoot))
  // @ts-ignore .mjs 代理脚本未配声明文件，动态导入仅用于构建期本地加速。
  const { startStagingRegistryProxy } = await import(pathToFileURL(join(projectRoot, 'scripts', 'staging-registry-proxy.mjs')).href)
  const prefetchDir = join(projectRoot, 'Data', 'Temp', 'prefetch')
  const upstreamRegistry = process.env.DSH_UPSTREAM_REGISTRY || 'https://registry.npmjs.org/'
  const proxy = await startStagingRegistryProxy({ prefetchDir, upstream: upstreamRegistry, port: 0 })
  try {
    await timed('插件装配与离线验证', () => stageBundledPlugins(pluginRoot, nodeRoot, undefined, proxy.url))
  } finally {
    await proxy.close()
  }
  const officialStore = join(officialRuntimeRoot, '.store')
  await timed('官方运行时安装', () => stageOfficialRuntime(officialRuntimeRoot, nodeRoot, officialStore))
  await removePreparedPath(officialStore)
  await timed('运行时硬链接落盘', async () => {
    await materializeHardlinks(join(pluginRoot, 'store'))
    await materializeHardlinks(officialRuntimeRoot)
  })
  const storeDir = join(pluginRoot, 'store')
  const snapshotDir = join(pluginRoot, 'store-snapshot')
  const archivePath = join(pluginRoot, 'store.tgz')
  await timed('插件归档快照', () => cloneTreeForArchive(storeDir, snapshotDir))
  try {
    await timed('插件归档与真实解压验证', async () => {
      packDirectoryToTarGz(snapshotDir, archivePath)
      await verifyPackagedPluginArchive(pluginRoot, nodeRoot, snapshotDir, archivePath)
    })
  } finally {
    await removePreparedPath(snapshotDir)
  }
  await timed('官方运行时归档', async () => { packDirectoryToTarGz(officialRuntimeRoot, join(projectRoot, 'runtime-dsh.tgz')) })
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
  const packageRoot = await materializePnpmPackage(resolve(destinationRoot))
  const entry = resolvePnpmEntry(packageRoot)
  // Resolve/download the native payload during packaging, never on the user's first offline launch.
  const prepared = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 180000, cwd: packageRoot })
  if (prepared.status !== 0 || prepared.stdout.trim() !== bundledPnpmVersion) {
    throw new Error(`随包 pnpm 未就绪：${prepared.error?.message ?? prepared.stderr}`)
  }
  const offline = spawnSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, cwd: packageRoot, env: { ...process.env, COREPACK_ENABLE_NETWORK: '0' },
  })
  if (offline.status !== 0 || offline.stdout.trim() !== bundledPnpmVersion) throw new Error('随包 pnpm 离线入口验证失败。')
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
const DEFAULT_STAGING_REGISTRY = 'https://registry.npmjs.org/'

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
  // Metadata and lockfile must retain the official published tarball URLs.
  // The metadata proxy no longer redirects tarballs to transient local ports.
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
    // 上游 v1.0.76 的随包仓库完整性校验要求 store 自带 cache 子目录；冻结离线安装
    //（buildFrozenSeedInstallArgs）的默认 cache-dir 同为 <store>/cache，两处必须一致。
    ...pnpmStoreOptions(storeDir).map(arg => arg.startsWith('--cache-dir=') ? `--cache-dir=${join(storeDir, 'cache')}` : arg),
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.minimumReleaseAge=0',
    `--registry=${stagingRegistry}`,
  ]
  await run(installArgs)
  await assertPortablePluginLockfile(join(stagingDir, 'pnpm-lock.yaml'))
  for (const plugin of stagedPackages) {
    if (!existsSync(join(stagingDir, 'node_modules', ...plugin.packageName.split('/'), 'package.json'))) {
      throw new Error(`内置插件装配后缺失：${plugin.packageName}`)
    }
  }
  // 上游 v1.0.76：锁文件以 BUNDLED_LOCKFILE_NAME 发布（首启 applyBundledLockfile 按它冻结安装），
  // 并补全 metadata-full、校验随包元数据完整性（缺失即阻止出包）。
  await publishBundledLockfile(stagingDir, storeDir)
  await pruneStoreForPackaging(storeDir)
  await completeBundledPluginMetadata(storeDir)
  await assertBundledPluginMetadataComplete(storeDir)
  // Resolution caches abbreviated packuments; frozen policy validation also
  // requires full packuments. Materialize both during the online build, not startup.
  await discardCachedPolicyVerdict(storeDir)
  await run([...installArgs, '--frozen-lockfile'])
  // 离线验证与运行时补种都按 registry.npmjs.org 查找元数据，把镜像缓存同步成 npmjs 路径。
  await mirrorPnpmStoreMetadata(storeDir, stagingRegistry)
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
  const installOptions = { storeDir, cacheDir: join(storeDir, 'cache'), offline: true }
  await assertPortablePluginLockfile(join(verificationDir, 'pnpm-lock.yaml'))
  // Existing installations contain local customizations, unlike an empty
  // Profile. Exercise an actual junction through both pnpm installations.
  const localName = 'dsh-desktop-offline-link-probe'
  const localDir = join(verificationDir, 'local', localName)
  await mkdir(localDir, { recursive: true })
  await writeFile(join(localDir, 'package.json'), JSON.stringify({ name: localName, version: '0.0.0', private: true }))
  const manifestPath = join(verificationDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies[localName] = `link:local/${localName}`
  await writeFile(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  const localLink = join(verificationDir, 'node_modules', localName)
  await symlink(localDir, localLink, process.platform === 'win32' ? 'junction' : 'dir')
  // First launch alone missed a production failure. Force a real incremental
  // add and then a fresh-policy frozen reinstall using the resulting lockfile.
  await discardCachedPolicyVerdict(storeDir)
  await run(buildSeedPluginArgs([STORE_PACKAGES[0]!], verificationDir, installOptions))
  await assertPortablePluginLockfile(join(verificationDir, 'pnpm-lock.yaml'))
  await discardCachedPolicyVerdict(storeDir)
  await run(buildFrozenSeedInstallArgs(verificationDir, installOptions))
  if (await realpath(localLink) !== await realpath(localDir)) throw new Error('离线安装改变了本地定制插件链接。')
  await applyPendingProfileUpdates({
    nodeExecutable: join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node'),
    profileDir: verificationDir, pluginStoreDir: storeDir,
    runner: async () => { throw new Error('已安装的验证 Profile 不应在再次启动时重装。') },
  })
}

/** Fail before publication, never rewrite URLs or integrity to waive policy. */
export async function assertPortablePluginLockfile(path: string): Promise<void> {
  const lock = parseYaml(await readFile(path, 'utf8')) as { packages?: Record<string, { resolution?: { tarball?: string } }> }
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.resolution?.tarball === undefined) continue
    const url = new URL(entry.resolution.tarball)
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) {
      throw new Error(`内置插件锁文件含不可发布的下载来源：${name}；请使用官方 metadata 重新装配。`)
    }
  }
}

/** 把装配时解析好的锁文件放进仓库，首启按它冻结安装，避免范围再解析到未下载的压缩包。 */
export async function publishBundledLockfile(stagingDir: string, storeDir: string): Promise<void> {
  const source = join(stagingDir, 'pnpm-lock.yaml')
  if (!existsSync(source)) throw new Error('内置插件装配没有生成锁文件。')
  await copyFile(source, join(storeDir, BUNDLED_LOCKFILE_NAME))
}

/** 打包前用空 Profile 和随包锁文件离线安装，缺少任何依赖即阻止生成安装包。 */
export async function verifyBundledPluginStore(destinationRoot: string, nodeRoot: string,
  run: (args: readonly string[]) => void | Promise<void> = args => runStagedPnpm(nodeRoot, args),
  storeDir = join(destinationRoot, 'store')): Promise<void> {
  const profile = await mkdtemp(join(destinationRoot, 'verify-offline-'))
  const lockSource = join(storeDir, BUNDLED_LOCKFILE_NAME)
  try {
    if (!existsSync(lockSource)) throw new Error('随包仓库缺少锁定的依赖树。')
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      private: true,
      dependencies: Object.fromEntries(STORE_PACKAGES.map(plugin => [plugin.packageName, plugin.version])),
    }, undefined, 2) + '\n', 'utf8')
    await writeFile(join(profile, 'pnpm-workspace.yaml'), pnpmWorkspaceYaml(false), 'utf8')
    await copyFile(lockSource, join(profile, 'pnpm-lock.yaml'))
    // 本地 runStagedPnpm 是异步 spawn（上游为 spawnSync）：必须 await，否则 pnpm 还在安装
    // 而调用方的 finally 已把临时 Profile 删掉，得到 ENOENT 与"随包 pnpm 执行失败"。
    await run([
      'install', `--dir=${profile}`, '--frozen-lockfile',
      '--store-dir', storeDir, '--cache-dir', join(storeDir, 'cache'), '--offline',
      '--config.node-linker=hoisted', '--config.auto-install-peers=false', '--config.minimumReleaseAge=0',
      '--registry=https://registry.npmjs.org/',
    ])
    for (const plugin of STORE_PACKAGES) {
      const manifest = JSON.parse(await readFile(join(profile, 'node_modules', plugin.packageName, 'package.json'), 'utf8'))
      if (manifest.version !== plugin.version) throw new Error(`随包离线校验版本不匹配：${plugin.packageName}`)
    }
  } finally {
    assertPreparedRemovalTarget(profile)
    await rm(profile, { recursive: true, force: true })
  }
}

/** 用安装时的解压复制检查压缩包，不能只检查还没打包的目录。 */
export async function verifyPackagedPluginArchive(destinationRoot: string, nodeRoot: string, sourceStore: string, archivePath: string,
  run?: (args: readonly string[]) => void): Promise<void> {
  const root = await mkdtemp(join(destinationRoot, 'verify-archive-'))
  const staging = join(root, 'staging')
  const copied = join(root, 'store')
  try {
    extractTarGz(archivePath, staging)
    copyExtractedTree(staging, copied)
    assertPreparedRemovalTarget(staging)
    await rm(staging, { recursive: true, force: true })
    assertPnpmStorePackagesPreserved(sourceStore, copied)
    await verifyBundledPluginStore(root, nodeRoot, run, copied)
  } finally {
    assertPreparedRemovalTarget(root)
    await rm(root, { recursive: true, force: true })
  }
}

/** 只保证 metadata-full 路径存在：把缺失的文件从缩写 metadata 拷过去，不改已有文件，也不补 time 等完整字段。App 侧 seed 必须保持 minimumReleaseAge=0。 */
export async function completeBundledPluginMetadata(storeDir: string): Promise<void> {
  const metadataRoot = join(storeDir, 'cache', 'v11', 'metadata')
  if (!existsSync(metadataRoot)) return
  for (const relative of await listMetadataJsonl(metadataRoot)) {
    const from = join(metadataRoot, relative)
    const to = join(storeDir, 'cache', 'v11', 'metadata-full', relative)
    if (existsSync(to)) continue
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, await readFile(from))
  }
}

export async function assertBundledPluginMetadataComplete(storeDir: string): Promise<void> {
  const metadataRoot = join(storeDir, 'cache', 'v11', 'metadata')
  if (!existsSync(metadataRoot)) return
  const missing = (await listMetadataJsonl(metadataRoot))
    .filter(relative => !existsSync(join(storeDir, 'cache', 'v11', 'metadata-full', relative)))
  if (missing.length === 0) return
  const preview = missing.slice(0, 5).join('、')
  throw new Error(`随包仓库缺少离线升级所需的完整元数据：${preview}${missing.length > 5 ? ` 等 ${missing.length} 项` : ''}`)
}

async function listMetadataJsonl(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await listMetadataJsonl(join(root, entry.name), relative))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(relative)
  }
  return files
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

export async function discardCachedPolicyVerdict(storeDir: string): Promise<void> {
  // Ship the policy inputs, not a time-limited successful verdict from the build PC.
  for (const base of [storeDir, join(storeDir, 'cache')]) {
    await unlink(join(base, 'lockfile-verified.jsonl')).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

/** Our staging proxy exposes a root public registry. Reject path/credential variants
 * rather than guessing pnpm's private-cache or path hashing conventions. */
export function pnpmStagingRegistryKey(registry: string): string {
  const url = new URL(registry)
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/'
    || url.username || url.password || url.search || url.hash
    || !/^[a-z0-9.-]+$/i.test(url.hostname) || url.hostname.endsWith('.')) {
    throw new Error('装配源必须是无凭据、无子路径的 HTTP(S) registry。')
  }
  return `${url.protocol.slice(0, -1)}%3A+${url.hostname}${url.port ? `+${url.port}` : ''}`
}

export async function mirrorPnpmStoreMetadata(storeDir: string, stagingRegistry: string): Promise<void> {
  const sourceKey = pnpmStagingRegistryKey(stagingRegistry)
  const targetKey = pnpmStagingRegistryKey('https://registry.npmjs.org/')
  if (sourceKey === targetKey) return
  for (const dir of ['metadata', 'metadata-full']) {
    const base = join(storeDir, 'cache', 'v11', dir)
    const source = join(base, sourceKey)
    if (!existsSync(source)) throw new Error(`装配源缺少 ${dir} 缓存，拒绝构建离线仓库。`)
    const target = join(base, targetKey)
    // Frozen validation may already have fetched additional official metadata
    // (including peers absent from the proxy namespace). Preserve those entries
    // and prefer existing official bytes; only fill gaps from the explicit proxy.
    // Never merge unrelated/private registries or rewrite metadata/integrity.
    await cp(source, target, { recursive: true, dereference: false, force: false })
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
  return resolvePnpmNodeEntry(packageRoot)
}

function runStagedPnpm(nodeRoot: string, args: readonly string[]): Promise<void> {
  const nodeExecutable = join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  const invocation = preparePnpmInvocation(args)
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [resolvePnpmEntry(join(nodeRoot, 'pnpm-package')), ...invocation.args], { env: invocation.env, stdio: 'inherit', windowsHide: true })
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
  const pnpmEntry = resolvePnpmEntry(resolvePnpmPackageRoot())
  const invocation = preparePnpmInvocation(args)
  const result = spawnSync(process.execPath, [pnpmEntry, ...invocation.args], { env: invocation.env, encoding: 'utf8', windowsHide: true })
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


