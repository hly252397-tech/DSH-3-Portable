import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

function temporaryPath(path: string, suffix = '.tmp'): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}${suffix}`)
}

function isTransientRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
}

const RENAME_DELAYS = [25, 50, 100, 200, 400] as const

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const delay = RENAME_DELAYS[attempt]
      if (delay === undefined || !isTransientRenameError(error)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
}

function renameWithRetrySync(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      const delay = RENAME_DELAYS[attempt]
      if (delay === undefined || !isTransientRenameError(error)) throw error
      sleepSync(delay)
    }
  }
}

/** 同步睡眠：Atomics.wait 阻塞不烧 CPU；环境不支持时退回极短自旋。 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* 退路 */
    }
  }
}

/**
 * 原子写（异步）。
 *
 * 历史缺陷：旧实现 `finally { rm(tmp) }` **无条件**删掉临时文件；而 rename 失败时
 * （Windows 覆盖语义下目标状态不确定）临时文件是新内容的唯一副本 ⇒ 新旧内容可能一起消失。
 * 现在：改名失败**保留**临时文件并把它的位置写进错误；只有改名成功才清理。
 */
export async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  const temporary = temporaryPath(path)
  await writeFile(temporary, content, 'utf8')
  try {
    await renameWithRetry(temporary, path)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`原子写改名失败；新内容保留在临时文件 ${temporary}（目标 ${path}）：${detail}`, { cause: error })
  }
  await rm(temporary, { force: true }).catch(() => undefined)
}

/**
 * 原子写（同步）。与异步版同一策略，另加"先写旧内容恢复副本"：
 * 改名失败时新内容留在临时文件、旧内容留在恢复副本，**至少一份完整内容可恢复**。
 */
export function writeTextFileAtomicSync(path: string, content: string): void {
  const temporary = temporaryPath(path)
  const recovery = temporaryPath(path, '.recover')
  let hasRecovery = false
  if (existsSync(path)) {
    try {
      copyFileSync(path, recovery)
      hasRecovery = true
    } catch {
      hasRecovery = false
    }
  }
  writeFileSync(temporary, content, 'utf8')
  try {
    // 2026-09-21：原先直接 renameSync —— Windows 上杀软/索引器短暂持有目标即 EPERM，
    // 表现为间歇性写失败（browser-extension-state 用例隔离连跑 3 过 1 挂即为实证）。
    // 调用方是 modules 状态 / 插件 manifest / 运行时指针这些要害写入，必须走重试。
    renameWithRetrySync(temporary, path)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`原子写改名失败；新内容保留在 ${temporary}${hasRecovery ? `，旧内容保留在 ${recovery}` : ''}（目标 ${path}）：${detail}`, { cause: error })
  }
  rmSync(temporary, { force: true })
  if (hasRecovery) rmSync(recovery, { force: true })
}
