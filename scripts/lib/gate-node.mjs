/**
 * 门禁 Node 解析器 —— 门禁必须跑在**与清单一致**的 Node 上。
 *
 * 背景（2026-09-26 实测 + Codex 独立复核，登记册 R-170）：
 * `AGENTS.md` 与多个门禁脚本长期硬编码 `App/resources/node/node.exe`。而该目录是**工作区里
 * 一棵 1.0.43 旧构建树的快照**：它的 `resources/app.asar` 自述 `bundledNodeVersion=v24.20.0`，
 * 其 `node.exe` 的旁置 `.sha256` 也正好等于 `5C976096…` —— 子树**内部完全自洽**，但版本是
 * v24.20.0；而当前 `package.json`、`Tools/node`、`runtime-node`、两个部署槽全部是 v24.21.0。
 *
 * 后果（危险的是"静默"那一半）：
 *   · 门禁在 v24.20.0 上通过，产品实际跑 v24.21.0 ⇒ **绿灯不覆盖真实发行运行时**；
 *   · `scripts/prepare-runtime.ts:167` 的版本守卫在该 Node 上**必然抛错**；
 *   · 旁置 `.sha256` 由同一个二进制生成，因此**只能发现损坏，发现不了错版**。
 *
 * 解析顺序：`Tools/node`（`Build-DSH-Portable.ps1` 用清单哈希校验并自愈的目标）
 * → `App/resources/node` → 取第一个 SHA256 命中清单的。
 * CI/新检出也校验 process.execPath。全部不命中或清单无效时拒绝运行，不能降级为未校验门禁。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const platformTarget = `${process.platform}-${process.arch}`
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'

function manifestBundledNodeSha256() {
  try {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    const value = manifest?.config?.bundledNodeSha256?.[platformTarget]
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function fileSha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

function resolveGateNode() {
  const expected = manifestBundledNodeSha256()
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).config?.bundledNodeVersion
  const candidates = [
    ...(typeof version === 'string' && /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
      ? [join(REPO_ROOT, 'Tools', `node-${version}`, nodeName)] : []),
    join(REPO_ROOT, 'Tools', 'node', nodeName),
    join(REPO_ROOT, 'App', 'resources', 'node', nodeName),
    process.execPath,
  ].filter((candidate) => existsSync(candidate))

  if (expected === undefined) {
    throw new Error(`[gate-node] package.json 缺少有效 config.bundledNodeSha256['${platformTarget}']，拒绝未校验的门禁 Node。`)
  }
  for (const candidate of candidates) {
    if (fileSha256(candidate) === expected) return candidate
  }
  throw new Error(
    '[gate-node] 候选项均与清单不一致，拒绝未校验的门禁 Node。\n'
    + candidates.map((candidate) => `  · ${candidate} → ${fileSha256(candidate) ?? '<不可读>'}`).join('\n')
    + `\n  期望 ${expected}`,
  )
}

/** 与清单一致的 Node 可执行文件路径。 */
export const GATE_NODE = resolveGateNode()
