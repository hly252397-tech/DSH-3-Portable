import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'

const api = await import(pathToFileURL(resolve('scripts/lib/build-input-receipt.mjs')).href) as any
const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const held = async (action: (assertHeld: () => void) => Promise<unknown>) => action(() => {})

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-build-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (name: string, value: string | Buffer) => { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), value) }
  const read = async (name: string) => JSON.parse(await readFile(join(root, name), 'utf8'))
  const node = 'fixture-node', pnpmVersion = '12.0.0'
  const manifest = { version: '1.0.0', engines: { node: '1.0.0' }, packageManager: `pnpm@${pnpmVersion}`,
    config: { bundledNodeSha256: { [`${process.platform}-${process.arch}`]: sha(node) } },
    build: { icon: 'assets/icons/icon.ico', extraResources: [{ from: 'assets/theme.css', to: 'theme.css' }] } }
  await put('package.json', json(manifest))
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'browser-library.cjs', 'Build-DSH-Portable.ps1', 'Build-UI-Only.ps1', 'Portable-Environment.ps1']) await put(name, 'fixture input\n')
  await put('src/main.ts', 'old-source')
  await put('scripts/gate.mjs', 'fixture gate')
  await put('test/input.test.ts', 'fixture test')
  await put('build/installer.nsh', 'installer')
  await put('assets/theme.css', 'theme-a')
  await put('assets/icons/icon.ico', 'icon-a')
  await put('customizations/preservation.json', json({ schema: 1, sources: [{ sourceDir: 'customizations/example', files: [{ path: 'lib/index.js' }] }] }))
  await put('customizations/example/lib/index.js', 'accepted local plugin')
  await put(`Tools/node-v1.0.0/${process.platform === 'win32' ? 'node.exe' : 'node'}`, node)
  await put(`Tools/pnpm-v${pnpmVersion}/node_modules/pnpm/package.json`, json({ name: 'pnpm', version: pnpmVersion }))
  await put(`Tools/pnpm-v${pnpmVersion}/node_modules/pnpm/bin/pnpm.mjs`, 'fixture pnpm entry')
  await put('dist/release-source.json', json({ owner: 'fixture', repo: 'fixture' }))
  await put('dist/src/main.js', 'compiled fixture')
  await put('release/win-unpacked/resources/release-source.json', json({ owner: 'fixture', repo: 'fixture' }))
  await put('release/win-unpacked/resources/app.asar', 'validated-asar')
  await put('release/win-unpacked/resources/desktop-bridge/bridge.js', 'validated bridge')
  await put('release/win-unpacked/resources/node/node.exe', 'validated node')
  await put('release/win-unpacked/resources/dsh-runtime.tgz', 'validated archive')
  await put('release/win-unpacked/icudtl.dat', 'validated Electron data')
  await put('release/win-unpacked/DSH Codex Desktop.exe', 'validated executable')
  await put('release/win-unpacked/resources/theme.css', 'theme-a')
  const pointer = { schema: 1, current: { relativePath: 'App', version: '0.0.0', sha256: '0'.repeat(64) }, updatedAt: 'fixture' }
  await put('Data/Updates/Desktop/pointer.json', json(pointer))
  const appDirectory = join(root, 'release/win-unpacked')
  return { root, appDirectory, put, read, pointer }
}

async function payloadFiles(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = join(current, entry.name)
      if (entry.isDirectory()) await walk(name)
      else result[relative(directory, name).replaceAll('\\', '/')] = sha(await readFile(name))
    }
  }
  await walk(directory)
  return result
}

function fakeStage(f: Awaited<ReturnType<typeof fixture>>, afterPublish?: (staged: any) => Promise<void>, beforePublish?: () => Promise<void>) {
  return async (intent: Record<string, string>) => {
    const transactionId = randomUUID(), slotRelativePath = `Data/Updates/Desktop/slots/1.0.0-local-fixture-txn-${transactionId.slice(0, 8)}`
    const transaction = `Data/Updates/Desktop/transactions/${transactionId}`
    await mkdir(join(f.root, slotRelativePath), { recursive: true })
    await cp(f.appDirectory, join(f.root, slotRelativePath), { recursive: true })
    const manifest = { schema: 1, version: '1.0.0', producer: api.BUILD_RECEIPT_PRODUCER, transactionId,
      completeFileList: true, files: await payloadFiles(join(f.root, slotRelativePath)) }
    await f.put(`${slotRelativePath}/slot-manifest.json`, json(manifest))
    await beforePublish?.()
    const prior = await f.read('Data/Updates/Desktop/pointer.json')
    await f.put(`${transaction}/build-prior-pointer.json`, json(prior))
    const pending = { relativePath: slotRelativePath, version: '1.0.0', transactionId, producer: api.BUILD_RECEIPT_PRODUCER,
      sha256: sha(await readFile(join(f.root, `${slotRelativePath}/slot-manifest.json`))) }
    await f.put(`${transaction}/build-intent.json`, json({ schema: 1, producer: api.BUILD_RECEIPT_PRODUCER,
      transactionId, slotRelativePath, version: '1.0.0', slotManifestSha256: pending.sha256, ...intent }))
    await f.put('Data/Updates/Desktop/pointer.json', json({ ...prior, pending }))
    const staged = { transactionId, slotRelativePath, version: '1.0.0' }
    await afterPublish?.(staged)
    return staged
  }
}

async function fullBuild(f: Awaited<ReturnType<typeof fixture>>, stage = fakeStage(f)) {
  const snapshot = await api.captureBuildInputs(f.root), compiledSnapshot = await api.captureCompiledInputs(f.root, snapshot)
  return api.stageBuildWithReceipt({ ...f, snapshot, compiledSnapshot, version: '1.0.0', stage, operationLock: held })
}

test('build capture covers source, tests, installer and explicit customizations but not Data/dependencies/UI archives', async t => {
  const f = await fixture(t), initial = await api.captureBuildInputs(f.root)
  for (const name of ['Data/private.json', 'node_modules/generated.js', 'customizations/ui/history/old.json']) await f.put(name, 'unrelated mutable content')
  assert.equal((await api.captureBuildInputs(f.root)).fingerprint, initial.fingerprint)
  await f.put('test/input.test.ts', 'changed tests')
  assert.notEqual((await api.captureBuildInputs(f.root)).coreFingerprint, initial.coreFingerprint)
})

test('first UI-only attempt without a successful receipt fails closed and does not create cache directories', async t => {
  const f = await fixture(t)
  await assert.rejects(api.verifyUIBuildReceipt(f.root, f.appDirectory), { code: 'BUILD_RECEIPT_MISSING' })
  assert.equal(existsSync(join(f.root, 'Data/Development')), false)
})

test('full validated build publishes exact transaction proof independent of later global receipt replacement', async t => {
  const f = await fixture(t), staged = await fullBuild(f)
  assert.equal((await api.verifyFinalizedBuildForSlot(f.root, staged.slotRelativePath)).finalized, true)
  const receipt = await f.read('Data/Development/build-cache/desktop-build-receipt.json')
  assert.equal(receipt.inputs.coreFingerprint, (await api.captureBuildInputs(f.root)).coreFingerprint)
  await f.put('Data/Development/build-cache/desktop-build-receipt.json', json({ diagnostic: 'later cache replacement' }))
  assert.equal((await api.verifyFinalizedBuildForSlot(f.root, staged.slotRelativePath)).finalized, true)
})

test('same built source bytes remain eligible when dirty/touched, while ordinary assets-only changes can commit', async t => {
  const f = await fixture(t)
  await fullBuild(f)
  await utimes(join(f.root, 'src/main.ts'), new Date(), new Date())
  await utimes(join(f.root, 'dist/src/main.js'), new Date(), new Date())
  await f.put('assets/theme.css', 'theme-b')
  await api.verifyUIBuildReceipt(f.root, f.appDirectory)
  const snapshot = await api.captureBuildInputs(f.root)
  await f.put('release/win-unpacked/resources/theme.css', 'theme-b')
  await api.commitUIBuildReceipt(f.root, snapshot, f.appDirectory)
  assert.equal((await f.read('Data/Development/build-cache/desktop-build-receipt.json')).mode, 'ui')
})

test('same-size/same-mtime source changes, embedded icons and compiled closure changes reject UI-only', async t => {
  for (const name of ['src/main.ts', 'assets/icons/icon.ico', 'dist/src/main.js']) {
    const f = await fixture(t)
    await fullBuild(f)
    const before = await readFile(join(f.root, name))
    const stamp = new Date('2026-01-01T00:00:00Z')
    await utimes(join(f.root, name), stamp, stamp)
    await f.put(name, Buffer.alloc(before.length, 'x'))
    await utimes(join(f.root, name), stamp, stamp)
    await assert.rejects(api.verifyUIBuildReceipt(f.root, f.appDirectory), { code: name.startsWith('dist/') ? 'BUILD_ARTIFACT_CHANGED' : 'BUILD_CORE_INPUT_CHANGED' })
  }
})

test('ASAR, executable and bundled runtime changes cannot be re-approved through UI-only', async t => {
  for (const name of ['resources/app.asar', 'DSH Codex Desktop.exe', 'resources/node/node.exe', 'resources/dsh-runtime.tgz', 'icudtl.dat']) {
    const f = await fixture(t)
    await fullBuild(f)
    const path = `release/win-unpacked/${name}`, old = await readFile(join(f.root, path))
    await f.put(path, Buffer.alloc(old.length, 'x'))
    await assert.rejects(api.verifyUIBuildReceipt(f.root, f.appDirectory), { code: 'BUILD_ARTIFACT_CHANGED' })
  }
})

test('source mutation during stage creates no finalized proof and withdraws only its own pending', async t => {
  const f = await fixture(t)
  let staged: any
  await assert.rejects(fullBuild(f, fakeStage(f, async result => { staged = result; await f.put('src/main.ts', 'new-source') })), { code: 'BUILD_INPUT_CHANGED' })
  assert.equal(existsSync(join(f.root, `Data/Updates/Desktop/transactions/${staged.transactionId}/build-finalized.json`)), false)
  assert.equal((await f.read('Data/Updates/Desktop/pointer.json')).pending, undefined)
  assert.equal(existsSync(api.buildReceiptPath(f.root)), false)
  assert.ok((await readdir(join(f.root, 'Data/Development/build-cache'))).some(name => name.startsWith('failure-')))
})

test('withdrawal repairs only its own deploying state and clears invalid transaction metadata', async t => {
  const f = await fixture(t)
  await assert.rejects(fullBuild(f, fakeStage(f, async staged => {
    await f.put('Data/Updates/Desktop/state.json', json({ schema: 1, phase: 'deploying', currentVersion: 'wrong',
      transactionId: staged.transactionId, slotRelativePath: staged.slotRelativePath, targetVersion: staged.version,
      release: { unverified: 'new candidate' }, detail: 'deploying C' }))
    await f.put('src/main.ts', 'new-source')
  })), { code: 'BUILD_INPUT_CHANGED' })
  const state = await f.read('Data/Updates/Desktop/state.json')
  assert.equal(state.phase, 'error')
  assert.equal(state.currentVersion, f.pointer.current.version)
  assert.equal(state.errorCode, 'BUILD_INPUT_CHANGED')
  for (const field of ['transactionId', 'slotRelativePath', 'targetVersion', 'release']) assert.equal(state[field], undefined)
  assert.match(state.detail, /自身候选已撤销.*现役保持不变/)
})

test('withdrawal reports the real restored predecessor without fabricating release or replacing another state', async t => {
  for (const ownsState of [true, false]) {
    const f = await fixture(t)
    const prior = { relativePath: 'Data/Updates/Desktop/slots/previous', version: 'previous', sha256: 'a'.repeat(64), transactionId: randomUUID() }
    await f.put('Data/Updates/Desktop/pointer.json', json({ ...f.pointer, pending: prior }))
    const otherId = randomUUID()
    let original: unknown
    await assert.rejects(fullBuild(f, fakeStage(f, async staged => {
      original = { schema: 1, phase: 'deploying', currentVersion: 'unrelated', transactionId: ownsState ? staged.transactionId : otherId,
        slotRelativePath: 'new-C', targetVersion: 'new-C', release: { author: 'another state' }, detail: 'old report' }
      await f.put('Data/Updates/Desktop/state.json', json(original))
      await f.put('src/main.ts', 'new-source')
    })), { code: 'BUILD_INPUT_CHANGED' })
    const state = await f.read('Data/Updates/Desktop/state.json')
    if (!ownsState) assert.deepEqual(state, original)
    else {
      assert.equal(state.phase, 'error')
      assert.equal(state.transactionId, prior.transactionId)
      assert.equal(state.targetVersion, prior.version)
      assert.equal(state.slotRelativePath, prior.relativePath)
      assert.equal(state.release, undefined)
      assert.match(state.detail, /先前候选.*已恢复，待正常启动验证/)
    }
  }
})

test('withdrawal restores the actual D-commit predecessor, not a stale pending seen before copying', async t => {
  const f = await fixture(t)
  const old = { relativePath: 'Data/Updates/Desktop/slots/old', version: 'old', sha256: 'a'.repeat(64), transactionId: randomUUID() }
  const later = { ...old, relativePath: 'Data/Updates/Desktop/slots/later', transactionId: randomUUID() }
  await f.put('Data/Updates/Desktop/pointer.json', json({ ...f.pointer, pending: old }))
  const stage = fakeStage(f, async () => f.put('src/main.ts', 'new-source'), async () => {
    await f.put('Data/Updates/Desktop/pointer.json', json({ ...f.pointer, pending: later }))
  })
  await assert.rejects(fullBuild(f, stage), { code: 'BUILD_INPUT_CHANGED' })
  assert.deepEqual((await f.read('Data/Updates/Desktop/pointer.json')).pending, later)
})

test('wrapper crash before finalization leaves a slot that recovery validation cannot accept', async t => {
  const f = await fixture(t), inputs = await api.captureBuildInputs(f.root)
  const asarSha256 = sha(await readFile(join(f.appDirectory, 'resources/app.asar')))
  const staged = await fakeStage(f)({ inputFingerprint: inputs.fingerprint, coreFingerprint: inputs.coreFingerprint, asarSha256 })
  await assert.rejects(api.verifyFinalizedBuildForSlot(f.root, staged.slotRelativePath), { code: 'BUILD_INPUT_MISSING' })
})

test('copied non-ASAR payload drift prevents finalization even when source build and ASAR remain unchanged', async t => {
  const f = await fixture(t)
  await assert.rejects(fullBuild(f, fakeStage(f, async staged => f.put(`${staged.slotRelativePath}/resources/theme.css`, 'corrupt'))), { code: 'BUILD_ARTIFACT_CHANGED' })
})

test('lost operation lease cannot publish proof or overwrite a different pending transaction', async t => {
  const f = await fixture(t), snapshot = await api.captureBuildInputs(f.root)
  const other = { relativePath: 'Data/Updates/Desktop/slots/other', version: 'other', sha256: 'a'.repeat(64), transactionId: randomUUID() }
  const lock = async (action: (assertHeld: () => void) => Promise<unknown>) => action(() => {
    // Exactly at the commit guard: another writer publishes B after this
    // action has already inspected its own C; the lost lease must prevent
    // writing the obsolete value or a success marker.
    writeFileSync(join(f.root, 'Data/Updates/Desktop/pointer.json'), json({ ...f.pointer, pending: other }))
    throw Object.assign(new Error('lease gone'), { code: 'BUILD_OPERATION_BUSY' })
  })
  await assert.rejects(api.stageBuildWithReceipt({ ...f, snapshot, compiledSnapshot: await api.captureCompiledInputs(f.root, snapshot), version: '1.0.0', stage: fakeStage(f), operationLock: lock }), { code: 'BUILD_OPERATION_BUSY' })
  const current = await f.read('Data/Updates/Desktop/pointer.json')
  assert.equal(existsSync(api.buildReceiptPath(f.root)), false)
  assert.deepEqual(current.pending, other)
})

test('post-tsc seal ignores legitimate generated release metadata but rejects later compiled mutations before staging', async t => {
  const f = await fixture(t), snapshot = await api.captureBuildInputs(f.root)
  const compiled = await api.captureCompiledInputs(f.root, snapshot)
  await f.put('dist/release-source.json', json({ owner: 'new-fixture', repo: 'new-fixture' }))
  await api.assertCompiledInputsUnchanged(f.root, snapshot, compiled)
  await f.put('dist/src/main.js', 'different compiled code')
  let called = false
  await assert.rejects(api.stageBuildWithReceipt({ ...f, snapshot, compiledSnapshot: compiled, version: '1.0.0', operationLock: held,
    stage: async () => { called = true; return {} } }), { code: 'BUILD_COMPILED_CHANGED' })
  assert.equal(called, false)
  assert.equal(existsSync(api.buildReceiptPath(f.root)), false)
})

test('adding or deleting immutable build files invalidates the successful output closure', async t => {
  for (const change of ['add', 'delete']) {
    const f = await fixture(t)
    await fullBuild(f)
    if (change === 'add') await f.put('release/win-unpacked/unexpected.pak', 'new bytes')
    else await rm(join(f.root, 'release/win-unpacked/icudtl.dat'))
    await assert.rejects(api.verifyUIBuildReceipt(f.root, f.appDirectory), { code: 'BUILD_ARTIFACT_CHANGED' })
  }
})

test('snapshot path escape and linked cache directory are rejected without touching target data', async t => {
  const f = await fixture(t), snapshot = await api.captureBuildInputs(f.root)
  await assert.rejects(api.writeBuildSnapshot(f.root, join(f.root, 'outside', `input-${randomUUID()}.json`), snapshot), { code: 'UNSAFE_RECEIPT_PATH' })
  const outside = await mkdtemp(join(tmpdir(), 'dsh-build-receipt-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(f.root, 'Data/Development'), { recursive: true })
  await symlink(outside, join(f.root, 'Data/Development/build-cache'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(api.writeBuildSnapshot(f.root, join(f.root, 'Data/Development/build-cache', `input-${randomUUID()}.json`), snapshot), { code: 'UNSAFE_BUILD_PATH' })
  assert.deepEqual(await readdir(outside), [])
})
