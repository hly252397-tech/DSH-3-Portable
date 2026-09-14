import assert from 'node:assert/strict'
import { isAbsolute, relative } from 'node:path'
import test from 'node:test'

import { applyPortableEnvironment, resolvePortablePaths } from '../src/portable-paths.js'

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
