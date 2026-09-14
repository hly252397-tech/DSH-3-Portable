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
// 用法：
//   ./App/resources/node/node.exe scripts/run-tests.mjs              # 全量
//   ./App/resources/node/node.exe scripts/run-tests.mjs dist/test/foo.test.js   # 指定文件
//   DSH_TEST_KEEP_TMP=1 ... scripts/run-tests.mjs                    # 强制保留临时目录
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

const baseTemp = process.env.TEMP ?? process.env.TMP ?? tmpdir()
const runsRoot = join(baseTemp, 'dsh-test-runs')

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

function collectDefaultTargets() {
  return readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join(testDir, name))
}

const pruned = pruneStaleRuns(Date.now())
mkdirSync(runsRoot, { recursive: true })
const runDir = mkdtempSync(join(runsRoot, 'run-'))
const targets = passthrough.length > 0 ? passthrough : collectDefaultTargets()

console.log(`[test-run] 本次运行临时目录：${runDir}${pruned > 0 ? `（另清理 ${pruned} 个过期运行目录）` : ''}`)
console.log(`[test-run] 测试文件 ${targets.length} 个；子进程 TEMP/TMP/TMPDIR 均指向本次运行目录。`)

const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...targets], {
  stdio: 'inherit',
  env: { ...process.env, TEMP: runDir, TMP: runDir, TMPDIR: runDir },
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

process.exit(status)
