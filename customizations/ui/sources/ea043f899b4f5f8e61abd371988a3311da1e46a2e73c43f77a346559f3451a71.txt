import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const pluginRoot = resolve(root, 'Data', 'DSH', 'profiles', 'web', 'local', 'dsh-sidebar-spaces')
const sourcePath = resolve(pluginRoot, 'lib', 'client.src.js')
const vendorPath = resolve(pluginRoot, 'lib', 'echarts.min.js')
const outputPath = resolve(pluginRoot, 'lib', 'client.js')
const anchor = '\t\t/* __ECHARTS_VENDOR_ANCHOR__ */'

const [source, vendor] = await Promise.all([
  readFile(sourcePath, 'utf8'),
  readFile(vendorPath, 'utf8'),
])

if (!source.includes(anchor)) {
  throw new Error(`Missing ECharts vendor anchor in ${sourcePath}`)
}

const embedded = [
  '\t\tconst echarts = (function () {',
  '\t\t\tconst module = { exports: {} };',
  '\t\t\tconst exports = module.exports;',
  vendor,
  '\t\t\treturn module.exports;',
  '\t\t})();',
].join('\n')

await writeFile(outputPath, source.replace(anchor, embedded), 'utf8')
console.log(outputPath)
