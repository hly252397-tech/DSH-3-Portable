#!/usr/bin/env node
/**
 * 自适应布局自动复测（2026-09-16 固化）。
 *
 * 为什么有它：此前"右栏自适应"的每次验证都是我手工三步——改 token 触发刷新 → 等 15s →
 * 读探针 JSON 再肉眼比对。手工步骤多、口径容易漂。这里把它收成一条命令：
 *
 *   node scripts/verify-adaptive-layout.mjs            # 只读当前探针数据
 *   node scripts/verify-adaptive-layout.mjs --refresh   # 先触发一次页面刷新再测（默认等 16s）
 *   node scripts/verify-adaptive-layout.mjs --refresh --wait=20
 *
 * 依赖：本地插件 dsh-ui-tweaks 里的**只读**宽度探针（无视觉输出）把页面布局写成
 * `Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/ui-probe.json`。
 * 判定项见下（PASS/FAIL），证据写到 Data/artifacts/adaptive-verify-<时间>/results.json，
 * 该文件可直接作为 UI 基线重记的 --evidence（status/results 形状）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { activeUiProfile } from './lib/active-ui-profile.mjs'
import { findWorkbenchProbeViolations } from './workbench-geometry-guard.mjs'

const ROOT = resolve(process.cwd())
const LIB = resolve(activeUiProfile(ROOT).profile, 'local/dsh-ui-tweaks/lib')
const PROBE = resolve(LIB, 'ui-probe.json')
const TOKEN = resolve(LIB, 'client.js')
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : Number(hit.split('=')[1])
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const floor = 400 // resolveWorkbenchWidth 的硬下限；640 为默认让位，680 已退役。

if (process.argv.includes('--refresh')) {
  appendFileSync(TOKEN, `\n// verify-adaptive-layout ${Date.now()}\n`)
  await sleep(arg('wait', 16) * 1000)
}
if (!existsSync(PROBE)) {
  console.error(`probe missing: ${PROBE}`)
  process.exit(2)
}

const j = JSON.parse(readFileSync(PROBE, 'utf8'))
const age = Date.now() - Date.parse(j.sampledAt)
const num = (re, s) => {
  const m = re.exec(s ?? '')
  return m === null ? Number.NaN : Number(m[1])
}
const rootW = num(/w=(\d+)px/, j.chain?.[0] ?? '')
const panelBody = (j.bands ?? []).find((b) => b.includes('nArs4W_panelBody')) ?? ''
const panelFrom = num(/\[(\d+)\.\./, panelBody)
const handle = (j.bands ?? []).find((b) => b.includes('nArs4W_panelResize')) ?? ''
const handleFrom = num(/\[(\d+)\.\./, handle)
const handleTo = num(/\.\.(\d+)\]/, handle)
const gapBands = (j.bands ?? []).filter((b) => /:\s*body\s/.test(b))
const ruler = Number.parseFloat(j.appWidthVar)
const compact = j.compact === null || j.compact === undefined ? '' : String(j.compact)
const panelOpen = Number.parseFloat(j.sidebarVar) > 0 && compact !== '1'
const geometryErrors = findWorkbenchProbeViolations(j)

const results = []
const check = (name, ok, measured, expected) => results.push({ name, ok: Boolean(ok), measured: String(measured), expected: String(expected) })

check('探针数据新鲜（≤120s）', age >= 0 && age <= 120_000, `${Math.round(age / 1000)}s`, '0–120s')
check('探针不处于拖动过渡帧', j.dragging !== true, String(j.dragging), '非拖动')
check('采样目标是会话页而非设置覆盖层', !(j.bands ?? []).some(b => /dcu-settings-/.test(b)), '按命中元素检查当前页面', '会话页')
check('外壳尺子已下发（--dsh-app-width ≈ 视口宽）', Number.isFinite(ruler) && Math.abs(ruler - j.vw) <= 2, `appW=${j.appWidthVar} vw=${j.vw}`, '两者相等')
check('两框之间无空白带（无 body 带）', gapBands.length === 0, gapBands.length === 0 ? '无' : gapBands.join(' | '), '无')
check('面板开启贴合、关闭释放让位且输入框无覆盖', geometryErrors.length === 0, geometryErrors.join(' | ') || (panelOpen ? '开启边界一致' : '关闭释放全部宽度'), '几何一致')
check('对话列保住内容下限', !Number.isFinite(rootW) || rootW >= floor || j.vw < 760, `root=${rootW} vw=${j.vw}`, `≥${floor}（窄窗豁免）`)
check('开启时拖动柄居中，关闭时无可命中拖动柄', panelOpen
  ? Number.isFinite(handleFrom) && Number.isFinite(handleTo) && Math.abs((handleFrom + handleTo) / 2 - rootW) <= 4
  : !Number.isFinite(handleFrom), `handle=${handleFrom}..${handleTo}`, panelOpen ? `≈${rootW}` : '无可见拖动柄')
check('右栏实际可见性与开关一致', panelOpen
  ? Number.isFinite(panelFrom) && j.vw - panelFrom > 40
  : !Number.isFinite(panelFrom), `panelFrom=${panelFrom}`, panelOpen ? '< vw-40' : '无可见右栏')

// 竖排/挤压断言（2026-09-17 用户指出："2 个后台任务"被压成 43x114 竖排并压住会话标题）
const narrow = Array.isArray(j.narrowText) ? j.narrowText : []
const squeezed = narrow.filter((line) => String(line).includes('后台任务'))
check('无被挤压成竖排的后台任务徽标', squeezed.length === 0, squeezed.length === 0 ? '无' : squeezed.join(' | '), '无')

const pass = results.filter((r) => r.ok).length
const status = pass === results.length ? 'pass' : 'fail'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dir = resolve(ROOT, `Data/artifacts/adaptive-verify-${stamp}`)
mkdirSync(dir, { recursive: true })
const file = resolve(dir, 'results.json')
writeFileSync(file, JSON.stringify({ status, checkedAt: new Date().toISOString(), viewport: { w: j.vw, h: j.vh }, compact, results }, null, 2))

const pad = (s, n) => String(s).padEnd(n)
console.log(`\n自适应布局复测  ${status === 'pass' ? 'PASS' : 'FAIL'}  (${pass}/${results.length})  视口 ${j.vw}x${j.vh}\n`)
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${pad(r.name, 34)} 实测 ${pad(r.measured, 28)} 期望 ${r.expected}`)
console.log(`\n证据: ${file.replace(ROOT + '\\', '')}\n`)
process.exit(status === 'pass' ? 0 : 1)
