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
  const source = (await readFile(sourcePath, 'utf8')).replace('exports.apply = apply;', 'exports.layout = { activityDays, activityMonths, HOME_DETAIL_CSS, HOME_CARD_ALIGNMENT_CSS }; exports.apply = apply;')
  runInNewContext(source, { window: { __ModuleLoader__: { load(def: any) { api = def.factory(() => ({})).layout } } } })
  return api
}

test('month labels share the 52 week columns, including 13 month fragments and leap years', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')
  const api = await model()
  for (const year of [2024, 2025, 2026]) for (let month = 0; month < 12; month++) for (const date of [1, 5, 15, 28]) {
    const days = api.activityDays({ ids: [], byId: {} }, new Date(year, month, date, 12))
    const labels = api.activityMonths(days)
    assert.equal(days.length, 364)
    assert.equal(labels.flatMap((label: any) => label.months).join(','), days.filter((d: any, i: number) => !i || d.month !== days[i - 1].month).map((d: any) => d.month).join(','))
    assert.equal(labels[0].column, 1)
    assert.equal(labels.at(-1).end, 53)
    for (const label of labels) {
      assert.equal(label.column, Math.floor(days.findIndex((d: any) => d.day === label.day) / 7) + 1)
      assert.ok(label.end > label.column)
    }
  }
  assert.equal(api.activityMonths(api.activityDays({}, new Date(2026, 8, 5))).length, 13)
})

test('homepage cards share a responsive content column without a separate composer spacer', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')
  const api = await model()
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /container-type: inline-size/)
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /transform: none !important/)
  assert.match(api.HOME_CARD_ALIGNMENT_CSS, /:is\(\.dss-activity,\.uV2eYG_card\)/)
  assert.doesNotMatch(api.HOME_CARD_ALIGNMENT_CSS, /margin-top: auto/)
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
  assert.match(HOME_DETAIL_CSS, /background: var\(--dsh-bg-surface-1\)/)
})

test('coding mode copy is localized real text without replacing the native brand elsewhere', async t => {
  if (!haveLiveCodexClient) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  const source = await readFile(codexClientPath, 'utf8')
  assert.match(source, /className: "dcu-mode-label", hidden: true, children: t\("sidebar.codingMode"\)/)
  assert.match(source, /"sidebar.codingMode": "编程"/)
  assert.match(source, /"sidebar.codingMode": "Code"/)
  assert.match(source, /BrandWordmark, \{ size: 24 \}/)
})
