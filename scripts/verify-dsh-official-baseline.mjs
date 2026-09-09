import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = resolve(root, 'docs/03-技术架构/DeepSeek-Harness-官方兼容基线.json')
const desktopManifestPath = resolve(root, 'package.json')
const installedManifestPath = resolve(root, 'Data/Runtime/dsh-runtime/node_modules/@deepseek-ai/dsh/package.json')
const online = process.argv.includes('--online')

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
if (existsSync(installedManifestPath)) {
  const installedVersion = readJson(installedManifestPath).version
  if (installedVersion !== bundledVersion) {
    fail(`实际运行时 ${installedVersion} 与桌面清单 ${bundledVersion} 不一致。`)
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
      signal: AbortSignal.timeout(15_000),
    })
    if (!commitResponse.ok) throw new Error(`GitHub API HTTP ${commitResponse.status}`)
    const currentCommit = (await commitResponse.json()).sha
    if (currentCommit !== baseline.official.commit) {
      fail(`官方 HEAD 已变化：基线 ${baseline.official.commit}，当前 ${currentCommit}。先人工审阅官方规范并更新基线。`)
    }
    if (!process.exitCode) {
      const manifestResponse = await fetch(`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${currentCommit}/apps/cli/package.json`, {
        headers: { 'User-Agent': headers['User-Agent'] },
        signal: AbortSignal.timeout(15_000),
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
