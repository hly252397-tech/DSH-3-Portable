import { spawn, type ChildProcess } from 'node:child_process'

interface TerminateProcessTreeOptions {
  processGroup?: boolean
  /** 等待进程树真正结束的上限（毫秒），默认 8 秒；到点即放弃并 resolve。 */
  timeoutMs?: number
}

const DEFAULT_TERMINATE_TIMEOUT_MS = 8_000

/**
 * 终止子进程及其整棵进程树，返回的 Promise 在「信号已发出且子进程已退出」或超时后 resolve。
 *
 * 选型说明（为什么不 `unref()`）：旧行为是 `spawn('taskkill', …)` 之后立刻 `return`——
 * 调用方以为树已经死了就去删目录/起新进程，实际 taskkill 还没跑完；改成 `unref()` 只会
 * 让「父进程先退出、taskkill 还在跑」的竞态更严重。因此这里改成**返回 Promise 并等
 * `close`/`exit`**，同时给出超时上限，避免一个卡死的 taskkill 把事件循环无限吊住。
 *
 * 兼容性：返回类型从 `void` 变成 `Promise<void>`，但 6 个调用点（dsh-process /
 * desktop-host / plugin-seed / extract-runtime / harness-runtime-candidate）全部是
 * 语句式调用或返回 `void` 的箭头函数，源码无需改动即可编译；忽略返回值时行为与原来
 * 一致（子进程句柄本身就让事件循环等它退出），需要确定性的调用方则可以 `await`。
 *
 * 该 Promise **永不 reject**：所有失败（spawn 失败、超时、权限不足）都降级为 best-effort
 * 的 `child.kill('SIGKILL')` 后 resolve，所以忽略它不会产生 unhandledRejection。
 *
 * @param options.timeoutMs 整体等待上限，默认 {@link DEFAULT_TERMINATE_TIMEOUT_MS}。
 */
export async function terminateProcessTree(child: ChildProcess, options: TerminateProcessTreeOptions = {}): Promise<void> {
  const deadline = Date.now() + Math.max(options.timeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS, 0)
  // `child.killed` only means a signal was sent; it does not mean the process exited.
  // Returning here would reopen the exact race this function is meant to close.
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    await runTaskkill(child, remaining(deadline))
  } else if (options.processGroup === true && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // 子进程可能在创建进程组前退出；回退到直接终止。
      child.kill('SIGKILL')
    }
  } else {
    child.kill('SIGKILL')
  }
  await waitForExit(child, remaining(deadline))
}

/** Windows：`taskkill /pid <pid> /t /f`，等到它自己结束（或超时后杀掉它）。 */
function runTaskkill(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.pid === undefined) return Promise.resolve()
  return new Promise<void>(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      // taskkill 自己卡住：杀掉它并放弃，别把事件循环吊死。
      killer.kill()
      finish()
    }, Math.max(timeoutMs, 0))
    killer.once('error', () => {
      // taskkill 拿不到句柄（进程已退出/权限问题）时退回直接 kill。
      child.kill('SIGKILL')
      finish()
    })
    killer.once('close', finish)
  })
}

/** 等子进程真正退出；已退出或超时立刻返回，绝不 reject。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || timeoutMs <= 0) return Promise.resolve()
  return new Promise<void>(resolve => {
    const done = (): void => {
      clearTimeout(timer)
      child.removeListener('exit', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    child.once('exit', done)
  })
}

function remaining(deadline: number): number {
  return Math.max(deadline - Date.now(), 0)
}
