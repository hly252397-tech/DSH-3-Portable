import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { repairMisplacedSessionLogs } from '../src/session-path-repair.js'

test('修复会话头与物理项目目录错位且保留原始备份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-repair-'))
  const sessions = join(root, 'sessions')
  const backup = join(root, 'backup')
  const id = '2efc8648-94ee-4e86-80f8-ac959b48a426'
  const oldDirectory = join(sessions, '--G-old--', id)
  const expectedDirectory = join(sessions, '--G-DSH-~5DE5~4F5C~7A7A~95F4--', id)
  const source = Buffer.from(`${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: 'G:\\DSH\\工作空间', delegationDepth: 0 })}\n`, 'utf8')
  await mkdir(oldDirectory, { recursive: true })
  await writeFile(join(oldDirectory, 'session.jsonl.zstd'), zstdCompressSync(source))
  await writeFile(join(oldDirectory, 'attachment.txt'), 'preserved')

  const repaired = await repairMisplacedSessionLogs(sessions, backup)

  assert.equal(repaired.length, 1)
  assert.equal(repaired[0]?.to, expectedDirectory)
  assert.equal(await readFile(join(expectedDirectory, 'attachment.txt'), 'utf8'), 'preserved')
  assert.deepEqual(await readFile(repaired[0]!.backup), zstdCompressSync(source))
  assert.deepEqual(await repairMisplacedSessionLogs(sessions, backup), [])
})

test('目标会话已存在时拒绝覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-repair-collision-'))
  const sessions = join(root, 'sessions')
  const id = 'same-id'
  const sourceDirectory = join(sessions, '--wrong--', id)
  const targetDirectory = join(sessions, '--G-project--', id)
  const source = `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: 'G:\\project', delegationDepth: 0 })}\n`
  await mkdir(sourceDirectory, { recursive: true })
  await mkdir(targetDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, 'session.jsonl'), source)

  await assert.rejects(repairMisplacedSessionLogs(sessions, join(root, 'backup')), /目标会话 same-id 已存在/)
})
