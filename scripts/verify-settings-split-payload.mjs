/** Read-only delivery check; does not start an app, mutate pointers, or accept new hashes. */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FEATURES = ['ui.desktop-settings-integrated', 'ui.settings-split-sections', 'ui.appearance-general-extension']

export function readAsarEntry(archive, entryPath) {
  const parts = entryPath.split('/')
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('Invalid ASAR entry path')
  const fd = openSync(archive, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('ASAR is not an ordinary file')
    const prefix = Buffer.alloc(16)
    if (readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error('Invalid ASAR header')
    const headerSize = prefix.readUInt32LE(4), pickleSize = prefix.readUInt32LE(8), jsonSize = prefix.readUInt32LE(12)
    const contentBase = 8 + headerSize
    if (headerSize < 8 || headerSize % 4 !== 0 || pickleSize !== headerSize - 4
      || headerSize !== 8 + Math.ceil(jsonSize / 4) * 4 || jsonSize > 16 * 1024 * 1024
      || contentBase > stat.size) throw new Error('Invalid ASAR header bounds')
    const json = Buffer.alloc(jsonSize)
    if (readSync(fd, json, 0, jsonSize, 16) !== jsonSize) throw new Error('Truncated ASAR header')
    let entry = JSON.parse(json.toString('utf8'))
    for (const part of parts) entry = entry?.files?.[part]
    if (!entry || entry.files || entry.link || entry.unpacked || !/^\d+$/.test(String(entry.offset))) throw new Error('Missing or unsupported packed ASAR entry: ' + entryPath)
    const offset = Number(entry.offset), size = entry.size
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024
      || !Number.isSafeInteger(contentBase + offset + size) || contentBase + offset + size > stat.size) throw new Error('Invalid ASAR entry bounds')
    const data = Buffer.alloc(size)
    if (readSync(fd, data, 0, size, contentBase + offset) !== size) throw new Error('Truncated ASAR entry')
    return data
  } finally { closeSync(fd) }
}

function generatedClient(module) {
  // The production bundle is factory.toString(); retain the exact declaration bytes, without evaluating a candidate.
  const begin = module.indexOf('export function desktopBridgeClientFactory(')
  const end = module.indexOf('\nexport function desktopBridgeClientBundle(', begin)
  if (begin !== 0 || end < 0) throw new Error('Unexpected desktop bridge module format')
  const factory = module.slice('export '.length, end).trimEnd()
  return `window.__ModuleLoader__.load({id:'dsh-desktop-bridge',factory:${factory}});\n`
}

export function verifySettingsSplitPayload(appDir, { sourceRoot = ROOT, profileDir } = {}) {
  appDir = resolve(appDir)
  sourceRoot = resolve(sourceRoot)
  const results = []
  function check(name, callback) {
    try {
      if (!callback()) throw new Error('Contract mismatch')
      results.push({ name, status: 'pass' })
    } catch (error) { results.push({ name, status: 'fail', detail: String(error.message ?? error) }) }
  }
  let module
  check('ASAR contains the exact freshly compiled bridge', () => {
    const bytes = readAsarEntry(join(appDir, 'resources/app.asar'), 'dist/src/desktop-bridge-client-source.js')
    module = bytes.toString('utf8')
    return bytes.equals(readFileSync(join(sourceRoot, 'dist/src/desktop-bridge-client-source.js')))
  })
  check('External bridge equals the ASAR bridge', () => module !== undefined
    && readFileSync(join(appDir, 'resources/desktop-bridge/desktop-bridge-client-source.js'), 'utf8') === module)
  check('Independent sections and additive appearance ID are packaged', () => module !== undefined
    && module.includes("'desktop-notifications'") && module.includes("'desktop-updates'")
    && /id:\s*'desktop-appearance'/.test(module) && /order:\s*10\.5/.test(module)
    && !/id:\s*'(?:desktop-settings|appearance)'/.test(module))
  check('Settings resource equals canonical source', () => readFileSync(join(appDir, 'resources/settings.html'))
    .equals(readFileSync(join(sourceRoot, 'assets/settings.html'))))
  check('Sections retain both updater routes and initial selection', () => {
    const html = readFileSync(join(appDir, 'resources/settings.html'), 'utf8')
    return html.includes('api.desktopUpdateAction') && html.includes('api.harnessUpdateAction')
      && html.includes('dataset.dshSection') && html.includes('html[data-dsh-section] aside{display:none!important}')
  })
  check('Candidate and accepted manifest retain split-settings capabilities', () => {
    const accepted = JSON.parse(readFileSync(join(sourceRoot, 'customizations/preservation.json'), 'utf8'))
    const candidate = JSON.parse(readFileSync(join(appDir, 'resources/preservation.json'), 'utf8'))
    return candidate.schema === 1 && candidate.revision >= accepted.revision
      && FEATURES.every(id => accepted.features.includes(id) && candidate.features.includes(id))
      && JSON.stringify(candidate) === JSON.stringify(accepted)
  })
  if (profileDir !== undefined) check('Startup-generated Profile client equals the packaged factory', () => module !== undefined
    && readFileSync(join(resolve(profileDir), 'node_modules/dsh-desktop-bridge/desktop-bridge-client.js'), 'utf8') === generatedClient(module))
  return { status: results.every(row => row.status === 'pass') ? 'pass' : 'fail', appDir, profileChecked: profileDir !== undefined, results }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!['--app', '--root', '--profile'].includes(key) || !value || value.startsWith('--') || options[key]) throw new Error('Usage: --app <app directory> [--root <source root>] [--profile <actual Profile>]')
    options[key] = value
  }
  if (!options['--app']) throw new Error('--app is required; the checker never selects or activates a candidate')
  const report = verifySettingsSplitPayload(options['--app'], { sourceRoot: options['--root'] ?? ROOT, profileDir: options['--profile'] })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.status === 'pass' ? 0 : 1
}
