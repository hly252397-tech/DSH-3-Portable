import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activeUiProfile } from './lib/active-ui-profile.mjs'

export const protectedPaths = [
  'assets/theme.css', 'assets/shell.html', 'src/dsh-view-preload.cts',
  'scripts/build-sidebar-spaces-client.mjs', 'scripts/build-native-browser-card.mjs', 'scripts/build-sidebar-layout-compat.mjs',
  ...['lib/client.src.js', 'lib/client.js'].map(p => `Data/DSH/profiles/web/local/dsh-sidebar-spaces/${p}`),
  ...['src/client/Sidebar.tsx', 'src/client/service.ts', 'src/client/layout.css', 'lib/client.js', 'portable/browser-view.js'].map(p => `Data/DSH/profiles/web/local/dsh-better-sidebar/${p}`),
  'Data/DSH/profiles/web/local/dsh-restart-button/lib/client.js',
  'customizations/black-hole/lib/client.js',
  'scripts/restore-scheduled-tasks-entry.mjs',
  'Customize/Automation-Workbench/build.mjs',
  'Data/DSH/profiles/web/node_modules/@michengai/dsh-automation/lib/client.js',
  'Data/DSH/profiles/web/local/dsh-better-sidebar/src/client/SideCardSection.tsx',
  'Data/DSH/profiles/web/local/dsh-black-hole/lib/client.js',
  'customizations/custom-spaces/lib/client.js',
]
export const localPlugins = ['dsh-better-sidebar', 'dsh-sidebar-spaces', 'dsh-restart-button', 'dsh-custom-spaces', 'dsh-black-hole']
// 实机目录已被改名（local/dsh-custom-spaces → local/dsh-custom-spaces.disabled），归档件仍由
// customizations/custom-spaces/lib/client.js 保护。存在性按 local 目录判定，缺失时打印跳过原因。
const baselinePath = 'customizations/ui/baseline.json'
export const digest = data => createHash('sha256').update(data).digest('hex')
const content = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
function inside(root, name) {
  const path = resolve(root, name), rel = relative(root, path)
  if (!name || isAbsolute(name) || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path outside project: ${name}`)
  return path
}
const json = file => JSON.parse(readFileSync(file, 'utf8'))
export function activeProtectedPaths(root) {
  const { runtime, profile } = activeUiProfile(root)
  if (!runtime || profile === resolve(root, 'Data/DSH/profiles/web')) return []
  // Keep frozen-generation recovery snapshots as well as the currently loaded UI.
  return ['local/dsh-better-sidebar/lib/client.js', 'local/dsh-better-sidebar/src/client/SideChatView.tsx',
    'local/dsh-custom-spaces/lib/client.js'].map(path => relative(root, resolve(profile, path)).replaceAll('\\', '/'))
}

export function verifyBaseline(root, { live = true } = {}) {
  const baseline = json(inside(root, baselinePath)), problems = []
  if (baseline.schema !== 1 || !Array.isArray(baseline.files)) throw new Error('Invalid UI baseline')
  const history = json(inside(root, baseline.history))
  if (JSON.stringify(history) !== JSON.stringify(baseline)) problems.push('Current baseline differs from immutable history')
  if (!existsSync(inside(root, baseline.note))) problems.push(`Missing change record: ${baseline.note}`)
  for (const proof of baseline.evidence) {
    const file = inside(root, proof.snapshot)
    if (!existsSync(file) || digest(readFileSync(file)) !== proof.sha256) problems.push(`Broken UI evidence snapshot: ${proof.path}`)
  }
  for (const required of protectedPaths) if (!baseline.files.some(f => f.path === required)) problems.push(`Protection removed: ${required}`)
  if (live) for (const required of activeProtectedPaths(root)) if (!baseline.files.some(f => f.path === required)) problems.push(`Active UI protection missing: ${required}`)
  for (const file of baseline.files) {
    const snapshot = inside(root, file.snapshot)
    if (!existsSync(snapshot) || digest(content(snapshot)) !== file.sha256) problems.push(`Broken source snapshot: ${file.path}`)
    if (!live && file.path.startsWith('Data/')) continue
    const current = inside(root, file.path)
    if (!existsSync(current) || digest(content(current)) !== file.sha256) problems.push(`UI drift: ${file.path}`)
  }
  if (live) {
    const profileRoot = activeUiProfile(root).profile
    const manifest = json(resolve(profileRoot, 'package.json'))
    for (const name of localPlugins) {
      const localSource = resolve(profileRoot, 'local', name)
      if (!existsSync(localSource)) {
        if (profileRoot !== inside(root, 'Data/DSH/profiles/web')) {
          problems.push(`Missing active local plugin: ${name}`)
          continue
        }
        console.warn(`[ui-baseline] skip local plugin check: ${name} — 实机源码目录不存在 (${relative(root, localSource)})，插件已改名/停用；归档件仍受 protectedPaths 保护。`)
        continue
      }
      const declared = manifest.dependencies?.[name]
      if (typeof declared !== 'string' || !declared.startsWith('link:') || resolve(profileRoot, declared.slice(5)) !== resolve(profileRoot, 'local', name)) problems.push(`Local link changed: ${name}`)
      if (!manifest.dsh?.profile?.bundles?.includes(name)) problems.push(`Bundle disabled: ${name}`)
      try {
        if (realpathSync(resolve(profileRoot, 'node_modules', name)) !== realpathSync(resolve(profileRoot, 'local', name))) problems.push(`Installed copy differs from local source: ${name}`)
      } catch { problems.push(`Missing installed local plugin: ${name}`) }
    }
    if (!manifest.dsh?.profile?.bundles?.includes('@michengai/dsh-codex-ui')) problems.push('Codex navigation disabled')
  }
  return problems
}

export function recordBaseline(root, { note, evidence }) {
  if (!note?.startsWith('docs/') || !existsSync(inside(root, note))) throw new Error('A project change record under docs/ is required')
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error('Real UI evidence JSON is required')
  const proofs = evidence.map(path => {
    const file = inside(root, path), result = json(file)
    if (result.status !== 'pass' || !Array.isArray(result.results) || !result.results.length) throw new Error(`UI evidence is not passing: ${path}`)
    const data = readFileSync(file), sha256 = digest(data)
    return { path, data, sha256, snapshot: `customizations/ui/evidence/${sha256}.json` }
  })
  const files = [...protectedPaths, ...activeProtectedPaths(root)].map(path => {
    const data = content(inside(root, path)), sha256 = digest(data)
    return { path, data, sha256, snapshot: `customizations/ui/sources/${sha256}.txt` }
  })
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const baseline = { schema: 1, recordedAt: new Date().toISOString(), note, evidence: proofs.map(({ data, ...proof }) => proof), history: `customizations/ui/history/${id}.json`, files: files.map(({ data, ...file }) => file) }
  for (const proof of proofs) {
    const dest = inside(root, proof.snapshot); mkdirSync(dirname(dest), { recursive: true })
    if (!existsSync(dest)) writeFileSync(dest, proof.data, { flag: 'wx' })
    else if (digest(readFileSync(dest)) !== proof.sha256) throw new Error(`Corrupt immutable evidence: ${proof.snapshot}`)
  }
  for (const file of files) {
    const dest = inside(root, file.snapshot); mkdirSync(dirname(dest), { recursive: true })
    if (!existsSync(dest)) writeFileSync(dest, file.data, { flag: 'wx' })
    else if (digest(content(dest)) !== file.sha256) throw new Error(`Corrupt immutable snapshot: ${file.snapshot}`)
  }
  const history = inside(root, baseline.history); mkdirSync(dirname(history), { recursive: true })
  writeFileSync(history, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(inside(root, baselinePath), JSON.stringify(baseline, null, 2) + '\n')
  return baseline
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), root = process.cwd()
    if (args.includes('--record')) {
      const note = args[args.indexOf('--note') + 1]
      const evidence = args.flatMap((a, i) => a === '--evidence' ? [args[i + 1]] : [])
      const baseline = recordBaseline(root, { note, evidence }); console.log(`UI baseline recorded: ${baseline.history}`)
    }
    const problems = verifyBaseline(root, { live: !args.includes('--source-only') })
    if (problems.length) throw new Error(problems.join('\n') + '\nRead docs/03-技术架构/UI定制维护契约.md; do not accept drift without review and UI evidence.')
    console.log(args.includes('--source-only') ? 'PASS UI source snapshots (live Profile not checked)' : 'PASS UI baseline, local links and enabled bundles')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
