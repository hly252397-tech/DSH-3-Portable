import { readFile, lstat, realpath } from 'node:fs/promises'
import { resolve, dirname, parse, sep } from 'node:path'
import { auditUiConsistency } from './lib/ui-consistency-contract.mjs'

const args = process.argv.slice(2)
const options = { root: process.cwd(), catalog: 'customizations/ui/interface-catalog.json' }
try {
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === '--help') {
      process.stdout.write('Read-only v1 UI diagnostics: --root PATH --catalog PATH [--evidence PATH --evidence-root PATH]. JSON to stdout only; exit 0 diagnostic pass, 1 fail, 2 blocked. Actual Loader/source-to-output proof verification is unsupported: captures remain SOURCE_BINDING_UNPROVEN, including equal-copy or JSON verified claims. Not a deployment or acceptance gate; no Data writes.\n')
      process.exit(0)
    }
    if (!['--root', '--catalog', '--evidence', '--evidence-root'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Unknown option or missing value: ' + name)
    options[name.slice(2)] = args[++index]
  }
  const readJson = async path => {
    const anchor = parse(path).root
    let cursor = anchor
    for (const part of path.slice(anchor.length).split(sep).filter(Boolean)) {
      cursor = resolve(cursor, part)
      const item = await lstat(cursor)
      if (item.isSymbolicLink() || (cursor !== path && !item.isDirectory())) throw new Error('Audit JSON path may not contain a link')
    }
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024 || resolve(await realpath(path)) !== path) throw new Error('Audit JSON input must be a bounded plain file')
    return JSON.parse(await readFile(path, 'utf8'))
  }
  const root = resolve(options.root)
  const catalog = await readJson(resolve(root, options.catalog))
  const evidencePath = options.evidence ? resolve(root, options.evidence) : undefined
  const evidence = evidencePath ? await readJson(evidencePath) : undefined
  const result = await auditUiConsistency({ repositoryRoot: root, catalog, evidence, evidenceRoot: evidencePath ? resolve(root, options['evidence-root'] ?? dirname(evidencePath)) : undefined })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2
} catch (error) {
  process.stdout.write(JSON.stringify({ schema: 1, kind: 'ui-consistency-audit', status: 'fail', acceptance: 'not-performed', findings: [{ severity: 'fail', code: 'AUDIT_INPUT_ERROR', message: error.message }] }, null, 2) + '\n')
  process.exitCode = 1
}
