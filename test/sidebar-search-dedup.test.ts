import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// 实机 profile 产物；全新检出（如 CI）缺失时相关用例跳过。
const pluginClient = new URL(
  '../../Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js',
  import.meta.url,
)
const codexClient = new URL('../../Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js', import.meta.url)
const haveLiveSpacesClient = existsSync(pluginClient)
const haveLiveCodexClient = existsSync(codexClient)

test('按用户要求移除侧栏知识与数据快捷入口，保留右侧卡片', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')
  const source = await readFile(pluginClient, 'utf8')

  for (const id of ['dsh-task-search', 'dsh-automation', 'dsh-extensions', 'dsh-knowledge-center', 'sidebar-spaces-workbench']) {
    assert.doesNotMatch(source, new RegExp(`id:\\s*["']${id}["']`))
  }
  assert.doesNotMatch(source, /sidebar\.footer\.action/)
  assert.match(source, /id:\s*["']space-knowledge["']/)
  assert.match(source, /id:\s*["']space-database["']/)
})

test('去重不删除任务搜索实现，顶部放大镜仍打开 DSH 会话搜索', async t => {
  if (!haveLiveSpacesClient || !haveLiveCodexClient) return t.skip('实机插件产物缺失（CI 全新检出）')
  const [plugin, codexUi] = await Promise.all([
    readFile(pluginClient, 'utf8'),
    readFile(codexClient, 'utf8'),
  ])

  assert.match(plugin, /function TaskSearchApp\(\)/)
  assert.match(plugin, /type === ["']space-search["'] \? h\(TaskSearchApp\)/)
  assert.match(codexUi, /className: "dcu-icon dcu-search-trigger"/)
  assert.match(codexUi, /search\.current\?\.open\(\)/)
})

test('全局设置保留可访问的官方入口，不能作为重复快捷方式隐藏', async t => {
  if (!haveLiveCodexClient) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  const codexUi = await readFile(codexClient, 'utf8')

  assert.match(codexUi, /className: "dcu-settings-seat"/)
  assert.doesNotMatch(codexUi, /dcu-settings-seat-proxy/)
  assert.match(codexUi, /children: renderSlot\("sidebar\.settings"/)
  assert.match(codexUi, /settingsSeat\.current\?\.querySelector\("\[aria-haspopup=\\"dialog\\"\]"\)\?\.click\(\)/)
})
