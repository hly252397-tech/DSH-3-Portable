import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { REVIEWED_MCP_VERSIONS, patchMcpScopeRefresh, patchMcpGovernanceRefresh } from '../src/mcp-scope-refresh.js'
export { REVIEWED_MCP_VERSIONS, patchMcpScopeRefresh, patchMcpGovernanceRefresh }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2]
  if (!root) throw new Error('Usage: patch-mcp-scope-refresh <connector package directory> [--install]')
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (manifest.name !== 'dsh-mcp-connector' || !REVIEWED_MCP_VERSIONS.includes(manifest.version)) {
    throw new Error(`This reviewed compatibility patch requires dsh-mcp-connector ${REVIEWED_MCP_VERSIONS.join(' or ')}`)
  }
  for (const [file, transform] of [['connection-scopes.js', patchMcpScopeRefresh], ['governance.js', patchMcpGovernanceRefresh]] as const) {
  const target = resolve(root, 'lib', file)
  const before = readFileSync(target, 'utf8')
  const after = transform(before)
  if (before === after) console.log('MCP scope refresh patch is already installed')
  else if (!process.argv.includes('--install')) console.log('MCP scope refresh patch is applicable; no files changed')
  else {
    const backup = target + '.before-refresh-snapshot-20260927'
    if (!existsSync(backup)) copyFileSync(target, backup)
    writeFileSync(target, after)
    console.log(`Installed MCP scope refresh patch; backup: ${backup}`)
  }
  }
}
