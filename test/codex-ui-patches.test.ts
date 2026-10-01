// codex-ui「插件配置」分区补丁的护栏测试（2026-10-01）。
//
// 这个 bug 复发过一次（2026-09-28 修好，2026-09-30 新建 auto-020-rc2 家园时原样复发），所以
// 测试必须守住的不只是"补丁内容对不对"，更是三条更隐蔽的失效路径：
//   ① 补丁应用器自己写错却报成功（正向用例）；
//   ② 重复应用把文件改坏（幂等用例：第二次必须是 no-op 且字节不变）；
//   ③ 上游 codex-ui 变形后"匹配不上就静默跳过"——这会把同一个坑留给下一个人（变形用例必须抛错）。
//
// 另加一条真实家园巡检：CI 是全新检出会没有 Data/ 产物，按仓库惯例 existsSync 守卫 + skip，
// 不让本机实机状态变成 CI 红灯。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// 与 settings-nav-distinct-icons.test.ts 同惯例：按仓库根解析（编译产物在 dist/test/，
// 相对 import.meta.url 会指到 dist/customizations/ 这种不存在的位置）。
const moduleUrl = pathToFileURL(resolve('customizations/codex-ui-patches/apply.mjs')).href
const patches = await import(moduleUrl) as {
  PATCHES: { id: string; from: string; to: string }[]
  applyToText: (source: string) => { text: string; results: { id: string; state: string }[]; changed: boolean }
  targetFiles: (root: string) => { file: string; hardlinked: boolean }[]
  run: (root: string, verifyOnly: boolean) => { ok: boolean; files: { file: string; status: string; changed: boolean }[] }
}

/**
 * 一份与 codex-ui 1.1.18 同形的未打补丁源码，只保留补丁锚点所在的最小上下文。
 * 缩进按深度程序化生成：补丁锚点是带前导 tab 的精确文本匹配，手写缩进极易差一级
 * （本文件就为此返工过一次），而差一级的表现恰恰是"补丁漂移"——会把笔误误报成上游变形。
 */
function upstreamFixture(): string {
  const line = (depth: number, text: string) => '\t'.repeat(depth) + text
  return [
    line(3, 'function registerPluginConfigSection(ctx) {'),
    line(4, 'const t = ctx.locale.bind(NS);'),
    line(4, 'ctx.slots.inject("settings.section", () => {'),
    line(5, 'let current;'),
    line(5, 'let remove;'),
    line(5, 'const refresh = () => {'),
    line(6, 'const entry = ctx.slots.entriesOfSlot("main").find((item) => item.options.key === OFFICIAL_PLUGINS_PANEL_ID);'),
    line(6, 'if (entry === current) return;'),
    line(6, 'remove?.();'),
    line(6, 'remove = void 0;'),
    line(6, 'current = entry;'),
    line(6, 'const Official = officialPluginsPage(entry);'),
    line(5, 'if (Official === void 0 || entry?.inject === void 0 || entry.locale !== OFFICIAL_PLUGIN_MANAGER_NS) return;'),
    line(5, 'remove = ctx.slots.register({'),
    line(6, 'name: "settings.section",'),
    line(6, 'id: PLUGIN_CONFIG_SECTION_ID,'),
    line(6, 'order: 16,'),
    line(6, 'label: () => t("settings.pluginConfig"),'),
    line(6, 'locale: entry.locale,'),
    line(6, 'inject: entry.inject'),
    line(5, '}, createPluginConfigSection(Official, () => t("settings.pluginConfig"), ctx.slots, bindPluginConfigLocale((ns) => {'),
    line(6, 'const translate = ctx.locale.bind(ns);'),
    line(6, 'return (key, params) => translate(key, params);'),
    line(5, '})));'),
    line(5, '};'),
    line(4, 'return () => {};'),
    line(4, '});'),
    line(3, '}'),
  ].join('\n')
}

test('正向：未打补丁的原型会被补上 store 转发与准入守卫', () => {
  const result = patches.applyToText(upstreamFixture())
  assert.equal(result.changed, true)
  assert.deepEqual(result.results.map((item) => item.state), ['patched', 'patched'])
  assert.ok(result.text.includes('entry.store === void 0'), '准入判断必须拒绝缺 store 的 main 条目')
  assert.ok(result.text.includes('store: entry.store,'), 'settings.section 必须转发 entry.store')
})

test('回归语义：补完后官方页拿得到 useStore 句柄', () => {
  const patched = patches.applyToText(upstreamFixture()).text
  // 官方 PluginManagerPage 首渲染即调用 props.useStore()；renderer 只为「带 entry.store 的条目」
  // 生成 useStore/actions。少一个 store 转发就是 props.useStore is not a function → 条目退位。
  const forwardsStore = /id: PLUGIN_CONFIG_SECTION_ID,[\s\S]*?store: entry\.store,[\s\S]*?inject: entry\.inject/.test(patched)
  assert.equal(forwardsStore, true, 'store 必须与 inject 一起出现在同一次 slots.register 调用里')
})

test('幂等：第二次应用是 no-op 且字节不变', () => {
  const once = patches.applyToText(upstreamFixture()).text
  const twice = patches.applyToText(once)
  assert.equal(twice.changed, false, '已打补丁不得被再次改写')
  assert.equal(twice.text, once, '幂等要求字节完全一致')
  assert.deepEqual(twice.results.map((item) => item.state), ['applied', 'applied'])
})

test('负向：上游变形时必须抛错，绝不静默跳过', () => {
  const drifted = upstreamFixture().replace('entry.locale !== OFFICIAL_PLUGIN_MANAGER_NS', 'entry.locale !== OFFICIAL_PLUGIN_MANAGER_NS_V2')
  assert.throws(() => patches.applyToText(drifted), (error: any) => {
    assert.equal(error.code, 'PATCH_SHAPE_DRIFT')
    assert.ok(String(error.message).includes('registerPluginConfigSection'), '报错必须附上游现场，便于人工复核')
    return true
  })
})

test('补丁锚点在真实上游文件里各自唯一（防误伤同名片段）', () => {
  for (const patch of patches.PATCHES) {
    const fixture = upstreamFixture()
    assert.equal(fixture.split(patch.from).length - 1, 1, `${patch.id} 的 from 在原型中必须唯一`)
    const patchedOnce = patches.applyToText(fixture).text
    assert.equal(patchedOnce.split(patch.to).length - 1, 1, `${patch.id} 的 to 在补完后必须唯一`)
  }
})

test('run()：缺失副本在 verify 模式报 missing，应用模式补齐后退出条件为真', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-ui-patch-'))
  const homes = [join(root, 'Data', 'DSH'), join(root, 'Data', 'DSH-generations', 'gen-a', 'home')]
  for (const home of homes) {
    const file = join(home, 'profiles', 'web', 'node_modules', '@michengai', 'dsh-codex-ui', 'lib', 'client.js')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, upstreamFixture(), 'utf8')
  }
  // 没装 codex-ui 的家园不算问题，必须被跳过而不是报错。
  mkdirSync(join(root, 'Data', 'DSH-generations', 'gen-b', 'home'), { recursive: true })

  const verify = patches.run(root, true)
  assert.equal(verify.ok, false, '两处缺失时 verify 必须判否')
  assert.deepEqual(verify.files.map((item) => item.status), ['missing', 'missing'])

  const applied = patches.run(root, false)
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.files.map((item) => item.status), ['patched', 'patched'])
  assert.equal(readFileSync(join(homes[0]!, 'profiles', 'web', 'node_modules', '@michengai', 'dsh-codex-ui', 'lib', 'client.js'), 'utf8').includes('store: entry.store'), true)
  assert.equal(patches.run(root, true).ok, true, '复跑 verify 必须通过')
})

test('实机家园巡检：所有已安装副本都已打补丁且不与 pnpm store 共用 inode', (t) => {
  if (!existsSync(resolve('Data'))) return t.skip('实机产物缺失（CI 全新检出）')
  const files = patches.targetFiles(resolve('.'))
  if (files.length === 0) return t.skip('实机未安装 codex-ui')
  for (const item of files) {
    const text = readFileSync(item.file, 'utf8')
    assert.ok(text.includes('store: entry.store'), `未打补丁：${item.file}`)
    assert.equal(item.hardlinked, false, `仍与 pnpm store 共用 inode，就地改会污染依赖树：${item.file}`)
  }
})
