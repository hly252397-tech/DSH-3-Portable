import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeTextFileAtomic } from './atomic-file.js'
import { OFFICIAL_PROFILE_BUNDLES } from './bundled-plugins.js'
import { ensureDesktopBridgePatch } from './desktop-host.js'
import { inspectProfileBundle } from './profile-bundle-health.js'
import { quarantineProfileBundle } from './profile-quarantine.js'
import {
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
export async function repairBrokenProfile(profileDir: string, extraDirs: readonly string[] = []): Promise<string[]> {
  if (!existsSync(join(profileDir, 'package.json'))) return []
  await stripOfficialProfileDependencies(profileDir)
  ensureAutoInstallPeersDisabled(profileDir)
  ensureDesktopBridgePatch(profileDir)
  const finalized = await finalizeProfileBundlesAfterInstall(profileDir, extraDirs)
  const repaired = [...finalized.removed]
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
  for (const packageName of manifest.dsh?.profile?.bundles ?? []) {
    if (!isSelfRepairableBundle(packageName)) continue
    const health = inspectProfileBundle(profileDir, packageName)
    if (health.loadable) continue
    if (await quarantineProfileBundle(profileDir, packageName, health.reason ?? '插件入口预检失败。', 'preflight')) repaired.push(packageName)
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
