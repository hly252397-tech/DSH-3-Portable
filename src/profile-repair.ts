import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeTextFileAtomic } from './atomic-file.js'
import { OFFICIAL_PROFILE_BUNDLES } from './bundled-plugins.js'
import { ensureDesktopBridgePatch } from './desktop-host.js'
import { inspectProfileBundle } from './profile-bundle-health.js'
import { quarantineProfileBundle } from './profile-quarantine.js'
import {
  assertOfficialProfileBundlesAvailable,
  ensureAutoInstallPeersDisabled,
  finalizeProfileBundlesAfterInstall,
  stripOfficialProfileDependencies,
} from './plugin-seed.js'

export function parseUnresolvedBundleError(message: string): string | undefined {
  const packageName = /cannot resolve profile bundle "([^"]+)"/.exec(message)?.[1]
    ?? /failed to import loader entry [^(\r\n]+\(([^)\r\n]+)\)/.exec(message)?.[1]
  return packageName !== undefined && isValidPackageName(packageName) ? packageName : undefined
}

export function isSelfRepairableBundle(packageName: string): boolean {
  return !(OFFICIAL_PROFILE_BUNDLES as readonly string[]).includes(packageName)
}

export async function removeProfileBundle(profileDir: string, packageName: string): Promise<boolean> {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const current = manifest.dsh?.profile?.bundles ?? []
  const next = current.filter((name) => name !== packageName)
  const hadDependency = manifest.dependencies?.[packageName] !== undefined
  if (next.length === current.length && !hadDependency) return false
  if (hadDependency) {
    const dependencies = { ...manifest.dependencies }
    delete dependencies[packageName]
    manifest.dependencies = dependencies
  }
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
  await writeTextFileAtomic(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return true
}

/** 启动前把已知损坏修掉：官方包串进 profile、空 bundle、坏的 bridge patch。 */
export interface RepairBrokenProfileOptions {
  /** 上游 v1.0.76 语义：false 时跳过 bundle 清单协调，只做其余修复。 */
  reconcileBundles?: boolean
}

export async function repairBrokenProfile(profileDir: string, extraDirs: readonly string[] = [], options: RepairBrokenProfileOptions = {}): Promise<string[]> {
  if (!existsSync(join(profileDir, 'package.json'))) return []
  await stripOfficialProfileDependencies(profileDir)
  ensureAutoInstallPeersDisabled(profileDir)
  ensureDesktopBridgePatch(profileDir)
  if (options.reconcileBundles === false) return []
  const finalized = await finalizeProfileBundlesAfterInstall(profileDir, extraDirs)
  const repaired = [...finalized.removed]
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
  for (const packageName of manifest.dsh?.profile?.bundles ?? []) {
    if (!isSelfRepairableBundle(packageName)) continue
    const health = inspectProfileBundle(profileDir, packageName, extraDirs)
    if (health.loadable) continue
    if (await quarantineProfileBundle(profileDir, packageName, health.reason ?? '插件入口预检失败。', 'preflight', { extraDirs })) repaired.push(packageName)
  }
  return repaired
}

export async function startWithProfileSelfRepair<T>(options: {
  profileDir: string
  extraDirs?: readonly string[]
  start: () => Promise<T>
  maxAttempts?: number
}): Promise<{ result: T; repaired: string[] }> {
  const extraDirs = options.extraDirs ?? []
  const repaired = [...await repairBrokenProfile(options.profileDir, extraDirs)]
  // 上游 v1.0.76：启动前先验证官方 bundle 在运行时依赖树里真实可解析，缺了立刻报安装损坏，
  // 不等启动超时（官方 bundle 不可自我修复，也不会被隔离）。
  assertOfficialProfileBundlesAvailable(options.profileDir, extraDirs)
  const maxAttempts = options.maxAttempts ?? 5
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return { result: await options.start(), repaired }
    } catch (error) {
      lastError = error
      const missing = parseUnresolvedBundleError(error instanceof Error ? error.message : String(error))
      if (missing === undefined || !isSelfRepairableBundle(missing)) throw error
      const removed = await quarantineProfileBundle(
        options.profileDir,
        missing,
        error instanceof Error ? error.message : String(error),
        'startup',
        { extraDirs },
      )
      if (!removed) throw error
      repaired.push(missing)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('自我修复后仍无法启动 DSH。')
}

function isValidPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)
}
