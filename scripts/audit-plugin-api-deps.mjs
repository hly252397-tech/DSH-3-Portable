#!/usr/bin/env node
// 插件 API 依赖面审计：全量提取 profile 插件对 @deepseek-ai/* 的 import 符号，
// 对照目标内核槽逐符号核验存活，并生成 compatibility.json 豁免草稿。
// 用法：Tools/node/node.exe scripts/gate-node-run.mjs scripts/audit-plugin-api-deps.mjs [目标内核版本，默认 previous 槽]
// 来源：2026-09-29 内核/插件解耦方针（AGENTS.md「内核/插件解耦方针」节）。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = join(root, 'Data/Runtime/Harness')
const pointer = JSON.parse(readFileSync(join(harnessRoot, 'current.json'), 'utf8'))
const requested = process.argv[2]
const slots = readdirSync(join(harnessRoot, 'slots'))
const candidate = requested
  ? slots.find(d => d === requested || d.startsWith(requested + '-') || d.startsWith(requested + '.'))
  : pointer.previous?.relativePath?.split('/').pop()
if (!candidate) throw new Error('目标内核槽未找到：' + requested + '（可用：' + slots.join(', ') + '）')
const targetSlot = candidate
const officialDir = join(harnessRoot, 'slots', targetSlot, 'node_modules/@deepseek-ai')
if (!existsSync(officialDir)) throw new Error('目标槽没有 @deepseek-ai 层：' + officialDir)
// 版本从槽内 dsh 包清单实读（槽目录名含 hash 与 .quarantined 后缀，不可反推）。
const targetVersion = JSON.parse(readFileSync(join(officialDir, 'dsh/package.json'), 'utf8')).version

// —— 1) 收集 profile 插件（本地 + npm）的 host/client 入口与 import 符号 ——
const homes = [
  join(root, 'Data/DSH-generations/v4-rc2b/home/profiles/web'),
  join(root, 'Data/DSH/profiles/web'),
]
const home = homes[0]

function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  const found = new Map() // pkg -> Set(symbol)
  const re = /import\s*\{([^}]+)\}\s*from\s*["'](@deepseek-ai\/[a-z0-9-]+)["']/g
  let m
  while ((m = re.exec(text)) !== null) {
    const pkg = m[2]
    if (!found.has(pkg)) found.set(pkg, new Set())
    for (const part of m[1].split(',')) {
      const sym = part.trim().split(/\s+as\s+/)[0]?.trim()
      if (sym) found.get(pkg).add(sym)
    }
  }
  return found
}

function auditBundle(name, dir) {
  const deps = new Map()
  for (const entry of ['lib/index.js', 'lib/client.js']) {
    const f = join(dir, entry)
    if (!existsSync(f)) continue
    for (const [pkg, syms] of importsOf(f)) {
      if (!deps.has(pkg)) deps.set(pkg, new Set())
      for (const s of syms) deps.get(pkg).add(s)
    }
  }
  return deps
}

const plugins = []
for (const d of readdirSync(join(home, 'local'))) {
  if (!existsSync(join(home, 'local', d, 'package.json'))) continue
  plugins.push({ name: d, dir: join(home, 'local', d), local: true })
}
for (const scope of ['@michengai', '@kenz1117']) {
  const sdir = join(home, 'node_modules', scope)
  if (!existsSync(sdir)) continue
  for (const d of readdirSync(sdir)) plugins.push({ name: `${scope}/${d}`, dir: join(sdir, d), local: false })
}
for (const p of ['dsh-context', 'dsh-mcp-connector', 'dshmarket']) {
  if (existsSync(join(home, 'node_modules', p, 'package.json'))) plugins.push({ name: p, dir: join(home, 'node_modules', p), local: false })
}

// —— 2) 逐符号对照目标槽 ——
function pkgExportsText(pkg) {
  // pkg 形如 "@deepseek-ai/dsh-llm"；officialDir 已是 .../@deepseek-ai，去掉 scope 前缀再拼。
  const pkgDir = join(officialDir, pkg.replace(/^@deepseek-ai\//, ''))
  const idx = join(pkgDir, 'lib/index.js')
  const cli = join(pkgDir, 'lib/client.js')
  let text = ''
  for (const f of [idx, cli]) if (existsSync(f)) text += readFileSync(f, 'utf8')
  return text
}

const report = []
for (const p of plugins) {
  const deps = auditBundle(p.name, p.dir)
  if (deps.size === 0) continue
  const rows = []
  for (const [pkg, syms] of deps) {
    const targetText = pkgExportsText(pkg)
    if (targetText === '') { rows.push({ pkg, syms: [...syms], status: '包缺失' }); continue }
    const missing = [...syms].filter(s => !targetText.includes(s))
    rows.push({ pkg, count: syms.size, missing: missing.length === 0 ? [] : missing, status: missing.length === 0 ? '兼容' : `${missing.length}/${syms.size} 符号缺失` })
  }
  const hardBreak = rows.some(r => r.status === '包缺失' || (r.missing?.length > 0))
  report.push({ plugin: p.name, local: p.local, deps: rows, hardBreak })
}

// —— 3) peer 阻挡 + 豁免草稿 ——
const blocked = []
for (const p of plugins) {
  try {
    const j = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'))
    const peer = j.peerDependencies || {}
    const dshPeers = Object.entries(peer).filter(([k]) => k === '@deepseek-ai/dsh' || k.startsWith('@deepseek-ai/dsh-'))
    if (dshPeers.length === 0) continue
    const blocking = dshPeers.filter(([k, r]) => !r.includes(targetVersion))
    if (blocking.length > 0) blocked.push({ plugin: p.name, version: j.version, peers: blocking })
  } catch {}
}

console.log(`# 插件 API 依赖面审计（目标内核 ${targetVersion}，槽 ${targetSlot}）\n`)
console.log(`## A. 对官方包有 import 依赖的插件（${report.length} 个）\n`)
for (const r of report) {
  console.log(`- ${r.plugin}${r.local ? '（本地）' : ''} — ${r.hardBreak ? '❌ 存在硬断裂' : '✅ 全部符号存活'}`)
  for (const d of r.deps) console.log(`    · ${d.pkg}（${d.count ?? d.syms.length} 符号）${d.status}${d.missing?.length ? '：' + d.missing.slice(0, 6).join(', ') + (d.missing.length > 6 ? ` 等${d.missing.length}个` : '') : ''}`)
}
console.log(`\n## B. peer 声明阻挡（不含 ${targetVersion}，共 ${blocked.length} 个）\n`)
for (const b of blocked) console.log(`- ${b.plugin}@${b.version}（${b.peers.length} 条 peer 钉旧版）`)
console.log(`\n## C. compatibility.json 豁免草稿（targetRuntime=${targetVersion}）\n`)
const draft = {}
for (const b of blocked) draft[`${b.plugin}@${b.version}`] = [targetVersion]
console.log(JSON.stringify(draft, null, 2))
console.log(`\n说明：A 组 hardBreak=false 且仅 B 组阻挡的插件，豁免后大概率可跑（需 7b 体检验证行为）；A 组硬断裂的插件豁免也会崩，需先改代码。`)
