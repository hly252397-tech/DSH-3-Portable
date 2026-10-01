// 测试运行器 —— 让「跑测试」不再往 Data\Temp 里堆垃圾。
//
// 为什么需要：2026-09-13 实测 29 个使用 mkdtemp 的测试文件中仅 2 个含清理（其余靠 tmpdir()），
// 每跑一轮全量测试残留约 270 个目录，累积到 Data\Temp 1.58 GB / 40,782 文件。
// 逐个改测试文件既不彻底（新测试还会忘），也会和其他会话的改动冲突；本运行器改为「一次收口」：
//
//   1. 每次运行创建独立目录 <TEMP>\dsh-test-runs\run-XXXX，并把子进程的 TEMP/TMP/TMPDIR 全指向它，
//      因此所有测试（含它们 spawn 的子进程）产生的临时文件都落在这一次运行的目录里；
//   2. 退出码 0（全绿）时整目录删除；失败时保留并打印路径，方便排查现场；
//   3. 每次启动顺手清理超过 24 小时的旧运行目录（防止强杀/断电留下永久垃圾）。
//
// 用法（测试子进程由 GATE_NODE spawn，所以用哪个 Node 启动本脚本都不影响结果有效性；
// 但为免"启动器版本"与"实际跑测试的版本"两个口径混淆，仍推荐经转发器）：
//   ./Tools/node/node.exe scripts/gate-node-run.mjs scripts/run-tests.mjs              # 全量
//   ./Tools/node/node.exe scripts/gate-node-run.mjs scripts/run-tests.mjs dist/test/foo.test.js   # 指定文件
//   DSH_TEST_KEEP_TMP=1 ... scripts/run-tests.mjs                    # 强制保留临时目录
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GATE_NODE } from './lib/gate-node.mjs'
import { assertFreshTestBuild } from './lib/test-build-freshness.mjs'

const KEEP_FLAG = '--keep'
const STALE_MS = 24 * 60 * 60 * 1000
// Windows 上刚被终止的子进程会短暂占用其工作目录，杀毒/索引也会扫描刚写入的文件，裸删除会偶发
// EBUSY。回收运行目录时统一带重试（2026-09-13 实证：并发跑全套时单例 EBUSY 让门禁变红）。
const RM_RETRY = { maxRetries: 10, retryDelay: 50 }
const root = process.cwd()
const testDir = resolve(root, 'dist', 'test')
const keep = process.argv.includes(KEEP_FLAG) || process.env.DSH_TEST_KEEP_TMP === '1'
const passthrough = process.argv.slice(2).filter((arg) => arg !== KEEP_FLAG)

if (!existsSync(testDir)) {
  console.error(`[test-run] 找不到 ${testDir}，请先运行 tsc 编译测试。`)
  process.exit(1)
}
assertFreshTestBuild(root)

const baseTemp = process.env.TEMP ?? process.env.TMP ?? tmpdir()
const runsRoot = join(baseTemp, 'dsh-test-runs')

// ── 跨进程互斥 ────────────────────────────────────────────────────────────────
// 为什么需要（2026-09-26 实测，登记册 R-172）：
//   两个 run-tests.mjs 同时在跑时，双方都在写同一个共享 runsRoot，且子进程的
//   TEMP/TMP/TMPDIR 收口目录一旦被复用/交错清理，就会出现
//     EPERM: operation not permitted, rename '<runsRoot>\run-XXXX\.xxx.tmp'
//     EEXIST: file already exists, copyfile '<runsRoot>\...'
//   这类**伪失败**：隔离跑全绿、并发跑变红。实测一次并发全量出现 14 个失败
//   （含 8 条与本次改动无关的用例），静默后重跑即恢复。
//   修法不是改用例（每个会话都有各自的临时用法），而是让"跑测试"这件事**串行**。
const LOCK_WAIT_MS = Number(process.env.DSH_TEST_LOCK_WAIT_MS ?? 5 * 60 * 1000)
const LOCK_STALE_MS = Number(process.env.DSH_TEST_LOCK_STALE_MS ?? 2 * 60 * 1000)
if (![LOCK_WAIT_MS, LOCK_STALE_MS].every(value => Number.isSafeInteger(value) && value > 0)) {
  throw new Error('DSH_TEST_LOCK_WAIT_MS and DSH_TEST_LOCK_STALE_MS must be positive integer milliseconds')
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function lockHolderDescription(lockPath) {
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf8'))
    return `pid ${info.pid}（${info.startedAt ?? '未知开始时间'}）`
  } catch {
    return '未知持有者'
  }
}

/** 等待窗口的可读写法：不足 1 秒时保留毫秒，否则取整到秒（100ms 原本会被显示成误导性的「0s」）。 */
function formatLockWait(ms) {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

/** 判定锁是否可回收：**持有者进程已死**（首选，立刻回收），或锁文件超龄（兜底，防 pid 不可判）。 */
function removeStaleLock(lockPath, now) {
  let pid = null
  try {
    pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid
  } catch {
    // 锁文件内容损坏：落到下面的超龄兜底。
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    let alive = true
    try {
      process.kill(pid, 0) // 只探测存在性，不真正发信号
    } catch (error) {
      alive = error?.code === 'EPERM' // EPERM=存在但无权限；其余（ESRCH）=已死
    }
    if (!alive) {
      try {
        unlinkSync(lockPath)
        console.log(`[test-run] 上一个测试进程（pid ${pid}）已退出但未释放锁，已接管。`)
        return true
      } catch {
        return false
      }
    }
    return false // 持有者活着：继续等
  }
  try {
    if (now - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
      unlinkSync(lockPath)
      console.log('[test-run] 发现超龄且无法判定持有者的测试锁，已接管。')
      return true
    }
  } catch {
    // 锁文件刚消失：下一轮重试即可。
  }
  return false
}

/** 返回锁文件路径；拿到锁后必须用 releaseLock 释放。 */
function acquireLock(lockPath) {
  if (process.env.DSH_TEST_NO_LOCK === '1') return null
  const deadline = Date.now() + LOCK_WAIT_MS
  let announced = false
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx') // 原子创建：已存在即 EEXIST
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: root }))
      } finally {
        closeSync(fd)
      }
      return lockPath
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (removeStaleLock(lockPath, Date.now())) continue
      if (Date.now() >= deadline) {
        console.error(
          `[test-run] 等待测试锁超时（${formatLockWait(LOCK_WAIT_MS)}）。持有者：${lockHolderDescription(lockPath)}。`
          + `\n[test-run] 若确认对方已死，删除 ${lockPath} 即可；也可用 DSH_TEST_LOCK_WAIT_MS 调整等待，或 DSH_TEST_NO_LOCK=1 跳过互斥。`,
        )
        process.exit(1)
      }
      if (!announced) {
        console.log(`[test-run] 另一个测试进程正在运行（${lockHolderDescription(lockPath)}）——本次将等待它结束以避免并发伪失败。`)
        announced = true
      }
      sleepSync(1000)
    }
  }
}

function releaseLock(lockPath) {
  if (!lockPath) return
  try {
    unlinkSync(lockPath)
  } catch {
    // 已被清理：忽略。
  }
}

/** 清理超过 STALE_MS 的旧运行目录（被强杀留下的那部分）。 */
function pruneStaleRuns(now) {
  let removed = 0
  if (!existsSync(runsRoot)) return removed
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(runsRoot, entry.name)
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) {
        rmSync(path, { recursive: true, force: true, ...RM_RETRY })
        removed += 1
      }
    } catch {
      // 清理失败不影响本次运行。
    }
  }
  return removed
}

function collectDefaultTargets() {  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.test.js')) found.push(path)
    }
  }
  walk(testDir)
  // 子目录里的测试过去被 readdirSync 的非递归收集漏掉（假绿），递归后保持稳定排序。
  return found.sort()
}

// 不在 dist/test 下、递归也收不到的门禁目标：必须显式追加，否则它一条门禁都没有。
const extraFullRunTargets = ['scripts/portable-health/health.test.cjs']

mkdirSync(runsRoot, { recursive: true })
const lockPath = join(runsRoot, 'run-tests.lock')
const heldLock = acquireLock(lockPath)
process.on('exit', () => releaseLock(heldLock))
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    releaseLock(heldLock)
    process.exit(130)
  })
}

const pruned = pruneStaleRuns(Date.now())
const runDir = mkdtempSync(join(runsRoot, 'run-'))
const targets = passthrough.length > 0 ? [...passthrough] : collectDefaultTargets()
if (passthrough.length === 0) {
  for (const relative of extraFullRunTargets) {
    const path = resolve(root, relative)
    if (!existsSync(path)) {
      console.error(`[test-run] 附加门禁目标缺失：${relative}`)
      process.exit(1)
    }
    targets.push(path)
  }
}
if (targets.length === 0) {
  console.error(`[test-run] 在 ${testDir} 下未收集到任何测试文件——0 个测试不得算通过。`)
  process.exit(1)
}

console.log(`[test-run] 本次运行临时目录：${runDir}${pruned > 0 ? `（另清理 ${pruned} 个过期运行目录）` : ''}`)
console.log(`[test-run] 测试文件 ${targets.length} 个；子进程 TEMP/TMP/TMPDIR 均指向本次运行目录。`)
if (passthrough.length === 0) {
  console.log(`[test-run] 附加目标：${extraFullRunTargets.join(', ')}（不在 dist/test 下，递归收集覆盖不到，显式纳入门禁）`)
}

// Waiting for another process may have allowed sources to change; recheck under the lock.
assertFreshTestBuild(root)
const result = spawnSync(GATE_NODE, ['--test', '--test-reporter=tap', ...targets], {
  stdio: 'inherit',
  // DSH_RECYCLE_ROOT 同样收口到本次运行目录：prepare-runtime 的回收桶默认落在
  // <项目>/Data/Temp/prepare-recycle，而 runDir 就在 <项目>/Data/Temp/dsh-test-runs 下
  // —— 也就落在 projectRoot 内、照样能通过「只回收项目内路径」的守卫，于是测试会在
  // 实机回收区里留下真桶、并 spawn 一个脱离进程树的真清理器（它比测试进程活得久）。
  // 指到 runDir 后，测试期回收的全部产物随 runDir 一起在成功后被删掉。
  env: { ...process.env, TEMP: runDir, TMP: runDir, TMPDIR: runDir, DSH_RECYCLE_ROOT: runDir },
})

const status = result.status ?? 1
if (status === 0 && !keep) {
  try {
    rmSync(runDir, { recursive: true, force: true, ...RM_RETRY })
    console.log('[test-run] 全绿，已清理本次运行临时目录。')
  } catch (error) {
    console.log(`[test-run] 清理临时目录失败（不影响结果）：${error instanceof Error ? error.message : String(error)}`)
  }
} else {
  console.log(`[test-run] 未清理临时目录（${status === 0 ? 'DSH_TEST_KEEP_TMP/--keep' : '存在失败'}）：${runDir}`)
}

releaseLock(heldLock)
process.exit(status)
