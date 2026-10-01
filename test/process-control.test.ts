import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { terminateProcessTree } from '../src/process-control.js'

/** 起一个确定不会自己退出的子进程，交给被测函数处置。 */
function spawnLongRunning(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
}

/** 起一个马上就会自己退出的子进程。 */
function spawnShortLived(): ChildProcess {
  return spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

test('terminateProcessTree 返回 Promise，resolve 时进程树确实已经退出', async () => {
  const child = spawnLongRunning()
  try {
    assert.notEqual(child.pid, undefined, '子进程应已拿到 pid')
    const pending = terminateProcessTree(child)
    // A3 的签名要求：旧实现是 `return void`，这里根本拿不到 then。
    assert.equal(typeof (pending as unknown as { then?: unknown } | undefined)?.then, 'function', 'terminateProcessTree 必须返回可 await 的 Promise')
    // 「名副其实」的关键：await 回来时子进程必须已经死透，而不是「任务已经发出去了」。
    await pending
    assert.equal(hasExited(child), true, 'await 返回时子进程应已退出')
  } finally {
    if (!hasExited(child)) child.kill('SIGKILL')
  }
})

test('terminateProcessTree 对已退出的子进程立即 resolve，且不 reject', async () => {
  const child = spawnShortLived()
  await new Promise<void>(resolve => child.once('exit', () => resolve()))
  await assert.doesNotReject(() => terminateProcessTree(child))
})

test('terminateProcessTree 的超时上限生效：到点就返回，不会无限等待', async () => {
  const child = spawnLongRunning()
  try {
    const startedAt = Date.now()
    await terminateProcessTree(child, { timeoutMs: 1 })
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 5_000, `timeoutMs=1 时应在毫秒级返回，实测 ${elapsed}ms`)
  } finally {
    if (!hasExited(child)) child.kill('SIGKILL')
  }
})

test('child.killed 只代表信号已发出，terminateProcessTree 仍要等进程退出', async () => {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    killed: boolean
    pid: number | undefined
    kill: (signal?: NodeJS.Signals) => boolean
  }
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    killed: true,
    pid: undefined,
    kill: (): boolean => {
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'))
      return true
    },
  })

  await terminateProcessTree(child as unknown as ChildProcess)
  assert.equal(child.listenerCount('exit'), 0, '等待完成后应移除临时 exit 监听器')
})
