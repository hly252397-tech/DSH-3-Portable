import assert from 'node:assert/strict'
import { isAbsolute, relative } from 'node:path'
import test from 'node:test'

import { applyPortableEnvironment, resolvePortablePaths } from '../src/portable-paths.js'

test('便携路径全部收口在当前便携根目录', () => {
  const paths = resolvePortablePaths('G:\\DSH-3-Portable')
  assert.ok(paths)
  for (const [name, path] of Object.entries(paths)) {
    assert.equal(isAbsolute(path), true, `${name} must be absolute`)
    if (name === 'root') continue
    const child = relative(paths.root, path)
    assert.equal(child.startsWith('..'), false, `${name} escaped portable root`)
  }
})

test('便携环境覆盖 DSH、用户目录、缓存和常见开发工具目录', () => {
  const paths = resolvePortablePaths('G:\\DSH-3-Portable')!
  const environment: NodeJS.ProcessEnv = {}
  applyPortableEnvironment(paths, environment)
  assert.equal(environment.DSH_HOME, paths.dshHome)
  assert.equal(environment.USERPROFILE, paths.home)
  assert.equal(environment.APPDATA, paths.appData)
  assert.equal(environment.TEMP, paths.temp)
  assert.match(environment.PNPM_STORE_DIR!, /Development[\\/]pnpm-store$/)
  assert.match(environment.GIT_CONFIG_GLOBAL!, /Development[\\/]gitconfig$/)
})

test('未设置便携根目录时保持普通安装模式', () => {
  assert.equal(resolvePortablePaths(undefined), undefined)
  assert.equal(resolvePortablePaths('  '), undefined)
})
