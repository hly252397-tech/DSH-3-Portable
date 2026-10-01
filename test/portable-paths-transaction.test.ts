import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'

import { OFFICIAL_LAUNCH_PEERS } from '../src/bundled-plugins.js'
import { applyPortableEnvironment, portableRuntimeHomeBindingPath, resolveActivePortablePaths, resolvePortablePaths } from '../src/portable-paths.js'
import { runtimePointerPath } from '../src/runtime-slots.js'
import { makeTrackedTempDir } from './helpers/tmp.js'

async function put(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}

async function writeRuntime(directory: string, version: string): Promise<void> {
  const dsh = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  await put(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  await put(join(dsh, 'lib', 'bin.js'), '// isolated runtime')
  for (const peer of OFFICIAL_LAUNCH_PEERS) await put(join(directory, 'node_modules', ...peer.packageName.split('/'), 'package.json'), JSON.stringify({ name: peer.packageName, version }))
}

async function fixture(pending = false) {
  const root = await makeTrackedTempDir(join(tmpdir(), 'dsh-paths-transaction-'))
  const legacy = join(root, 'Data', 'Runtime', 'dsh-runtime')
  const previousVersion = '0.2.0-rc.2', currentVersion = '0.3.0-rc.1'
  const previousRuntime = join(root, 'Data', 'Runtime', 'Harness', 'slots', 'old-runtime')
  const currentRuntime = join(root, 'Data', 'Runtime', 'Harness', 'slots', 'next-runtime')
  await writeRuntime(legacy, previousVersion)
  await writeRuntime(previousRuntime, previousVersion)
  await writeRuntime(currentRuntime, currentVersion)
  await put(join(root, 'Data', 'DSH', 'sessions', 'legacy.txt'), 'untouched shared legacy home')
  const previousHome = join(root, 'Data', 'DSH-generations', 'previous-home', 'home')
  const currentHome = join(root, 'Data', 'DSH-generations', 'current-home', 'home')
  await put(join(previousHome, 'profiles', 'web', 'package.json'), '{"dsh":{"profile":{"bundles":[]}}}')
  await put(join(currentHome, 'profiles', 'web', 'package.json'), '{"dsh":{"profile":{"bundles":[]}}}')
  await put(join(previousHome, 'data', 'session.json'), '{"format":"old","message":"last committed session"}')
  await put(join(currentHome, 'data', 'session.json'), '{"format":"new","message":"uncommitted candidate session"}')
  const binding = { schema: 2, runtimeVersion: currentVersion, generation: 'current-home', runtimeRelativePath: relative(root, currentRuntime).replaceAll('\\', '/') }
  const previousBinding = { schema: 2, runtimeVersion: previousVersion, generation: 'previous-home', runtimeRelativePath: relative(root, previousRuntime).replaceAll('\\', '/') }
  const bindingPath = portableRuntimeHomeBindingPath(root, currentVersion)
  await put(bindingPath, JSON.stringify(binding))
  await put(portableRuntimeHomeBindingPath(root, previousVersion), JSON.stringify(previousBinding))
  const pointer = {
    schema: 1,
    current: { relativePath: relative(dirname(legacy), currentRuntime).replaceAll('\\', '/'), version: currentVersion, fingerprint: 'b'.repeat(64) },
    previous: { relativePath: relative(dirname(legacy), previousRuntime).replaceAll('\\', '/'), version: previousVersion, fingerprint: 'a'.repeat(64) },
    activatedAt: new Date().toISOString(),
    ...(pending ? { pendingTransactionId: 'pending-transaction' } : {}),
  }
  await put(runtimePointerPath(legacy), JSON.stringify(pointer))
  return { root, legacy, previousVersion, currentVersion, previousRuntime, currentRuntime, previousHome, currentHome, binding, bindingPath, previousBinding, pointer }
}

test('schema2 家园绑定只引用已有全局运行时，不复制运行时或改变现役数据', async () => {
  const f = await fixture()
  const paths = resolveActivePortablePaths(f.root)!
  assert.equal(paths.dshHome, f.currentHome)
  assert.equal(paths.runtime, f.currentRuntime)
  assert.equal(existsSync(join(dirname(f.currentHome), 'runtime')), false)
  assert.equal(await readFile(join(f.previousHome, 'data', 'session.json'), 'utf8'), '{"format":"old","message":"last committed session"}')
  assert.equal(await readFile(join(f.root, 'Data', 'DSH', 'sessions', 'legacy.txt'), 'utf8'), 'untouched shared legacy home')
  const environment: NodeJS.ProcessEnv = {}
  applyPortableEnvironment(paths, environment)
  assert.equal(environment.DSH_HOME, f.currentHome)
  assert.equal(environment.DSH_DESKTOP_RUNTIME_DIR, f.currentRuntime)
  assert.equal(environment.TEMP, join(f.root, 'Data', 'Temp'))
})

test('未提交 pending 启动选择 previous 家园与运行时，不能先读取新格式会话', async () => {
  const f = await fixture(true)
  const pointerBefore = await readFile(runtimePointerPath(f.legacy), 'utf8')
  const paths = resolveActivePortablePaths(f.root)!
  assert.equal(paths.dshHome, f.previousHome)
  assert.equal(paths.runtime, f.previousRuntime)
  assert.equal(await readFile(join(paths.dshHome, 'data', 'session.json'), 'utf8'), '{"format":"old","message":"last committed session"}')
  assert.equal(await readFile(runtimePointerPath(f.legacy), 'utf8'), pointerBefore, 'path selection is read-only; main owns rollback transaction')
})

test('未提交 pending 没有 previous 时失败关闭，不落入共享旧数据', async () => {
  const f = await fixture(true)
  const { previous: _previous, ...withoutPrevious } = f.pointer
  await put(runtimePointerPath(f.legacy), JSON.stringify(withoutPrevious))
  assert.throws(() => resolveActivePortablePaths(f.root), /没有可回滚家园|安全停止/)
})

test('pending previous 不可启动、身份漂移或路径越界时不能回退共享旧家园', async t => {
  await t.test('previous 的官方入口缺失', async () => {
    const f = await fixture(true)
    await rm(join(f.previousRuntime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    assert.throws(() => resolveActivePortablePaths(f.root))
  })
  await t.test('previous 的包版本与指针身份不一致', async () => {
    const f = await fixture(true)
    await writeRuntime(f.previousRuntime, f.currentVersion)
    assert.throws(() => resolveActivePortablePaths(f.root))
  })
  await t.test('previous 绝对路径不能指向其他便携目录', async () => {
    const f = await fixture(true), outside = await fixture()
    await put(runtimePointerPath(f.legacy), JSON.stringify({ ...f.pointer, previous: { ...f.pointer.previous, relativePath: outside.previousRuntime } }))
    assert.throws(() => resolveActivePortablePaths(f.root))
  })
})

test('schema2 绑定损坏、版本不一致、越界或槽缺失都不能回退到旧数据', async t => {
  const invalid = [
    '{', 'null',
    JSON.stringify({ schema: 3, runtimeVersion: '0.3.0-rc.1', generation: 'current-home' }),
    JSON.stringify({ schema: 2, runtimeVersion: '0.3.0-rc.1', generation: 'current-home' }),
    JSON.stringify({ schema: 2, runtimeVersion: '0.2.0-rc.2', generation: 'current-home', runtimeRelativePath: 'Data/Runtime/Harness/slots/next-runtime' }),
    JSON.stringify({ schema: 2, runtimeVersion: '0.3.0-rc.1', generation: '..', runtimeRelativePath: 'Data/Runtime/Harness/slots/next-runtime' }),
    JSON.stringify({ schema: 2, runtimeVersion: '0.3.0-rc.1', generation: 'current-home', runtimeRelativePath: 'Data/Runtime/Harness/slots/../../DSH' }),
    JSON.stringify({ schema: 2, runtimeVersion: '0.3.0-rc.1', generation: 'current-home', runtimeRelativePath: 'Data/Runtime/Harness/slots/missing-runtime' }),
  ]
  for (const value of invalid) await t.test(value, async () => {
    const f = await fixture()
    await put(f.bindingPath, value)
    assert.throws(() => resolvePortablePaths(f.root, process.execPath, f.currentVersion), /绑定校验失败|拒绝回落/)
    assert.throws(() => resolveActivePortablePaths(f.root), /绑定校验失败|拒绝回落/)
  })
})

test('pending 的 previous 绑定损坏同样拒绝启动，不退回当前新家园或共享旧家园', async () => {
  const f = await fixture(true)
  await put(portableRuntimeHomeBindingPath(f.root, f.previousVersion), '{')
  assert.throws(() => resolveActivePortablePaths(f.root), /绑定校验失败|拒绝回落/)
})

test('schema2 槽实际版本必须匹配绑定，即使包与入口都完整', async () => {
  const f = await fixture()
  await writeRuntime(f.currentRuntime, '0.9.0')
  assert.throws(() => resolvePortablePaths(f.root, process.execPath, f.currentVersion), /绑定校验失败|拒绝回落/)
})

test('同版本不代表同一槽：schema2 家园绑定必须指向实际选中的槽', async t => {
  for (const pending of [false, true]) await t.test(pending ? 'pending previous 槽' : 'committed current 槽', async () => {
    const f = await fixture(pending)
    const version = pending ? f.previousVersion : f.currentVersion
    const anotherRuntime = join(f.root, 'Data', 'Runtime', 'Harness', 'slots', 'same-version-other-fingerprint')
    await writeRuntime(anotherRuntime, version)
    const binding = pending ? f.previousBinding : f.binding
    await put(portableRuntimeHomeBindingPath(f.root, version), JSON.stringify({ ...binding, runtimeRelativePath: relative(f.root, anotherRuntime).replaceAll('\\', '/') }))
    assert.throws(() => resolveActivePortablePaths(f.root), /槽身份不一致|另一槽/)
  })
})

test('binding 的父目录经 junction 指向外部时拒绝读取，即使 JSON 内容有效', async () => {
  const f = await fixture(), outside = await fixture()
  const homes = dirname(f.bindingPath)
  await rename(homes, `${homes}-original`)
  await symlink(dirname(outside.bindingPath), homes, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => resolveActivePortablePaths(f.root), /绑定/)
})

test('schema2 家园 generation 及全局 runtime 槽均拒绝外部目录链接', async t => {
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  await t.test('家园代号经 junction 指向其他便携目录', async () => {
    const f = await fixture(), outside = await fixture()
    const linked = join(f.root, 'Data', 'DSH-generations', 'external-home')
    await symlink(dirname(outside.currentHome), linked, type)
    await put(f.bindingPath, JSON.stringify({ ...f.binding, generation: 'external-home' }))
    assert.throws(() => resolvePortablePaths(f.root, process.execPath, f.currentVersion), /绑定校验失败|拒绝回落/)
  })
  await t.test('全局槽经 junction 指向其他便携目录', async () => {
    const f = await fixture(), outside = await fixture()
    const linked = join(f.root, 'Data', 'Runtime', 'Harness', 'slots', 'external-runtime')
    await symlink(outside.currentRuntime, linked, type)
    await put(f.bindingPath, JSON.stringify({ ...f.binding, runtimeRelativePath: 'Data/Runtime/Harness/slots/external-runtime' }))
    assert.throws(() => resolvePortablePaths(f.root, process.execPath, f.currentVersion), /绑定校验失败|拒绝回落/)
  })
  await t.test('槽内部官方 package 经 junction 指向外部文件也拒绝', async () => {
    const f = await fixture(), outside = await fixture()
    const linkedRuntime = join(f.root, 'Data', 'Runtime', 'Harness', 'slots', 'linked-package-runtime')
    const scope = join(linkedRuntime, 'node_modules', '@deepseek-ai')
    await mkdir(scope, { recursive: true })
    await symlink(join(outside.currentRuntime, 'node_modules', '@deepseek-ai', 'dsh'), join(scope, 'dsh'), type)
    await put(f.bindingPath, JSON.stringify({ ...f.binding, runtimeRelativePath: 'Data/Runtime/Harness/slots/linked-package-runtime' }))
    assert.throws(() => resolvePortablePaths(f.root, process.execPath, f.currentVersion), /绑定校验失败|拒绝回落/)
  })
})
