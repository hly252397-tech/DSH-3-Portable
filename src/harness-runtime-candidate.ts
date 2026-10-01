import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { OFFICIAL_RUNTIME_RESOLUTION_POLICY, pnpmWorkspaceYaml } from './bundled-plugins.js'
import { preparePnpmInvocation } from './plugin-toolchain.js'
import {
  isOfficialRuntimeFamilyAligned,
  isOfficialRuntimeLaunchable,
  officialRuntimeInstallArgs,
  writeOfficialRuntimeManifest,
} from './plugin-seed.js'
import { terminateProcessTree } from './process-control.js'
import { runtimeSlotDirectory, runtimeSlotsRoot } from './runtime-slots.js'
import { prepareRuntimePnpmLayout, verifyRuntimePnpmLayout } from './runtime-pnpm-layout.js'

export interface HarnessRuntimeCandidate {
  readonly directory: string
  readonly version: string
  readonly fingerprint: string
  readonly reused: boolean
  readonly packageCount: number
}

/** 允许出现在 lockfile 里的直接下载/本地来源（**显式白名单**）。
 *  历史缺陷：旧实现只拦 `http://`/`git+`/`git:`/`file:`，`https://evil/…` 能穿过
 *  「lockfile 含非允许来源」门禁；且它在 `!lock.includes(integrity)` 成立时根本不会执行。
 *  现在改为「任何 URL 形式的来源都必须命中白名单」，https 与 http 一视同仁。 */
const ALLOWED_LOCKFILE_SOURCE_URLS: readonly RegExp[] = [
  /^https?:\/\/(?:registry\.npmjs\.org|registry\.npmmirror\.com|registry\.npmirror\.com)\//,
]

/** 逐条校验 lockfile 里出现的来源（tarball 直链、git、本地路径）。命中白名单外一律抛错。 */
export function assertLockfileSourcesAllowed(lock: string): void {
  const offenders: string[] = []
  const reject = (value: string): void => {
    const normalized = value.replace(/["']+$/, '')
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) || /^git\+/i.test(normalized) || /^file:/i.test(normalized)) {
      if (!ALLOWED_LOCKFILE_SOURCE_URLS.some(rx => rx.test(normalized))) offenders.push(normalized)
      return
    }
    // 形如 `file:../x`、`link:../x` 的本地来源没有 `//`，单独拦。
    if (/^(?:file|link):/i.test(normalized)) offenders.push(normalized)
    // scp 风格 git（git@host:path）没有协议头。
    if (/^(?:git@|ssh:\/\/)/i.test(normalized)) offenders.push(normalized)
  }
  for (const line of lock.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const tarball = /^tarball:\s*(\S+)\s*$/i.exec(trimmed)
    if (tarball) { reject(tarball[1]); continue }
    const resolution = /^resolution:\s*(\S+)\s*$/i.exec(trimmed)
    if (resolution) { reject(resolution[1]); continue }
    const spec = /^specifier:\s*(\S+)\s*$/i.exec(trimmed)
    if (spec) { reject(spec[1]) }
  }
  if (offenders.length > 0) {
    throw new Error(`候选 DSH lockfile 包含非允许来源：${[...new Set(offenders)].slice(0, 3).join('、')}`)
  }
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
  let moved = false
  try {
    writeOfficialRuntimeManifest(stagingDir, options.version)
    await writeFile(
      join(stagingDir, 'pnpm-workspace.yaml'),
      pnpmWorkspaceYaml(true, OFFICIAL_RUNTIME_RESOLUTION_POLICY),
      'utf8',
    )
    const args = officialRuntimeInstallArgs(stagingDir, options.storeDir)
    await (options.runner ?? ((commandArgs, cwd) => runPnpm(options.nodeExecutable, options.pnpmEntry, commandArgs, cwd, options.timeoutMs)))(args, stagingDir)
    await prepareRuntimePnpmLayout(stagingDir)
    const validation = await validateHarnessRuntimeCandidate(stagingDir, options.version, options.expectedNpmIntegrity)
    await writeFile(join(stagingDir, '.dsh-runtime-fingerprint'), `${validation.fingerprint}\n`, 'utf8')
    const destination = runtimeSlotDirectory(options.legacyRuntimeDir, options.version, validation.fingerprint)
    if (existsSync(destination)) {
      // 复用分支必须比对**槽内真实指纹**（`.dsh-runtime-fingerprint`），而不能再对目标重算一遍。
      // 重算只能证明「目标自洽」，无法证明「目标就是我们要的那个槽」；指纹标记缺失/被改写时
      // 那种做法会静默复用一个来历不明的槽。
      const markerPath = join(destination, '.dsh-runtime-fingerprint')
      const recorded = existsSync(markerPath) ? (await readFile(markerPath, 'utf8')).trim().toLowerCase() : ''
      if (recorded !== validation.fingerprint.toLowerCase()) {
        throw new Error(`同名 DSH 运行时槽的槽内指纹与候选不一致（槽内 ${recorded || '<缺失>'}）。`)
      }
      const existing = await validateHarnessRuntimeCandidate(destination, options.version, options.expectedNpmIntegrity)
      await verifyRuntimePnpmLayout(destination)
      if (existing.fingerprint !== validation.fingerprint) throw new Error('同名 DSH 运行时槽与候选指纹不一致。')
      return { directory: destination, version: options.version, fingerprint: validation.fingerprint, reused: true, packageCount: validation.packageCount }
    }
    await rename(stagingDir, destination)
    moved = true
    return { directory: destination, version: options.version, fingerprint: validation.fingerprint, reused: false, packageCount: validation.packageCount }
  } finally {
    // rename 成功后 stagingDir 已不存在；只有失败/复用分支才需要清理残留。
    if (!moved) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
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
  assertLockfileSourcesAllowed(lock)

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
    // Do not reuse a pre-fix immutable slot with the same package lock.
    .update('dsh-runtime-pnpm-layout-v2\0')
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
    // pnpm 12 拒绝 --cache-dir（2026-09-28 实测：候选装配首次走到此路径即报
    // "unexpected argument '--cache-dir'"）。与 plugin-seed/desktop-host 的进程边界
    // 一样，在此翻译为 PNPM_CONFIG_CACHE_DIR 环境变量。
    const invocation = preparePnpmInvocation(args)
    const child = spawn(nodeExecutable, [pnpmEntry, ...invocation.args], {
      cwd,
      env: {
        ...invocation.env,
        CI: 'true',
        npm_config_registry: 'https://registry.npmjs.org/',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    let timeoutError: Error | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error === undefined) resolvePromise()
      else reject(error)
    }
    const timeout = setTimeout(() => {
      timeoutError = new Error('候选 DSH 运行时装配超时，已终止子进程。')
      // 失败返回前先等进程树退出，避免调用方立即清理 staging 目录时撞上仍被占用的文件。
      void terminateProcessTree(child).then(
        () => finish(timeoutError),
        () => finish(timeoutError),
      )
    }, timeoutMs)
    timeout.unref?.()
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-12_000) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => finish(new Error('无法启动随包 pnpm 装配候选运行时。')))
    child.once('exit', code => {
      if (timeoutError !== undefined) return finish(timeoutError)
      if (code === 0) return finish()
      finish(new Error(pnpmFailureDetail(output, code)))
    })
  })
}

/** pnpm 的失败原因必须能被自动升级的失败记录如实承载。
 *
 * 2026-09-30 实测踩过的坑：调用方只保留 detail 前 200 字符，而 pnpm 的输出尾部常以
 * `[WARN] The "pnpm" field in package.json is no longer read by pnpm...` 收尾 ——
 * 真正的 `ERR_PNPM_NO_MATURE_MATCHING_VERSION` 被截断吃掉，于是
 * state.json / update-events.jsonl 里整整两天的失败原因都记着那行与故障无关的 WARN，
 * 自动升级的退避闸门还据此判成「已重试 2 次」，排查只能靠手工绕过记录层重跑一遍。
 *
 * 所以这里按「像错误」筛行：pnpm 的错误码行、`Error:`/`error:` 前缀行优先，
 * 找不到再退回第一条非 WARN 行。全都没有才用整段尾巴。 */
export function pnpmFailureDetail(output: string, code?: number | null): string {
  const fallback = `候选 DSH 运行时装配失败（退出码 ${code ?? '未知'}）。`
  const normalized = output.replace(/\s+/g, ' ').trim()
  if (normalized === '') return fallback
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const isWarning = (line: string): boolean => /^\[?(?:WARN|WARNING)\b/i.test(line)
  const isErrorish = (line: string): boolean =>
    /ERR_PNPM_|\b(?:Error|ERROR)\b\s*:/.test(line) && !isWarning(line)
  const picked = lines.find(isErrorish) ?? lines.find(line => !isWarning(line))
  const detail = (picked ?? normalized).replace(/\s+/g, ' ').trim()
  return detail === '' ? fallback : detail
}
