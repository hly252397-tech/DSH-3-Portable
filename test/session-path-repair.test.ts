import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { repairMisplacedSessionLogs, runSessionPathRepairAtStartup } from '../src/session-path-repair.js'
// 用受跟踪的 mkdtemp：测试结束后自动删除临时目录（见 test/helpers/tmp.ts）。
import { makeTrackedTempDir as mkdtemp } from './helpers/tmp.js'

const header = (id: string, cwd: string): Buffer =>
  Buffer.from(`${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd, delegationDepth: 0 })}\n`, 'utf8')

test('startup repair tolerates traversal and report failures without deleting source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-startup-'))
  const notDirectory = join(root, 'sessions')
  await writeFile(notDirectory, 'preserve')
  await assert.rejects(repairMisplacedSessionLogs(notDirectory, join(root, 'backup')))
  let reported = false
  await assert.doesNotReject(runSessionPathRepairAtStartup(notDirectory, join(root, 'backup'), async () => { reported = true }))
  assert.equal(reported, false)
  assert.equal(await readFile(notDirectory, 'utf8'), 'preserve')
  await assert.doesNotReject(runSessionPathRepairAtStartup(join(root, 'missing'), join(root, 'backup'), async () => { throw new Error('report failed') }))
})

test('修复会话头与物理项目目录错位且保留原始备份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-repair-'))
  const sessions = join(root, 'sessions')
  const backup = join(root, 'backup')
  const id = '2efc8648-94ee-4e86-80f8-ac959b48a426'
  const oldDirectory = join(sessions, '--G-old--', id)
  const expectedDirectory = join(sessions, '--G-DSH-~5DE5~4F5C~7A7A~95F4--', id)
  const source = header(id, 'G:\\DSH\\工作空间')
  await mkdir(oldDirectory, { recursive: true })
  await writeFile(join(oldDirectory, 'session.jsonl.zstd'), zstdCompressSync(source))
  await writeFile(join(oldDirectory, 'attachment.txt'), 'preserved')

  const { repairs, failures } = await repairMisplacedSessionLogs(sessions, backup)

  assert.deepEqual(failures, [])
  assert.equal(repairs.length, 1)
  assert.equal(repairs[0]?.to, expectedDirectory)
  assert.equal(await readFile(join(expectedDirectory, 'attachment.txt'), 'utf8'), 'preserved')
  assert.deepEqual(await readFile(repairs[0]!.backup), zstdCompressSync(source))

  // 幂等：目录已经就位，不再产出修复、也不应报失败。
  const again = await repairMisplacedSessionLogs(sessions, backup)
  assert.deepEqual(again.repairs, [])
  assert.deepEqual(again.failures, [])
})

test('备份已存在且内容一致时视为完成，不因 COPYFILE_EXCL 而失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-repair-idem-'))
  const sessions = join(root, 'sessions')
  const backupRoot = join(root, 'backup')
  const id = 'idem-session'
  const oldDirectory = join(sessions, '--wrong--', id)
  const expectedDirectory = join(sessions, '--G-project--', id)
  const source = header(id, 'G:\\project')
  await mkdir(oldDirectory, { recursive: true })
  await writeFile(join(oldDirectory, 'session.jsonl'), source)
  // 预置一份内容一致的备份（模拟崩溃后重跑：备份在、目录没搬）。
  const backupPath = join(backupRoot, '--wrong--', id, 'session.jsonl')
  await mkdir(join(backupRoot, '--wrong--', id), { recursive: true })
  await writeFile(backupPath, source)

  const { repairs, failures } = await repairMisplacedSessionLogs(sessions, backupRoot)

  assert.deepEqual(failures, [])
  assert.equal(repairs.length, 1)
  assert.equal(repairs[0]?.to, expectedDirectory)
})

test('目标会话已存在时只记账失败，不抛错、不移动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-repair-collision-'))
  const sessions = join(root, 'sessions')
  const id = 'same-id'
  const sourceDirectory = join(sessions, '--wrong--', id)
  const targetDirectory = join(sessions, '--G-project--', id)
  const source = header(id, 'G:\\project').toString('utf8')
  await mkdir(sourceDirectory, { recursive: true })
  await mkdir(targetDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, 'session.jsonl'), source)

  const { repairs, failures } = await repairMisplacedSessionLogs(sessions, join(root, 'backup'))

  assert.deepEqual(repairs, [])
  assert.equal(failures.length, 1)
  assert.match(failures[0]!, /已存在/)
  // 源目录必须原样保留（没有移动、没有删除）。
  assert.equal(await readFile(join(sourceDirectory, 'session.jsonl'), 'utf8'), source)
})

test('移动失败时保留已写出的备份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-repair-keepbak-'))
  const sessions = join(root, 'sessions')
  const backupRoot = join(root, 'backup')
  const id = 'keep-backup'
  const sessionDirectory = join(sessions, '--wrong--', id)
  const source = header(id, 'G:\\project')
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(join(sessionDirectory, 'session.jsonl'), source)
  const backupPath = join(backupRoot, '--wrong--', id, 'session.jsonl')
  // 预置一份**内容不一致**的备份：函数必须拒绝继续，且绝不覆盖/删除它。
  await mkdir(join(backupRoot, '--wrong--', id), { recursive: true })
  await writeFile(backupPath, 'stale-backup-content')

  const { repairs, failures } = await repairMisplacedSessionLogs(sessions, backupRoot)

  assert.deepEqual(repairs, [])
  assert.equal(failures.length, 1)
  assert.match(failures[0]!, /不一致/)
  // 备份原样保留，源目录未被移动。
  assert.equal(await readFile(backupPath, 'utf8'), 'stale-backup-content')
  assert.equal(await readFile(join(sessionDirectory, 'session.jsonl'), 'utf8'), source.toString('utf8'))
  await rm(backupPath, { force: true })
})

test('备份写出后后续步骤失败时保留备份（失败不删唯一还原依据）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-repair-keepbak-after-'))
  const sessions = join(root, 'sessions')
  const backupRoot = join(root, 'backup')
  const id = 'keep-after-failure'
  const sourceDirectory = join(sessions, '--wrong--', id)
  const source = header(id, 'G:\\project')
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, 'session.jsonl'), source)
  // 让「备份之后」的步骤必然失败：目标项目名被同名**文件**占住，
  // mkdir(dirname(expectedDirectory)) 会抛 EEXIST —— 此时备份已经写出来了。
  await writeFile(join(sessions, '--G-project--'), 'not-a-directory')
  const backupPath = join(backupRoot, '--wrong--', id, 'session.jsonl')

  const { repairs, failures } = await repairMisplacedSessionLogs(sessions, backupRoot)

  assert.deepEqual(repairs, [])
  assert.equal(failures.length, 1)
  // 关键断言：备份必须还在。旧实现会在失败分支 rm(backup)，等于毁掉唯一还原依据。
  assert.deepEqual(await readFile(backupPath), source)
  // 源目录必须原样保留（没有移动、没有删除）。
  assert.deepEqual(await readFile(join(sourceDirectory, 'session.jsonl')), source)
})
