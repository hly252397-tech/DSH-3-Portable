import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const installerUrl = new URL('../../工作空间/侧栏空间插件/install.ps1', import.meta.url)
const haveInstaller = existsSync(new URL('../../工作空间/侧栏空间插件/install.ps1', import.meta.url))

test('便携插件安装采用暂存校验、原子清单和失败回滚', async t => {
  if (!haveInstaller) return t.skip('工作空间 install.ps1 缺失（CI 全新检出）')
  const source = await readFile(installerUrl, 'utf8')
  assert.match(source, /\.stage-/)
  assert.match(source, /Assert-PluginOutput \$NodeStage/)
  assert.match(source, /System\.IO\.File\]::Replace/)
  assert.match(source, /Write-RawAtomic \$ManifestPath \$originalManifest/)
})

test('便携插件安装只请求 DSH 子服务热重载，不要求退出桌面', async t => {
  if (!haveInstaller) return t.skip('工作空间 install.ps1 缺失（CI 全新检出）')
  const source = await readFile(installerUrl, 'utf8')
  assert.match(source, /\.dsh-reload-request/)
  assert.match(source, /桌面保持运行|桌面程序.*保持运行/)
  assert.doesNotMatch(source, /完全退出 DSH/)
})
