import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireBuildCacheLock, checkBuildArtifactCache, collectBuildArtifacts, commitBuildArtifactCache, fingerprintBuildInputs, hashBuildFile, runtimeAssemblyInput } from '../src/build-cache.js'

async function fixture(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-build-cache-'))
  try { await action(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('构建输入按内容校验，Node/pnpm/锁文件变化与可选文件新增都会失效', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'lock.yaml'), 'first')
    const inputs = ['lock.yaml', '.npmrc']
    const toolchain = { node: '26.10.0', pnpm: '12.7.0' }
    const initial = await fingerprintBuildInputs(root, inputs, toolchain)
    assert.equal(await fingerprintBuildInputs(root, [...inputs].reverse(), toolchain), initial)
    await writeFile(join(root, 'lock.yaml'), 'other') // equal byte length, cannot rely on size
    assert.notEqual(await fingerprintBuildInputs(root, inputs, toolchain), initial)
    await writeFile(join(root, 'lock.yaml'), 'first')
    assert.notEqual(await fingerprintBuildInputs(root, inputs, { ...toolchain, pnpm: '12.8.0' }), initial)
    assert.notEqual(await fingerprintBuildInputs(root, inputs, { ...toolchain, node: '26.11.0' }), initial)
    await writeFile(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/')
    assert.notEqual(await fingerprintBuildInputs(root, inputs, toolchain), initial)
  })
})

test('成功提交后才命中缓存，等长损坏、文件增加与缺失均不能复用', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'node'))
    await writeFile(join(root, 'node', 'node.exe'), 'node')
    await writeFile(join(root, 'runtime.tgz'), 'good')
    const input = await fingerprintBuildInputs(root, [], { version: 'v1' })
    const record = join(root, 'cache.json')
    const artifacts = ['node', 'runtime.tgz']
    assert.equal((await checkBuildArtifactCache(root, record, input, artifacts)).hit, false)
    await commitBuildArtifactCache(root, record, input, artifacts)
    assert.equal((await checkBuildArtifactCache(root, record, input, artifacts)).hit, true)
    assert.equal((await checkBuildArtifactCache(root, record, 'f'.repeat(64), artifacts)).hit, false)
    await writeFile(join(root, 'runtime.tgz'), 'evil')
    assert.equal((await checkBuildArtifactCache(root, record, input, artifacts)).hit, false)
    await writeFile(join(root, 'runtime.tgz'), 'good')
    await writeFile(join(root, 'node', 'extra.bin'), 'extra')
    assert.equal((await checkBuildArtifactCache(root, record, input, artifacts)).hit, false)
    await rm(join(root, 'node', 'extra.bin'))
    await rm(join(root, 'node', 'node.exe'))
    assert.equal((await checkBuildArtifactCache(root, record, input, artifacts)).hit, false)
  })
})

test('半成品和损坏清单不能成为成功缓存，失败提交保留上一条完整记录', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'output.bin'), 'complete')
    const input = 'a'.repeat(64)
    const record = join(root, 'cache.json')
    await commitBuildArtifactCache(root, record, input, ['output.bin'])
    const previous = await readFile(record, 'utf8')
    await assert.rejects(commitBuildArtifactCache(root, record, input, ['output.bin', 'missing.bin']))
    assert.equal(await readFile(record, 'utf8'), previous)
    await writeFile(record, '{bad')
    assert.equal((await checkBuildArtifactCache(root, record, input, ['output.bin'])).hit, false)
    await writeFile(record, JSON.stringify({ schema: 1, input, artifacts: [null] }))
    assert.equal((await checkBuildArtifactCache(root, record, input, ['output.bin'])).hit, false)
    await mkdir(join(root, 'empty'))
    await assert.rejects(commitBuildArtifactCache(root, record, input, ['empty']), /制品为空/)
  })
})

test('构建缓存拒绝越界与目录链接循环', async () => {
  await fixture(async root => {
    await assert.rejects(fingerprintBuildInputs(root, ['../outside'], {}), /越界/)
    await mkdir(join(root, 'output'))
    await symlink(join(root, 'output'), join(root, 'output', 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(collectBuildArtifacts(root, ['output']), /链接循环/)
  })
})

test('装配锁串行等待，退出释放，存活持有者不会被超时偷锁', async () => {
  await fixture(async root => {
    const releaseFirst = await acquireBuildCacheLock(root)
    await assert.rejects(acquireBuildCacheLock(root, { waitMs: 10, pollMs: 2 }), /超时/)
    let notified = 0
    let acquired = false
    const second = acquireBuildCacheLock(root, { waitMs: 5000, pollMs: 2, onWait: () => { notified += 1 } })
      .then(release => { acquired = true; return release })
    await new Promise<void>(done => setTimeout(done, 10))
    assert.equal(acquired, false)
    await releaseFirst()
    const releaseSecond = await second
    assert.equal(acquired, true)
    assert.equal(notified, 1)
    await releaseSecond()
  })
})

test('装配锁回收已退出持有者，但旧处置器不能删除后继的锁', async () => {
  await fixture(async root => {
    // A completed child supplies an actually dead PID instead of assuming a large number is unused.
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true })
    assert.equal(child.status, 0)
    await writeFile(join(root, 'assembly.lock'), JSON.stringify({ pid: Number(child.stdout.trim()), token: 'old' }))
    const release = await acquireBuildCacheLock(root, { waitMs: 1000, pollMs: 2 })
    await writeFile(join(root, 'assembly.lock'), JSON.stringify({ pid: process.pid, token: 'successor' }))
    await release()
    assert.equal(JSON.parse(await readFile(join(root, 'assembly.lock'), 'utf8')).token, 'successor')
  })
})

test('运行时缓存覆盖源文件依赖闭包及实际执行产物，桌面版本变化允许复用', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'dist', 'scripts'), { recursive: true })
    await mkdir(join(root, 'dist', 'src'), { recursive: true })
    const manifest = { version: '1.0.77', packageManager: 'pnpm@12.7.0', engines: { node: '26.10.0' }, config: { bundledDshVersion: '0.2.0-rc.2' }, devDependencies: {} }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'scripts', 'prepare-runtime.ts'), "import { value } from '../src/runtime.js'\n")
    await writeFile(join(root, 'src', 'runtime.ts'), 'export const value = 1\n')
    await writeFile(join(root, 'scripts', 'staging-registry-proxy.mjs'), '// proxy')
    await writeFile(join(root, 'dist', 'scripts', 'prepare-runtime.js'), 'compiled main')
    await writeFile(join(root, 'dist', 'src', 'runtime.js'), 'compiled runtime')
    const node = { executable: process.execPath, sha256: 'a'.repeat(64) }
    const initial = await runtimeAssemblyInput(root, node, {})
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...manifest, version: '1.0.78' }))
    assert.equal(await runtimeAssemblyInput(root, node, {}), initial)
    await writeFile(join(root, 'dist', 'src', 'runtime.js'), 'changed runtime')
    assert.notEqual(await runtimeAssemblyInput(root, node, {}), initial)
    await writeFile(join(root, 'src', 'runtime.ts'), 'export const value = 2\n')
    await writeFile(join(root, 'dist', 'src', 'runtime.js'), 'compiled changed runtime')
    assert.notEqual(await runtimeAssemblyInput(root, node, {}), initial)
    assert.notEqual(await runtimeAssemblyInput(root, { ...node, sha256: 'b'.repeat(64) }, {}), initial)
  })
})

test('开发依赖 CLI 缺工具时拒绝复用，提交后检查入口与 Electron 内容', async () => {
  await fixture(async root => {
    const entry = fileURLToPath(new URL('../src/build-cache.js', import.meta.url))
    const manifest = {
      packageManager: 'pnpm@12.7.0', engines: { node: process.versions.node },
      config: { bundledNodeSha256: { [`${process.platform}-${process.arch}`]: await hashBuildFile(process.execPath) } },
      devDependencies: { typescript: '1.0.0', electron: '1.0.0' },
    }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const invoke = (command: string) => spawnSync(process.execPath, [entry, command, root], { encoding: 'utf8', windowsHide: true })
    assert.equal(invoke('dependencies-check').status, 2)
    await mkdir(join(root, 'Tools', 'pnpm-v12.7.0', 'node_modules', 'pnpm', 'bin'), { recursive: true })
    await writeFile(join(root, 'Tools', 'pnpm-v12.7.0', 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', version: '12.7.0' }))
    await writeFile(join(root, 'Tools', 'pnpm-v12.7.0', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'), '// pnpm')
    await mkdir(join(root, 'node_modules', 'typescript', 'bin'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'electron', 'dist'), { recursive: true })
    await writeFile(join(root, 'node_modules', '.modules.yaml'), 'modules')
    await writeFile(join(root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '1.0.0', bin: { tsc: 'bin/tsc' } }))
    await writeFile(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), 'compiler')
    await writeFile(join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const binary = process.platform === 'win32' ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      : process.platform === 'darwin' ? join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(root, 'node_modules', 'electron', 'dist', 'electron')
    await mkdir(resolve(binary, '..'), { recursive: true })
    await writeFile(binary, 'good')
    assert.equal(invoke('dependencies-commit').status, 0)
    assert.equal(invoke('dependencies-check').status, 0)
    await writeFile(binary, 'evil')
    assert.equal(invoke('dependencies-check').status, 2)
    await writeFile(binary, 'good')
    await rm(join(root, 'node_modules', 'typescript', 'bin', 'tsc'))
    assert.equal(invoke('dependencies-check').status, 2)
  })
})
