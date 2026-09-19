import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

// 实机 profile 产物；全新检出（如 CI）缺失时相关用例跳过。
const sourcePath = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js')
const codexClientPath = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js')
const haveLiveSpacesClient = existsSync(sourcePath)
const haveLiveCodexClient = existsSync(codexClientPath)
async function model() {
  let api: any
  const source = (await readFile(sourcePath, 'utf8')).replace('exports.apply = apply;', 'exports.layout = { HOME_DETAIL_CSS, HOME_CARD_ALIGNMENT_CSS }; exports.apply = apply;')
  runInNewContext(source, { window: { __ModuleLoader__: { load(def: any) { api = def.factory(() => ({})).layout } } } })
  return api
}

// 2026-09-13：「任务最近活动分布」整卡按用户决定下线。任务快照只带每个任务的 updatedAt，
// 12 个月里通常只有 1 个月有数据，52x7 热力图与 12 月柱状图都撑不起这块版式。
// 这里钉住「卡片已彻底退场」——挂载点、数据函数、组件与样式都不该再留在产物里。
test('hero activity card is retired and no longer mounts a host', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')
  const source = await readFile(sourcePath, 'utf8')
  assert.match(source, /function retireHeroActivityGrid\(\)/)
  assert.match(source, /ctx\.effect\(retireHeroActivityGrid,/)
  for (const gone of [
    'function ActivityGrid',
    'function activityMonths',
    'function activityTotal',
    'mountHeroActivityGrid',
    'data-dss-activity-host="true"',
  ]) {
    assert.ok(!source.includes(gone), `已下线的活动卡不应再保留 ${gone}`)
  }
  // 残留的 dss-activity 只允许出现在注释或「清理旧宿主」那一行里。
  const leftovers = source.split('\n').filter(line => line.includes('dss-activity'))
  assert.ok(leftovers.length > 0, '清理逻辑本身必须保留')
  for (const line of leftovers) {
    assert.match(line.trim(), /^(\/\/|for \(const host of document\.querySelectorAll)/, `意外残留渲染路径：${line.trim()}`)
  }
  // 输入卡继续沿用 09-12 定的单一高度变量；活动卡样式必须全部消失。
  const api = await model()
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /--dss-home-card-height: calc\(15 \* var\(--dss-home-unit\)\)/)
  assert.doesNotMatch(api.HOME_CARD_ALIGNMENT_CSS, /dss-activity/)
  assert.doesNotMatch(api.HOME_DETAIL_CSS, /dss-activity/)
})

test('homepage cards share a responsive content column without a separate composer spacer', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')
  const api = await model()
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /container-type: inline-size/)
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /transform: none !important/)
  // 活动卡下线后只剩输入卡，但仍走同一个内容列与同一个高度变量（docs 06/15/19/21
  // 禁止给卡片加自己的 max-width，也不允许出现卡间自动外边距）。
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /:is\(\.wSkVaW_heroWorkspaceRow,\.uV2eYG_card\)/)
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /min-height: var\(--dss-home-card-height\)/)
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /--dss-home-card-height: calc\(15 \* var\(--dss-home-unit\)\)/)
  assert.doesNotMatch(api.HOME_CARD_ALIGNMENT_CSS, /dss-activity/)
  // An automatic margin inside the input card pins its toolbar to the bottom.
  // It must never become a spacer between the separate homepage cards.
  const toolbarRule = /[^{}]*\.uV2eYG_card > \.uV2eYG_row\s*\{[^{}]*\}/g
  const toolbar = api.HOME_CARD_ALIGNMENT_CSS.match(toolbarRule)?.join('') ?? ''
  assert.match(toolbar, /margin-top:\s*auto/)
  assert.doesNotMatch(api.HOME_CARD_ALIGNMENT_CSS.replace(toolbarRule, ''), /margin-top:\s*auto/)
  assert.match(api.HOME_DETAIL_CSS, /focus-visible/)
  assert.match(api.HOME_DETAIL_CSS, /max-height:720px/)
})

test('sidebar search uses localized real text in its existing actionable button', async t => {
  if (!haveLiveCodexClient) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  const source = await readFile(codexClientPath, 'utf8')
  assert.match(source, /className: "dcu-icon dcu-search-trigger"/)
  assert.match(source, /className: "dcu-search-label", hidden: true, children: t\("sidebar.search"\)/)
  assert.match(source, /search\.current\?\.open\(\)/)
})

test('Qoder geometry is shared across color schemes and respects the resized sidebar', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')
  const { HOME_DETAIL_CSS } = await model()
  assert.match(HOME_DETAIL_CSS, /body\[data-color-scheme\]\[data-dsh-preset="qoder"\]/)
  assert.doesNotMatch(HOME_DETAIL_CSS, /data-color-scheme="light"/)
  assert.match(HOME_DETAIL_CSS, /--dcu-sidebar-wide-width: 100% !important/)
  assert.match(HOME_DETAIL_CSS, /\.dcu-root\.dcu-compact \.dcu-foot \{ width: 36px !important/)
  assert.match(HOME_DETAIL_CSS, /font-family: var\(--dss-home-font\) !important/)
})

test('coding mode copy is localized real text without replacing the native brand elsewhere', async t => {
  if (!haveLiveCodexClient) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  const source = await readFile(codexClientPath, 'utf8')
  assert.match(source, /className: "dcu-mode-label", hidden: true, children: t\("sidebar.codingMode"\)/)
  assert.match(source, /"sidebar.codingMode": "编程"/)
  assert.match(source, /"sidebar.codingMode": "Code"/)
  assert.match(source, /BrandWordmark, \{ size: 24 \}/)
})
