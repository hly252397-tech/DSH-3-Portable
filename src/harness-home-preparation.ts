import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { writeTextFileAtomic } from './atomic-file.js'
import { assertCustomizationPreserved, captureCustomizationState, type CustomizationSnapshot } from './customization-preservation.js'

export interface PreparedHarnessHomeBinding {
  readonly schema: 2
  readonly runtimeVersion: string
  readonly generation: string
  readonly runtimeRelativePath: string
}
export interface PrepareHarnessHomeOptions {
  readonly portableRoot: string
  readonly sourceProfileDir: string
  readonly candidate: { readonly directory: string; readonly version: string; readonly fingerprint: string }
  readonly transactionId: string
  /** The caller has actually stopped the old server under the updater idle gate. */
  readonly sourceStopped: true
  readonly profileCompatibility?: Readonly<Record<string, readonly string[]>>
  readonly snapshot?: CustomizationSnapshot
  /** Isolated fixtures only. Product callers load semver from the candidate runtime. */
  readonly satisfies?: (version: string, range: string) => boolean
}
export interface PreparedHarnessHome {
  readonly home: string
  readonly profileDir: string
  readonly binding: PreparedHarnessHomeBinding
  publishBinding(): Promise<void>
  /** Stop/dispose any server started from this home before rolling it back. */
  rollbackBinding(): Promise<void>
}

const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i
function within(root: string, path: string): boolean {
  const tail = relative(resolve(root), resolve(path))
  return tail === '' || tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail)
}
async function assertExistingWithin(root: string, path: string): Promise<void> {
  if (!within(root, await realpath(path))) throw new Error('Harness home preparation path resolves outside its owned root')
}
async function assertParentWithin(root: string, path: string): Promise<void> {
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('Harness home preparation parent cannot be resolved')
    ancestor = parent
  }
  await assertExistingWithin(root, ancestor)
}
async function optionalText(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Harness home binding must be an ordinary file')
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function readObject(path: string): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('Harness home metadata is missing or invalid: ' + basename(path)) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Harness home metadata is not an object: ' + basename(path))
  return value as Record<string, unknown>
}
async function loadSatisfies(candidate: string): Promise<(version: string, range: string) => boolean> {
  const requireCandidate = createRequire(join(candidate, 'node_modules/@deepseek-ai/dsh/package.json'))
  let path: string
  try { path = requireCandidate.resolve('semver') } catch { throw new Error('Candidate runtime does not provide semver for plugin compatibility validation') }
  await assertExistingWithin(candidate, path)
  const semver = requireCandidate(path) as { satisfies?: (version: string, range: string, options: { includePrerelease: boolean }) => boolean }
  if (typeof semver.satisfies !== 'function') throw new Error('Candidate runtime semver API is invalid')
  return (version, range) => semver.satisfies!(version, range, { includePrerelease: true })
}
async function findManifest(profile: string, runtime: string, name: string): Promise<Record<string, unknown> | undefined> {
  if (!PACKAGE.test(name)) throw new Error('Enabled bundle name is invalid')
  for (const directory of [profile, runtime]) {
    const path = join(directory, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(path)) continue
    const actual = await realpath(path)
    if (!within(profile, actual) && !within(runtime, actual)) throw new Error('Enabled bundle resolves outside the prepared home/runtime')
    const manifest = await readObject(path)
    if (manifest.name !== name || typeof manifest.version !== 'string') throw new Error('Enabled bundle identity is invalid: ' + name)
    return manifest
  }
  return undefined
}

async function validateCompatibility(
  profile: string, candidate: string, version: string,
  grants: Readonly<Record<string, readonly string[]>> | undefined,
  satisfies: (version: string, range: string) => boolean,
): Promise<void> {
  const manifest = await readObject(join(profile, 'package.json'))
  const bundles = (manifest.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string' && PACKAGE.test(name))) throw new Error('Prepared Profile bundle list is invalid')
  const compatibilityPath = join(profile, 'compatibility.json')
  const existing = existsSync(compatibilityPath) ? await readObject(compatibilityPath) : {}
  const compatibility: Record<string, string[]> = Object.create(null)
  for (const [key, versions] of Object.entries(existing)) {
    if (!Array.isArray(versions) || !versions.every(item => typeof item === 'string')) throw new Error('Existing Profile compatibility grant is invalid')
    compatibility[key] = [...versions]
  }
  const installed = new Map<string, Record<string, unknown>>()
  for (const name of bundles as string[]) {
    const plugin = await findManifest(profile, candidate, name)
    if (!plugin) throw new Error('Candidate loses an enabled bundle: ' + name)
    installed.set(name + '@' + plugin.version, plugin)
  }
  let changed = false
  for (const [key, versions] of Object.entries(grants ?? {})) {
    if (!installed.has(key) || !Array.isArray(versions) || versions.length !== 1 || versions[0] !== version) {
      throw new Error('Published compatibility grant must name an installed enabled bundle and only the target runtime: ' + key)
    }
    const previous = compatibility[key] ?? []
    if (!previous.includes(version)) { compatibility[key] = [...previous, version]; changed = true }
  }
  for (const [key, plugin] of installed) {
    const peers = plugin.peerDependencies
    if (peers === undefined) continue
    if (!peers || typeof peers !== 'object' || Array.isArray(peers)) throw new Error('Enabled plugin peer metadata is invalid: ' + key)
    const optional = plugin.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined
    for (const [name, range] of Object.entries(peers)) {
      if (typeof range !== 'string') throw new Error('Enabled plugin peer range is invalid: ' + key)
      // Official runtime peers must be resolved from the candidate, never the old Profile layer.
      const official = name.startsWith('@deepseek-ai/')
      const peer = official ? await findManifest(candidate, candidate, name) : await findManifest(profile, candidate, name)
      if (!peer && optional?.[name]?.optional === true) continue
      if (!peer) throw new Error('Candidate lacks a required plugin peer: ' + key + ' -> ' + name)
      if (!satisfies(String(peer.version), range) && !(official && compatibility[key]?.includes(version))) {
        throw new Error('Enabled plugin is not compatible with the target runtime and has no exact approved grant: ' + key)
      }
    }
  }
  if (changed) await writeTextFileAtomic(compatibilityPath, JSON.stringify(compatibility, null, 2) + '\n')
}

/** Prepare only while the caller owns the idle/stopped interval. Copy the explicit
 * active home into a fresh transaction, remap all links, retain the source on failure.
 * Runtime binaries remain in their canonical immutable slot; no runtime-tree copy. */
export async function prepareHarnessHome(options: PrepareHarnessHomeOptions): Promise<PreparedHarnessHome> {
  if (options.sourceStopped !== true) throw new Error('The active DSH server must be stopped before copying its home')
  if (!VERSION.test(options.candidate.version) || !/^[a-f0-9]{64}$/i.test(options.candidate.fingerprint)
    || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(options.transactionId)) throw new Error('Harness home preparation transaction or candidate identity is invalid')
  const root = await realpath(resolve(options.portableRoot))
  const dataRoot = join(root, 'Data')
  const profile = await realpath(resolve(options.sourceProfileDir))
  if (basename(profile) !== 'web' || basename(dirname(profile)) !== 'profiles') throw new Error('The active web Profile path is invalid')
  const sourceHome = resolve(profile, '../..')
  if (!within(dataRoot, sourceHome) || sourceHome === dataRoot) throw new Error('The active home must be inside portable Data')
  await assertExistingWithin(dataRoot, sourceHome)
  const candidate = await realpath(resolve(options.candidate.directory))
  const expectedCandidate = join(dataRoot, 'Runtime/Harness/slots', options.candidate.version + '-' + options.candidate.fingerprint.slice(0, 16).toLowerCase())
  if (candidate !== expectedCandidate || (await lstat(options.candidate.directory)).isSymbolicLink()) throw new Error('Candidate runtime is not its canonical immutable slot')
  for (const path of ['node_modules/@deepseek-ai/dsh/package.json', 'node_modules/@deepseek-ai/dsh/lib/bin.js', '.dsh-runtime-fingerprint']) {
    await assertExistingWithin(candidate, join(candidate, path))
    if (!(await lstat(join(candidate, path))).isFile()) throw new Error('Candidate runtime identity and entry must be ordinary files')
  }
  const candidateManifest = await readObject(join(candidate, 'node_modules/@deepseek-ai/dsh/package.json'))
  if (candidateManifest.name !== '@deepseek-ai/dsh' || candidateManifest.version !== options.candidate.version
    || !existsSync(join(candidate, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
    || (await readFile(join(candidate, '.dsh-runtime-fingerprint'), 'utf8')).trim().toLowerCase() !== options.candidate.fingerprint.toLowerCase()) {
    throw new Error('Candidate runtime identity, entry or fingerprint is invalid')
  }
  const snapshot = options.snapshot ?? captureCustomizationState({ portableRoot: root, profileDir: profile })
  assertCustomizationPreserved(snapshot, { portableRoot: root, profileDir: profile })
  const satisfies = options.satisfies ?? await loadSatisfies(candidate)
  const token = createHash('sha256').update(options.transactionId).digest('hex').slice(0, 16)
  const generation = 'update-' + options.candidate.version.replace(/[^a-z0-9_-]/ig, '-').slice(0, 40) + '-' + token
  const generationRoot = join(dataRoot, 'DSH-generations', generation)
  const home = join(generationRoot, 'home'), nextProfile = join(home, 'profiles/web')
  const bindingPath = join(dataRoot, 'Updates/Harness/homes', options.candidate.version + '.json')
  await assertParentWithin(dataRoot, generationRoot)
  await assertParentWithin(dataRoot, bindingPath)
  const originalBinding = await optionalText(bindingPath)
  if (originalBinding !== undefined) {
    const previous = await readObject(bindingPath)
    if (previous.schema !== 1 && previous.schema !== 2 || previous.runtimeVersion !== options.candidate.version
      || typeof previous.generation !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(previous.generation)) throw new Error('Existing target home binding is invalid')
  }
  const binding: PreparedHarnessHomeBinding = { schema: 2, runtimeVersion: options.candidate.version, generation,
    runtimeRelativePath: relative(root, candidate).replaceAll('\\', '/') }
  const bindingText = JSON.stringify(binding, null, 2) + '\n'
  await mkdir(dirname(generationRoot), { recursive: true })
  if (existsSync(generationRoot + '.incomplete-' + token)) throw new Error('Harness home transaction was already attempted; use a new transaction ID')
  await mkdir(generationRoot) // Exclusive: never reuse a previous copy with stale sessions.
  let published = false, rolledBack = false
  let copiedFiles = 0, copiedBytes = 0, internalLinks = 0, officialLinks = 0
  const quarantine = async (): Promise<void> => {
    if (existsSync(generationRoot)) await rename(generationRoot, generationRoot + '.incomplete-' + token)
  }
  const officialRoots = [join(dataRoot, 'Runtime/dsh-runtime/node_modules'), resolve(sourceHome, '../runtime/dsh-runtime/node_modules')]
  const slots = join(dataRoot, 'Runtime/Harness/slots')
  const remapLink = async (source: string, target: string): Promise<string> => {
    const absolute = isAbsolute(target) ? resolve(target) : resolve(dirname(source), target)
    if (within(sourceHome, absolute)) {
      await assertExistingWithin(sourceHome, absolute)
      internalLinks++
      return resolve(home, relative(sourceHome, absolute))
    }
    let tail: string | undefined
    for (const prefix of officialRoots) if (within(prefix, absolute) && absolute !== prefix) tail = relative(prefix, absolute)
    if (within(slots, absolute)) {
      const parts = relative(slots, absolute).split(sep)
      if (/^.+-[a-f0-9]{16}$/i.test(parts[0] ?? '') && parts[1] === 'node_modules' && parts.length > 2) tail = parts.slice(2).join(sep)
    }
    if (!tail) throw new Error('Active home contains an unowned external link; migration refuses to drop it: ' + relative(sourceHome, source))
    const remapped = resolve(candidate, 'node_modules', tail)
    if (!within(candidate, remapped) || !existsSync(remapped)) throw new Error('Candidate does not contain the target of an official runtime link: ' + relative(sourceHome, source))
    await assertExistingWithin(candidate, remapped)
    officialLinks++
    return remapped
  }
  const copy = async (source: string, destination: string): Promise<void> => {
    const information = await lstat(source)
    const parts = relative(sourceHome, source).split(sep)
    if (parts.length === 5 && parts[0] === 'profiles' && parts[2] === 'node_modules' && parts[3] === '@deepseek-ai') {
      const target = join(candidate, 'node_modules/@deepseek-ai', parts[4]!)
      if (!existsSync(join(target, 'package.json'))) throw new Error('Candidate drops an installed official package: @deepseek-ai/' + parts[4])
      await assertExistingWithin(candidate, target)
      await assertExistingWithin(candidate, join(target, 'package.json'))
      const officialPackage = await readObject(join(target, 'package.json'))
      if (officialPackage.name !== '@deepseek-ai/' + parts[4] || typeof officialPackage.version !== 'string') throw new Error('Candidate official package identity is invalid')
      await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
      officialLinks++
    } else if (information.isSymbolicLink()) {
      const target = await remapLink(source, await readlink(source))
      // Known runtime targets may already have been retired. Internal targets
      // must still exist in the stopped source; runtime types come from candidate.
      const targetInfo = await stat(within(home, target) ? source : target)
      await symlink(target, destination, targetInfo.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file')
    } else if (information.isDirectory()) {
      await mkdir(destination)
      for (const entry of await readdir(source)) await copy(join(source, entry), join(destination, entry))
    } else if (information.isFile()) {
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      copiedFiles++; copiedBytes += information.size
    } else throw new Error('Active home contains an unsupported filesystem object')
  }
  try {
    await copy(sourceHome, home)
    assertCustomizationPreserved(snapshot, { portableRoot: root, profileDir: nextProfile })
    await validateCompatibility(nextProfile, candidate, options.candidate.version, options.profileCompatibility, satisfies)
    await mkdir(dirname(bindingPath), { recursive: true })
    if (originalBinding !== undefined) await writeFile(join(generationRoot, 'binding-before.json'), originalBinding, { encoding: 'utf8', flag: 'wx' })
    await writeFile(join(generationRoot, 'receipt.json'), JSON.stringify({ schema: 1, transactionId: options.transactionId,
      generation, runtimeVersion: options.candidate.version, sourceHome: relative(root, sourceHome).replaceAll('\\', '/'),
      runtimeRelativePath: binding.runtimeRelativePath, customizationFingerprint: snapshot.fingerprint,
      copiedFiles, copiedBytes, internalLinks, officialLinks, preparedAt: new Date().toISOString() }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await writeFile(join(generationRoot, 'failure.json'), JSON.stringify({ schema: 1, transactionId: options.transactionId,
      stage: 'prepare', failedAt: new Date().toISOString(), detail: error instanceof Error ? error.message : 'Home preparation failed' }, null, 2)).catch(() => undefined)
    await quarantine().catch(() => undefined)
    throw error
  }
  return {
    home, profileDir: nextProfile, binding,
    async publishBinding() {
      if (rolledBack) throw new Error('Rolled-back home transaction cannot be published')
      if (published) {
        if (await optionalText(bindingPath) !== bindingText) throw new Error('Published home binding was changed by another transaction')
        return
      }
      if (await optionalText(bindingPath) !== originalBinding) throw new Error('Home binding changed while candidate was preparing; refusing to overwrite it')
      assertCustomizationPreserved(snapshot, { portableRoot: root, profileDir: nextProfile })
      await writeTextFileAtomic(bindingPath, bindingText)
      published = true
    },
    async rollbackBinding() {
      if (rolledBack) return
      if (published) {
        if (await optionalText(bindingPath) !== bindingText) throw new Error('Home binding is no longer owned by this transaction; refusing to restore over it')
        if (originalBinding === undefined) await unlink(bindingPath)
        else await writeTextFileAtomic(bindingPath, originalBinding)
      } else {
        const current = await optionalText(bindingPath)
        if (current !== originalBinding && current?.includes('"generation": "' + generation + '"')) throw new Error('Another transaction owns a binding to the prepared home')
      }
      rolledBack = true
      await quarantine()
    },
  }
}
