#!/usr/bin/env node
/**
 * L3 上下文简报（2026-09-17）——按关键词吐出「该看什么 / 跑什么 / 验收数字 / 同类事故」。
 *
 * 目的：让"聪明"落在制品里——下个会话（或换个模型）先跑这一条，不用靠回忆。
 *
 *   node scripts/brief.mjs 自适应 拖动
 *   node scripts/brief.mjs 构建 反回滚
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const words = process.argv.slice(2).filter((w) => !w.startsWith('--')).map((w) => w.toLowerCase())
if (words.length === 0) {
  console.log('用法: node scripts/brief.mjs <关键词…>')
  process.exit(2)
}
const hit = (s) => words.some((w) => s.toLowerCase().includes(w))
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

// 1) 规则条目（全局 AGENTS + 契约 §10）：按行筛
const ruleFiles = ['Data/DSH/AGENTS.md', 'docs/03-技术架构/UI定制维护契约.md', 'AGENTS.md']
const rules = []
for (const rel of ruleFiles) {
  const text = read(resolve(ROOT, rel))
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/^[-*\s>#|]+/, '').trim()
    if (t.length >= 8 && hit(t) && !t.startsWith('//')) rules.push(`[${rel}] ${t.slice(0, 150)}`)
  }
}

// 2) 脚本工具清单：文件名或首行注释命中
const scriptDirs = ['scripts']
const tools = []
for (const dir of scriptDirs) {
  const abs = resolve(ROOT, dir)
  if (!existsSync(abs)) continue
  for (const f of readdirSync(abs)) {
    if (!/\.(mjs|ps1|cmd)$/.test(f)) continue
    const head = read(join(abs, f)).split(/\r?\n/).slice(0, 6).join(' ')
    if (hit(f) || hit(head)) tools.push(`scripts/${f}  —  ${head.replace(/\s+/g, ' ').slice(0, 110)}`)
  }
}

// 3) 文档索引：docs/** 文件名命中
const docs = []
const walk = (dir, depth = 0) => {
  if (depth > 3 || !existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (e.name.endsWith('.md') && hit(e.name)) docs.push(p.replace(ROOT + '\\', ''))
  }
}
walk(resolve(ROOT, 'docs'))

// 4) 已知事故（机器门禁覆盖的）
const lint = 'scripts/lint-ui-discipline.mjs'
const incidents = existsSync(resolve(ROOT, lint))
  ? [
      'CSS/!important 覆盖 JS 内联写的状态变量 → 拖动失效（现由 lint-ui-discipline 断言盯住）',
      '补丁脚本幂等守卫只按标记 → 改载荷不进制品（现由 lint-ui-discipline 断言盯住）',
      '用历史副本判断"是否生效" → 结论反转（纪律：认正在运行的进程路径/活动槽）',
      '取证工具刷新页面 → 自己造出"内容被覆盖"（纪律：工具零副作用）',
    ].filter((s) => words.length === 0 || hit(s) || true)
  : []

const out = (title, rows) => {
  console.log(`\n── ${title} ──`)
  if (rows.length === 0) console.log('  （无命中）')
  else for (const r of rows.slice(0, 12)) console.log('  ' + r)
}
console.log(`\n上下文简报  关键词: ${words.join(' ')}`)
out('规则（会被自动加载的写入位置）', rules)
out('现成工具（先跑这些，别手工重做）', tools)
out('相关文档', docs)
out('同类事故（已固化为门禁）', incidents)
out('默认验收命令', [
  'node scripts/lint-ui-discipline.mjs            # 纪律 lint（事故→断言）',
  'node scripts/verify-adaptive-layout.mjs         # 右栏自适应 7 条断言',
  'node scripts/verify-adaptive-layout.mjs --refresh  # 先刷新页面再测',
  'powershell -File scripts/verify-adaptive-matrix.ps1 -Widths 960,1360,1920 -Zooms 100,130  # 矩阵',
])
console.log('')
