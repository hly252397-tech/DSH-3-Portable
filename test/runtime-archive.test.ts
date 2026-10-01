import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import * as runtimeArchive from '../src/runtime-archive.js'
import * as runtimeExtraction from '../src/extract-runtime.js'
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

test('目录外硬链接实化后源文件改动不影响归档内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hardlink-'))
  try {
    const outside = join(root, 'outside.txt')
    const source = join(root, 'source')
    const inside = join(source, 'nested', 'inside.txt')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(outside, 'original-package-bytes')
    await link(outside, inside)
    assert.ok((await lstat(inside)).nlink > 1)
    assert.ok('materializeHardlinks' in runtimeArchive && typeof runtimeArchive.materializeHardlinks === 'function')
    assert.equal(await runtimeArchive.materializeHardlinks(source), 1)
    assert.equal(await runtimeArchive.materializeHardlinks(source), 0)
    assert.equal((await lstat(inside)).nlink, 1)
    await writeFile(outside, 'changed-outside')
    assert.equal(await readFile(inside, 'utf8'), 'original-package-bytes')
    const archive = join(root, 'bundle.tgz')
    packDirectoryToTarGz(source, archive)
    await rm(source, { recursive: true, force: true })
    extractTarGz(archive, join(root, 'dest'))
    assert.equal(await readFile(join(root, 'dest', 'nested', 'inside.txt'), 'utf8'), 'original-package-bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('归档快照展开硬链接和目录联接且不再依赖源树', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-snapshot-'))
  try {
    const outside = join(root, 'outside')
    const source = join(root, 'source')
    const snapshot = join(root, 'snapshot')
    await mkdir(outside)
    await mkdir(source)
    await mkdir(snapshot)
    await writeFile(join(snapshot, 'stale.txt'), 'must-not-survive')
    await writeFile(join(outside, 'file.txt'), 'package-content')
    await link(join(outside, 'file.txt'), join(source, 'hardlink.txt'))
    await symlink(outside, join(source, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.ok('cloneTreeForArchive' in runtimeArchive && typeof runtimeArchive.cloneTreeForArchive === 'function')
    await runtimeArchive.cloneTreeForArchive(source, snapshot)
    assert.equal(existsSync(join(snapshot, 'stale.txt')), false)
    assert.equal((await lstat(join(snapshot, 'hardlink.txt'))).nlink, 1)
    assert.equal((await lstat(join(snapshot, 'linked-directory'))).isSymbolicLink(), false)
    await writeFile(join(outside, 'file.txt'), 'changed-after-snapshot')
    await rm(source, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    const archive = join(root, 'bundle.tgz')
    packDirectoryToTarGz(snapshot, archive)
    await rm(snapshot, { recursive: true, force: true })
    extractTarGz(archive, join(root, 'dest'))
    for (const path of ['hardlink.txt', join('linked-directory', 'file.txt')]) {
      assert.equal(await readFile(join(root, 'dest', path), 'utf8'), 'package-content')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('打开的 WAL 包索引经快照、归档、解压和真实复制仍保留实体内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-wal-'))
  let db: DatabaseSync | undefined
  try {
    const source = join(root, 'store')
    const dbPath = join(source, 'v11', 'index.db')
    const key = 'sha512-abc\tlucide-react@1.48.0'
    const data = Buffer.from('package-index-content')
    await mkdir(join(source, 'v11', 'files', 'ab'), { recursive: true })
    await writeFile(join(source, 'v11', 'files', 'ab', 'package'), 'package-file-bytes')
    await writeFile(join(source, 'dsh-store-lock.yaml'), 'lockfileVersion: 9\n')
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    db.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL)')
    db.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)').run(key, data)
    // 保持连接打开，确保行确实仍在 WAL，不能靠 close() 的自动 checkpoint 假通过。
    const walBefore = await readFile(`${dbPath}-wal`)
    assert.ok(walBefore.length > 0)
    const mainOnly = join(root, 'main-only.db')
    await writeFile(mainOnly, await readFile(dbPath))
    const uncheckpointed = new DatabaseSync(mainOnly, { readOnly: true })
    try {
      assert.throws(() => uncheckpointed.prepare('SELECT key FROM package_index').all(), /no such table/)
    } finally {
      uncheckpointed.close()
    }
    assert.ok('cloneTreeForArchive' in runtimeArchive && typeof runtimeArchive.cloneTreeForArchive === 'function')
    assert.ok('assertPnpmStorePackagesPreserved' in runtimeArchive && typeof runtimeArchive.assertPnpmStorePackagesPreserved === 'function')
    assert.ok('copyExtractedTree' in runtimeExtraction && typeof runtimeExtraction.copyExtractedTree === 'function')
    const assertPreserved = runtimeArchive.assertPnpmStorePackagesPreserved
    const snapshot = join(root, 'snapshot')
    const staging = join(root, 'staging')
    const installed = join(root, 'installed')
    const digest = pnpmStoreContentSha256(source)
    await runtimeArchive.cloneTreeForArchive(source, snapshot)
    assert.deepEqual(await readFile(`${dbPath}-wal`), walBefore, '快照不能检查点或改写源仓库')
    assert.equal(existsSync(join(snapshot, 'v11', 'index.db-wal')), false)
    assert.equal(existsSync(join(snapshot, 'v11', 'index.db-shm')), false)
    assert.equal(pnpmStoreContentSha256(snapshot), digest, 'SQLite 实化不能改变便携缓存身份')
    const archive = join(root, 'bundle.tgz')
    packDirectoryToTarGz(snapshot, archive)
    extractTarGz(archive, staging)
    runtimeExtraction.copyExtractedTree(staging, installed)
    await rm(staging, { recursive: true, force: true })
    await rm(snapshot, { recursive: true, force: true })
    assertPreserved(source, installed)
    const packaged = new DatabaseSync(join(installed, 'v11', 'index.db'))
    try {
      const row = packaged.prepare('SELECT key, data FROM package_index').get()!
      assert.equal(row.key, key)
      assert.deepEqual(Buffer.from(row.data as Uint8Array), data)
      assert.equal(await readFile(join(installed, 'v11', 'files', 'ab', 'package'), 'utf8'), 'package-file-bytes')
      assert.equal(pnpmStoreContentSha256(installed), digest)
      packaged.exec('DELETE FROM package_index')
      assert.throws(() => assertPreserved(source, installed), /lucide-react@1\.48\.0/)
    } finally {
      packaged.close()
    }
    await rm(join(installed, 'v11', 'index.db'))
    assert.throws(() => assertPreserved(source, installed), /丢失了仓库索引/)
  } finally {
    db?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('解压前拒绝绝对路径和目录穿越条目', () => {
  assert.doesNotThrow(() => validateArchiveEntries(['./nested/ok.txt']))
  assert.throws(() => validateArchiveEntries(['../escape.txt']), /不安全/)
  assert.throws(() => validateArchiveEntries(['/absolute.txt']), /不安全/)
  assert.throws(() => validateArchiveEntries(['C:\\absolute.txt']), /不安全/)
  assert.throws(() => validateArchiveEntries(['C:/absolute.txt']), /不安全/)
  assert.throws(() => validateArchiveEntries(['nested\\..\\escape.txt']), /不安全/)
})

test('真实恶意归档在同步及异步解压前拒绝路径穿越', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-traversal-'))
  try {
    // 构造带有效校验和的 ustar，避免测试被打包器自身的路径清洗掩盖。
    const header = Buffer.alloc(512)
    header.write('../escape.txt', 0)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write('00000000004\0', 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
    const archive = join(root, 'unsafe.tgz')
    await writeFile(archive, gzipSync(Buffer.concat([header, Buffer.from('evil'), Buffer.alloc(508 + 1024)])))
    const dest = join(root, 'dest')
    assert.throws(() => extractTarGz(archive, dest), /不安全路径/)
    const progress: number[] = []
    await assert.rejects(extractTarGzWithProgress(archive, dest, completed => progress.push(completed)), /不安全路径/)
    assert.deepEqual(progress, [])
    assert.equal(existsSync(dest), false)
    assert.equal(existsSync(join(root, 'escape.txt')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
