import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeTextFileAtomic, writeTextFileAtomicSync } from '../src/atomic-file.js'

test('原子写入会完整替换清单且不留下临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-'))
  try {
    const target = join(root, 'package.json')
    await writeFile(target, '{"old":true}\n', 'utf8')
    await writeTextFileAtomic(target, '{"next":true}\n')
    assert.equal(await readFile(target, 'utf8'), '{"next":true}\n')
    assert.deepEqual(await readdir(root), ['package.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('同步原子写成功后同样不留下临时文件与恢复副本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-sync-'))
  try {
    const target = join(root, 'state.json')
    await writeFile(target, '{"v":1}\n', 'utf8')
    writeTextFileAtomicSync(target, '{"v":2}\n')
    assert.equal(await readFile(target, 'utf8'), '{"v":2}\n')
    assert.deepEqual(await readdir(root), ['state.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('同步原子写改名失败时保留新内容与旧内容两份恢复副本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-recover-'))
  try {
    // 把目标做成目录 ⇒ rename 必然失败（文件不能覆盖目录）。
    const target = join(root, 'state.json')
    await mkdir(target, { recursive: true })
    let message = ''
    try {
      writeTextFileAtomicSync(target, '{"v":2}\n')
      assert.fail('改名失败时应当抛错')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // 错误信息必须指出新内容留在了哪个临时文件（旧实现会把它删掉，等于新旧俱毁）。
    const tmp = /新内容保留在 (.+?)(?:，|（)/.exec(message)
    assert.ok(tmp, `错误信息未包含临时文件位置：${message}`)
    assert.equal(await readFile(tmp![1]!, 'utf8'), '{"v":2}\n')
    const leftovers = await readdir(root)
    assert.equal(leftovers.some(name => name.endsWith('.tmp')), true, `临时文件被删掉了：${leftovers.join(',')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('异步原子写改名失败时同样保留新内容副本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-async-recover-'))
  try {
    // 把目标做成目录 ⇒ rename 必然失败（文件不能覆盖目录）。
    const target = join(root, 'state.json')
    await mkdir(target, { recursive: true })
    let message = ''
    try {
      await writeTextFileAtomic(target, '{"v":2}\n')
      assert.fail('改名失败时应当抛错')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // 旧实现 finally 无条件 rm(tmp)：新内容的唯一副本会被删掉，等于新旧俱毁。
    const tmp = /新内容保留在临时文件 (.+?)（/.exec(message)
    assert.ok(tmp, `错误信息未包含临时文件位置：${message}`)
    assert.equal(await readFile(tmp![1]!, 'utf8'), '{"v":2}\n')
    assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), true, '临时文件被删掉了')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
