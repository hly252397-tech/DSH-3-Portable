import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { directoryContentSha256, extractTarGz, extractTarGzWithProgress, packDirectoryToTarGz, pnpmStoreContentSha256, validateArchiveEntries, verifyFileSha256, writeFileSha256 } from '../src/runtime-archive.js'

test('目录可以打成 tar.gz 再解回原结构', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-'))
  try {
    const source = join(root, 'source')
    const dest = join(root, 'dest')
    const archive = join(root, 'bundle.tgz')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'nested', 'ok.txt'), 'ready', 'utf8')
    packDirectoryToTarGz(source, archive)
    extractTarGz(archive, dest)
    assert.equal(await readFile(join(dest, 'nested', 'ok.txt'), 'utf8'), 'ready')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('解压前拒绝绝对路径和目录穿越条目', () => {
  assert.doesNotThrow(() => validateArchiveEntries(['./nested/ok.txt']))
  assert.throws(() => validateArchiveEntries(['../escape.txt']), /不安全/)
  assert.throws(() => validateArchiveEntries(['/absolute.txt']), /不安全/)
  assert.throws(() => validateArchiveEntries(['C:\\absolute.txt']), /不安全/)
})

test('逻辑内容摘要忽略打包时间但能识别文件变化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-content-digest-'))
  try {
    const file = join(root, 'nested', 'value.txt')
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, 'same-content', 'utf8')
    const first = directoryContentSha256(root)
    await utimes(file, new Date('2020-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'))
    assert.equal(directoryContentSha256(root), first)
    await writeFile(file, 'changed-content', 'utf8')
    assert.notEqual(directoryContentSha256(root), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pnpm 仓库摘要忽略易变 SQLite 时间戳但锁文件变化必须失效缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-store-digest-'))
  try {
    await mkdir(join(root, 'v11'), { recursive: true })
    await writeFile(join(root, 'v11', 'index.db'), 'volatile-build-one', 'utf8')
    await writeFile(join(root, 'dsh-store-lock.yaml'), 'lockfileVersion: 9\npackage: one\n', 'utf8')
    const first = pnpmStoreContentSha256(root)
    await writeFile(join(root, 'v11', 'index.db'), 'volatile-build-two-with-different-bytes', 'utf8')
    assert.equal(pnpmStoreContentSha256(root), first)
    await writeFile(join(root, 'dsh-store-lock.yaml'), 'lockfileVersion: 9\npackage: two\n', 'utf8')
    assert.notEqual(pnpmStoreContentSha256(root), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('流式 SHA256 与整文件摘要一致且能上报字节进度', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-hash-'))
  try {
    // 刻意超过单个 4 MB 分块，确保真的走了多轮读取而不是一次性读入。
    const payload = Buffer.alloc(5 * 1024 * 1024 + 12345)
    for (let index = 0; index < payload.length; index += 997) payload[index] = index % 251
    const archive = join(root, 'dsh-runtime.tgz')
    await writeFile(archive, payload)
    writeFileSha256(archive)
    const ticks: Array<{ completed: number; total: number }> = []
    verifyFileSha256(archive, (completed, total) => ticks.push({ completed, total }))
    assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${createHash('sha256').update(payload).digest('hex')}\n`)
    assert.equal(ticks[0]?.completed, 0)
    assert.deepEqual(ticks.at(-1), { completed: payload.length, total: payload.length })
    // 篡改任意字节都必须失败：分块实现不能只校验了最后一块。
    const tampered = Buffer.from(payload)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    await writeFile(archive, tampered)
    assert.throws(() => verifyFileSha256(archive), /SHA256 校验失败/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('异步解压上报条目进度、收尾报满并还原结构', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-progress-'))
  try {
    const source = join(root, 'source')
    const dest = join(root, 'dest')
    const archive = join(root, 'bundle.tgz')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'nested', 'ok.txt'), 'ready', 'utf8')
    await writeFile(join(source, 'top.txt'), 'top', 'utf8')
    packDirectoryToTarGz(source, archive)
    const ticks: Array<{ completed: number; total: number }> = []
    await extractTarGzWithProgress(archive, dest, (completed, total) => ticks.push({ completed, total }))
    assert.equal(await readFile(join(dest, 'nested', 'ok.txt'), 'utf8'), 'ready')
    assert.equal(await readFile(join(dest, 'top.txt'), 'utf8'), 'top')
    assert.equal(ticks[0]?.completed, 0)
    const last = ticks.at(-1)
    assert.ok((last?.total ?? 0) > 0)
    // 收尾必须报满，否则启动窗口会永久停在 99%。
    assert.deepEqual(last, { completed: last?.total, total: last?.total })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
