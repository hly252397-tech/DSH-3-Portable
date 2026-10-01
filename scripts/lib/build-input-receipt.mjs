import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const HEX = /^[a-f0-9]{64}$/
export const BUILD_RECEIPT_PRODUCER = 'local-build-receipt-v1'
export const BUILD_RECEIPT_NAME = 'desktop-build-receipt.json'
const required = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'browser-library.cjs',
  'Build-DSH-Portable.ps1', 'Build-UI-Only.ps1', 'Portable-Environment.ps1', 'customizations/preservation.json']
const optional = ['.npmrc', '.pnpmfile.cjs', '.gitattributes', '.gitignore']
const digest = value => createHash('sha256').update(value).digest('hex')
const sorted = list => list.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const error = (code, detail) => Object.assign(new Error(`${code}: ${detail}`), { code })

function localPath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || isAbsolute(name)
    || name.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f:*?<>|]/.test(name)) {
    throw error('UNSAFE_BUILD_PATH', 'Expected a canonical project-relative path')
  }
  const target = resolve(root, ...name.split('/'))
  const rel = relative(resolve(root), target)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw error('UNSAFE_BUILD_PATH', name)
  return target
}

async function plainParents(directory, create = false) {
  const absolute = resolve(directory), volume = parse(absolute).root
  let cursor = volume
  for (const part of absolute.slice(volume.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    let info
    try { info = await lstat(cursor) } catch (failure) {
      if (!create || failure.code !== 'ENOENT') throw failure
      try { await mkdir(cursor) } catch (race) { if (race.code !== 'EEXIST') throw race }
      info = await lstat(cursor)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw error('UNSAFE_BUILD_PATH', cursor)
  }
}

async function optionalStat(path) {
  try { return await lstat(path) } catch (failure) { if (failure.code === 'ENOENT') return null; throw failure }
}

async function plainJson(root, name) {
  const identity = await fileIdentity(root, name)
  const target = localPath(root, name), info = await lstat(target)
  if (info.nlink > 1 || info.size > 4 * 1024 * 1024) throw error('UNSAFE_RECEIPT_PATH', name)
  const bytes = await readFile(target)
  await plainParents(dirname(target))
  if (digest(bytes) !== identity.sha256) throw error('BUILD_INPUT_RACED', name)
  return JSON.parse(bytes.toString('utf8'))
}

async function fileIdentity(root, name, absent = false) {
  const target = localPath(root, name)
  await plainParents(dirname(target))
  const before = await optionalStat(target)
  if (!before && absent) return { path: name, kind: 'absent', sha256: null, size: 0 }
  if (!before) throw error('BUILD_INPUT_MISSING', name)
  if (before.isSymbolicLink() || !before.isFile()) throw error('UNSAFE_BUILD_PATH', name)
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    await plainParents(dirname(target))
    const started = await handle.stat(), hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    const ended = await handle.stat(), after = await lstat(target)
    await plainParents(dirname(target))
    if (after.isSymbolicLink() || started.ino !== after.ino || started.dev !== after.dev
      || started.size !== ended.size || started.mtimeMs !== ended.mtimeMs || started.ctimeMs !== ended.ctimeMs) {
      throw error('BUILD_INPUT_RACED', name)
    }
    return { path: name, kind: 'file', sha256: hash.digest('hex'), size: ended.size }
  } finally { await handle.close() }
}

async function treeFiles(root, name, requiredTree = true) {
  const target = localPath(root, name)
  await plainParents(dirname(target))
  const info = await optionalStat(target)
  if (!info && !requiredTree) return [name]
  if (!info) throw error('BUILD_INPUT_MISSING', name)
  if (info.isSymbolicLink() || !info.isDirectory()) throw error('UNSAFE_BUILD_PATH', name)
  const result = []
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = `${name}/${entry.name}`
    if (entry.isSymbolicLink()) throw error('UNSAFE_BUILD_PATH', child)
    if (entry.isDirectory()) result.push(...await treeFiles(root, child))
    else if (entry.isFile()) result.push(child)
    else throw error('UNSAFE_BUILD_PATH', child)
  }
  return result
}

function fingerprints(files, environmentFingerprint) {
  const coreFingerprint = digest(JSON.stringify({ policy: 1, environmentFingerprint, files: files.filter(f => f.group === 'core') }))
  const assetsFingerprint = digest(JSON.stringify(files.filter(f => f.group === 'assets')))
  return { coreFingerprint, assetsFingerprint, fingerprint: digest(JSON.stringify({ coreFingerprint, assetsFingerprint })) }
}

function validateSnapshot(snapshot) {
  if (snapshot?.schema !== 1 || snapshot.policy !== 1 || !Array.isArray(snapshot.files) || !snapshot.files.length
    || !HEX.test(snapshot.environmentFingerprint ?? '') || snapshot.files.some((file, index, all) =>
      typeof file?.path !== 'string' || !['core', 'assets'].includes(file.group) || !['file', 'absent'].includes(file.kind)
      || !Number.isSafeInteger(file.size) || file.size < 0 || (file.kind === 'file' ? !HEX.test(file.sha256 ?? '') : file.sha256 !== null)
      || (index > 0 && all[index - 1].path >= file.path))) throw error('BUILD_SNAPSHOT_INVALID', 'Malformed build input snapshot')
  const actual = fingerprints(snapshot.files, snapshot.environmentFingerprint)
  if (Object.keys(actual).some(key => snapshot[key] !== actual[key])) throw error('BUILD_SNAPSHOT_INVALID', 'Input digest mismatch')
  return snapshot
}

function immutableAssetPaths(manifest) {
  const result = new Set()
  const add = value => { if (typeof value === 'string' && value.startsWith('assets/')) result.add(value) }
  add(manifest.build?.icon)
  for (const platform of ['win', 'mac', 'linux']) {
    add(manifest.build?.[platform]?.icon)
    for (const mapping of manifest.build?.[platform]?.extraFiles ?? []) add(mapping.from)
  }
  for (const [key, value] of Object.entries(manifest.build?.nsis ?? {})) if (/icon|bitmap/i.test(key)) add(value)
  return result
}

/** Explicit source closure only: never recursively scan Data, dependencies or UI history archives. */
export async function captureBuildInputs(root, env = process.env) {
  root = resolve(root)
  await plainParents(root)
  const manifest = await plainJson(root, 'package.json')
  const preservation = await plainJson(root, 'customizations/preservation.json')
  if (preservation.schema !== 1 || !Array.isArray(preservation.sources)) throw error('BUILD_INPUT_INVALID', 'Preservation source registry is missing')
  const paths = new Set([...required, ...optional])
  for (const name of ['src', 'scripts', 'test', 'assets']) for (const file of await treeFiles(root, name)) paths.add(file)
  for (const file of await treeFiles(root, 'build', false)) paths.add(file)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:ps1|cmd|bat|cjs|mjs)$/i.test(entry.name)) paths.add(entry.name)
  }
  for (const source of preservation.sources) {
    if (typeof source?.sourceDir !== 'string' || /^(?:Data|node_modules)(?:\/|$)/i.test(source.sourceDir)
      || /^customizations\/ui(?:\/|$)/i.test(source.sourceDir) || !Array.isArray(source.files)) {
      throw error('BUILD_INPUT_INVALID', 'Unsafe preservation source group')
    }
    for (const file of source.files) {
      const name = `${source.sourceDir}/${file.path}`
      localPath(root, name)
      paths.add(name)
    }
  }
  // Tool identities are explicit files, not recursive dependency traversal.
  const nodeVersion = manifest.engines?.node, pnpmVersion = manifest.packageManager?.split('@').at(-1)
  if (typeof nodeVersion !== 'string' || typeof pnpmVersion !== 'string'
    || !/^[\d.]+(?:-[a-z0-9.-]+)?$/i.test(nodeVersion) || !/^[\d.]+(?:-[a-z0-9.-]+)?$/i.test(pnpmVersion)) {
    throw error('BUILD_INPUT_INVALID', 'Missing controlled tool versions')
  }
  const nodePath = `Tools/node-v${nodeVersion}/${process.platform === 'win32' ? 'node.exe' : 'node'}`
  const node = await fileIdentity(root, nodePath)
  if (node.sha256.toUpperCase() !== manifest.config?.bundledNodeSha256?.[`${process.platform}-${process.arch}`]?.toUpperCase()) {
    throw error('BUILD_TOOL_IDENTITY_CHANGED', 'Node is not the package manifest SHA256')
  }
  paths.add(nodePath)
  const pnpmRoot = `Tools/pnpm-v${pnpmVersion}/node_modules/pnpm`
  const pnpm = await plainJson(root, `${pnpmRoot}/package.json`)
  if (pnpm.name !== 'pnpm' || pnpm.version !== pnpmVersion) throw error('BUILD_TOOL_IDENTITY_CHANGED', 'pnpm package identity mismatch')
  paths.add(`${pnpmRoot}/package.json`)
  paths.add(`${pnpmRoot}/bin/${pnpmVersion.startsWith('12.') ? 'pnpm.mjs' : 'pnpm.cjs'}`)
  const embedded = immutableAssetPaths(manifest)
  const files = []
  for (const name of [...paths].sort()) {
    const item = name === nodePath ? node : await fileIdentity(root, name, optional.includes(name) || name === 'build')
    const coreAsset = [...embedded].some(path => name === path || name.startsWith(path + '/'))
    files.push({ ...item, group: name.startsWith('assets/') && !coreAsset ? 'assets' : 'core' })
  }
  // Store only a digest of controlled release-source input, never environment/configuration bodies.
  const environmentFingerprint = digest(JSON.stringify({ releaseSource: digest(env.DSH_PORTABLE_RELEASE_SOURCE ?? '') }))
  return { schema: 1, policy: 1, capturedAt: new Date().toISOString(), files: sorted(files), environmentFingerprint,
    ...fingerprints(sorted(files), environmentFingerprint) }
}

export async function assertBuildInputsUnchanged(root, snapshot) {
  validateSnapshot(snapshot)
  const actual = await captureBuildInputs(root)
  if (actual.fingerprint !== snapshot.fingerprint) throw error('BUILD_INPUT_CHANGED', 'Source/test/tool inputs changed during the build')
  return actual
}

export function buildReceiptPath(root) { return join(resolve(root), 'Data', 'Development', 'build-cache', BUILD_RECEIPT_NAME) }

async function ownedCachePath(root, path, create = false) {
  const cache = join(resolve(root), 'Data', 'Development', 'build-cache')
  const target = resolve(path), rel = relative(cache, target)
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || rel.includes(sep)) throw error('UNSAFE_RECEIPT_PATH', 'Receipt/snapshot must be a direct cache child')
  await plainParents(cache, create)
  const info = await optionalStat(target)
  if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)) throw error('UNSAFE_RECEIPT_PATH', target)
  return target
}

async function atomicJson(path, value, assertHeld = () => {}) {
  await plainParents(dirname(path))
  const current = await optionalStat(path)
  if (current && (current.isSymbolicLink() || !current.isFile() || current.nlink > 1)) throw error('UNSAFE_RECEIPT_PATH', path)
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  // Failure retains this transaction's diagnostic temp; never unlink the previous receipt.
  await plainParents(dirname(path))
  const latest = await optionalStat(path)
  if (latest && (latest.isSymbolicLink() || !latest.isFile() || latest.nlink > 1)) throw error('UNSAFE_RECEIPT_PATH', path)
  assertHeld()
  await rename(temporary, path)
}

export async function writeBuildSnapshot(root, path, snapshot) {
  if (!/^input-[a-f0-9-]{36}\.json$/.test(parse(path).base)) throw error('UNSAFE_RECEIPT_PATH', 'Invalid snapshot filename')
  const target = await ownedCachePath(root, path, true)
  if (await optionalStat(target)) throw error('BUILD_SNAPSHOT_EXISTS', 'Never overwrite an earlier capture')
  await atomicJson(target, validateSnapshot(snapshot))
}

export async function readBuildSnapshot(root, path) {
  return validateSnapshot(JSON.parse(await readFile(await ownedCachePath(root, path), 'utf8')))
}

async function compiledFiles(root) {
  const files = []
  for (const path of await treeFiles(root, 'dist')) {
    // This one file is deliberately generated after tests by prepare-runtime;
    // source/env identity and the final output receipt bind it separately.
    if (path !== 'dist/release-source.json') files.push(await fileIdentity(root, path))
  }
  if (!files.length) throw error('BUILD_COMPILED_MISSING', 'No compiled outputs to seal')
  return sorted(files)
}

export async function captureCompiledInputs(root, inputs) {
  await assertBuildInputsUnchanged(root, inputs)
  const files = await compiledFiles(root)
  return { schema: 1, inputFingerprint: inputs.fingerprint, files, fingerprint: digest(JSON.stringify(files)) }
}

export async function assertCompiledInputsUnchanged(root, inputs, compiled) {
  if (compiled?.schema !== 1 || compiled.inputFingerprint !== inputs.fingerprint || !Array.isArray(compiled.files)
    || compiled.fingerprint !== digest(JSON.stringify(compiled.files))) throw error('BUILD_COMPILED_SNAPSHOT_INVALID', 'Missing or mismatched post-tsc seal')
  if (digest(JSON.stringify(await compiledFiles(root))) !== compiled.fingerprint) throw error('BUILD_COMPILED_CHANGED', 'Compiled outputs changed after tsc/tests')
}

function compiledSnapshotPath(snapshotPath) {
  if (!/^input-[a-f0-9-]{36}\.json$/.test(parse(snapshotPath).base)) throw error('UNSAFE_RECEIPT_PATH', 'Invalid source snapshot name')
  return join(dirname(snapshotPath), parse(snapshotPath).base.replace(/^input-/, 'compiled-'))
}

export async function writeCompiledSnapshot(root, snapshotPath, inputs) {
  const path = await ownedCachePath(root, compiledSnapshotPath(snapshotPath), true)
  if (await optionalStat(path)) throw error('BUILD_SNAPSHOT_EXISTS', 'Never overwrite the original compiled seal')
  await atomicJson(path, await captureCompiledInputs(root, inputs))
}

export async function readCompiledSnapshot(root, snapshotPath) {
  return JSON.parse(await readFile(await ownedCachePath(root, compiledSnapshotPath(snapshotPath)), 'utf8'))
}

async function buildArtifacts(root, appDirectory) {
  const app = relative(resolve(root), resolve(appDirectory)).split(sep).join('/')
  if (app !== 'release/win-unpacked') throw error('UNSAFE_BUILD_PATH', 'Receipt only binds the canonical local build tree')
  const asar = await fileIdentity(root, `${app}/resources/app.asar`)
  const manifest = await plainJson(root, 'package.json')
  const replaceable = []
  for (const mapping of manifest.build?.extraResources ?? []) {
    if (typeof mapping.from !== 'string' || !mapping.from.startsWith('assets/')) continue
    const target = `${app}/resources/${mapping.to}`
    localPath(root, target)
    const source = await lstat(localPath(root, mapping.from))
    replaceable.push({ path: target, directory: source.isDirectory() })
  }
  // dist is a post-compile artifact closure, never part of the pre-build source
  // capture (otherwise every legitimate tsc would invalidate a full build).
  const artifacts = []
  for (const file of await treeFiles(root, 'dist')) artifacts.push(await fileIdentity(root, file))
  for (const file of await treeFiles(root, app)) {
    if (file === asar.path || replaceable.some(item => file === item.path || (item.directory && file.startsWith(item.path + '/')))) continue
    artifacts.push(await fileIdentity(root, file))
  }
  return { asar, artifacts: sorted(artifacts) }
}

export async function verifyUIBuildReceipt(root, appDirectory) {
  let receipt
  try { receipt = JSON.parse(await readFile(await ownedCachePath(root, buildReceiptPath(root)), 'utf8')) }
  catch (failure) { if (failure.code === 'ENOENT') throw error('BUILD_RECEIPT_MISSING', 'First complete build is required'); throw failure }
  if (receipt?.schema !== 1 || receipt.kind !== 'dsh-desktop-build' || receipt.status !== 'validated') throw error('BUILD_RECEIPT_INVALID', 'Missing successful build receipt')
  validateSnapshot(receipt.inputs)
  const actual = await captureBuildInputs(root), outputs = await buildArtifacts(root, appDirectory)
  if (actual.coreFingerprint !== receipt.inputs.coreFingerprint) throw error('BUILD_CORE_INPUT_CHANGED', 'Only non-embedded assets may use the UI-only path')
  if (JSON.stringify(outputs) !== JSON.stringify({ asar: receipt.asar, artifacts: receipt.artifacts })) {
    throw error('BUILD_ARTIFACT_CHANGED', 'ASAR or compiled/baked resources no longer match their successful receipt')
  }
  return { receipt, inputs: actual, outputs }
}

export async function assertUIAssetsCopied(root, appDirectory) {
  const manifest = JSON.parse(await readFile(localPath(root, 'package.json'), 'utf8'))
  for (const mapping of manifest.build?.extraResources ?? []) {
    if (typeof mapping.from !== 'string' || !mapping.from.startsWith('assets/')) continue
    const source = localPath(root, mapping.from)
    const info = await lstat(source)
    const destination = `release/win-unpacked/resources/${mapping.to}`
    localPath(root, destination)
    if (resolve(appDirectory) !== resolve(root, 'release/win-unpacked')) throw error('UNSAFE_BUILD_PATH', 'Unexpected UI build tree')
    const sources = info.isDirectory() ? await treeFiles(root, mapping.from) : [mapping.from]
    const targets = info.isDirectory() ? await treeFiles(root, destination) : [destination]
    const expected = []
    for (const name of sources) {
      const target = info.isDirectory() ? `${destination}/${name.slice(mapping.from.length + 1)}` : destination
      const before = await fileIdentity(root, name), after = await fileIdentity(root, target)
      if (before.sha256 !== after.sha256 || before.size !== after.size) throw error('BUILD_UI_RESOURCE_CHANGED', name)
      expected.push(target)
    }
    if (targets.length !== expected.length || targets.some(name => !expected.includes(name))) throw error('BUILD_UI_RESOURCE_CHANGED', 'Stale or unexpected mapped UI resources')
  }
}

async function successfulReceipt(root, snapshot, appDirectory, mode) {
  const inputs = await assertBuildInputsUnchanged(root, snapshot)
  await assertUIAssetsCopied(root, appDirectory)
  const outputs = await buildArtifacts(root, appDirectory)
  return { schema: 1, kind: 'dsh-desktop-build', status: 'validated', mode, completedAt: new Date().toISOString(), inputs, ...outputs }
}

export async function commitUIBuildReceipt(root, snapshot, appDirectory) {
  await verifyUIBuildReceipt(root, appDirectory)
  const receipt = await successfulReceipt(root, snapshot, appDirectory, 'ui')
  await atomicJson(await ownedCachePath(root, buildReceiptPath(root), true), receipt)
  return receipt
}

async function withDesktopOperationLock(root, action) {
  const directory = join(resolve(root), 'Data', 'Updates', 'Desktop')
  await plainParents(directory, true)
  const lock = join(directory, 'operation.lock')
  const info = await optionalStat(lock)
  if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)) throw error('UNSAFE_RECEIPT_PATH', lock)
  if (process.platform !== 'win32') throw error('BUILD_OPERATION_LOCK_UNAVAILABLE', 'Windows FileShare.None is required')
  const code = "$ErrorActionPreference='Stop';$s=$null;try{$s=[System.IO.File]::Open($env:DSH_RECEIPT_OPERATION_LOCK,[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None);[Console]::Out.WriteLine('READY');[Console]::Out.Flush();[void][Console]::In.ReadLine()}finally{if($null-ne$s){$s.Dispose()}}"
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    windowsHide: true, env: { ...process.env, DSH_RECEIPT_OPERATION_LOCK: lock }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  helper.stdin.on('error', () => {})
  helper.stderr.on('data', () => {})
  await new Promise((accept, reject) => {
    const timeout = setTimeout(() => { helper.kill(); reject(error('BUILD_OPERATION_BUSY', 'Desktop pointer lock unavailable')) }, 10000)
    let stdout = '', done = false
    const finish = failure => { if (done) return; done = true; clearTimeout(timeout); failure ? reject(failure) : accept() }
    helper.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.includes('READY')) finish() })
    helper.once('error', () => finish(error('BUILD_OPERATION_BUSY', 'Cannot create pointer lock helper')))
    helper.once('exit', () => finish(error('BUILD_OPERATION_BUSY', 'Desktop pointer lock is busy')))
  })
  try {
    const assertHeld = () => {
      if (helper.exitCode !== null || helper.signalCode !== null) throw error('BUILD_OPERATION_BUSY', 'Pointer lock holder exited')
    }
    assertHeld()
    return await action(assertHeld)
  } finally {
    helper.stdin.end('\n')
    await new Promise(accept => { if (helper.exitCode !== null) return accept(); const timer = setTimeout(() => { helper.kill(); accept() }, 5000); helper.once('exit', () => { clearTimeout(timer); accept() }) })
  }
}

async function desktopPointer(root) {
  const name = 'Data/Updates/Desktop/pointer.json', target = localPath(root, name)
  await plainParents(dirname(target), true)
  const info = await optionalStat(target)
  if (!info) return null
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw error('UNSAFE_RECEIPT_PATH', name)
  return await plainJson(root, name)
}

function ownPending(pointer, staged) {
  return pointer?.pending?.transactionId === staged.transactionId && pointer.pending.relativePath === staged.slotRelativePath
    && pointer.pending.version === staged.version && pointer.pending.producer === BUILD_RECEIPT_PRODUCER
}

async function revokeOwnPending(root, staged, lock, reasonCode) {
  return lock(async assertHeld => {
    const current = await desktopPointer(root)
    if (!ownPending(current, staged)) return { restored: false, reason: 'OWN_PENDING_NO_LONGER_PRESENT' }
    const transaction = localPath(root, `Data/Updates/Desktop/transactions/${staged.transactionId}`)
    await plainParents(transaction)
    if (await optionalStat(join(transaction, 'activation-attempt.json'))) return { restored: false, reason: 'ACTIVATION_STARTED' }
    // Captured by the producer inside D at its actual publication point, not
    // the wrapper's older pointer observed before a potentially long copy.
    const prior = await plainJson(root, `Data/Updates/Desktop/transactions/${staged.transactionId}/build-prior-pointer.json`)
    if (JSON.stringify(current.current) !== JSON.stringify(prior.current) || JSON.stringify(current.previous) !== JSON.stringify(prior.previous)) {
      return { restored: false, reason: 'CURRENT_OR_PREVIOUS_CHANGED' }
    }
    const next = { ...current, updatedAt: new Date().toISOString() }
    if (prior.pending) next.pending = prior.pending
    else delete next.pending
    await atomicJson(localPath(root, 'Data/Updates/Desktop/pointer.json'), next, assertHeld)
    // The stage API already published deploying(C). Once C is withdrawn it
    // must not keep the UI/updater busy forever. Change only C's state; a
    // different transaction's report belongs to its writer.
    const stateName = 'Data/Updates/Desktop/state.json'
    if (await optionalStat(localPath(root, stateName))) {
      const state = await plainJson(root, stateName)
      if (state.transactionId === staged.transactionId) {
        const code = /^[A-Z_]{2,80}$/.test(reasonCode ?? '') ? reasonCode : 'BUILD_NOT_FINALIZED'
        const repaired = { ...state, phase: 'error', currentVersion: prior.current.version,
          overallProgress: 0, stageProgress: 0, updatedAt: new Date().toISOString(), errorCode: code,
          detail: prior.pending
            ? `本次本地构建验证失败（${code}），自身候选已撤销；先前候选 ${prior.pending.version}（${prior.pending.transactionId}）已恢复，待正常启动验证。`
            : `本次本地构建验证失败（${code}），自身候选已撤销；现役保持不变。` }
        for (const field of ['transactionId', 'slotRelativePath', 'targetVersion', 'release']) delete repaired[field]
        // These are observed predecessor pointer fields, not a fabricated
        // release or old state record. The error still describes failed C.
        if (prior.pending) Object.assign(repaired, { transactionId: prior.pending.transactionId,
          slotRelativePath: prior.pending.relativePath, targetVersion: prior.pending.version })
        await atomicJson(localPath(root, stateName), repaired, assertHeld)
      }
    }
    return { restored: true, reason: prior.pending ? 'PREVIOUS_PENDING_RESTORED' : 'OWN_PENDING_WITHDRAWN' }
  })
}

/** Caller holds build.lock throughout. Intent is published before pending by the stage API. */
export async function stageBuildWithReceipt({ root, appDirectory, snapshot, version, mode = 'full', stage,
  compiledSnapshot,
  operationLock = action => withDesktopOperationLock(root, action) }) {
  if (!['full', 'ui'].includes(mode)) throw error('BUILD_RECEIPT_INVALID', 'Unexpected build mode')
  const initial = await assertBuildInputsUnchanged(root, snapshot)
  if (mode === 'full') await assertCompiledInputsUnchanged(root, snapshot, compiledSnapshot)
  if (mode === 'ui') await verifyUIBuildReceipt(root, appDirectory)
  await assertUIAssetsCopied(root, appDirectory)
  const originalOutputs = await buildArtifacts(root, appDirectory)
  await desktopPointer(root)
  const intent = { inputFingerprint: initial.fingerprint, coreFingerprint: initial.coreFingerprint, asarSha256: originalOutputs.asar.sha256 }
  let staged
  try {
    staged = await stage(intent)
    if (!/^[a-f0-9-]{36}$/.test(staged?.transactionId ?? '') || typeof staged?.slotRelativePath !== 'string' || staged.version !== version) {
      throw error('BUILD_STAGE_RESULT_INVALID', 'No owned staged transaction')
    }
    await operationLock(async assertHeld => {
      const pointer = await desktopPointer(root)
      if (!ownPending(pointer, staged)) throw error('BUILD_PENDING_CHANGED', 'New pending transaction changed before finalization')
      if (mode === 'full') await assertCompiledInputsUnchanged(root, snapshot, compiledSnapshot)
      const receipt = await successfulReceipt(root, snapshot, appDirectory, mode)
      if (JSON.stringify({ asar: receipt.asar, artifacts: receipt.artifacts }) !== JSON.stringify(originalOutputs)) {
        throw error('BUILD_ARTIFACT_CHANGED', 'Packaged outputs changed during staging')
      }
      const transaction = localPath(root, `Data/Updates/Desktop/transactions/${staged.transactionId}`)
      await plainParents(transaction)
      if (await optionalStat(join(transaction, 'activation-attempt.json'))) throw error('BUILD_PENDING_CHANGED', 'Activation unexpectedly started before finalization')
      const required = await plainJson(root, `Data/Updates/Desktop/transactions/${staged.transactionId}/build-intent.json`)
      const proof = { schema: 1, producer: BUILD_RECEIPT_PRODUCER, transactionId: staged.transactionId,
        slotRelativePath: staged.slotRelativePath, version, slotManifestSha256: pointer.pending.sha256, ...intent }
      if (Object.keys(proof).some(key => required[key] !== proof[key])) throw error('BUILD_INTENT_CHANGED', 'Published intent does not match the exact candidate')
      const slotAsar = await fileIdentity(root, `${staged.slotRelativePath}/resources/app.asar`)
      const slotManifest = await fileIdentity(root, `${staged.slotRelativePath}/slot-manifest.json`)
      if (slotAsar.sha256 !== intent.asarSha256 || slotManifest.sha256 !== pointer.pending.sha256) throw error('BUILD_ARTIFACT_CHANGED', 'Slot does not match the validated package')
      await verifyReceiptSlotPayload(root, staged.slotRelativePath, staged.transactionId)
      await atomicJson(await ownedCachePath(root, buildReceiptPath(root), true), receipt, assertHeld)
      await atomicJson(join(transaction, 'build-receipt.json'), receipt, assertHeld)
      const copied = await fileIdentity(root, `Data/Updates/Desktop/transactions/${staged.transactionId}/build-receipt.json`)
      // This is the only success marker. Missing it (including wrapper crash) forbids activation.
      await atomicJson(join(transaction, 'build-finalized.json'), { ...proof, receiptSha256: copied.sha256 }, assertHeld)
    })
    return staged
  } catch (failure) {
    let restoration = { restored: false, reason: staged ? 'WITHDRAWAL_NOT_ATTEMPTED' : 'NO_OWN_STAGE_RESULT' }
    if (staged) try { restoration = await revokeOwnPending(root, staged, operationLock, failure.code) }
    catch (withdrawal) { restoration = { restored: false, reason: withdrawal.code ?? 'WITHDRAWAL_FAILED' } }
    const diagnostic = await ownedCachePath(root, join(dirname(buildReceiptPath(root)), `failure-${randomUUID()}.json`), true)
    await atomicJson(diagnostic, { schema: 1, code: failure.code ?? 'BUILD_RECEIPT_FAILED', at: new Date().toISOString(),
      inputFingerprint: snapshot.fingerprint, ...(staged ? { transactionId: staged.transactionId } : {}), restoration })
    throw error(failure.code ?? 'BUILD_RECEIPT_FAILED', `${failure.message}; ${restoration.reason}; diagnostic=${diagnostic}`)
  }
}

async function verifyReceiptSlotPayload(root, slotRelativePath, transactionId) {
  if (!/^Data\/Updates\/Desktop\/slots\/[^/]+$/.test(slotRelativePath)) throw error('UNSAFE_RECEIPT_PATH', 'Not a canonical desktop slot')
  const manifest = await plainJson(root, `${slotRelativePath}/slot-manifest.json`)
  if (manifest.schema !== 1 || manifest.producer !== BUILD_RECEIPT_PRODUCER || manifest.transactionId !== transactionId
    || manifest.completeFileList !== true || !manifest.files || typeof manifest.files !== 'object') {
    throw error('BUILD_SLOT_INVALID', 'Missing transaction-bound complete payload manifest')
  }
  const actual = (await treeFiles(root, slotRelativePath)).filter(name => name !== `${slotRelativePath}/slot-manifest.json`)
  const expected = Object.keys(manifest.files).map(name => {
    localPath(root, `${slotRelativePath}/${name}`)
    if (!HEX.test(manifest.files[name] ?? '')) throw error('BUILD_SLOT_INVALID', 'Invalid slot file identity')
    return `${slotRelativePath}/${name}`
  })
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort())) throw error('BUILD_SLOT_INVALID', 'Slot file set changed')
  for (const name of actual) {
    const file = await fileIdentity(root, name)
    if (file.sha256 !== manifest.files[name.slice(slotRelativePath.length + 1)]) throw error('BUILD_ARTIFACT_CHANGED', 'Slot payload hash changed')
  }
  return manifest
}

/** Read-only proof verification works for recovery scans as well as pending. */
export async function verifyFinalizedBuildForSlot(root, slotRelativePath) {
  const manifest = await plainJson(root, `${slotRelativePath}/slot-manifest.json`)
  if (manifest.producer !== BUILD_RECEIPT_PRODUCER || !/^[a-f0-9-]{36}$/.test(manifest.transactionId ?? '')) {
    throw error('BUILD_NOT_FINALIZED', 'Not a receipt-bound local slot')
  }
  const transaction = `Data/Updates/Desktop/transactions/${manifest.transactionId}`
  const intent = await plainJson(root, `${transaction}/build-intent.json`)
  const proof = await plainJson(root, `${transaction}/build-finalized.json`)
  const receipt = await plainJson(root, `${transaction}/build-receipt.json`)
  validateSnapshot(receipt.inputs)
  const slotHash = await fileIdentity(root, `${slotRelativePath}/slot-manifest.json`)
  const asar = await fileIdentity(root, `${slotRelativePath}/resources/app.asar`)
  const receiptFile = await fileIdentity(root, `${transaction}/build-receipt.json`)
  const identity = { schema: 1, producer: BUILD_RECEIPT_PRODUCER, transactionId: manifest.transactionId,
    slotRelativePath, version: manifest.version, slotManifestSha256: slotHash.sha256,
    inputFingerprint: receipt.inputs.fingerprint, coreFingerprint: receipt.inputs.coreFingerprint, asarSha256: asar.sha256 }
  if (Object.keys(identity).some(key => intent[key] !== identity[key] || proof[key] !== identity[key])
    || proof.receiptSha256 !== receiptFile.sha256 || receipt.schema !== 1 || receipt.kind !== 'dsh-desktop-build'
    || receipt.status !== 'validated' || receipt.asar?.sha256 !== asar.sha256) throw error('BUILD_NOT_FINALIZED', 'Candidate proof does not match its exact immutable slot')
  await verifyReceiptSlotPayload(root, slotRelativePath, manifest.transactionId)
  return { transactionId: manifest.transactionId, slotRelativePath, finalized: true }
}
