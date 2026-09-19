import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { makeTrackedTempDir, makeTrackedTempDirSync, removeTempDir, trackedTempDirs } from './helpers/tmp.js'

// 背景（2026-09-13）：29 个使用 mkdtemp 的测试文件里只有 2 个会清理，每跑一轮全量测试残留约 270 个
// 临时目录，累积到 Data\Temp 1.58 GB / 40,782 文件。本文件把「不再泄漏」钉成可执行契约：
//   ① 运行器把子进程 TEMP/TMP/TMPDIR 指向本次运行目录，成功即整目录删除、失败保留、过期目录自动清理；
//   ② 测试助手创建的目录在文件结束时自动删除（本文件用子进程实证）；
//   ③ 门禁文档必须指向运行器，避免有人把命令改回会泄漏的裸 node --test。
const root = process.cwd()

test('运行器把临时目录收口到本次运行目录，并在成功时清理', () => {
  const source = readFileSync(join(root, 'scripts', 'run-tests.mjs'), 'utf8')
  assert.match(source, /dsh-test-runs/, '必须把临时目录收口到 dsh-test-runs 下')
  assert.match(source, /TEMP: runDir/, '子进程 TEMP 必须指向本次运行目录')
  assert.match(source, /TMP: runDir/, '子进程 TMP 必须指向本次运行目录')
  assert.match(source, /TMPDIR: runDir/, '子进程 TMPDIR 必须指向本次运行目录')
  assert.match(source, /rmSync\(runDir/, '成功时必须删除本次运行目录')
  assert.match(source, /DSH_TEST_KEEP_TMP/, '必须提供保留现场开关')
  assert.match(source, /STALE_MS/, '必须清理过期运行目录（防强杀残留）')
})

test('门禁与文档指向运行器，而不是会泄漏的裸命令', () => {
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.match(agents, /scripts\/run-tests\.mjs/, 'AGENTS.md 的测试门禁必须使用运行器')
  const codeMap = readFileSync(join(root, 'docs', '05-系统认知', '02-代码地图.md'), 'utf8')
  assert.match(codeMap, /scripts\/run-tests\.mjs/, '代码地图的测试门禁必须使用运行器')
})

test('助手登记目录并在文件结束时自动清理（子进程实证）', () => {
  const scratch = makeTrackedTempDirSync(join(process.env.TEMP ?? process.env.TMP ?? resolve(root), 'dsh-tmp-hygiene-'))
  const helperHref = new URL('./helpers/tmp.js', import.meta.url).href
  const fixture = join(scratch, 'child.test.mjs')
  writeFileSync(fixture, [
    "import test from 'node:test'",
    "import { existsSync } from 'node:fs'",
    `import { makeTrackedTempDir, trackedTempDirs } from ${JSON.stringify(helperHref)}`,
    '',
    "test('创建一个受跟踪的临时目录', async () => {",
    `  const dir = await makeTrackedTempDir(${JSON.stringify(join(scratch, 'child-tracked-'))})`,
    "  if (!existsSync(dir)) throw new Error('临时目录未创建：' + dir)",
    '})',
    '',
    '// 文件结束后助手应已删除目录；若仍存在则判定泄漏并以非零退出。',
    'process.on(\'exit\', () => {',
    '  for (const dir of trackedTempDirs()) {',
    "    if (existsSync(dir)) { console.error('LEAK:' + dir); process.exitCode = 7 }",
    '  }',
    '})',
    '',
  ].join('\n'))

  const result = spawnSync(process.execPath, ['--test', fixture], { encoding: 'utf8' })
  assert.equal(result.status, 0, `子进程未通过（可能发生泄漏）：\n${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, /LEAK:/)
})

test('助手本身登记了目录，且保留开关存在时不删除', () => {
  const dir = makeTrackedTempDirSync(join(process.env.TEMP ?? process.env.TMP ?? resolve(root), 'dsh-tmp-tracked-'))
  assert.ok(existsSync(dir), '目录应已创建')
  assert.ok(trackedTempDirs().includes(dir), '目录应已登记，等待文件结束时清理')
  const source = readFileSync(join(root, 'test', 'helpers', 'tmp.ts'), 'utf8')
  assert.match(source, /DSH_TEST_KEEP_TMP/, '助手必须支持保留现场')
  assert.match(source, /after\(/, '助手必须用 node:test 的 after 钩子做清理')
})

test('异步助手与同步助手行为一致', async () => {
  const dir = await makeTrackedTempDir(join(process.env.TEMP ?? process.env.TMP ?? resolve(root), 'dsh-tmp-async-'))
  assert.ok(existsSync(dir))
  assert.ok(trackedTempDirs().includes(dir))
})

test('清理对 Windows 瞬时占用重试，且失败不抛错', async () => {
  const tmp = process.env.TEMP ?? process.env.TMP ?? resolve(root)
  const helper = readFileSync(join(root, 'test', 'helpers', 'tmp.ts'), 'utf8')
  assert.match(helper, /maxRetries/, '助手删除目录必须带 maxRetries（Windows EBUSY 重试）')
  assert.match(helper, /export async function removeTempDir/, '助手必须导出可重试的 removeTempDir')
  // 运行器回收运行目录同样要带重试，否则被占用时会把上一次运行的现场留下来。
  const runner = readFileSync(join(root, 'scripts', 'run-tests.mjs'), 'utf8')
  assert.match(runner, /RM_RETRY/, '运行器回收临时目录必须带重试参数')

  // 行为契约：不存在（或已被占用到放弃）的目录不得让用例变红。
  assert.equal(await removeTempDir(join(tmp, 'dsh-tmp-missing-does-not-exist')), true, '删除不存在的目录应视为成功')
  const real = await makeTrackedTempDir(join(tmp, 'dsh-tmp-removable-'))
  writeFileSync(join(real, 'payload.txt'), 'x', 'utf8')
  assert.equal(await removeTempDir(real), true, '普通目录应删除成功')
  assert.equal(existsSync(real), false, '删除后目录不应存在')
})
