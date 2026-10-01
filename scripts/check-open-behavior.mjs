#!/usr/bin/env node
// 会话「打开方式」一键体检：验证 better-sidebar 的外链/文件卡片拦截是否健康。
// 用法：Tools/node/node.exe scripts/gate-node-run.mjs scripts/check-open-behavior.mjs
// 依赖：DSH 运行中 + hj-workbench 探针 broker（127.0.0.1:8976）活着。
// 副作用：体检会真实打开 1-2 个侧栏卡片（PROBE 标记），报告通过后可随手关闭。
// 来源：2026-09-28 fileLink 事故的排查工具固化（docs/01-当前工作/20260928-会话文件卡片开进侧边栏.md）。
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeUiProfile } from './lib/active-ui-profile.mjs'

const root = resolve(import.meta.dirname, '..')

// 代际必须跟随启动器选中的活动家园，不能钉死某个代号：钉死后拿旧代 token 打新代际 broker
// 会鉴权失败，且 0.2 起活动代际已是 v5-020rc1（2026-09-29 实测该脚本因此原理性跑不通）。
// activeUiProfile() 是 fail-closed 的——绑定损坏时直接抛错，不会静默回落冻结家园。
const { profile } = activeUiProfile(root)
const workbench = resolve(profile, 'local/dsh-hj-workbench/lib/client.js')
if (!existsSync(workbench)) {
  console.error(`FAIL: 活动家园缺少 hj-workbench 客户端 — ${workbench}\n`
    + '  插件可能被隔离或未装入当前代际；先看 profile 的 bundles 与 quarantine 记录。')
  process.exit(1)
}
const source = readFileSync(workbench, 'utf8')
const token = source.match(/const BROKER_TOKEN = '([^']+)'/)?.[1]
if (!token) {
  console.error(`FAIL: 未能从 hj-workbench 客户端解析 BROKER_TOKEN — ${workbench}\n`
    + '  探针 broker 会拒绝无 token 的 push；先确认该插件版本是否仍带 BROKER_TOKEN 常量。')
  process.exit(1)
}
const base = 'http://127.0.0.1:8976'

// 探针文件用相对便携根解析：本产品要能整体搬到任意盘符/路径，写死绝对路径会让体检在
// 别的机器上必然假红（PROBE 文件不存在 ⇒ 卡片开不出来 ⇒ editorTabOpened=false）。
const probeFile = resolve(root, 'docs/01-当前工作/20260928-会话文件卡片开进侧边栏.md')
if (!existsSync(probeFile)) {
  console.error(`FAIL: 体检探针文件不存在 — ${probeFile}\n`
    + '  该文件是 1d 项「文件开进侧栏编辑器卡」的判据，缺失即无法判定。')
  process.exit(1)
}

async function request(path, options) {
  const res = await fetch(base + path, { ...options, signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error('broker HTTP ' + res.status)
  return res.json()
}

async function push(code) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const s0 = await request('/status')
    if (s0.queued !== 0) { await new Promise(r => setTimeout(r, 3000)); continue }
    const job = await request('/push?t=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'page', code }),
    })
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 250))
      const s = await request('/status')
      if (s.last && s.last.id === job.id) return s.last
      if (s.last && s.last.id > job.id) break
    }
  }
  throw new Error('探针结果未返回（broker 忙或页面未轮询）')
}

const results = []
const record = (name, pass, detail) => results.push({ name, pass, detail })

// —— 1) 页面内一次性完成全部检查 ——
const probe = await push([
  'const out = { origin: location.origin };',
  // 1a. DOM 形态：官方 fileLink 按钮是否存在、路径可解析率
  'const links = [...document.querySelectorAll(\'button[class*="fileLink"]\')];',
  'out.fileLinkCount = links.length;',
  'out.pathResolvable = links.filter(function(b) {',
  '  const t = (b.getAttribute("title") || "").trim(); const x = (b.textContent || "").trim();',
  '  return /^[A-Za-z]:[\\\\/]/.test(t) || /^\\//.test(t) || /^[A-Za-z]:[\\\\/]/.test(x);',
  '}).length;',
  // 1b. 拦截器活性：自造受控按钮（真实存在文件），dispatchEvent 返回 false = 被 preventDefault
  'const b = document.createElement("button");',
  'b.className = "probe_fileLink_check";',
  'b.textContent = ' + JSON.stringify(probeFile) + ';',
  'document.body.appendChild(b);',
  'const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });',
  'out.fileIntercepted = b.dispatchEvent(ev) === false;',
  'b.remove();',
  // 1c. 外链拦截活性：自造外链 a（https），dispatchEvent 返回 false = 被拦
  'const a = document.createElement("a");',
  'a.href = "https://example.com/"; a.textContent = "probe";',
  'document.body.appendChild(a);',
  'const ev2 = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });',
  'out.linkIntercepted = a.dispatchEvent(ev2) === false;',
  'a.remove();',
  'await new Promise(function(r) { setTimeout(r, 1000); });',
  // 1d. 侧栏卡片确实打开了（编辑器卡 = PROBE 文件；浏览器卡 = example.com）
  'const tabs = [...document.querySelectorAll(\'[class*="tabList"] [class*="tab"]\')].map(function(t){ return (t.getAttribute("title") || t.textContent || "").trim(); });',
  'out.editorTabOpened = tabs.some(function(t){ return /会话文件卡片开进侧边栏\\.md$/.test(t); });',
  'out.browserTabOpened = tabs.some(function(t){ return /example\\.com/.test(t) || t === "浏览器"; }) && out.linkIntercepted;',
  // 1e. 插件 client 存活
  'out.sidebarAlive = document.querySelectorAll("[class*=nArs4W_panel]").length > 0;',
  'return out;'
].join('\n'))

if (!probe.ok) {
  console.log('FAIL: 探针执行失败 —', probe.error)
  process.exit(1)
}
const r = probe.result

record('broker 探针通道', true, `origin=${r.origin}`)
record('better-sidebar client 存活', r.sidebarAlive, `面板 DOM ${r.sidebarAlive ? '在' : '缺失（插件挂了）'}`)
record('官方 fileLink DOM 形态', r.fileLinkCount === 0 || r.pathResolvable > 0,
  `页面 ${r.fileLinkCount} 个 fileLink 按钮，${r.pathResolvable} 个路径可解析（title/textContent）；0 可解析=官方改了形态，拦截器认不出`)
record('文件卡片拦截器活性', r.fileIntercepted, `受控按钮 ${r.fileIntercepted ? '被拦截' : '未被拦截（拦截器未注册）'}`)
record('文件开进侧栏编辑器卡', r.editorTabOpened, r.editorTabOpened ? 'PROBE 文件卡片已打开' : '拦截了但卡片没开（openSidebarFile 链路断）')
record('https 外链拦截器活性', r.linkIntercepted, `受控外链 ${r.linkIntercepted ? '被拦截' : '未被拦截（browserIntercept 配置回退？）'}`)

const failed = results.filter(x => !x.pass)
for (const x of results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name} — ${x.detail}`)
console.log(failed.length === 0
  ? '\n体检结论：打开方式拦截链路健康（外链/文件卡片都开进定制侧栏）。'
  : `\n体检结论：${failed.length} 项异常 — ${failed.map(x => x.name).join('；')}。修复指引见 docs/01-当前工作/20260928-会话文件卡片开进侧边栏.md（类名/形态/注册三层排查）。`)
process.exit(failed.length === 0 ? 0 : 1)
