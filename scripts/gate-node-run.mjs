import { spawnSync } from 'node:child_process'
import { delimiter, dirname } from 'node:path'
import { GATE_NODE } from './lib/gate-node.mjs'

if (process.argv.length < 3) throw new Error('Usage: gate-node-run.mjs <Node arguments...>')
const result = spawnSync(GATE_NODE, process.argv.slice(2), {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, PATH: `${dirname(GATE_NODE)}${delimiter}${process.env.PATH ?? ''}` },
})
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
