import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

function temporaryPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
}

function isTransientRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const delays = [25, 50, 100, 200, 400]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const delay = delays[attempt]
      if (delay === undefined || !isTransientRenameError(error)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
}

export async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  const temporary = temporaryPath(path)
  try {
    await writeFile(temporary, content, 'utf8')
    await renameWithRetry(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
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

/** 同步版重试 rename：与上面的异步 renameWithRetry **同一策略**（2026-09-21 补齐）。 */
function renameWithRetrySync(source: string, destination: string): void {
  const delays = [25, 50, 100, 200, 400]
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      const delay = delays[attempt]
      if (delay === undefined || !isTransientRenameError(error)) throw error
      sleepSync(delay)
    }
  }
}

export function writeTextFileAtomicSync(path: string, content: string): void {
  const temporary = temporaryPath(path)
  try {
    writeFileSync(temporary, content, 'utf8')
    // 2026-09-21：原先直接 renameSync —— Windows 上杀软/索引器短暂持有目标即 EPERM，
    // 表现为间歇性写失败（browser-extension-state 用例隔离连跑 3 过 1 挂即为实证）。
    // 调用方是 modules 状态 / 插件 manifest / 运行时指针这些要害写入，必须走重试。
    renameWithRetrySync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
