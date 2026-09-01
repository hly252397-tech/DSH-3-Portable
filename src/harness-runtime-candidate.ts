import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pnpmWorkspaceYaml } from './bundled-plugins.js'
import {
  isOfficialRuntimeFamilyAligned,
  isOfficialRuntimeLaunchable,
  officialRuntimeInstallArgs,
  writeOfficialRuntimeManifest,
} from './plugin-seed.js'
import { terminateProcessTree } from './process-control.js'
import { runtimeSlotDirectory, runtimeSlotsRoot } from './runtime-slots.js'

export interface HarnessRuntimeCandidate {
  readonly directory: string
  readonly version: string
  readonly fingerprint: string
  readonly reused: boolean
  readonly packageCount: number
}

export async function buildHarnessRuntimeCandidate(options: {
  legacyRuntimeDir: string
  version: string
  expectedNpmIntegrity: string
  nodeExecutable: string
  pnpmEntry: string
  storeDir: string
  timeoutMs?: number
  runner?: (args: readonly string[], cwd: string) => Promise<void>
}): Promise<HarnessRuntimeCandidate> {
  const slotsRoot = runtimeSlotsRoot(options.legacyRuntimeDir)
  await mkdir(slotsRoot, { recursive: true })
  const stagingDir = await mkdtemp(join(slotsRoot, '.staging-'))
  try {
    writeOfficialRuntimeManifest(stagingDir, options.version)
    await writeFile(join(stagingDir, 'pnpm-workspace.yaml'), pnpmWorkspaceYaml(), 'utf8')
    const args = officialRuntimeInstallArgs(stagingDir, options.storeDir)
    await (options.runner ?? ((commandArgs, cwd) => runPnpm(options.nodeExecutable, options.pnpmEntry, commandArgs, cwd, options.timeoutMs)))(args, stagingDir)
    const validation = await validateHarnessRuntimeCandidate(stagingDir, options.version, options.expectedNpmIntegrity)
    await writeFile(join(stagingDir, '.dsh-runtime-fingerprint'), `${validation.fingerprint}\n`, 'utf8')
    const destination = runtimeSlotDirectory(options.legacyRuntimeDir, options.version, validation.fingerprint)
    if (existsSync(destination)) {
      const existing = await validateHarnessRuntimeCandidate(destination, options.version, options.expectedNpmIntegrity)
      if (existing.fingerprint !== validation.fingerprint) throw new Error('同名 DSH 运行时槽与候选指纹不一致。')
      return { directory: destination, version: options.version, fingerprint: validation.fingerprint, reused: true, packageCount: validation.packageCount }
    }
    await rename(stagingDir, destination)
    return { directory: destination, version: options.version, fingerprint: validation.fingerprint, reused: false, packageCount: validation.packageCount }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function validateHarnessRuntimeCandidate(
  directory: string,
  expectedVersion: string,
  expectedNpmIntegrity: string,
): Promise<{ fingerprint: string; packageCount: number }> {
  if (!isOfficialRuntimeLaunchable(directory)) throw new Error('候选 DSH 运行时缺少入口或启动 peer。')
  if (!isOfficialRuntimeFamilyAligned(directory, expectedVersion)) throw new Error('候选 DSH 运行时核心包版本未对齐。')
  const lockPath = join(directory, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) throw new Error('候选 DSH 运行时缺少 pnpm lockfile。')
  const lock = await readFile(lockPath, 'utf8')
  if (!lock.includes(expectedNpmIntegrity)) throw new Error('候选 DSH 根包 integrity 与受信清单不一致。')
  if (/(?:^|\s)(?:tarball:\s*)?(?:http:\/\/|git\+|git:|file:)/im.test(lock)) {
    throw new Error('候选 DSH lockfile 包含非允许来源。')
  }

  const scopeRoot = join(directory, 'node_modules', '@deepseek-ai')
  const manifests: string[] = []
  for (const entry of await readdir(scopeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const manifestPath = join(scopeRoot, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const source = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(source) as { name?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error(`候选包清单无效：${entry.name}`)
    if ((manifest.name === '@deepseek-ai/dsh' || manifest.name.startsWith('@deepseek-ai/dsh-')) && manifest.version !== expectedVersion) {
      throw new Error(`候选 DSH 家族版本混用：${manifest.name}@${manifest.version}`)
    }
    manifests.push(`${manifest.name}\0${manifest.version}\0${source}`)
  }
  if (manifests.length === 0) throw new Error('候选 DSH 运行时没有可审计的官方包。')
  const fingerprint = createHash('sha256')
    .update(lock)
    .update('\0')
    .update(manifests.sort().join('\0'))
    .digest('hex')
  return { fingerprint, packageCount: manifests.length }
}

function runPnpm(
  nodeExecutable: string,
  pnpmEntry: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 15 * 60_000,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(nodeExecutable, [pnpmEntry, ...args], {
      cwd,
      env: {
        ...process.env,
        CI: 'true',
        npm_config_registry: 'https://registry.npmjs.org/',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    let timeoutError: Error | undefined
    let killDeadline: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killDeadline)
      if (error === undefined) resolvePromise()
      else reject(error)
    }
    const timeout = setTimeout(() => {
      timeoutError = new Error('候选 DSH 运行时装配超时，已终止子进程。')
      terminateProcessTree(child)
      killDeadline = setTimeout(() => finish(timeoutError), 2_000)
    }, timeoutMs)
    timeout.unref?.()
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-12_000) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => finish(new Error('无法启动随包 pnpm 装配候选运行时。')))
    child.once('exit', code => {
      if (timeoutError !== undefined) return finish(timeoutError)
      if (code === 0) return finish()
      finish(new Error(output.replace(/\s+/g, ' ').trim() || `候选 DSH 运行时装配失败（退出码 ${code ?? '未知'}）。`))
    })
  })
}
