#!/usr/bin/env node
/**
 * L4 watch——改完自动跑（2026-09-17）。
 *
 * 为什么有它：此前的循环是"我改 → 我手工跑 → 我肉眼比"，而且我常常在一个 turn 结束时
 * 只说"下一步做"。把循环交给常驻进程：本地插件/主题一变，2s 内自动跑纪律 lint + 自适应复测，
 * 失败立刻打印 FAIL——不需要任何人在场。
 *
 * 用法（后台常驻）：
 *   node scripts/watch-ui.mjs            # 前台
 *   （本仓库用法：作为后台作业启动，日志落到 Data/Temp/watch-ui.log）
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { GATE_NODE } from './lib/gate-node.mjs'

const ROOT = resolve(process.cwd())
// 门禁必须跑在与清单一致的 Node 上（原先硬编码 App/resources/node 是 1.0.43 旧树，v24.20.0）。
const NODE = GATE_NODE
const WATCH_DIRS = [
  'Data/DSH/profiles/web/local',
  'assets',
]
const LOG = resolve(ROOT, 'Data/Temp/watch-ui.log')
mkdirSync(dirname(LOG), { recursive: true })
const log = (line) => {
  const s = `[${new Date().toISOString()}] ${line}`
  console.log(s)
  appendFileSync(LOG, s + '\n')
}

const run = (rel) => {
  try {
    const out = execFileSync(NODE, [resolve(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    const verdict = /PASS/.test(out) ? 'PASS' : '?'
    const ratio = (out.match(/\((\d+)\/(\d+)\)/) ?? [])[0] ?? ''
    return { ok: true, verdict, ratio, out }
  } catch (error) {
    const out = String(error.stdout ?? '') + String(error.stderr ?? '')
    const ratio = (out.match(/\((\d+)\/(\d+)\)/) ?? [])[0] ?? ''
    const failed = out.split(/\r?\n/).filter((l) => l.includes('FAIL')).slice(0, 3).join(' ; ')
    return { ok: false, verdict: 'FAIL', ratio, out, failed }
  }
}

let timer = null
const sweep = (reason) => {
  log(`change detected (${reason}) -> running gates`)
  const lint = run('scripts/lint-ui-discipline.mjs')
  log(`lint-ui-discipline      ${lint.verdict} ${lint.ratio}${lint.failed ? ' :: ' + lint.failed : ''}`)
  const verify = run('scripts/verify-adaptive-layout.mjs')
  log(`verify-adaptive-layout  ${verify.verdict} ${verify.ratio}${verify.failed ? ' :: ' + verify.failed : ''}`)
  log(lint.ok && verify.ok ? 'gates: ALL PASS' : 'gates: FAILED (see above)')
  // 机器可读结论：让"忘读日志"变成一道会红的门禁（lint-ui-discipline 会读它）
  try {
    writeFileSync(resolve(ROOT, 'Data/Temp/watch-last-verdict.json'), JSON.stringify({
      at: new Date().toISOString(),
      status: lint.ok && verify.ok ? 'pass' : 'fail',
      reason,
      lint: { status: lint.verdict, ratio: lint.ratio, failed: lint.failed ?? '' },
      verify: { status: verify.verdict, ratio: verify.ratio, failed: verify.failed ?? '' },
    }, null, 2))
  } catch (e) { log('verdict write failed: ' + e.message) }
}

// 起步先跑一次，确认当前基线
sweep('initial')

for (const rel of WATCH_DIRS) {
  const abs = resolve(ROOT, rel)
  try {
    statSync(abs)
  } catch {
    log(`skip missing dir ${rel}`)
    continue
  }
  watch(abs, { recursive: true }, (_event, file) => {
    if (file && /node_modules|\.log$|ui-probe\.json$/.test(String(file))) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => sweep(String(file ?? rel)), 2000)
  })
  log(`watching ${rel}`)
}
log('watch-ui ready')
