import assert from 'node:assert/strict'
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import test from 'node:test'

import { applyPortableEnvironment, readRuntimePackageVersion, resolveActivePortablePaths, resolvePortablePaths } from '../src/portable-paths.js'
import { makeTrackedTempDir } from './helpers/tmp.js'

test('便携路径全部收口在当前便携根目录', t => {
  if (process.platform !== 'win32') return t.skip('便携根以 Windows 盘符路径表达，仅在 win32 验证')
  const paths = resolvePortablePaths('G:\\DSH-3-Portable')
  assert.ok(paths)
  for (const [name, path] of Object.entries(paths)) {
    assert.equal(isAbsolute(path), true, `${name} must be absolute`)
    if (name === 'root') continue
    const child = relative(paths.root, path)
    assert.equal(child.startsWith('..'), false, `${name} escaped portable root`)
  }
})

test('便携环境覆盖 DSH、用户目录、缓存和常见开发工具目录', t => {
  if (process.platform !== 'win32') return t.skip('便携根以 Windows 盘符路径表达，仅在 win32 验证')
  const paths = resolvePortablePaths('G:\\DSH-3-Portable')!
  const environment: NodeJS.ProcessEnv = {}
  applyPortableEnvironment(paths, environment)
  assert.equal(environment.DSH_HOME, paths.dshHome)
  assert.equal(environment.USERPROFILE, paths.home)
  assert.equal(environment.APPDATA, paths.appData)
  assert.equal(environment.TEMP, paths.temp)
  // PNPM_STORE_DIR 已于 2026-09-14 退役：pnpm 不读这个变量，src/ 里也没有任何读取方
  // （仓库位置由 profile 的 .modules.yaml 记录 + 启动时注入的 DSH_PNPM_STORE_DIR 决定）。
  // 这里改钉「它不再被导出」，避免死变量复活。
  assert.equal(environment.PNPM_STORE_DIR, undefined)
  assert.match(environment.GIT_CONFIG_GLOBAL!, /Development[\\/]gitconfig$/)
})

test('未设置便携根目录时保持普通安装模式', () => {
  assert.equal(resolvePortablePaths(undefined), undefined)
  assert.equal(resolvePortablePaths('  '), undefined)
})

async function homeFixture() {
  const root = await makeTrackedTempDir(join(tmpdir(), 'dsh-home-binding-'))
  const generation = 'v4-candidate'
  const generationRoot = join(root, 'Data', 'DSH-generations', generation)
  const home = join(generationRoot, 'home')
  const runtime = join(generationRoot, 'runtime', 'dsh-runtime')
  const bindingPath = join(root, 'Data', 'Updates', 'Harness', 'homes', '0.1.7-rc.2.json')
  const binding = { schema: 1, runtimeVersion: '0.1.7-rc.2', generation }
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  await mkdir(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await mkdir(join(root, 'Data', 'Updates', 'Harness', 'homes'), { recursive: true })
  await mkdir(join(root, 'Data', 'DSH'), { recursive: true })
  await writeFile(join(root, 'Data', 'DSH', 'original.txt'), 'original V3 data')
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"private":true}')
  await writeFile(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.7-rc.2"}')
  await writeFile(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
  await writeFile(bindingPath, JSON.stringify(binding))
  const resolveNew = () => resolvePortablePaths(root, process.execPath, '0.1.7-rc.2')
  return { root, home, runtime, bindingPath, binding, resolveNew }
}

test('新版绑定独立家园和运行时，旧版路径与原数据不变', async () => {
  const f = await homeFixture()
  const next = f.resolveNew()
  assert.ok(next)
  assert.equal(next.dshHome, f.home)
  assert.equal(next.runtime, f.runtime)
  const previous = resolvePortablePaths(f.root)!
  assert.equal(previous.dshHome, join(f.root, 'Data', 'DSH'))
  assert.equal(previous.runtime, join(f.root, 'Data', 'Runtime', 'dsh-runtime'))
  const environment: NodeJS.ProcessEnv = {}
  applyPortableEnvironment(next, environment)
  assert.equal(environment.DSH_HOME, f.home)
  assert.equal(environment.DSH_DESKTOP_RUNTIME_DIR, f.runtime)
  assert.equal(await readFile(join(previous.dshHome, 'original.txt'), 'utf8'), 'original V3 data')
})

test('损坏或版本不匹配的家园绑定不得静默回落到原数据', async () => {
  const f = await homeFixture()
  for (const content of ['{', JSON.stringify({ ...f.binding, schema: 2 }), JSON.stringify({ ...f.binding, runtimeVersion: '0.1.6-alpha.2' })]) {
    await writeFile(f.bindingPath, content)
    assert.throws(f.resolveNew, /家园|绑定/)
  }
})

test('家园绑定拒绝越界代号和不完整副本', async () => {
  const f = await homeFixture()
  for (const generation of ['../../DSH', '..', 'C:\\outside', 'missing-copy']) {
    await writeFile(f.bindingPath, JSON.stringify({ ...f.binding, generation }))
    assert.throws(f.resolveNew, /家园|绑定/)
  }
})

test('家园绑定拒绝经目录链接逃回原数据', async () => {
  const f = await homeFixture()
  const linked = join(f.root, 'Data', 'DSH-generations', 'linked-home')
  await symlink(join(f.root, 'Data', 'DSH'), linked, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(f.bindingPath, JSON.stringify({ ...f.binding, generation: 'linked-home' }))
  assert.throws(f.resolveNew, /家园|绑定/)
})

async function writeSlotManifest(root: string, content: string): Promise<string> {
  const manifestDir = join(root, 'Data', 'Runtime', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(manifestDir, { recursive: true })
  const manifestPath = join(manifestDir, 'package.json')
  await writeFile(manifestPath, content)
  return manifestPath
}

test('启动入口按活动槽版本二段解析：旧版本不触发绑定，新版本重定向家园', async () => {
  const f = await homeFixture()
  const legacy = resolveActivePortablePaths(f.root)!
  assert.equal(legacy.dshHome, join(f.root, 'Data', 'DSH'))
  await writeSlotManifest(f.root, '{"name":"@deepseek-ai/dsh","version":"0.1.6-alpha.2"}')
  assert.equal(resolveActivePortablePaths(f.root)!.dshHome, join(f.root, 'Data', 'DSH'))
  await writeSlotManifest(f.root, '{"name":"@deepseek-ai/dsh","version":"0.1.7-rc.2"}')
  const next = resolveActivePortablePaths(f.root)!
  assert.equal(next.dshHome, f.home)
  assert.equal(next.runtime, f.runtime)
  assert.equal(readRuntimePackageVersion(join(f.root, 'Data', 'Runtime', 'dsh-runtime')), '0.1.7-rc.2')
})

test('启动入口在运行时清单缺失或损坏时按默认布局启动', async () => {
  const f = await homeFixture()
  assert.equal(resolveActivePortablePaths(f.root)!.dshHome, join(f.root, 'Data', 'DSH'))
  for (const content of ['{', '{"name":"other","version":"0.1.7-rc.2"}', '{"name":"@deepseek-ai/dsh","version":"not-a-version"}']) {
    await writeSlotManifest(f.root, content)
    assert.equal(resolveActivePortablePaths(f.root)!.dshHome, join(f.root, 'Data', 'DSH'))
  }
  assert.equal(readRuntimePackageVersion(join(f.root, 'Data', 'Runtime', 'dsh-runtime')), undefined)
})
