// test/helpers/tmp.ts —— 让测试创建的临时目录在测试结束后自动清理。
//
// 为什么需要：2026-09-13 实测 29 个使用 mkdtemp 的测试文件中仅 2 个含清理，每跑一轮全量测试
// 残留约 270 个目录，累积到 Data\Temp 1.58 GB / 40,782 文件。本助手把「创建即登记、文件结束即清理」
// 变成默认行为，避免再靠每个测试作者记得写 rmSync。
//
// 用法（保持与原 mkdtemp 调用点兼容）：
//   import { makeTrackedTempDir as mkdtemp } from './helpers/tmp.js'
//   const root = await mkdtemp(join(tmpdir(), 'dsh-my-test-'))
// 需要保留现场排查时：设置环境变量 DSH_TEST_KEEP_TMP=1 再跑测试，目录路径会打印出来。
import { mkdtemp, mkdtempSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { after } from 'node:test'

const tracked: string[] = []

// Windows 删除目录会在两类情况下抛 EBUSY：刚被 taskkill 掉的子进程尚未释放句柄、以及杀毒/索引
// 扫描刚写入的文件。Node 的 rm/rmSync 自带 maxRetries+retryDelay 就是为这种瞬时占用准备的，
// 默认 0 次重试会在并发跑全套测试时偶发失败（2026-09-13 实证：启动补种 pnpm 超时用例）。
const RETRY_OPTIONS = { maxRetries: 10, retryDelay: 50 } as const

/** 本次测试文件已登记的临时目录（供测试自身断言用）。 */
export function trackedTempDirs(): readonly string[] {
  return tracked
}

/** 与 node:fs/promises 的 mkdtemp 同签名，额外登记以便测试结束后清理。 */
export async function makeTrackedTempDir(template: string): Promise<string> {
  const dir = await new Promise<string>((resolve, reject) => {
    mkdtemp(template, (error, created) => (error === null ? resolve(created) : reject(error)))
  })
  tracked.push(dir)
  return dir
}

/** 同步版本；语义与 mkdtempSync 一致（入参为完整路径模板）。 */
export function makeTrackedTempDirSync(template: string): string {
  const dir = mkdtempSync(template)
  tracked.push(dir)
  return dir
}

/**
 * 删除临时目录，对 Windows 的瞬时占用（EBUSY/EPERM）做多层重试。
 *
 * 为什么不用裸 `rm(dir, { recursive: true, force: true })`：测试里创建目录后常紧接着终止子进程
 * （如 pnpm 超时用例），Windows 释放被终止进程的目录句柄是异步的，紧跟其后的删除会偶发 EBUSY
 * 并让本来通过的用例变红。内层复用 Node 自带重试，外层再兜 5 轮，覆盖杀毒扫描这类更长的占用。
 *
 * 清理是尽力而为：返回是否删除成功，绝不抛错——不能把清理失败变成测试失败。
 */
export async function removeTempDir(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, ...RETRY_OPTIONS })
      return true
    } catch {
      await new Promise<void>(resolve => { setTimeout(resolve, 100) })
    }
  }
  return false
}

// 模块级 after：无论测试是否失败，文件结束时都会执行。
after(() => {
  if (process.env.DSH_TEST_KEEP_TMP === '1') {
    if (tracked.length > 0) console.log(`[test-tmp] DSH_TEST_KEEP_TMP=1，保留 ${tracked.length} 个目录：${tracked.join(', ')}`)
    return
  }
  for (const dir of tracked) {
    try {
      // 同一进程内的第二次机会：用例自己 finally 删不掉时（占用期未过），这里通常已能删除。
      rmSync(dir, { recursive: true, force: true, ...RETRY_OPTIONS })
    } catch {
      // 被占用等失败不抛出：清理是尽力而为，不能把测试结果变成失败。
    }
  }
  tracked.length = 0
})
