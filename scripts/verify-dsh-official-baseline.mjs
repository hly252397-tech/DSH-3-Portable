import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = resolve(root, 'docs/03-技术架构/DeepSeek-Harness-官方兼容基线.json')
const desktopManifestPath = resolve(root, 'package.json')
const installedManifestPath = resolve(root, 'Data/Runtime/dsh-runtime/node_modules/@deepseek-ai/dsh/package.json')
const desktopPointerPath = resolve(root, 'Data/Updates/Desktop/pointer.json')
const activeRuntimePointerPath = resolve(root, 'Data/Runtime/Harness/current.json')
const online = process.argv.includes('--online')
// 联网核对超时（2026-09-13 实测依据）：api.github.com 在本机存在间歇性卡顿——同一份脚本
// 连续 3 次以 15s 超时误报「无法核对官方 HEAD」，随后连跑 4 次全绿（单次请求仅 0.6~1.1s）。
// 15s 判定过紧，会把网络抖动误报成基线红灯；30s 仍能拦住真正不可达的官方源。
const onlineTimeoutMs = 30_000

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function fail(message) {
  console.error(`[official-spec] ${message}`)
  process.exitCode = 1
}

const baseline = readJson(baselinePath)
const desktopManifest = readJson(desktopManifestPath)
const bundledVersion = desktopManifest.config?.bundledDshVersion

if (!/^https:\/\/github\.com\/deepseek-ai\/deepseek-harness\.git$/.test(baseline.official?.repository ?? '')) {
  fail('官方仓库不在允许列表中。')
}
if (!/^https:\/\/deepseek-harness\.github\.io\/deepseek-harness\/$/.test(baseline.official?.documentation ?? '')) {
  fail('官方文档地址不在允许列表中。')
}
if (!/^[0-9a-f]{40}$/.test(baseline.official?.commit ?? '')) {
  fail('官方提交必须是完整的 40 位 SHA。')
}
if (baseline.bundled?.dshVersion !== bundledVersion) {
  fail(`基线内置版本 ${baseline.bundled?.dshVersion} 与 package.json ${bundledVersion} 不一致。`)
}

// 供给链真实证据：当前指针槽（或 App 回退目录）里打包的 dsh-runtime.tgz
// 必须与桌面清单声明一致。首启解压的 Data/Runtime/dsh-runtime 是历史回退目录，
// 在存在活动运行时槽时不参与启动、可能长期落后，因此只在无活动槽时强校验。
let packagedResourcesDir = resolve(root, 'App', 'resources')
try {
  const pointer = readJson(desktopPointerPath)
  const currentPath = pointer?.current?.relativePath
  if (typeof currentPath === 'string' && currentPath !== '' && !currentPath.includes('..')) {
    packagedResourcesDir = resolve(root, currentPath, 'resources')
  }
} catch {
  // 指针缺失或损坏时回退 App 目录。
}
const packagedRuntimeTgz = resolve(packagedResourcesDir, 'dsh-runtime.tgz')
// 与 src/runtime-archive.ts 相同的 GNU tar 探测：GNU tar 会把 `G:/...` 盘符路径当
// 远程主机（child connect 失败），需 --force-local；Windows 内置 bsdtar 不需要也不支持。
const tarProbe = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
const tarForceLocal = /gnu/i.test(String(tarProbe.stdout ?? '')) ? ['--force-local'] : []
if (existsSync(packagedRuntimeTgz)) {
  const listing = spawnSync('tar', [...tarForceLocal, '-tzf', packagedRuntimeTgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const member = listing.status === 0
    ? listing.stdout.split(/\r?\n/).find(name => name.endsWith('node_modules/@deepseek-ai/dsh/package.json'))
    : undefined
  if (member === undefined) {
    fail(`打包回退运行时 ${packagedRuntimeTgz} 缺少 @deepseek-ai/dsh（tar 退出码 ${listing.status}）。`)
  } else {
    const extracted = spawnSync('tar', [...tarForceLocal, '-xzOf', packagedRuntimeTgz, member], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    const packagedVersion = extracted.status === 0 ? (() => { try { return JSON.parse(extracted.stdout).version } catch { return undefined } })() : undefined
    if (packagedVersion === undefined) {
      fail(`无法读取打包回退运行时 ${packagedRuntimeTgz} 的版本（tar 退出码 ${extracted.status}）。`)
    } else if (packagedVersion !== bundledVersion) {
      fail(`打包回退运行时 ${packagedVersion} 与桌面清单 ${bundledVersion} 不一致。`)
    } else {
      console.log(`[official-spec] 打包回退运行时版本 ${packagedVersion} 与桌面清单一致。`)
    }
  }
} else {
  console.log(`[official-spec] 提示：未找到打包回退运行时（${packagedRuntimeTgz}），跳过打包一致性检查。`)
}
if (existsSync(installedManifestPath)) {
  const installedVersion = readJson(installedManifestPath).version
  if (installedVersion !== bundledVersion) {
    if (existsSync(activeRuntimePointerPath)) {
      console.log(`[official-spec] 提示：历史回退目录运行时 ${installedVersion} 落后于清单 ${bundledVersion}；存在活动运行时槽，回退目录不参与启动。`)
    } else {
      fail(`实际运行时 ${installedVersion} 与桌面清单 ${bundledVersion} 不一致。`)
    }
  }
}

if (online && !process.exitCode) {
  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DSH-Portable-Official-Spec-Gate',
    }
    const commitResponse = await fetch('https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master', {
      headers,
      signal: AbortSignal.timeout(onlineTimeoutMs),
    })
    if (!commitResponse.ok) throw new Error(`GitHub API HTTP ${commitResponse.status}`)
    const currentCommit = (await commitResponse.json()).sha
    if (currentCommit !== baseline.official.commit) {
      fail(`官方 HEAD 已变化：基线 ${baseline.official.commit}，当前 ${currentCommit}。先人工审阅官方规范并更新基线。`)
    }
    if (!process.exitCode) {
      const manifestResponse = await fetch(`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${currentCommit}/apps/cli/package.json`, {
        headers: { 'User-Agent': headers['User-Agent'] },
        signal: AbortSignal.timeout(onlineTimeoutMs),
      })
      if (!manifestResponse.ok) throw new Error(`GitHub Raw HTTP ${manifestResponse.status}`)
      const currentVersion = (await manifestResponse.json()).version
      if (currentVersion !== baseline.official.dshVersion) {
        fail(`官方 CLI 版本已变化：基线 ${baseline.official.dshVersion}，当前 ${currentVersion}。`)
      }
    }
  } catch (error) {
    fail(`无法核对官方 HEAD：${error instanceof Error ? error.message : String(error)}`)
  }
}

if (!process.exitCode) {
  console.log(`[official-spec] PASS bundled=${bundledVersion} upstream=${baseline.official.dshVersion}@${baseline.official.commit}${online ? ' online=verified' : ' online=skipped'}`)
}
