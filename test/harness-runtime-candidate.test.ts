import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OFFICIAL_LAUNCH_PEERS } from '../src/bundled-plugins.js'
import { buildHarnessRuntimeCandidate, validateHarnessRuntimeCandidate } from '../src/harness-runtime-candidate.js'

const VERSION = '0.1.2-alpha.3'
const INTEGRITY = 'sha512-enterprise-test-integrity'
const LOCKED_DSH_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-invariants',
] as const

async function writePackage(root: string, name: string, version: string): Promise<void> {
  const directory = join(root, 'node_modules', ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name, version })}\n`, 'utf8')
  if (name === '@deepseek-ai/dsh') {
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'lib', 'bin.js'), '', 'utf8')
  }
}

async function materializeCandidate(root: string, options: { version?: string; integrity?: string; source?: string } = {}): Promise<void> {
  const version = options.version ?? VERSION
  for (const name of LOCKED_DSH_PACKAGES) await writePackage(root, name, version)
  for (const peer of OFFICIAL_LAUNCH_PEERS) {
    if (LOCKED_DSH_PACKAGES.includes(peer.packageName as typeof LOCKED_DSH_PACKAGES[number])) continue
    await writePackage(root, peer.packageName, peer.packageName.startsWith('@deepseek-ai/dsh-') ? version : peer.version)
  }
  await writeFile(join(root, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'",
    'packages:',
    '  dsh:',
    `    integrity: ${options.integrity ?? INTEGRITY}`,
    ...(options.source === undefined ? [] : [`    tarball: ${options.source}`]),
    '',
  ].join('\n'), 'utf8')
}

test('候选运行时只在完整校验后原子进入不可变槽，重复构建复用同一指纹', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-'))
  try {
    const legacyRuntimeDir = join(root, 'dsh-runtime')
    const options = {
      legacyRuntimeDir,
      version: VERSION,
      expectedNpmIntegrity: INTEGRITY,
      nodeExecutable: 'unused-node',
      pnpmEntry: 'unused-pnpm',
      storeDir: join(root, 'store'),
      runner: async (_args: readonly string[], cwd: string) => materializeCandidate(cwd),
    }
    const first = await buildHarnessRuntimeCandidate(options)
    assert.equal(first.reused, false)
    assert.equal(first.version, VERSION)
    assert.equal(first.fingerprint.length, 64)
    assert.equal(first.packageCount >= LOCKED_DSH_PACKAGES.length, true)
    assert.equal(existsSync(join(first.directory, '.dsh-runtime-fingerprint')), true)

    const second = await buildHarnessRuntimeCandidate(options)
    assert.equal(second.reused, true)
    assert.equal(second.directory, first.directory)
    assert.equal(second.fingerprint, first.fingerprint)
    assert.deepEqual((await readdir(join(root, 'Harness', 'slots'))).filter(name => name.startsWith('.staging-')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('供应链校验拒绝 integrity 不符、非 HTTPS 来源和 DSH 家族版本混用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-trust-'))
  try {
    const runtime = join(root, 'runtime')
    await mkdir(runtime, { recursive: true })
    const manifest = {
      name: 'dsh-desktop-runtime',
      private: true,
      pnpm: { overrides: { '@deepseek-ai/dsh': VERSION, '@deepseek-ai/dsh-*': VERSION } },
    }
    await writeFile(join(runtime, 'package.json'), JSON.stringify(manifest), 'utf8')
    await materializeCandidate(runtime, { integrity: 'sha512-wrong' })
    await assert.rejects(validateHarnessRuntimeCandidate(runtime, VERSION, INTEGRITY), /integrity/)

    await materializeCandidate(runtime, { source: 'http://mirror.invalid/dsh.tgz' })
    await assert.rejects(validateHarnessRuntimeCandidate(runtime, VERSION, INTEGRITY), /非允许来源/)

    await materializeCandidate(runtime)
    await writePackage(runtime, '@deepseek-ai/dsh-host-apiproxy', '0.1.2-alpha.2')
    await assert.rejects(validateHarnessRuntimeCandidate(runtime, VERSION, INTEGRITY), /版本未对齐/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('候选装配失败不污染活动运行时，也不遗留 staging 目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-failure-'))
  try {
    const legacyRuntimeDir = join(root, 'dsh-runtime')
    await mkdir(legacyRuntimeDir, { recursive: true })
    await writeFile(join(legacyRuntimeDir, 'keep.txt'), 'active', 'utf8')
    await assert.rejects(buildHarnessRuntimeCandidate({
      legacyRuntimeDir,
      version: VERSION,
      expectedNpmIntegrity: INTEGRITY,
      nodeExecutable: 'unused-node',
      pnpmEntry: 'unused-pnpm',
      storeDir: join(root, 'store'),
      runner: async () => { throw new Error('injected install failure') },
    }), /injected install failure/)
    assert.equal(await readFile(join(legacyRuntimeDir, 'keep.txt'), 'utf8'), 'active')
    assert.deepEqual((await readdir(join(root, 'Harness', 'slots'))).filter(name => name.startsWith('.staging-')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
