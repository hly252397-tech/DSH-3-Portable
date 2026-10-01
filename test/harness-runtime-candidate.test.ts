import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OFFICIAL_LAUNCH_PEERS } from '../src/bundled-plugins.js'
import { assertLockfileSourcesAllowed, buildHarnessRuntimeCandidate, pnpmFailureDetail, validateHarnessRuntimeCandidate } from '../src/harness-runtime-candidate.js'

const VERSION = '0.1.2-rc.1'
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
  await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true })
  await writeFile(join(root, 'node_modules', '.modules.yaml'), JSON.stringify({ virtualStoreDir: join(root, 'node_modules', '.pnpm'), storeDir: join(root, '..', 'store'), preserved: true }))
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
    const modules = JSON.parse(await readFile(join(first.directory, 'node_modules', '.modules.yaml'), 'utf8'))
    assert.equal(modules.virtualStoreDir, '.pnpm')
    assert.equal(modules.preserved, true)

    const second = await buildHarnessRuntimeCandidate(options)
    assert.equal(second.reused, true)
    assert.equal(second.directory, first.directory)
    assert.equal(second.fingerprint, first.fingerprint)
    assert.deepEqual((await readdir(join(root, 'Harness', 'slots'))).filter(name => name.startsWith('.staging-')), [])

    // A stale published slot must never be silently rewritten during reuse.
    const brokenMetadata = JSON.stringify({ virtualStoreDir: join(root, 'deleted-staging/node_modules/.pnpm') })
    const metadataPath = join(first.directory, 'node_modules', '.modules.yaml')
    await writeFile(metadataPath, brokenMetadata)
    await assert.rejects(buildHarnessRuntimeCandidate(options), /virtualStoreDir/)
    assert.equal(await readFile(metadataPath, 'utf8'), brokenMetadata)
    assert.deepEqual((await readdir(join(root, 'Harness', 'slots'))).filter(name => name.startsWith('.staging-')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('供应链校验拒绝 integrity 不符、非 HTTPS 来源和 DSH 家族版本混用', async () => {  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-trust-'))
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

test('lockfile 来源白名单：https 直链与 git/file 来源一律拒绝，registry 放行', () => {
  const allowed = [
    "lockfileVersion: '9.0'",
    'packages:',
    '  dsh:',
    '    resolution: {integrity: sha512-x}',
    '  lodash:',
    '    resolution: {integrity: sha512-y}',
    '',
  ].join('\n')
  assert.doesNotThrow(() => assertLockfileSourcesAllowed(allowed))

  // 历史缺陷：旧实现只拦 http://，`https://` 直链可以穿过门禁。
  assert.throws(
    () => assertLockfileSourcesAllowed("packages:\n  evil:\n    tarball: https://evil.example/x.tgz\n"),
    /非允许来源/,
  )
  assert.throws(
    () => assertLockfileSourcesAllowed('packages:\n  evil:\n    resolution: https://evil.example/x.tgz\n'),
    /非允许来源/,
  )
  assert.throws(
    () => assertLockfileSourcesAllowed('packages:\n  evil:\n    resolution: git+https://evil.example/x.git\n'),
    /非允许来源/,
  )
  assert.throws(
    () => assertLockfileSourcesAllowed('packages:\n  evil:\n    resolution: file:../local.tgz\n'),
    /非允许来源/,
  )
  // 受信 registry 的显式 URL 仍然放行。
  assert.doesNotThrow(() => assertLockfileSourcesAllowed('packages:\n  ok:\n    resolution: https://registry.npmjs.org/lodash/-/lodash-4.0.0.tgz\n'))
  assert.doesNotThrow(() => assertLockfileSourcesAllowed('packages:\n  ok:\n    resolution: https://registry.npmmirror.com/lodash/-/lodash-4.0.0.tgz\n'))
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

// 事故回归：自动升级连续两天把「与故障无关的 pnpm WARN」记成失败原因，
// 退避闸门还据此判成已重试耗尽。根因是调用方只保留 detail 前 200 字符，
// 而 pnpm 输出的尾部常被 WARN 占住，真错误被截断吃掉。
test('装配失败原因挑真正的错误行，而不是被 WARN 占位的行首', () => {
  const real = [
    'Progress: resolved 530, reused 0, downloaded 0, added 0',
    'Packages: +530',
    '[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides". See https://pnpm.io/settings for the new home of each setting.',
    'Error: ERR_PNPM_NO_MATURE_MATCHING_VERSION',
    '',
    '  × installing dependencies',
    '  ╰─▶ 1 version does not meet the minimumReleaseAge constraint:',
    '        @deepseek-ai/dsh-client-ui-settings-account@0.2.0-rc.2 was published',
    '      at 2026-09-29T11:17:03.848Z, within the minimumReleaseAge cutoff (2026-09-29T10:56:27.792Z)',
  ].join('\n')
  // 调用方（deployHarnessCandidate）会把 detail 截到 200 字符，那才是真正进 state.json 的形态。
  const detail = pnpmFailureDetail(real, 1).slice(0, 200)
  assert.match(detail, /ERR_PNPM_NO_MATURE_MATCHING_VERSION/)
  assert.doesNotMatch(detail, /no longer read by pnpm/)
})

test('装配失败原因在没有 pnpm 错误码时退回第一条非 WARN 行', () => {
  const detail = pnpmFailureDetail([
    '[WARN] 1 deprecated subdependencies found: node-domexception@1.0.0',
    'ERROR: 构建脚本 node-pty 退出码 1',
  ].join('\n'), 1)
  assert.equal(detail, 'ERROR: 构建脚本 node-pty 退出码 1')
})

test('输出全空时给出可读的退出码兜底，不返回空串', () => {
  assert.equal(pnpmFailureDetail('   \n  ', 1), '候选 DSH 运行时装配失败（退出码 1）。')
  assert.equal(pnpmFailureDetail('', null), '候选 DSH 运行时装配失败（退出码 未知）。')
})
