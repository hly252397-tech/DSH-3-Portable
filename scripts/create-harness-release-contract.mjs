#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cloneTreeForArchive, packDirectoryToTarGz } from '../dist/src/runtime-archive.js'
import { buildHarnessRuntimeCandidate, validateHarnessRuntimeCandidate } from '../dist/src/harness-runtime-candidate.js'
import { harnessRuntimeContentSha256, extractHarnessRuntimeArchive } from '../dist/src/harness-prebuilt-update.js'
import { fetchOfficialHarnessProvenance, harnessReleaseNames, normalizeHarnessNodeVersion, parseHarnessReleaseContract, stampHarnessPrebuiltLockfile } from '../dist/src/harness-release-catalog.js'
import { prepareRuntimePnpmLayout } from '../dist/src/runtime-pnpm-layout.js'

const [version, runtimeInput, outputInput, ...args] = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const reviewInput = option('--reviewed-compatibility')
if (!version || !runtimeInput || !outputInput || !reviewInput) {
  throw new Error('Usage: create-harness-release-contract <version> <runtime-directory|--build> <output-directory> --reviewed-compatibility <tracked-review.json> [--pnpm-entry <pnpm.mjs>]')
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Harness win32-x64 release must be assembled and checked on Windows x64.')
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reviewPath = resolve(projectRoot, reviewInput)
const reviewRelative = relative(projectRoot, reviewPath)
if (reviewRelative === '..' || reviewRelative.startsWith('..\\') || reviewRelative.startsWith('../') || isAbsolute(reviewRelative)) {
  throw new Error('Compatibility review must be a repository file.')
}
if ((await stat(reviewPath)).size > 64 * 1024) throw new Error('Compatibility review is too large.')
const reviewed = JSON.parse(await readFile(reviewPath, 'utf8'))
if (reviewed === null || typeof reviewed !== 'object' || Array.isArray(reviewed)
  || Object.keys(reviewed).some(key => !['profileCompatibility', 'dataCompatibilityGroup'].includes(key))) {
  throw new Error('Compatibility review only accepts profileCompatibility and dataCompatibilityGroup.')
}
const names = harnessReleaseNames(version)
const nodeVersion = normalizeHarnessNodeVersion(process.version)
const output = resolve(outputInput)
await mkdir(output, { recursive: true })
const workspace = await mkdtemp(join(output, '.harness-release-'))
try {
  const provenance = await fetchOfficialHarnessProvenance(version)
  let runtime = resolve(runtimeInput)
  if (runtimeInput === '--build') {
    const pnpmEntry = option('--pnpm-entry')
    if (!pnpmEntry || !(await stat(resolve(pnpmEntry))).isFile()) throw new Error('--build requires an explicit pnpm.mjs entry.')
    const candidate = await buildHarnessRuntimeCandidate({
      legacyRuntimeDir: join(workspace, 'dsh-runtime'), version, expectedNpmIntegrity: provenance.npmIntegrity,
      nodeExecutable: process.execPath, pnpmEntry: resolve(pnpmEntry), storeDir: join(workspace, 'pnpm-store'),
    })
    runtime = candidate.directory
  }
  const inside = relative(runtime, output)
  const leavesRuntime = inside === '..' || inside.startsWith('..\\') || inside.startsWith('../') || isAbsolute(inside)
  if (!leavesRuntime) throw new Error('Release output cannot be inside the source runtime.')
  const plain = join(workspace, 'runtime')
  await cloneTreeForArchive(runtime, plain)
  await prepareRuntimePnpmLayout(plain)
  const lockPath = join(plain, 'pnpm-lock.yaml')
  await writeFile(lockPath, stampHarnessPrebuiltLockfile(await readFile(lockPath, 'utf8'), nodeVersion), 'utf8')
  const validation = await validateHarnessRuntimeCandidate(plain, version, provenance.npmIntegrity)
  await writeFile(join(plain, '.dsh-runtime-fingerprint'), `${validation.fingerprint}\n`, 'utf8')
  const contentSha256 = await harnessRuntimeContentSha256(plain)
  let unpackedSize = 0
  const count = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await count(path)
      else if (entry.isFile()) unpackedSize += (await stat(path)).size
      else throw new Error('Release runtime must contain only regular files/directories.')
    }
  }
  await count(plain)
  const archive = join(workspace, names.artifact)
  packDirectoryToTarGz(plain, archive)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  const contract = parseHarnessReleaseContract({
    schema: 1, component: 'harness', version, platform: 'win32', arch: 'x64', nodeVersion,
    artifact: names.artifact, size: (await stat(archive)).size, unpackedSize,
    sha256: hash.digest('hex'), contentSha256, ...provenance,
    runtimeFingerprint: validation.fingerprint, ...reviewed,
  }, version, nodeVersion)
  // Verify the exact file format the consumer uses, not just the unarchived source directory.
  const smoke = join(workspace, 'unpacked-check')
  await mkdir(smoke)
  await extractHarnessRuntimeArchive(archive, smoke, unpackedSize)
  const unpacked = await validateHarnessRuntimeCandidate(smoke, version, provenance.npmIntegrity)
  if (unpacked.fingerprint !== contract.runtimeFingerprint || await harnessRuntimeContentSha256(smoke) !== contentSha256) {
    throw new Error('Packaged runtime round-trip validation failed.')
  }
  const { rename } = await import('node:fs/promises')
  await rename(archive, join(output, names.artifact))
  await writeFile(join(output, names.contract), `${JSON.stringify(contract, undefined, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ version, artifact: names.artifact, size: contract.size, unpackedSize, sha256: contract.sha256, officialCommit: contract.officialCommit }))
} finally {
  await rm(workspace, { recursive: true, force: true })
}
