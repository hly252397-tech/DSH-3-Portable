/** Read-only development/release check. No capture file is written implicitly. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  captureCustomizationState, checkPreservationManifest, readPreservationManifest,
  verifyCustomizationPreserved, verifyCustomizationSources,
  type CustomizationSnapshot,
} from '../src/customization-preservation.js'
import { resolveActivePortablePaths } from '../src/portable-paths.js'

const args = process.argv.slice(2)
const value = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const result = args[index + 1]
  if (!result || result.startsWith('--')) throw new Error(name + ' needs a value')
  return result
}

try {
  const known = new Set(['--root', '--profile', '--source-only', '--candidate-manifest', '--snapshot', '--approved-snapshot', '--capture'])
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!
    if (!known.has(option)) throw new Error('Unknown option: ' + option)
    if (!['--source-only', '--capture'].includes(option)) index++
  }
  const root = resolve(value('--root') ?? process.cwd())
  const manifest = readPreservationManifest(root)
  const candidateManifest = value('--candidate-manifest')
  const result = candidateManifest === undefined ? verifyCustomizationSources(root, manifest)
    : checkPreservationManifest(JSON.parse(readFileSync(resolve(candidateManifest), 'utf8')), manifest)
  if (!result.ok) throw new Error(result.issues.map(item => item.code + ' ' + (item.pluginName ?? '') + ' ' + (item.path ?? '')).join('\n'))
  if (candidateManifest === undefined && !args.includes('--source-only')) {
    const profile = value('--profile') ?? resolve(resolveActivePortablePaths(root)?.dshHome ?? resolve(root, 'Data/DSH'), 'profiles/web')
    const options = { portableRoot: root, profileDir: resolve(profile), manifest }
    const snapshotPath = value('--snapshot'), approvedPath = value('--approved-snapshot')
    if (approvedPath && !snapshotPath) throw new Error('--approved-snapshot requires --snapshot')
    if (snapshotPath) {
      const snapshot = JSON.parse(readFileSync(resolve(snapshotPath), 'utf8')) as CustomizationSnapshot
      const approvedSnapshot = approvedPath ? JSON.parse(readFileSync(resolve(approvedPath), 'utf8')) as CustomizationSnapshot : undefined
      const preservation = verifyCustomizationPreserved(snapshot, { ...options, ...(approvedSnapshot ? { approvedSnapshot } : {}) })
      if (!preservation.ok) throw new Error(preservation.issues.map(item => item.code + ' ' + (item.pluginName ?? '') + ' ' + (item.path ?? '')).join('\n'))
    }
    const snapshot = captureCustomizationState(options)
    console.log(args.includes('--capture') ? JSON.stringify(snapshot, null, 2)
      : `PASS customization sources and loaded Profile: ${snapshot.plugins.length} local plugins, fingerprint ${snapshot.fingerprint}`)
  } else console.log(candidateManifest ? 'PASS candidate customization preservation manifest' : 'PASS accepted customization sources; live Profile not checked')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Customization preservation check failed')
  process.exitCode = 1
}
