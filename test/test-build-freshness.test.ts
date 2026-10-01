import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const { assertFreshTestBuild } = await import(pathToFileURL(resolve('scripts/lib/test-build-freshness.mjs')).href)

test('test gate rejects stale/missing outputs, changed config and orphan tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-freshness-'))
  const put = async (name: string, value: string, age = 0) => {
    const target = join(root, name)
    await writeFile(target, value)
    const time = new Date(Date.now() - age)
    await utimes(target, time, time)
  }
  // 年龄差必须远大于「两次 put 之间可能发生的耗时」。这条断言链里每次
  // assertFreshTestBuild 都会 spawnSync 一个真实的 `tsc --showConfig` 子进程，
  // 而 put 记的是**绝对** mtime —— 只要 src 与 dist 的年龄差小于该子进程的耗时，
  // 后写的 dist 就会比先写的 src 更新、判定翻转、断言假失败。
  // 2026-09-30 实测：机器负载高（800 用例并发 + 杀软扫盘）时 tsc 超过 3 秒，
  // 原本 5s/8s 的 3 秒余量被吃光，本用例在全量跑里挂掉、单独跑却全绿。
  // 改成「小时」量级：任何子进程耗时都不可能反转比较结果。
  const HOUR = 3_600_000
  try {
    for (const dir of ['src', 'test', 'dist/src', 'dist/test']) await mkdir(join(root, dir), { recursive: true })
    await put('tsconfig.json', JSON.stringify({ compilerOptions: { rootDir: '.', outDir: 'dist', module: 'NodeNext' }, include: ['src/**/*', 'test/**/*'] }), 3 * HOUR)
    await put('src/value.ts', 'export const value=1', 2 * HOUR)
    await put('test/example.test.ts', 'export {}', 2 * HOUR)
    await put('dist/test/example.test.js', 'export {}')
    assert.throws(() => assertFreshTestBuild(root), /missing/)
    await put('dist/src/value.js', 'export const value=1', 4 * HOUR)
    assert.throws(() => assertFreshTestBuild(root), /stale/)
    await put('dist/src/value.js', 'export const value=1')
    assert.doesNotThrow(() => assertFreshTestBuild(root))
    await put('dist/test/deleted.test.js', 'export {}')
    assert.throws(() => assertFreshTestBuild(root), /orphan test/)
    await rm(join(root, 'dist/test/deleted.test.js'))
    const future = new Date(Date.now() + 10000)
    await utimes(join(root, 'tsconfig.json'), future, future)
    assert.throws(() => assertFreshTestBuild(root), /stale/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
