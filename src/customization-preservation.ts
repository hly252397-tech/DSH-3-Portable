import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface PreservationFile {
  readonly path: string
  readonly sha256: string
  /** Explicit build input already embedded in the generated client, not a loaded file. */
  readonly runtime?: false
}
export interface PreservationSource {
  readonly pluginName: string
  readonly sourceDir: string
  readonly files: readonly PreservationFile[]
}
/** Accepted source identities, not a snapshot of credentials or user configuration. */
export interface PreservationManifest {
  readonly schema: 1
  readonly revision: number
  readonly features: readonly string[]
  readonly requiredPlugins: readonly string[]
  readonly sources: readonly PreservationSource[]
}
export interface PreservationIssue { readonly code: string; readonly pluginName?: string; readonly path?: string; readonly detail: string }
export interface PreservationReport { readonly ok: boolean; readonly issues: readonly PreservationIssue[] }
export interface PreservedPlugin {
  readonly name: string
  readonly version: string
  readonly localPath: string
  readonly enabled: boolean
  readonly manifestSha256: string
  readonly files: readonly PreservationFile[]
}
export interface CustomizationSnapshot {
  readonly schema: 1
  readonly registrySha256: string
  readonly plugins: readonly PreservedPlugin[]
  readonly fingerprint: string
}
export interface CaptureCustomizationOptions {
  readonly portableRoot: string
  readonly profileDir: string
  readonly manifest?: PreservationManifest
}

const HASH = /^[a-f0-9]{64}$/i
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i
const FEATURE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const CODE = /\.(?:[cm]?js|[cm]?ts|tsx|css|html|svg|png|jpe?g|webp|gif|woff2?|wasm)$/i
const TEXT = /\.(?:[cm]?js|[cm]?ts|tsx|css|html|svg|json|ya?ml)$/i
const STATIC_JSON = new Set(['dsh-capabilities.json'])
const OMIT_DIRS = new Set(['node_modules', 'evidence', 'test', 'tests', 'cache', 'logs', 'data', '.git'])

function hash(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return '{' + Object.keys(object).sort().filter(key => object[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}
function report(issues: PreservationIssue[]): PreservationReport { return { ok: issues.length === 0, issues } }
function issue(code: string, detail: string, pluginName?: string, path?: string): PreservationIssue {
  return { code, detail, ...(pluginName === undefined ? {} : { pluginName }), ...(path === undefined ? {} : { path }) }
}
function localPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !/^[a-z]:/i.test(value)
    && !value.includes('\0') && !value.replaceAll('\\', '/').split('/').some(part => part === '..' || part === '')
}
function child(root: string, path: string): string {
  if (!localPath(path)) throw new Error('Relative customization path is invalid')
  const result = resolve(root, path.replaceAll('\\', '/'))
  const tail = relative(resolve(root), result)
  if (tail === '' || tail === '..' || tail.startsWith('..' + sep) || isAbsolute(tail)) throw new Error('Customization path escapes its root')
  return result
}
function assertInside(root: string, path: string): void {
  const tail = relative(realpathSync(root), realpathSync(path))
  if (tail === '..' || tail.startsWith('..' + sep) || isAbsolute(tail)) throw new Error('Customization file resolves outside its root')
}
function fileDigest(root: string, path: string): string {
  const file = child(root, path)
  assertInside(root, file)
  if (!lstatSync(file).isFile()) throw new Error('Customization source is not an ordinary file')
  const bytes = readFileSync(file)
  return hash(TEXT.test(path) ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes)
}
function validManifest(value: unknown): value is PreservationManifest {
  if (value === null || typeof value !== 'object') return false
  const manifest = value as Partial<PreservationManifest>
  return manifest.schema === 1 && Number.isSafeInteger(manifest.revision) && manifest.revision! >= 1
    && Array.isArray(manifest.features) && manifest.features.length > 0
    && manifest.features.every(item => typeof item === 'string' && FEATURE.test(item))
    && new Set(manifest.features).size === manifest.features.length
    && Array.isArray(manifest.requiredPlugins) && manifest.requiredPlugins.every(item => typeof item === 'string' && PACKAGE.test(item))
    && new Set(manifest.requiredPlugins).size === manifest.requiredPlugins.length
    && Array.isArray(manifest.sources) && manifest.sources.every(source => source && typeof source.pluginName === 'string' && PACKAGE.test(source.pluginName)
      && localPath(source.sourceDir) && Array.isArray(source.files) && source.files.length > 0
      && source.files.every((file: PreservationFile) => file && localPath(file.path) && typeof file.sha256 === 'string' && HASH.test(file.sha256)
        && (file.runtime === undefined || file.runtime === false))
      && new Set(source.files.map((file: PreservationFile) => file.path)).size === source.files.length)
    && new Set(manifest.sources.map(source => source.pluginName)).size === manifest.sources.length
}

export function readPreservationManifest(portableRoot: string): PreservationManifest {
  const path = child(portableRoot, 'customizations/preservation.json')
  assertInside(portableRoot, path)
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!validManifest(manifest)) throw new Error('Customization preservation manifest is invalid')
  return manifest
}

/** Remote desktop packages must declare every accepted feature and canonical source hash.
 * New feature IDs/files may be added. Changed hashes require an explicitly reviewed new
 * requiredManifest; a revision number alone never waives the comparison. */
export function checkPreservationManifest(candidateManifest: unknown, requiredManifest?: PreservationManifest): PreservationReport {
  if (!validManifest(candidateManifest)) return report([issue('MANIFEST_INVALID', 'Candidate has no valid customization preservation manifest')])
  if (requiredManifest === undefined) return report([])
  if (!validManifest(requiredManifest)) return report([issue('MANIFEST_INVALID', 'Required customization preservation manifest is invalid')])
  const issues: PreservationIssue[] = []
  if (candidateManifest.revision < requiredManifest.revision) issues.push(issue('MANIFEST_DOWNGRADE', 'Candidate predates the accepted customization revision'))
  for (const feature of requiredManifest.features) if (!candidateManifest.features.includes(feature)) {
    issues.push(issue('FEATURE_MISSING', 'Candidate drops an accepted feature', undefined, feature))
  }
  for (const name of requiredManifest.requiredPlugins) if (!candidateManifest.requiredPlugins.includes(name)) {
    issues.push(issue('PLUGIN_REQUIREMENT_MISSING', 'Candidate drops a required local plugin', name))
  }
  for (const source of requiredManifest.sources) {
    const next = candidateManifest.sources.find(item => item.pluginName === source.pluginName)
    if (!next || next.sourceDir !== source.sourceDir) {
      issues.push(issue('SOURCE_MAPPING_CHANGED', 'Canonical customization source mapping changed', source.pluginName)); continue
    }
    for (const file of source.files) {
      const nextFile = next.files.find(item => item.path === file.path)
      if (!nextFile || nextFile.sha256.toLowerCase() !== file.sha256.toLowerCase()) {
        issues.push(issue('SOURCE_HASH_CHANGED', 'Canonical source changed without an accepted replacement', source.pluginName, file.path))
      } else if (nextFile.runtime !== file.runtime) {
        issues.push(issue('SOURCE_MAPPING_CHANGED', 'Source-to-runtime protection changed', source.pluginName, file.path))
      }
    }
  }
  return report(issues)
}

/** Does not read Profile settings, sessions, token files, logs, or probe output. */
export function verifyCustomizationSources(portableRoot: string, manifest = readPreservationManifest(portableRoot)): PreservationReport {
  const invalid = checkPreservationManifest(manifest)
  if (!invalid.ok) return invalid
  const issues: PreservationIssue[] = []
  for (const source of manifest.sources) for (const file of source.files) {
    try {
      const directory = child(portableRoot, source.sourceDir)
      assertInside(portableRoot, directory)
      if (fileDigest(directory, file.path) !== file.sha256.toLowerCase()) {
        issues.push(issue('SOURCE_DRIFT', 'Canonical source differs from the accepted manifest', source.pluginName, source.sourceDir + '/' + file.path))
      }
    } catch {
      issues.push(issue('SOURCE_UNAVAILABLE', 'Canonical source is missing, linked outside its root, or unreadable', source.pluginName, source.sourceDir + '/' + file.path))
    }
  }
  return report(issues)
}

export class CustomizationPreservationError extends Error {
  constructor(readonly issues: readonly PreservationIssue[]) {
    super(issues.map(item => item.code + ': ' + (item.pluginName ?? '') + (item.path ? ' / ' + item.path : '') + ' ' + item.detail).join('\n'))
    this.name = 'CustomizationPreservationError'
  }
}
function runtimeFiles(directory: string, manifest: Record<string, unknown>): PreservationFile[] {
  const paths = new Set<string>()
  const mandatory = new Set<string>()
  const addEntry = (value: unknown, key = ''): void => {
    if (key === 'types') return
    if (typeof value === 'string') {
      if (!value.includes('*') && value !== './package.json') mandatory.add(value.replace(/^\.\//, ''))
    } else if (value !== null && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) addEntry(item, name)
    }
  }
  addEntry(manifest.main)
  addEntry(manifest.exports)
  const patch = (manifest.dsh as { bundle?: { patch?: unknown } } | undefined)?.bundle?.patch
  const patchPaths = Array.isArray(patch) ? patch : [patch]
  for (const value of patchPaths) {
    addEntry(value)
    if (typeof value === 'string') {
      const path = value.replace(/^\.\//, '')
      fileDigest(directory, path)
      if (!/^\s*-?\s*id:\s*\S/m.test(readFileSync(child(directory, path), 'utf8'))) {
        throw new Error('Local bundle patch has no stable registration ID')
      }
    }
  }
  if (mandatory.size === 0) throw new Error('Local plugin has no runtime entry')
  for (const path of mandatory) { fileDigest(directory, path); paths.add(path) }
  const walk = (path: string): void => {
    const full = child(directory, path)
    assertInside(directory, full)
    const info = lstatSync(full)
    if (info.isSymbolicLink()) throw new Error('Runtime payload contains a directory link')
    if (info.isDirectory()) {
      for (const entry of readdirSync(full, { withFileTypes: true })) if (!OMIT_DIRS.has(entry.name)) walk(path + '/' + entry.name)
    } else if (info.isFile() && (CODE.test(path) && !path.endsWith('.d.ts') || STATIC_JSON.has(path.split('/').at(-1)!))) paths.add(path)
  }
  const roots = new Set(['lib', 'portable', 'assets'])
  if (Array.isArray(manifest.files)) for (const path of manifest.files) if (typeof path === 'string' && !path.includes('*') && localPath(path)) roots.add(path.replace(/^\.\//, ''))
  for (const path of roots) if (existsSync(child(directory, path))) walk(path)
  return [...paths].sort().map(path => ({ path, sha256: fileDigest(directory, path) }))
}
function semanticManifestDigest(manifest: Record<string, unknown>): string {
  return hash(canonical(Object.fromEntries(['name', 'version', 'type', 'main', 'exports', 'files', 'dsh', 'dependencies', 'peerDependencies', 'engines']
    .filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]))))
}
function snapshotFingerprint(registrySha256: string, plugins: readonly PreservedPlugin[]): string { return hash(canonical({ registrySha256, plugins })) }

/** Capture immediately before preparation, from the Profile selected by the active
 * runtime pointer. Never use the newest directory/receipt as a substitute. */
export function captureCustomizationState(options: CaptureCustomizationOptions): CustomizationSnapshot {
  const root = resolve(options.portableRoot), profile = resolve(options.profileDir)
  assertInside(root, profile)
  const registry = options.manifest ?? readPreservationManifest(root)
  const sourceReport = verifyCustomizationSources(root, registry)
  if (!sourceReport.ok) throw new CustomizationPreservationError(sourceReport.issues)
  fileDigest(profile, 'package.json')
  const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: unknown } }
  }
  if (!Array.isArray(profileManifest.dsh?.profile?.bundles)) throw new Error('Profile bundle list is invalid')
  const bundles = profileManifest.dsh.profile.bundles
  const declarations = Object.entries(profileManifest.dependencies ?? {}).filter(([, spec]) => typeof spec === 'string' && /^(?:link|file|portal):/i.test(spec))
  const issues: PreservationIssue[] = []
  const plugins: PreservedPlugin[] = []
  for (const name of registry.requiredPlugins) if (!declarations.some(([candidate]) => candidate === name)) {
    issues.push(issue('REQUIRED_PLUGIN_MISSING', 'Required customization no longer has a local declaration', name))
  }
  for (const [name, value] of declarations) {
    try {
      if (!PACKAGE.test(name) || typeof value !== 'string' || !/^link:/i.test(value)) throw new Error('Local plugin must use link:')
      const local = value.slice(value.indexOf(':') + 1).replaceAll('\\', '/').replace(/^\.\//, '')
      const directory = child(profile, local)
      assertInside(join(profile, 'local'), directory)
      const installed = child(profile, 'node_modules/' + name)
      // Windows 大小写陷阱：穿 junction 的 realpath 原样返回链接创建时的目标串拼写
      // （常来自 TEMP 环境变量，如 C:\WINDOWS\TEMP），直连路径的 realpath 返回磁盘
      // 规范拼写（C:\Windows\Temp）——同一路径会被判成不同源。win32 按平台语义
      // （大小写不敏感）比较；POSIX 保持严格。
      const installedReal = realpathSync(installed)
      const directoryReal = realpathSync(directory)
      const sameSource = process.platform === 'win32'
        ? installedReal.toLowerCase() === directoryReal.toLowerCase()
        : installedReal === directoryReal
      if (!sameSource) throw new Error('Installed plugin points at a different source')
      fileDigest(directory, 'package.json')
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
      if (manifest.name !== name || typeof manifest.version !== 'string') throw new Error('Local plugin identity differs')
      const files = runtimeFiles(directory, manifest)
      plugins.push({ name, version: manifest.version, localPath: local, enabled: bundles.includes(name), manifestSha256: semanticManifestDigest(manifest), files })
      const mapping = registry.sources.find(item => item.pluginName === name)
      if (mapping) for (const file of mapping.files) {
        if (file.runtime === false) continue
        try {
          if (fileDigest(directory, file.path) !== file.sha256.toLowerCase()) {
            issues.push(issue('SOURCE_RUNTIME_DRIFT', 'Loaded local plugin differs from canonical accepted source', name, file.path))
          }
        } catch {
          issues.push(issue('SOURCE_RUNTIME_UNAVAILABLE', 'Required canonical runtime file is missing or unsafe', name, file.path))
        }
      }
    } catch {
      issues.push(issue('LOCAL_PLUGIN_INVALID', 'Local declaration, installed link, identity, or runtime payload is invalid', name))
    }
  }
  if (issues.length) throw new CustomizationPreservationError(issues)
  plugins.sort((left, right) => left.name.localeCompare(right.name))
  const registrySha256 = hash(canonical(registry))
  return { schema: 1, registrySha256, plugins, fingerprint: snapshotFingerprint(registrySha256, plugins) }
}
function validSnapshot(value: CustomizationSnapshot): boolean {
  return value?.schema === 1 && typeof value.registrySha256 === 'string' && HASH.test(value.registrySha256)
    && Array.isArray(value.plugins) && value.plugins.every(plugin => plugin && typeof plugin.name === 'string' && PACKAGE.test(plugin.name)
      && typeof plugin.version === 'string' && localPath(plugin.localPath) && typeof plugin.enabled === 'boolean'
      && HASH.test(plugin.manifestSha256) && Array.isArray(plugin.files)
      && plugin.files.every((file: PreservationFile) => file && localPath(file.path) && HASH.test(file.sha256)))
    && new Set(value.plugins.map(plugin => plugin.name)).size === value.plugins.length
    && value.fingerprint === snapshotFingerprint(value.registrySha256, value.plugins)
}

/** Default: every captured plugin, link, enabled state and payload must survive.
 * approvedSnapshot is an explicit, complete replacement captured only after the
 * relevant changes were reviewed; this function never creates or approves it. */
export function verifyCustomizationPreserved(snapshot: CustomizationSnapshot, options: CaptureCustomizationOptions & {
  readonly approvedSnapshot?: CustomizationSnapshot
}): PreservationReport {
  const expected = options.approvedSnapshot ?? snapshot
  if (!validSnapshot(snapshot) || !validSnapshot(expected)) return report([issue('SNAPSHOT_INVALID', 'Customization snapshot is invalid or its fingerprint does not match')])
  let actual: CustomizationSnapshot
  try { actual = captureCustomizationState(options) }
  catch (error) {
    return report(error instanceof CustomizationPreservationError ? [...error.issues] : [issue('PROFILE_INVALID', 'Candidate customization Profile cannot be inspected safely')])
  }
  const issues: PreservationIssue[] = []
  if (actual.registrySha256 !== expected.registrySha256) issues.push(issue('UNAPPROVED_REGISTRY_CHANGE', 'Accepted customization manifest changed without an approved snapshot'))
  for (const plugin of expected.plugins) {
    const next = actual.plugins.find(item => item.name === plugin.name)
    if (!next) { issues.push(issue('PLUGIN_MISSING', 'Captured local customization is absent', plugin.name)); continue }
    if (next.localPath !== plugin.localPath) issues.push(issue('LOCAL_PATH_CHANGED', 'Local customization path changed', plugin.name))
    if (next.enabled !== plugin.enabled) issues.push(issue('PLUGIN_STATE_CHANGED', 'Enabled/disabled state changed without an approved snapshot', plugin.name))
    if (next.manifestSha256 !== plugin.manifestSha256) issues.push(issue('PLUGIN_MANIFEST_CHANGED', 'Local plugin identity, API exports or dependencies changed', plugin.name))
    for (const file of plugin.files) if (next.files.find(item => item.path === file.path)?.sha256 !== file.sha256) {
      issues.push(issue('PLUGIN_FILE_CHANGED', 'Runtime file is missing or changed', plugin.name, file.path))
    }
    for (const file of next.files) if (!plugin.files.some(item => item.path === file.path)) issues.push(issue('PLUGIN_FILE_ADDED', 'Runtime payload gained an unapproved file', plugin.name, file.path))
  }
  for (const plugin of actual.plugins) if (!expected.plugins.some(item => item.name === plugin.name)) issues.push(issue('PLUGIN_ADDED', 'Profile gained an unapproved local customization', plugin.name))
  return report(issues)
}

export function assertCustomizationPreserved(snapshot: CustomizationSnapshot, options: CaptureCustomizationOptions & {
  readonly approvedSnapshot?: CustomizationSnapshot
}): void {
  const result = verifyCustomizationPreserved(snapshot, options)
  if (!result.ok) throw new CustomizationPreservationError(result.issues)
}
