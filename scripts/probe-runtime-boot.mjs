#!/usr/bin/env node
// 运行时 boot 探针：与真实应用同构（dsh-bootstrap + bin.js web --port 0 --no-open），指向指定代际。
// 用于内核/家园/豁免变更后的无头验证：就绪判定 = 输出出现监听行；超时未就绪 = 复现卡死（退出码 2）。
// 用法：
//   Tools/node/node.exe scripts/gate-node-run.mjs scripts/probe-runtime-boot.mjs [--root <便携根>] [--generation <代号>] [--timeout-ms <毫秒>]
// 默认代际 = 活动绑定；无绑定时报错退出（探针只针对代际家园，legacy 布局请手工指 --generation 之外的场景）。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const arg = name => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : undefined }
const root = resolve(arg('--root') ?? join(scriptDir, '..'))
const timeoutMs = Number(arg('--timeout-ms') ?? 150_000)

let generation = arg('--generation')
if (!generation) {
  const pointerPath = join(root, 'Data', 'Runtime', 'Harness', 'current.json')
  if (!existsSync(pointerPath)) { console.error('无 Harness 指针且未指定 --generation'); process.exit(1) }
  const activeVersion = JSON.parse(readFileSync(pointerPath, 'utf8')).current?.version
  const bindingPath = join(root, 'Data', 'Updates', 'Harness', 'homes', `${activeVersion}.json`)
  if (!existsSync(bindingPath)) { console.error(`活动版本 ${activeVersion} 无家园绑定；请先跑 scripts/prepare-kernel-update.mjs --apply`); process.exit(1) }
  generation = JSON.parse(readFileSync(bindingPath, 'utf8')).generation
}

const genRoot = join(root, 'Data', 'DSH-generations', generation)
const home = join(genRoot, 'home')
const profileDir = join(home, 'profiles', 'web')
const runtimeDir = join(genRoot, 'runtime', 'dsh-runtime')
const entry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const bootstrap = join(root, 'dist', 'src', 'dsh-bootstrap.mjs')

let gateNode = join(root, 'Tools', 'node', 'node.exe')
let pnpmEntry = join(root, 'App', 'resources', 'node', 'pnpm-package', 'bin', 'pnpm.cjs')
try {
  const { pathToFileURL } = await import('node:url')
  const gate = await import(pathToFileURL(join(scriptDir, 'lib', 'gate-node.mjs')).href)
  if (gate.GATE_NODE) gateNode = gate.GATE_NODE
  const pnpm = await import(pathToFileURL(join(scriptDir, 'lib', 'gate-pnpm.mjs')).href)
  pnpmEntry = pnpm.resolveGatePnpm(root)
} catch { /* 回退默认路径 */ }

for (const p of [entry, gateNode, bootstrap, pnpmEntry, join(profileDir, 'package.json')]) {
  if (!existsSync(p)) { console.error('MISSING', p); process.exit(1) }
}

const child = spawn(gateNode, [bootstrap, entry, 'web', '--port', '0', '--no-open'], {
  cwd: process.env.USERPROFILE,
  env: {
    ...process.env,
    // 与真实外壳一致：hj 等本地插件用 DSH_PORTABLE_ROOT 做 env 优先推根，缺失时上溯推根在代际家园布局下必错
    DSH_PORTABLE_ROOT: root,
    DSH_HOME: home,
    DSH_PROFILE_DIR: profileDir,
    DSH_PROFILE_NAME: 'web',
    DSH_RUNTIME_DIR: runtimeDir,
    DSH_PNPM_ENTRY: pnpmEntry,
    DSH_PNPM_STORE_DIR: join(root, 'Data', 'Updates', 'Harness', 'pnpm-store'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let output = '', readyAt = 0
const startedAt = Date.now()
const feed = c => {
  const t = c.toString('utf8')
  output += t
  process.stdout.write(t)
  if (!readyAt && /listening|127\.0\.0\.1:\d+|http:\/\/localhost/i.test(t)) {
    readyAt = Date.now()
    console.log(`\n[runner] READY after ${((readyAt - startedAt) / 1000).toFixed(1)}s`)
    child.kill()
  }
}
child.stdout.on('data', feed)
child.stderr.on('data', feed)
const timer = setTimeout(() => {
  console.log(`\n[runner] TIMEOUT ${timeoutMs / 1000}s ${readyAt ? '(已就绪后未退出)' : '（未就绪——复现卡死）'}`)
  child.kill('SIGTERM')
  setTimeout(() => process.exit(readyAt ? 0 : 2), 2000)
}, timeoutMs)
child.once('exit', (code, signal) => {
  clearTimeout(timer)
  console.log(`\n[runner] exited code=${code ?? 'null'} signal=${signal ?? 'none'} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s ready=${readyAt ? 'yes' : 'no'}`)
  console.log(`[runner] output bytes: ${output.length}`)
  process.exit(readyAt || code === 0 ? 0 : 2)
})
