import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const [version, archiveInput, outputInput] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || archiveInput === undefined) {
  throw new Error('Usage: create-portable-release-contract <version> <win-x64.zip> [output.json]')
}
const archive = resolve(archiveInput)
const artifact = `dsh-codex-desktop-${version}-win-x64.zip`
if (basename(archive) !== artifact || !(await stat(archive)).isFile()) throw new Error(`Expected release artifact ${artifact}`)
const digest = createHash('sha256')
for await (const chunk of createReadStream(archive)) digest.update(chunk)
const contract = {
  schema: 1,
  edition: 'dsh-3-portable',
  version,
  artifact,
  sha256: digest.digest('hex'),
  capabilities: [
    'portable-data-v1',
    'desktop-ab-v1',
    'desktop-update-state-v1',
    'embedded-browser-v1',
    'runtime-prewarm-v1',
  ],
}
const output = resolve(outputInput ?? `dsh-portable-contract-${version}-win-x64.json`)
await writeFile(output, `${JSON.stringify(contract, undefined, 2)}\n`, 'utf8')
console.log(output)
