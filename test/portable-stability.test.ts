import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolvePortablePaths, applyPortableEnvironment } from '../src/portable-paths.js'
import { normalizeRuntimePnpmLayout } from '../src/runtime-pnpm-layout.js'

test('内部 EXE 自动识别 App 与 A/B 槽，显式隔离目录仍优先', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-stability-'))
  try {
    for (const marker of ['Start-DSH-Portable.ps1', 'Portable-Environment.ps1']) await writeFile(join(root, marker), '# fixture')
    for (const relative of ['App', 'Data/Updates/Desktop/slots/1.0.46-test']) {
      const exe = join(root, relative, 'DSH Codex Desktop.exe')
      assert.equal(resolvePortablePaths(undefined, exe)?.root, root)
      assert.equal(resolvePortablePaths(join(root, 'isolated'), exe)?.root, join(root, 'isolated'))
    }
    assert.equal(resolvePortablePaths(undefined, join(root, 'Other', 'DSH Codex Desktop.exe')), undefined)
    await rm(join(root, 'Portable-Environment.ps1'))
    assert.throws(() => resolvePortablePaths(undefined, join(root, 'App', 'DSH Codex Desktop.exe')), /不完整/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('无标记的普通安装不被劫持，损坏的便携槽不回退 C 盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-stability-normal-'))
  try {
    assert.equal(resolvePortablePaths(undefined, join(root, 'App', 'DSH Codex Desktop.exe')), undefined)
    assert.throws(() => resolvePortablePaths(undefined, join(root, 'Data/Updates/Desktop/slots/broken', 'DSH Codex Desktop.exe')), /启动文件缺失/)
    assert.throws(() => resolvePortablePaths('relative-root'), /absolute/)
    const env: NodeJS.ProcessEnv = {}
    applyPortableEnvironment(resolvePortablePaths(root)!, env)
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, join(root, 'Data/Development/playwright'))
    assert.equal(env.ELECTRON_CACHE, join(root, 'Data/Development/electron-cache'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pnpm JSON/YAML 路径规范化保留其他字段，重复执行不改变字节', () => {
  const directory = join(tmpdir(), 'candidate with spaces')
  const source = JSON.stringify({ virtualStoreDir: join(directory, 'node_modules/.pnpm'), storeDir: 'keep-store', hoistedDependencies: { x: 'keep' } })
  const normalized = normalizeRuntimePnpmLayout(source, directory)
  assert.equal(JSON.parse(normalized).virtualStoreDir, '.pnpm')
  assert.equal(JSON.parse(normalized).storeDir, 'keep-store')
  assert.deepEqual(JSON.parse(normalized).hoistedDependencies, { x: 'keep' })
  assert.equal(normalizeRuntimePnpmLayout(normalized, directory), normalized)
  const yaml = `storeDir: keep-store\r\nvirtualStoreDir: '${join(directory, 'node_modules/.pnpm')}'\r\nother: keep\r\n`
  assert.equal(normalizeRuntimePnpmLayout(yaml, directory), 'storeDir: keep-store\r\nvirtualStoreDir: .pnpm\r\nother: keep\r\n')
})

test('pnpm 越界、缺字段、重复字段和损坏元数据拒绝发布', () => {
  const directory = join(tmpdir(), 'candidate')
  for (const source of ['null', '[]', '{}', '{broken', 'virtualStoreDir: .pnpm\nvirtualStoreDir: .pnpm', JSON.stringify({ virtualStoreDir: '../../outside' })]) {
    assert.throws(() => normalizeRuntimePnpmLayout(source, directory))
  }
})
