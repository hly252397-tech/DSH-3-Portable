import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface ProfileBundleHealth {
  readonly fingerprint: string
  readonly loadable: boolean
  readonly reason?: string
}

interface BundleManifest {
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: unknown } }
  exports?: unknown
  main?: unknown
  version?: unknown
}

/**
 * 解析 bundle 的包根目录。官方 `bundleManifest` 用 `resolveBundleDir('dsh', name, installAnchor, profileDir)`
 * 在「运行时安装目录 + profile」两处查找；便携预检必须同样看待，否则只装在运行时里的官方实验性
 * bundle（如 @deepseek-ai/dsh-experimental-*）会被误判缺包而隔离，开关打开后又被回滚。
 * @param profileDir - profile 包目录。
 * @param packageName - bundle 包名。
 * @param extraDirs - 额外解析根（运行时安装目录），按序在 profile 之后尝试。
 * @returns 命中 package.json 的包根；都没有时为 undefined。
 */
function resolveBundlePackageRoot(profileDir: string, packageName: string, extraDirs: readonly string[]): string | undefined {
  for (const dir of [profileDir, ...extraDirs]) {
    const packageRoot = join(dir, 'node_modules', ...packageName.split('/'))
    if (existsSync(join(packageRoot, 'package.json'))) return packageRoot
  }
  return undefined
}

/** 依赖清单也按同一组根目录解析，避免「依赖装在运行时」被算成缺失指纹。 */
function resolveDependencyManifest(profileDir: string, dependency: string, extraDirs: readonly string[]): string {
  for (const dir of [profileDir, ...extraDirs]) {
    const manifestPath = join(dir, 'node_modules', ...dependency.split('/'), 'package.json')
    if (existsSync(manifestPath)) return manifestPath
  }
  return join(profileDir, 'node_modules', ...dependency.split('/'), 'package.json')
}

export function inspectProfileBundle(profileDir: string, packageName: string, extraDirs: readonly string[] = []): ProfileBundleHealth {
  const packageRoot = resolveBundlePackageRoot(profileDir, packageName, extraDirs)
  if (packageRoot === undefined) {
    return { loadable: false, reason: '插件 package.json 不存在。', fingerprint: hashParts(['missing-package']) }
  }
  const manifestPath = join(packageRoot, 'package.json')

  let source: string
  let manifest: BundleManifest
  try {
    source = readFileSync(manifestPath, 'utf8')
    manifest = JSON.parse(source) as BundleManifest
  } catch {
    return { loadable: false, reason: '插件 package.json 无法解析。', fingerprint: hashParts(['invalid-package']) }
  }

  const fingerprintParts = [source]
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch === 'string') {
    const resolvedPatch = resolvePackageFile(packageRoot, patch)
    fingerprintParts.push(fileFingerprint(resolvedPatch))
    if (resolvedPatch === undefined || !existsSync(resolvedPatch)) {
      return { loadable: false, reason: `插件 patch 入口不存在：${patch}`, fingerprint: hashParts(fingerprintParts) }
    }
  } else if (patch !== undefined) {
    return { loadable: false, reason: '插件 patch 入口声明无效。', fingerprint: hashParts(fingerprintParts) }
  }

  const declaredEntry = typeof manifest.main === 'string' || hasRootExport(manifest.exports)
  const entries = [...new Set([
    ...(typeof manifest.main === 'string' ? [manifest.main] : []),
    ...rootExportCandidates(manifest.exports),
  ])].filter(candidate => !candidate.endsWith('.d.ts'))
  const resolvedEntries = entries.map(candidate => ({ candidate, path: resolvePackageFile(packageRoot, candidate) }))
  fingerprintParts.push(...resolvedEntries.map(entry => fileFingerprint(entry.path)))
  if (declaredEntry && entries.length === 0) {
    return { loadable: false, reason: '插件主入口声明无效。', fingerprint: hashParts(fingerprintParts) }
  }
  if (entries.length > 0 && !resolvedEntries.some(entry => entry.path !== undefined && existsSync(entry.path))) {
    return {
      loadable: false,
      reason: `插件主入口不存在：${entries.join('、')}`,
      fingerprint: hashParts(fingerprintParts),
    }
  }

  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const dependencyManifest = resolveDependencyManifest(profileDir, dependency, extraDirs)
    fingerprintParts.push(`${dependency}:${fileFingerprint(dependencyManifest)}`)
  }
  return { loadable: true, fingerprint: hashParts(fingerprintParts) }
}

function hasRootExport(value: unknown): boolean {
  return typeof value === 'string'
    || Array.isArray(value)
    || (typeof value === 'object' && value !== null && (
      '.' in value
      // `exports: { import, require, default }` is also a root export.
      || !Object.keys(value).some(key => key.startsWith('.'))
    ))
}

function rootExportCandidates(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(rootExportCandidates)
  if (typeof value !== 'object' || value === null) return []
  if ('.' in value) return rootExportCandidates((value as Record<string, unknown>)['.'])
  return Object.values(value).flatMap(rootExportCandidates)
}

function resolvePackageFile(packageRoot: string, candidate: string): string | undefined {
  const path = resolve(packageRoot, candidate)
  if (isAbsolute(candidate) || !isPathWithin(packageRoot, path)) return undefined
  return path
}

function isPathWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path))
}

function fileFingerprint(path: string | undefined): string {
  if (path === undefined || !existsSync(path)) return `missing:${path ?? 'invalid'}`
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return `unreadable:${path}`
  }
}

function hashParts(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}
