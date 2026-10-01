import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeTextFileAtomicSync } from './atomic-file.js'

// npm 0.2.59 reviewed 2026-09-27: both target files are byte-identical to 0.2.58 snapshots.
export const REVIEWED_MCP_VERSIONS = ['0.2.58', '0.2.59'] as const

export function patchMcpScopeRefresh(source: string): string {
  const before = 'function installRestriction(agent) {\n    const denied = observedPublicNames().filter((name) => {'
  const after = 'function installRestriction(agent, publicNames) {\n    const denied = publicNames.filter((name) => {'
  const loop = 'for (const agent of live) installRestriction(agent);'
  const replacement = 'const publicNames = live.size ? observedPublicNames() : [];\n      for (const agent of live) installRestriction(agent, publicNames);'
  let text = source.replace(/\r\n/g, '\n')
  if (!text.includes(after) || !text.includes(replacement)) {
    if (text.split(before).length !== 2 || text.split(loop).length !== 2) {
    throw new Error('MCP scope implementation changed; review before applying this compatibility patch')
    }
    text = text.replace(before, after).replace(loop, replacement)
  }
  const anchor = 'function observedPublicNames() {\n'
  const guard = '    const currentBindings = bindings();\n    if (records().every(record => bindingForConnection(currentBindings, record.key).global === true)) return [];\n'
  if (!text.includes(guard)) {
    if (text.split(anchor).length !== 2) throw new Error('MCP scope observer implementation changed')
    text = text.replace(anchor, anchor + guard)
  }
  return text
}

export function patchMcpGovernanceRefresh(source: string): string {
  const text = source.replace(/\r\n/g, '\n')
  const anchor = 'function deniedObservedNames() {\n'
  const guard = '    if (rules().length === 0 && records().every(record => record.enabled !== false)) return [];\n'
  if (text.includes(guard)) return text
  if (text.split(anchor).length !== 2) throw new Error('MCP governance implementation changed; review before applying')
  return text.replace(anchor, anchor + guard)
}


/** Run after installation, before starting Loader (also on explicit plugin recycle).
 * Preflight both files before touching either; never modify running plugin modules. */
export function preserveMcpRefreshPatch(profileDir: string): string[] {
  const root = resolve(profileDir, 'node_modules/dsh-mcp-connector')
  if (!existsSync(resolve(root, 'package.json'))) return []
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (manifest.name !== 'dsh-mcp-connector' || !REVIEWED_MCP_VERSIONS.includes(manifest.version)) {
    throw new Error('MCP refresh compatibility requires review for version ' + manifest.version)
  }
  const changes = ([['connection-scopes.js', patchMcpScopeRefresh], ['governance.js', patchMcpGovernanceRefresh]] as const).map(([file, transform]) => {
    const target = resolve(root, 'lib', file)
    const before = readFileSync(target, 'utf8')
    return { target, before, after: transform(before) }
  }).filter(item => item.before !== item.after)
  for (const item of changes) {
    const backup = item.target + '.before-refresh-snapshot-20260927'
    if (!existsSync(backup)) copyFileSync(item.target, backup)
  }
  for (const item of changes) writeTextFileAtomicSync(item.target, item.after)
  return changes.map(item => item.target)
}
