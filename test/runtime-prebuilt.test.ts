import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PREBUILT_COMPLETE_MARKER, copyPrebuiltOfficialRuntime, resolvePrebuiltOfficialRuntime } from '../src/runtime-prebuilt.js'

async function writeOfficialEntry(dir: string): Promise<void> {
  await mkdir(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await writeFile(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
}

test('打包态从 extraResources 解析预装官方运行时', () => {
  const resourcesPath = 'D:\\app\\resources'
  const resolved = resolvePrebuiltOfficialRuntime({
    appPath: 'D:\\app',
    isPackaged: true,
    resourcesPath,
    exists: (path) => path === join(resourcesPath, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  })
  assert.equal(resolved, join(resourcesPath, 'dsh-runtime'))
})

test('预装运行时只在目标完整时跳过，复制成功后写出完成标记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prebuilt-'))
  try {
    const source = join(root, 'source')
    const dest = join(root, 'dest')
    await writeOfficialEntry(source)
    assert.equal(copyPrebuiltOfficialRuntime(source, dest), 'copied')
    // 完成标记是"整棵复制成功"的凭据，不能只靠入口文件存在。
    assert.match(await readFile(join(dest, PREBUILT_COMPLETE_MARKER), 'utf8'), /source/)
    assert.equal(copyPrebuiltOfficialRuntime(source, dest), 'skipped')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('目标残缺（有入口但无完成标记）时重新复制，而不是永久跳过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prebuilt-partial-'))
  try {
    const source = join(root, 'source')
    const dest = join(root, 'dest')
    await writeOfficialEntry(source)
    // 制造"中断后的残缺目标"：入口在，但整棵内容与标记都缺。
    await writeOfficialEntry(dest)
    const status = copyPrebuiltOfficialRuntime(source, dest)
    // 旧实现这里返回 'skipped' ⇒ 坏槽永久留存；新实现必须真正复制。
    assert.equal(status, 'copied')
    assert.match(await readFile(join(dest, PREBUILT_COMPLETE_MARKER), 'utf8'), /source/)
    assert.equal(copyPrebuiltOfficialRuntime(source, dest), 'skipped')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('完成标记指向别的源时视为不完整并重做', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prebuilt-marker-'))
  try {
    const source = join(root, 'source')
    const dest = join(root, 'dest')
    await writeOfficialEntry(source)
    await writeOfficialEntry(dest)
    await writeFile(join(dest, PREBUILT_COMPLETE_MARKER), 'D:\\other\\source\n', 'utf8')
    assert.equal(copyPrebuiltOfficialRuntime(source, dest), 'copied')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('源缺入口时返回 missing 且不动目标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prebuilt-missing-'))
  try {
    const source = join(root, 'source')
    const dest = join(root, 'dest')
    await mkdir(source, { recursive: true })
    assert.equal(copyPrebuiltOfficialRuntime(source, dest), 'missing')
    await assert.rejects(readFile(join(dest, 'anything'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
