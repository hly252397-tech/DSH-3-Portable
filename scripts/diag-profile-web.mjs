import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { GATE_NODE } from './lib/gate-node.mjs'
import { resolveGatePnpm } from './lib/gate-pnpm.mjs'

// 用 Data 的真实 web profile 副本启动一个独立 dsh web，用于 UI 诊断（不影响正在运行的桌面）。
// 用法: node scripts/diag-profile-web.mjs
// 就绪后把带 token 的 URL 写到 Data/Temp/diag-web-url.txt，进程保持运行直到被 kill。
const root = resolve(import.meta.dirname, '..')
const home = join(root, 'Data', 'Temp', 'diag-home')
const profile = join(home, 'profiles', 'web')
const runtime = join(root, 'Data', 'Runtime', 'Harness', 'slots', '0.1.5-rc.2-fd316e6b895e48c1')
const updateRoot = join(root, 'Data', 'Updates', 'Harness')

const nodeExecutable = GATE_NODE
const bootstrap = join(root, 'dist', 'src', 'dsh-bootstrap.mjs')
const pnpmEntry = resolveGatePnpm(root)
const entry = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const child = spawn(nodeExecutable, [bootstrap, entry, 'web', '--port', '0', '--no-open'], {
  cwd: process.env.USERPROFILE,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_PROFILE_DIR: profile,
    DSH_PROFILE_NAME: 'web',
    DSH_RUNTIME_DIR: runtime,
    DSH_PNPM_ENTRY: pnpmEntry,
    DSH_PNPM_STORE_DIR: join(updateRoot, 'pnpm-store'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let output = ''
let urlWritten = false
child.stdout.on('data', c => {
  const t = c.toString('utf8')
  output += t
  process.stdout.write(t)
  const match = t.match(/https?:\/\/[^\s\r\n]+/)
  if (!urlWritten && match) {
    urlWritten = true
    void writeFile(join(root, 'Data', 'Temp', 'diag-web-url.txt'), match[0], 'utf8')
      .then(() => console.log('[diag] URL written to Data/Temp/diag-web-url.txt'))
  }
})
child.stderr.on('data', c => { const t = c.toString('utf8'); output += t; process.stderr.write(t) })

child.once('exit', (code, signal) => {
  console.log(`[diag] dsh exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
  process.exit(0)
})
