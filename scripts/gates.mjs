#!/usr/bin/env node
/**
 * 一条命令的门禁（2026-09-17）—— 替代"没人消费的守护进程"。
 * 教训：watch 常驻 1h16m 报了 12 次判定，我一次都没读；后台作业只在**结束**时通知，
 * 常驻进程永不结束。闭环 = 判定必须被消费 ⇒ 改成同步一条命令，每轮开工先跑：
 *   node scripts/gates.mjs      # exit 0 = 全绿
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { GATE_NODE } from './lib/gate-node.mjs'
const ROOT = resolve(process.cwd())
// 门禁必须跑在与清单一致的 Node 上（原先硬编码 App/resources/node 是 1.0.43 旧树，v24.20.0）。
const NODE = GATE_NODE
const steps = [
  ['lint-ui-discipline', 'scripts/lint-ui-discipline.mjs'],
  ['lint-plugin-deps', 'scripts/lint-plugin-deps.mjs'],
  ['verify-adaptive-layout', 'scripts/verify-adaptive-layout.mjs'],
]
let fail = 0
for (const [name, rel] of steps) {
  try {
    const out = execFileSync(NODE, [resolve(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    const ratio = (out.match(/\((\d+)\/(\d+)\)/) ?? [])[0] ?? ''
    console.log(`  ok    ${name.padEnd(24)} PASS ${ratio}`)
  } catch (e) {
    fail += 1
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const bad = out.split(/\r?\n/).filter((l) => l.includes('FAIL')).slice(0, 2).join(' | ')
    console.log(`  FAIL  ${name.padEnd(24)} ${bad || '(see output above)'}`)
  }
}
console.log(`\ngates: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}\n`)
process.exit(fail === 0 ? 0 : 1)