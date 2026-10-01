#!/usr/bin/env node
// codex-ui「插件配置」分区补丁 —— 幂等应用器 / 校验器（2026-10-01）。
//
// 背景：官方 @michengai/dsh-codex-ui 的 registerPluginConfigSection 把官方 PluginManagerPage
// 包进 settings.section 条目时，只转发 inject/locale，漏了 main 条目随带的 store。官方页首渲染
// 即调用 props.useStore()，拿不到 store 句柄就抛
// `TypeError: props.useStore is not a function` → 走 reportEntryError(abdicate) 退位通道 →
// SlotCore.entriesOfSlot 永久排除该条目 → 设置导航里「插件配置」点了就没、且不自愈（刷新才恢复）。
//
// 为什么需要这个文件（不是一次性 sed）：
//   补丁对象是 `home/profiles/web/node_modules/@michengai/dsh-codex-ui/lib/client.js`——一个
//   **会被 profile 依赖物化覆盖的 npm 包**。2026-09-28 修过一次（当时哈希 00CC596E…），到
//   2026-09-30 新建 auto-020-rc2 家园时又变回未打补丁的原始哈希 04106142…，且 nlink=2 硬链到
//   pnpm store ⇒ 同一现象复发。这正是 AGENTS.md「profile 包 specifier 领先安装是地雷」同一个坑。
//   所以补丁必须是仓库资产 + 有唯一重放入口，而不是会话记忆里的一句话 + 散落在各家园的手改文件。
//
// 三态判定（这是防回退的核心，宁可报错也不静默跳过）：
//   applied   —— 已打补丁，no-op
//   patched   —— 本次打上
//   drift     —— 既不是 from 也不是 to：上游 codex-ui 变形了，**退出码非 0 并打印上下文**，
//                绝不「没匹配上就算了」。静默跳过等于把同一个坑留给下一个人。
//
// 写文件必须 rename 而不是 writeFileSync：目标常是硬链接到 pnpm store 的 inode，直接写会穿透
// 把整个 store 的原始包改成补丁版（污染依赖树、后续 pnpm 校验失真）。先写同目录临时文件再
// rename 覆盖目录项，只换掉这一个目录项，store 里的 inode 原样不动。

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_RELATIVE = join('profiles', 'web', 'node_modules', '@michengai', 'dsh-codex-ui', 'lib', 'client.js')

/** 每个 hunk 三态判定所需的两端文本；两端的 from 在 1.1.18 原型里各自唯一（已核对计数=1）。 */
export const PATCHES = [
  {
    id: 'plugin-config-store-guard',
    why: '准入判断补 entry.store 句柄：缺 store 的 main 条目一律不注册 settings.section，避免注册出一个必崩的条目再退位。',
    from: '\t\t\t\t\tif (Official === void 0 || entry?.inject === void 0 || entry.locale !== OFFICIAL_PLUGIN_MANAGER_NS) return;',
    to: '\t\t\t\t\tif (Official === void 0 || entry?.inject === void 0 || entry.locale !== OFFICIAL_PLUGIN_MANAGER_NS || entry.store === void 0) return;',
  },
  {
    id: 'plugin-config-store-forward',
    why: 'settings.section 与 main 同为 root scope，同一 store 句柄二次挂载合法（SlotCore 按 scope 钉住，count 递增）；官方页由此拿到 useStore 正常渲染。',
    from: '\t\t\t\t\t\tid: PLUGIN_CONFIG_SECTION_ID,\n\t\t\t\t\t\torder: 16,\n\t\t\t\t\t\tlabel: () => t("settings.pluginConfig"),\n\t\t\t\t\t\tlocale: entry.locale,\n\t\t\t\t\t\tinject: entry.inject\n',
    to: '\t\t\t\t\t\tid: PLUGIN_CONFIG_SECTION_ID,\n\t\t\t\t\t\torder: 16,\n\t\t\t\t\t\tlabel: () => t("settings.pluginConfig"),\n\t\t\t\t\t\tlocale: entry.locale,\n\t\t\t\t\t\tstore: entry.store,\n\t\t\t\t\t\tinject: entry.inject\n',
  },
]

/** 纯函数：对一份 codex-ui client.js 文本判定/应用补丁。drift 时抛错并带上游上下文。 */
export function applyToText(source, patches = PATCHES) {
  let text = source
  const results = []
  for (const patch of patches) {
    const hasTo = text.includes(patch.to)
    const hasFrom = text.includes(patch.from)
    if (hasTo && !hasFrom) { results.push({ id: patch.id, state: 'applied' }); continue }
    if (!hasTo && !hasFrom) {
      const hint = text.slice(Math.max(0, text.indexOf('registerPluginConfigSection')), Math.max(0, text.indexOf('registerPluginConfigSection')) + 900)
      const error = new Error(`补丁 ${patch.id} 匹配不到：上游 codex-ui 的 registerPluginConfigSection 已变形，需人工复核后更新本补丁。\n--- 现场 ---\n${hint}`)
      error.code = 'PATCH_SHAPE_DRIFT'
      error.patchId = patch.id
      throw error
    }
    if (hasTo && hasFrom) { results.push({ id: patch.id, state: 'ambiguous' }); continue }
    text = text.replace(patch.from, patch.to)
    results.push({ id: patch.id, state: 'patched' })
  }
  return { text, results, changed: results.some((item) => item.state === 'patched') }
}

/** 枚举所有家园根（含旧家园 Data/DSH 与各代际 Data/DSH-generations/<gen>/home）。 */
export function targetRoots(root) {
  const roots = [join(root, 'Data', 'DSH')]
  const generations = join(root, 'Data', 'DSH-generations')
  if (existsSync(generations)) {
    for (const entry of readdirSync(generations, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const home = join(generations, entry.name, 'home')
      if (existsSync(home)) roots.push(home)
    }
  }
  return roots
}

/** 列出所有待检的 codex-ui client.js；家园没装 codex-ui 时不算问题。 */
export function targetFiles(root) {
  const files = []
  for (const home of targetRoots(root)) {
    const file = join(home, PACKAGE_RELATIVE)
    if (existsSync(file)) files.push({ home, file, hardlinked: lstatSync(file).nlink > 1 })
  }
  return files
}

function patchFile(file, verifyOnly) {
  const source = readFileSync(file, 'utf8')
  try {
    const { text, results, changed } = applyToText(source)
    if (!changed) return { file, status: 'ok', changed: false, results, hardlinked: lstatSync(file).nlink > 1 }
    if (verifyOnly) return { file, status: 'missing', changed: false, results, hardlinked: lstatSync(file).nlink > 1 }
    const temporary = `${file}.dsh-patch-tmp-${process.pid}`
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, file)
    return { file, status: 'patched', changed: true, results, hardlinked: lstatSync(file).nlink > 1 }
  } catch (error) {
    if (error?.code === 'PATCH_SHAPE_DRIFT') {
      return { file, status: 'drift', changed: false, results: [], hardlinked: lstatSync(file).nlink > 1, detail: error.message }
    }
    throw error
  }
}

export function run(root, verifyOnly = false) {
  const files = targetFiles(root)
  const report = files.map((item) => patchFile(item.file, verifyOnly))
  const failures = report.filter((item) => item.status === 'drift' || item.status === 'missing')
  return { root, verifyOnly, files: report, ok: failures.length === 0 && report.length > 0 }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const verifyOnly = args.includes('--verify')
  const rootIndex = args.indexOf('--root')
  const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.cwd())
  const report = run(root, verifyOnly)
  for (const item of report.files) {
    const link = item.hardlinked ? ' [硬链]' : ''
    console.log(`${item.status.padEnd(8)} ${item.file}${link}`)
    if (item.detail) console.log(item.detail)
  }
  const absent = targetRoots(root).filter((home) => !existsSync(join(home, PACKAGE_RELATIVE)))
  if (absent.length > 0) console.log(`skip      未安装 codex-ui：${absent.join(', ')}`)
  if (!report.ok) {
    console.error(verifyOnly
      ? 'FAIL codex-ui 补丁缺失或上游变形；修好前不得发布/切换候选。修复：node customizations/codex-ui-patches/apply.mjs'
      : 'FAIL codex-ui 补丁应用失败（上游变形需人工复核），见上方 detail。')
    process.exitCode = 1
  } else console.log(`PASS codex-ui 补丁${verifyOnly ? '校验' : '应用'}：${report.files.length} 份副本`)
}
