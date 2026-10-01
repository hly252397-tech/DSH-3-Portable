#!/usr/bin/env node
/**
 * 起一个**诊断实例**（`dsh web`）用于改完界面后自验 —— 本仓库里这个动作已经手工做过 3 次，按纪律固化成脚本。
 *
 *   node scripts/diagnostic-web.mjs                 # 起实例，打印带 token 的 URL，阻塞到 Ctrl+C 并清理子进程
 *   node scripts/diagnostic-web.mjs --slot 0.1.6-alpha.1-xxxx   # 指定运行时槽（默认取最新）
 *   node scripts/diagnostic-web.mjs --print-only     # 只打印将要执行的命令与环境，不启动
 *
 * 为什么必须用独立进程自验：DSH **核心**客户端模块在 harness 进程启动时快照（`dsh-client-modules`），
 * 而正在跑会话的 App 不能重启；插件客户端 bundle 虽然每次请求现读磁盘，但要页面重载才有机会生效。
 * 诊断实例 = 同一 Profile / 同一运行时槽的**独立进程**，加载的正是盘上最新制品，
 * 用打印出来的 token URL 在任意浏览器打开即可读真实 DOM（本仓库 §12/§13 的自验都是这么做的）。
 *
 * 安全：只监听回环；token 一次性、仅本机可达；退出时杀掉自己拉起的子进程。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_NODE } from './lib/gate-node.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const newestDir = (parent) => {
  if (!existsSync(parent)) throw new Error(`缺少目录: ${parent}`)
  const dirs = readdirSync(parent).map((name) => ({ name, path: join(parent, name) }))
    .filter((entry) => { try { return statSync(entry.path).isDirectory() } catch { return false } })
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
  if (dirs.length === 0) throw new Error(`目录为空: ${parent}`)
  return dirs
}

const slotRoot = join(repo, 'Data/Runtime/Harness/slots')
const slotName = argValue('--slot')
const slot = slotName === undefined
  ? newestDir(slotRoot)[0].path
  : join(slotRoot, slotName)
const entry = join(slot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const bootstrapCandidates = newestDir(join(repo, 'Data/Updates/Desktop/slots'))
  .map((s) => join(s.path, 'resources/bootstrap.mjs'))
  .filter((p) => existsSync(p))
const bootstrap = bootstrapCandidates[0]
const nodeExe = GATE_NODE
for (const [label, path] of [['运行时槽', slot], ['CLI 入口', entry], ['bootstrap', bootstrap], ['便携 Node', nodeExe]]) {
  if (path === undefined || !existsSync(path)) { console.error(`找不到${label}: ${path}`); process.exit(2) }
}

const dshHome = join(repo, 'Data/DSH')
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_PROFILE_DIR: join(dshHome, 'profiles/web'),
  DSH_PROFILE_NAME: 'web',
  DSH_RUNTIME_DIR: slot,
  PATH: `${dirname(GATE_NODE)};${process.env.PATH ?? ''}`,
}
const argv = [bootstrap, entry, 'web', '--port', '0', '--no-open']

console.log(`[diagnostic-web] 槽=${slot.replace(repo + '\\', '')}`)
console.log(`[diagnostic-web] DSH_HOME=${dshHome}`)
console.log(`[diagnostic-web] ${nodeExe} ${argv.join(' ')}`)
if (args.includes('--print-only')) process.exit(0)

const child = spawn(nodeExe, argv, { cwd: slot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let ready = null
const banner = () => {
  if (ready === null) return
  console.log('\n================ 诊断实例就绪 ================')
  console.log(`  ${ready}`)
  console.log('  在浏览器打开上面这个带 token 的地址即可读真实 DOM；')
  console.log('  Ctrl+C 结束实例（会杀掉本脚本拉起的子进程）。')
  console.log('=============================================\n')
}
const onData = (chunk) => {
  const text = chunk.toString('utf8')
  process.stdout.write(text)
  const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(text)
  if (match !== null && ready === null) { ready = match[1]; banner() }
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)
child.on('exit', (code) => { console.log(`[diagnostic-web] 子进程退出 code=${code}`); process.exit(code ?? 0) })
const stop = () => { console.log('\n[diagnostic-web] 收到中断，结束实例…'); child.kill(); setTimeout(() => process.exit(0), 500) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
