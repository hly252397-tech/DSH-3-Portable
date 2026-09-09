import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pluginClient = new URL(
  '../../Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js',
  import.meta.url,
)

test('按用户要求移除侧栏知识与数据快捷入口，保留右侧卡片', async () => {
  const source = await readFile(pluginClient, 'utf8')

  for (const id of ['dsh-task-search', 'dsh-automation', 'dsh-extensions', 'dsh-knowledge-center', 'sidebar-spaces-workbench']) {
    assert.doesNotMatch(source, new RegExp(`id:\\s*["']${id}["']`))
  }
  assert.doesNotMatch(source, /sidebar\.footer\.action/)
  assert.match(source, /id:\s*["']space-knowledge["']/)
  assert.match(source, /id:\s*["']space-database["']/)
})

test('去重不删除任务搜索实现，顶部放大镜仍打开 DSH 会话搜索', async () => {
  const [plugin, codexUi] = await Promise.all([
    readFile(pluginClient, 'utf8'),
    readFile(new URL('../../Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js', import.meta.url), 'utf8'),
  ])

  assert.match(plugin, /function TaskSearchApp\(\)/)
  assert.match(plugin, /type === ["']space-search["'] \? h\(TaskSearchApp\)/)
  assert.match(codexUi, /className: "dcu-icon dcu-search-trigger"/)
  assert.match(codexUi, /search\.current\?\.open\(\)/)
})

test('全局设置保留可访问的官方入口，不能作为重复快捷方式隐藏', async () => {
  const codexUi = await readFile(
    new URL('../../Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js', import.meta.url),
    'utf8',
  )

  assert.match(codexUi, /className: "dcu-settings-seat"/)
  assert.doesNotMatch(codexUi, /dcu-settings-seat-proxy/)
  assert.match(codexUi, /children: renderSlot\("sidebar\.settings"/)
  assert.match(codexUi, /settingsSeat\.current\?\.querySelector\("\[aria-haspopup=\\"dialog\\"\]"\)\?\.click\(\)/)
})
