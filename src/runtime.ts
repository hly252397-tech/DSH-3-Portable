import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { isOfficialRuntimeLaunchable, resolveProfileDshEntry, resolveWebProfileDir } from './plugin-seed.js'
import { fileSha256, verifyFileSha256 } from './runtime-archive.js'

export interface DshRuntime {
  root: string
  entry: string
  workingDirectory?: string
}

interface RuntimeResolutionOptions {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
  profileDir?: string
  desktopRuntimeDir?: string
}

/** 官方运行时走桌面独立目录，避免官方包出现在 Web profile 插件列表。 */
export function resolveDshRuntime(options: RuntimeResolutionOptions): DshRuntime {
  const profileDir = options.profileDir ?? resolveWebProfileDir()
  const desktopDir = options.desktopRuntimeDir
  if (desktopDir !== undefined && isOfficialRuntimeLaunchable(desktopDir)) {
    return { root: desktopDir, entry: resolveProfileDshEntry(desktopDir), workingDirectory: homedir() }
  }
  if (isOfficialRuntimeLaunchable(profileDir)) {
    return { root: profileDir, entry: resolveProfileDshEntry(profileDir), workingDirectory: homedir() }
  }

  const candidates = [
    process.env.DSH_RUNTIME_ROOT,
    options.isPackaged ? join(options.resourcesPath, 'dsh') : undefined,
    options.isPackaged ? undefined : resolve(options.appPath, '..', 'deepseek-harness'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const root of candidates) {
    for (const entry of [
      join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(root, 'apps', 'cli', 'lib', 'bin.js'),
      join(root, 'lib', 'bin.js'),
    ]) {
      if (existsSync(entry)) return { root, entry, workingDirectory: root }
    }
  }

  throw new Error('未找到 DSH 运行时。请先完成桌面端补种，或设置 DSH_RUNTIME_ROOT。')
}

/** 开发态使用 PATH 中的 Node，安装包优先使用随包 Node。 */
export function resolveNodeExecutable(options: {
  isPackaged: boolean
  resourcesPath: string
  /** 应用根（打包态为 asar/解包目录，开发态为仓库根）。用于定位该应用**自己的** package.json。 */
  appPath?: string
}): string {
  const bundledNode = join(options.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  if (options.isPackaged) {
    if (existsSync(bundledNode)) {
      verifyFileSha256(bundledNode)
      verifyBundledNodeAgainstManifest(bundledNode, options)
      return bundledNode
    }
    throw new Error(`未找到随包 Node：${bundledNode}`)
  }

  if (process.env.DSH_NODE_EXECUTABLE) return process.env.DSH_NODE_EXECUTABLE

  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/**
 * 用**该应用自己**的 `package.json` → `config.bundledNodeSha256` 对随包 Node 再做一次交叉校验。
 *
 * 历史缺陷（2026-09-26 由 Codex 独立复核发现）：`verifyFileSha256` 只比对与目标**同目录**的
 * `<node>.sha256`，而该旁置文件由 `scripts/prepare-runtime.ts` 从**同一个二进制**生成
 * ⇒ 「自洽的副本」永远能通过校验，全程不看清单里的权威哈希。旁置文件与目标同源，
 * 所以它**只能发现损坏，不能发现错版**。
 *
 * 判据取**应用自己的清单**而非仓库根清单：一个旧的（但完整的）构建树是合法的
 * ——工作区 `App/` 实测就是 `1.0.43` 的整棵快照，其 node 与自身清单一致；
 * 若拿它去比仓库根的当前版本，会把"旧而自洽"误判成"坏"，让 legacy 回退路径无法启动。
 * 本校验要防的是「**同一次构建内部** node 与清单不一致」。
 *
 * 语义：清单可得且不符 ⇒ 拒绝（fail-closed，与旁置校验一致）；
 * 清单不可得（布局陌生 / asar 读不到）⇒ 只告警不阻断，避免因"读不到清单"而 Brick 启动。
 */
export function verifyBundledNodeAgainstManifest(
  nodePath: string,
  options: { isPackaged: boolean; resourcesPath: string; appPath?: string },
): void {
  const expected = readManifestBundledNodeSha256(options)
  if (expected === undefined) {
    console.warn('[runtime] 未能定位应用自身的 package.json，跳过随包 Node 的清单交叉校验。')
    return
  }
  const actual = fileSha256(nodePath)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `随包 Node 与本次构建的清单不一致：${nodePath}\n  实际 SHA256 = ${actual}\n  清单 SHA256 = ${expected}\n`
      + '旁置的 .sha256 由同一个二进制生成，因此它只能发现损坏、发现不了错版；'
      + '这条不一致说明该文件与它所在构建不是同一批产物。请用完整构建重新装配，不要就地替换。',
    )
  }
}

/** 按平台-架构取**应用自身**清单里的随包 Node 哈希；定位不到时返回 undefined。 */
function readManifestBundledNodeSha256(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath?: string
}): string | undefined {
  const candidates = [
    join(options.resourcesPath, 'app', 'package.json'), // 解包后的打包布局（实测部署槽即为该形态）
    options.appPath === undefined ? undefined : join(options.appPath, 'package.json'), // asar / 开发态
    join(options.resourcesPath, 'app.asar', 'package.json'), // asar 直读（Electron 的 fs 可透明读取）
  ].filter((candidate): candidate is string => typeof candidate === 'string')

  const target = `${process.platform}-${process.arch}`
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as {
        config?: { bundledNodeSha256?: Record<string, unknown> }
      }
      const value = manifest.config?.bundledNodeSha256?.[target]
      if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) return value
    } catch {
      // 该候选不可读或不是清单：继续尝试下一个。
    }
  }
  return undefined
}

/** 查找控制 DSH 优雅关闭的 Node 引导脚本。 */
export function resolveDshBootstrap(options: RuntimeResolutionOptions): string {
  const bootstrap = options.isPackaged
    ? join(options.resourcesPath, 'bootstrap.mjs')
    : resolve(options.appPath, 'dist', 'src', 'dsh-bootstrap.mjs')
  if (existsSync(bootstrap)) return bootstrap
  throw new Error(`未找到 DSH 启动引导脚本：${bootstrap}`)
}
