import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
const { activeUiProfile } = await import(pathToFileURL(resolve('scripts/lib/active-ui-profile.mjs')).href)

test('active UI Profile pairs runtime and generation, rejecting corrupt bindings and escaping paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-active-ui-'))
  const put = (path: string, value: unknown): void => {
    const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value))
  }
  try {
    assert.equal(activeUiProfile(root).profile, join(root, 'Data/DSH/profiles/web'))
    const pointer = 'Data/Runtime/Harness/current.json'
    const binding = 'Data/Updates/Harness/homes/0.1.7-rc.2.json'
    const current = { version: '0.1.7-rc.2', relativePath: 'Harness/slots/rc2' }
    put(pointer, { schema: 1, current })
    mkdirSync(join(root, 'Data/Runtime', current.relativePath), { recursive: true })
    assert.equal(activeUiProfile(root).profile, join(root, 'Data/DSH/profiles/web'), 'legacy runtime without a binding')
    put(binding, { schema: 1, runtimeVersion: current.version, generation: 'v4' })
    assert.throws(() => activeUiProfile(root), /missing/)
    put('Data/DSH-generations/v4/home/profiles/web/package.json', {})
    assert.equal(activeUiProfile(root).profile, join(root, 'Data/DSH-generations/v4/home/profiles/web'))
    put(binding, { schema: 2, runtimeVersion: current.version, generation: 'v4', runtimeRelativePath: `Data/Runtime/${current.relativePath}` })
    assert.equal(activeUiProfile(root).profile, join(root, 'Data/DSH-generations/v4/home/profiles/web'))
    assert.equal(activeUiProfile(root).runtime, join(root, 'Data/Runtime', current.relativePath))
    put(binding, { schema: 2, runtimeVersion: current.version, generation: 'v4', runtimeRelativePath: 'Data/Runtime/Harness/slots/other' })
    assert.throws(() => activeUiProfile(root), /mapping/)
    put(binding, { schema: 2, runtimeVersion: current.version, generation: 'v4', runtimeRelativePath: '../outside' })
    assert.throws(() => activeUiProfile(root), /mapping/)
    unlinkSync(join(root, binding))
    symlinkSync(join(root, process.platform === 'win32' ? 'missing-binding-directory' : 'missing-binding.json'), join(root, binding), process.platform === 'win32' ? 'junction' : 'file')
    assert.throws(() => activeUiProfile(root), /link/, 'a dangling binding link is not an absent legacy binding')
    unlinkSync(join(root, binding))
    put(binding, { schema: 1, runtimeVersion: 'wrong', generation: 'v4' })
    assert.throws(() => activeUiProfile(root), /binding/)
    put(binding, { schema: 1, runtimeVersion: current.version, generation: '../v4' })
    assert.throws(() => activeUiProfile(root), /binding/)
    put(pointer, { schema: 1, current: { ...current, relativePath: '../../escape' } })
    assert.throws(() => activeUiProfile(root), /path/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('active UI Profile refuses every uncommitted runtime transaction without guessing current or previous', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-active-ui-pending-'))
  const put = (relative: string, value: unknown): void => {
    const file = join(root, relative); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value))
  }
  try {
    const current = { version: '0.2.0-rc.2', relativePath: 'Harness/slots/rc2' }
    const previous = { version: '0.2.0-rc.1', relativePath: 'Harness/slots/rc1' }
    mkdirSync(join(root, 'Data/Runtime', current.relativePath), { recursive: true })
    mkdirSync(join(root, 'Data/Runtime', previous.relativePath), { recursive: true })
    put('Data/DSH/profiles/web/package.json', {})
    for (const [reference, generation] of [[current, 'new-home'], [previous, 'old-home']] as const) {
      put(`Data/DSH-generations/${generation}/home/profiles/web/package.json`, {})
      put(`Data/Updates/Harness/homes/${reference.version}.json`, {
        schema: 2, runtimeVersion: reference.version, generation, runtimeRelativePath: `Data/Runtime/${reference.relativePath}`,
      })
    }
    const pointer = 'Data/Runtime/Harness/current.json'
    for (const pendingTransactionId of ['11111111-1111-4111-8111-111111111111', '', null, 0]) {
      put(pointer, { schema: 1, current, previous, pendingTransactionId })
      assert.throws(() => activeUiProfile(root), (error: any) => error.code === 'RUNTIME_TRANSACTION_PENDING')
    }
    put(pointer, { schema: 1, current, pendingTransactionId: '11111111-1111-4111-8111-111111111111' })
    assert.throws(() => activeUiProfile(root), /Uncommitted runtime transaction/, 'no previous cannot fall back to legacy either')
    put(pointer, { schema: 1, current, previous })
    assert.equal(activeUiProfile(root).profile, join(root, 'Data/DSH-generations/new-home/home/profiles/web'))
    put(pointer, { schema: 1, current: previous })
    assert.equal(activeUiProfile(root).profile, join(root, 'Data/DSH-generations/old-home/home/profiles/web'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('active UI Profile refuses a linked generation rather than selecting legacy', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-active-ui-link-'))
  const target = mkdtempSync(join(tmpdir(), 'dsh-active-ui-external-'))
  const put = (relative: string, value: unknown): void => {
    const file = join(root, relative); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value))
  }
  try {
    const current = { version: '0.2.0-rc.2', relativePath: 'Harness/slots/rc2' }
    put('Data/Runtime/Harness/current.json', { schema: 1, current })
    mkdirSync(join(root, 'Data/Runtime', current.relativePath), { recursive: true })
    put('Data/Updates/Harness/homes/0.2.0-rc.2.json', { schema: 2, runtimeVersion: current.version, generation: 'linked', runtimeRelativePath: `Data/Runtime/${current.relativePath}` })
    mkdirSync(join(target, 'home/profiles/web'), { recursive: true })
    writeFileSync(join(target, 'home/profiles/web/package.json'), '{}')
    mkdirSync(join(root, 'Data/DSH-generations'), { recursive: true })
    symlinkSync(target, join(root, 'Data/DSH-generations/linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => activeUiProfile(root), /link/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})
