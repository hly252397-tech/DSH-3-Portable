import assert from 'node:assert/strict'
import test from 'node:test'

import { orphanCandidates } from '../src/orphan-sweep.js'

test('marks a stray harness or bridge outside the current process tree as orphan', () => {
  const procs = [
    { pid: 10, parentPid: 1, commandLine: 'node.exe G:/app/resources/node/bin.js web --port 0' },
    { pid: 20, parentPid: 1, commandLine: 'node.exe V:/scripts/Update-Bridge.js' },
    { pid: 30, parentPid: 10, commandLine: 'node.exe mcp-bridge child' },
  ]
  // self=999：与上面的树毫无血缘 → 10/20 都是孤儿；30 是 10 的子进程，同属孤儿树
  assert.deepEqual(orphanCandidates(procs, 999), [10, 20])
})

test('leaves the current generation and unrelated node processes alone', () => {
  const procs = [
    { pid: 10, parentPid: 5, commandLine: 'node.exe app/resources/node/bin.js web --port 0' }, // 本代 harness（父 5 是本代）
    { pid: 20, parentPid: 10, commandLine: 'node.exe mcp-bridge' }, // 本代 harness 的子进程
    { pid: 30, parentPid: 5, commandLine: 'node.exe some-other-tool --serve' }, // 无关进程，命令行不匹配
  ]
  assert.deepEqual(orphanCandidates(procs, 5), [])
})

test('an orphan with a live parent in the current tree is not an orphan', () => {
  const procs = [
    { pid: 10, parentPid: 999, commandLine: 'node.exe bin.js web --port 0' },
    { pid: 20, parentPid: 10, commandLine: 'node.exe whatever' },
  ]
  // self=999 → 10 的父就是本进程，属本代
  assert.deepEqual(orphanCandidates(procs, 999), [])
})
