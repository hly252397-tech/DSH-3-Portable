import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('插件补种与待更新失败都显示原因，冒烟模式不等待弹窗', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')
  const helper = /^async function showStartupPluginWarning\([\s\S]*?^\}/m.exec(source)?.[0]
  assert.ok(helper, '未能在构建产物中找到 showStartupPluginWarning')
  const dialogs: Array<{ title: string; message: string; detail: string }> = []
  const env: Record<string, string> = {}
  const scope = vm.createContext({
    process: { env },
    desktopText: (zh: string) => zh,
    dialog: { async showMessageBox(options: typeof dialogs[number]) { dialogs.push(options) } },
  })
  vm.runInContext(helper, scope)
  for (const kind of ['seed', 'pending']) {
    await vm.runInContext(`showStartupPluginWarning('${kind}', '安装失败原因')`, scope) as Promise<void>
  }
  assert.equal(dialogs.length, 2, '两类失败都必须弹出提示')
  assert.notEqual(dialogs[0]?.message, dialogs[1]?.message, '两类失败的原因不同，文案不能混用')
  assert.equal(dialogs.every(item => item.detail.includes('安装失败原因')), true, '必须把真实错误带进详情')
  assert.equal(dialogs.every(item => item.title !== '' && item.message !== ''), true)
  // 冒烟由错误日志判定成败，不能等一个人工弹窗。
  env.DSH_DESKTOP_SMOKE_READY_FILE = 'test-ready'
  for (const kind of ['seed', 'pending']) {
    await vm.runInContext(`showStartupPluginWarning('${kind}', '失败')`, scope) as Promise<void>
  }
  assert.equal(dialogs.length, 2, '冒烟运行不得弹出模态提示')
})

test('两处启动失败分支确实调用提示，失败不再只写日志', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.match(source, /showStartupPluginWarning\('seed', message\)/, '内置插件补种失败必须提示用户')
  assert.match(source, /showStartupPluginWarning\('pending', message\)/, '待更新应用失败必须提示用户')
  // 提示必须排在写日志之后调用，日志与用户可见反馈不能二选一。
  assert.match(source, /plugin-seed\.log[\s\S]{0,200}showStartupPluginWarning\('seed'/)
  assert.match(source, /plugin-update\.log[\s\S]{0,200}showStartupPluginWarning\('pending'/)
})
