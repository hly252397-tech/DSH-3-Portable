import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import semver from 'semver'

const json = path => JSON.parse(readFileSync(path, 'utf8'))
const within = (base, path) => { const rel = relative(base, path); return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel) }
const entries = value => typeof value === 'string' ? [value] : value && typeof value === 'object'
  ? Object.entries(value).filter(([key]) => key !== 'types').flatMap(([, item]) => entries(item)) : []
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const isDshFamily = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isExactVersion = value => {
  if (typeof value !== 'string') return false
  const parsed = semver.parse(value)
  return parsed !== null && value === parsed.version + (parsed.build.length ? '+' + parsed.build.join('.') : '')
}
const isExactPackageVersion = key => {
  const separator = key.lastIndexOf('@')
  return separator > 0 && PACKAGE_NAME.test(key.slice(0, separator)) && isExactVersion(key.slice(separator + 1))
}

/** The installed app-boot exposes these pure policies only through its aggregate
 * entry, which imports Loader/Cordis and launch services. Keep this synchronous
 * audit metadata-only: match profile-compatibility's exact identity schema without
 * importing runtime or business modules. Unlike boot, unsafe metadata is reported
 * to the gate, never used to grant a waiver. Nothing here creates new permissions. */
function readExistingGrants(profile) {
  const grants = new Map(), warnings = []
  const path = resolve(profile, 'compatibility.json')
  let value
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576) {
      warnings.push('compatibility.json is not bounded ordinary metadata; no exact approvals used')
      return { grants, warnings }
    }
    value = json(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') warnings.push('compatibility.json is unreadable or invalid JSON; no exact approvals used')
    return { grants, warnings }
  }
  if (!isObject(value)) {
    warnings.push('compatibility.json must map exact package versions to exact runtime versions; no exact approvals used')
    return { grants, warnings }
  }
  for (const [key, versions] of Object.entries(value)) {
    if (!isExactPackageVersion(key) || !Array.isArray(versions) || !versions.every(isExactVersion)) {
      warnings.push('compatibility.json contains an invalid exact-version record; that record was ignored')
      continue
    }
    grants.set(key, versions)
  }
  return { grants, warnings }
}

function readPeer(runtime, name) {
  if (!runtime || !PACKAGE_NAME.test(name)) return undefined
  try {
    const path = resolve(runtime, 'node_modules', name, 'package.json')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
    const value = json(path)
    return isObject(value) && value.name === name && isExactVersion(value.version) ? value : undefined
  } catch { return undefined }
}

/** Exact grants are DSH-runtime permissions, not a repair for a missing peer or a
 * mixed runtime. Resolve identity from installed dsh/app-boot, never a config,
 * directory name, plugin's wanted version, or the permission file itself. */
function trustedRuntimeVersion(runtime) {
  const dsh = readPeer(runtime, '@deepseek-ai/dsh')
  const boot = readPeer(runtime, '@deepseek-ai/dsh-app-boot')
  if (!dsh || !boot || dsh.version !== boot.version) return undefined
  try {
    const names = readdirSync(resolve(runtime, 'node_modules/@deepseek-ai')).filter(name => name === 'dsh' || name.startsWith('dsh-'))
    for (const name of names) {
      const manifest = readPeer(runtime, '@deepseek-ai/' + name)
      if (!manifest || manifest.version !== dsh.version) return undefined
    }
  } catch { return undefined }
  return dsh.version
}

/** Audit registered local plugins, not disabled directories. Validate actual link
 * targets and semantic peer satisfaction; prereleases never get a blanket waiver. */
export function auditPluginDependencies(profile, runtime) {
  const p = json(resolve(profile, 'package.json'))
  const bundles = p.dsh?.profile?.bundles ?? []
  const { grants, warnings } = readExistingGrants(profile)
  const runtimeVersion = grants.size ? trustedRuntimeVersion(runtime) : undefined
  const result = { plugins: [], links: [], entries: [], dependencies: [], peers: [], approved: [], compatibilityWarnings: warnings }
  for (const [name, spec] of Object.entries(p.dependencies ?? {})) {
    if (typeof spec !== 'string' || !/^(?:link:|file:)/.test(spec)) continue
    result.plugins.push(name)
    const dir = resolve(profile, spec.slice(spec.indexOf(':') + 1))
    const linkErrorsBefore = result.links.length
    if (!spec.startsWith('link:') || !within(resolve(profile, 'local'), dir)) result.links.push(`${name}: must link to profile/local`)
    if (!bundles.includes(name)) result.links.push(`${name}: not in bundles`)
    try {
      if (realpathSync(resolve(profile, 'node_modules', name)) !== realpathSync(dir)) result.links.push(`${name}: installed target differs`)
    } catch { result.links.push(`${name}: installed link missing`) }
    let pkg
    try { pkg = json(resolve(dir, 'package.json')) } catch { result.entries.push(`${name}: package.json missing/invalid`); continue }
    if (!isObject(pkg)) { result.entries.push(`${name}: package.json must be an object`); continue }
    if (pkg.name !== name) result.links.push(`${name}: manifest name differs (${typeof pkg.name === 'string' ? pkg.name : 'invalid identity'})`)
    const targets = [...entries(pkg.main), ...entries(pkg.exports?.['.']), ...entries(pkg.exports?.['./client'])]
    if (!targets.length) result.entries.push(`${name}: no entry declared`)
    for (const entry of new Set(targets)) {
      const path = resolve(dir, entry)
      if (!within(dir, path) || !existsSync(path)) result.entries.push(`${name}: ${entry}`)
    }
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (dep.startsWith('@deepseek-ai/')) result.dependencies.push(`${name}: ${dep}=${range}`)
    }
    const mismatches = []
    let invalidPeer = false
    if (pkg.peerDependencies !== undefined && !isObject(pkg.peerDependencies)) {
      result.peers.push(`${name}: peerDependencies must be an object`)
      invalidPeer = true
    }
    for (const [dep, range] of Object.entries(isObject(pkg.peerDependencies) ? pkg.peerDependencies : {})) {
      // This gate covers the DSH singleton family, not browser externals such as
      // React (served by frontend vendor modules, not profile/node_modules).
      if (!dep.startsWith('@deepseek-ai/')) continue
      const peer = readPeer(runtime, dep)
      const version = peer?.version
      const validRange = typeof range === 'string' && range.trim() !== '' && semver.validRange(range) !== null
      const path = runtime && PACKAGE_NAME.test(dep) ? resolve(runtime, 'node_modules', dep, 'package.json') : undefined
      if (validRange && path && !existsSync(path) && pkg.peerDependenciesMeta?.[dep]?.optional === true) continue
      if (!version || !validRange) {
        result.peers.push(`${name}: ${dep}@${version ?? 'missing/invalid'} not in ${typeof range === 'string' ? range : JSON.stringify(range)}`)
        invalidPeer = true
      } else if (!semver.satisfies(version, range)) {
        mismatches.push({ name: dep, installedVersion: version, range })
      }
    }
    const packageVersion = typeof pkg.name === 'string' && typeof pkg.version === 'string' ? `${pkg.name}@${pkg.version}` : ''
    const approvedPeers = []
    const mayUseGrant = !invalidPeer && result.links.length === linkErrorsBefore && isExactPackageVersion(packageVersion)
      && runtimeVersion !== undefined && grants.get(packageVersion)?.includes(runtimeVersion) === true
    for (const peer of mismatches) {
      if (mayUseGrant && isDshFamily(peer.name) && peer.installedVersion === runtimeVersion) approvedPeers.push(peer)
      else result.peers.push(`${name}: ${peer.name}@${peer.installedVersion} not in ${peer.range}`)
    }
    if (approvedPeers.length) result.approved.push({ packageVersion, runtimeVersion, peers: approvedPeers })
  }
  for (const name of bundles) {
    const local = resolve(profile, 'local', name, 'package.json')
    if (existsSync(local) && !result.plugins.includes(name)) result.links.push(`${name}: enabled local bundle has no local link declaration`)
  }
  return result
}
