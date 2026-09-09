import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const mode = process.argv[2] ?? 'dump'
const root = resolve(import.meta.dirname, '..')
const updateRoot = join(root, 'Data', 'Updates', 'Harness')
const candidate = join(root, 'Data', 'Runtime', 'Harness', 'slots', '0.1.5-alpha.1-8dea01d805f55807')
const canaryRoot = join(updateRoot, 'canary')
await mkdir(canaryRoot, { recursive: true })
const probeRoot = await mkdtemp(join(canaryRoot, `probe-${mode}-`))
const home = join(probeRoot, 'Home')
const profile = join(home, 'profiles', 'web')
await mkdir(profile, { recursive: true })
await writeFile(join(profile, 'package.json'), `${JSON.stringify({
  name: 'dsh-desktop-shadow-profile',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, undefined, 2)}\n`, 'utf8')
await writeFile(join(profile, 'cordis.patch.yml'), '# probe canary\n[]\n', 'utf8')
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n', 'utf8')

const nodeExecutable = join(root, 'App', 'resources', 'node', 'node.exe')
const bootstrap = join(root, 'dist', 'src', 'dsh-bootstrap.mjs')
const pnpmEntry = join(root, 'App', 'resources', 'node', 'pnpm-package', 'bin', 'pnpm.cjs')
const entry = join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const args = mode === 'dump'
  ? ['web', '--dump-config']
  : ['web', '--port', '0', '--no-open']
const stdinMode = mode === 'nostdin' ? 'ignore' : 'pipe'

const child = spawn(nodeExecutable, [bootstrap, entry, ...args], {
  cwd: process.env.USERPROFILE,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_PROFILE_DIR: profile,
    DSH_PROFILE_NAME: 'web',
    DSH_RUNTIME_DIR: candidate,
    DSH_PNPM_ENTRY: pnpmEntry,
    DSH_PNPM_STORE_DIR: join(updateRoot, 'pnpm-store'),
  },
  stdio: [stdinMode, 'pipe', 'pipe', 'ipc'],
  windowsHide: true,
})

let output = ''
child.stdout.on('data', c => { const t = c.toString('utf8'); output += t; process.stdout.write(t) })
child.stderr.on('data', c => { const t = c.toString('utf8'); output += t; process.stdout.write(t) })

const timeoutMs = 90_000
const startedAt = Date.now()
const timer = setTimeout(() => {
  console.log(`\n[runner] TIMEOUT after ${timeoutMs / 1000}s`)
  child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 2_000)
}, timeoutMs)

child.once('exit', (code, signal) => {
  clearTimeout(timer)
  console.log(`\n[runner] exited code=${code ?? 'null'} signal=${signal ?? 'none'} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  console.log(`[runner] output bytes: ${output.length}`)
  void rm(probeRoot, { recursive: true, force: true }).catch(() => undefined)
})
