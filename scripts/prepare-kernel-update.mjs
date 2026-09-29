#!/usr/bin/env node
// 内核更新配套工具：让"单独拉取内核更新"成为独立动作。
// 应用内点「检查更新」完成下载/影子验证/激活后，本工具补齐三件配套：
//   ① 新版本的家团代际（--source-home 取最新代际，防回落旧数据家园）
//   ② 豁免清单迁移（compatibility.json 的授权全部改命名新内核版本）
//   ③ awareness peer 放宽 + 经正规安装器装入新代际 profile
// 只做加法、可重入：已有绑定的版本自动跳过；默认只报告，--apply 才落盘。
// 用法：
//   Tools/node/node.exe scripts/prepare-kernel-update.mjs [--root <便携根>] [--apply]
// 退出码：0 = 无事可做/成功；3 = 有待办（报告模式）；1 = 执行失败。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : join(scriptDir, '..'))
const apply = process.argv.includes('--apply')

const homesDir = join(root, 'Data', 'Updates', 'Harness', 'homes')
const slotsDir = join(root, 'Data', 'Runtime', 'Harness', 'slots')
const awarenessPkgPath = join(root, 'plugins', 'dsh-system-awareness', 'package.json')

const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
const log = m => console.log(m)

// ---- 1. 扫描槽位（名字形如 <version>-<16位hash>，*.quarantined/.incomplete 天然不匹配）----
const slots = []
if (existsSync(slotsDir)) {
  for (const name of readdirSync(slotsDir, { withFileTypes: true })) {
    const m = name.name.match(/^(.+)-([0-9a-f]{16})$/)
    if (m && existsSync(join(slotsDir, name.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
      slots.push({ dir: join(slotsDir, name.name), version: m[1] })
    }
  }
}

// ---- 2. 活动版本 + 最新代际（按 receipt startedAt 取最新，回落 legacy Data/DSH）----
let activeVersion
const pointerPath = join(root, 'Data', 'Runtime', 'Harness', 'current.json')
if (existsSync(pointerPath)) {
  try { activeVersion = readJson(pointerPath).current?.version } catch { /* 指针损坏按无活动版本处理 */ }
}
let sourceHome = join(root, 'Data', 'DSH'), sourceLabel = 'legacy Data/DSH'
if (existsSync(homesDir)) {
  let best = null
  for (const f of readdirSync(homesDir)) {
    if (!f.endsWith('.json')) continue
    try {
      const binding = readJson(join(homesDir, f))
      const receipt = join(root, 'Data', 'DSH-generations', binding.generation, 'receipt.json')
      const startedAt = existsSync(receipt) ? readJson(receipt).startedAt : ''
      if (binding.schema === 1 && (!best || startedAt > best.startedAt)) best = { startedAt, home: join(root, 'Data', 'DSH-generations', binding.generation, 'home') }
    } catch { /* 跳过损坏条目 */ }
  }
  if (best) { sourceHome = best.home; sourceLabel = `最新代际 ${best.home}` }
}

// ---- 3. 计算待办 ----
const pending = []
for (const slot of slots) {
  if (existsSync(join(homesDir, `${slot.version}.json`))) continue
  pending.push({ ...slot, generation: 'auto-' + slot.version.replace(/\./g, '') })
}

// awareness peer 覆盖检查（对活动版本；新版本待建完代际后同样适用）
let peerCovered = true, peerValue = ''
if (existsSync(awarenessPkgPath)) {
  peerValue = readJson(awarenessPkgPath).peerDependencies?.['@deepseek-ai/dsh-tools'] ?? ''
  if (activeVersion) peerCovered = peerValue.split('||').map(s => s.trim()).includes(activeVersion)
}

log(`[内核更新配套] root = ${root}`)
log(`  槽位 ${slots.length} 个；活动版本 = ${activeVersion ?? '未知'}；家园源 = ${sourceLabel}`)
for (const p of pending) log(`  待配套: ${p.version}${p.version === activeVersion ? '（活动版本缺绑定——属回退态，配套后重启即可恢复）' : ''} ← ${p.dir}`)
if (activeVersion && !peerCovered) log(`  待配套: awareness peer 未覆盖活动版本 ${activeVersion}（当前: ${peerValue}）`)
if (!pending.length && peerCovered) {
  log('  无事可做：所有已装内核版本都有家园绑定，awareness peer 覆盖正常。')
  log('  提醒：更新双通道已锁 manual（用户规则），拉取请在应用内手动点「检查更新」。')
  process.exit(0)
}
if (!apply) {
  log('以上为计划；加 --apply 执行（建代际约 10–20 分钟，G: 盘大拷贝）。')
  process.exit(3)
}

// ---- 4. 执行 ----
const run = (file, args) => {
  log(`\n$ node ${file} ${args.join(' ')}`)
  const r = spawnSync(process.execPath, [join(scriptDir, file), ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${file} 退出码 ${r.status}`)
}

const widenAwarenessPeer = version => {
  if (!existsSync(awarenessPkgPath)) return
  const pkg = readJson(awarenessPkgPath)
  const key = '@deepseek-ai/dsh-tools'
  const current = pkg.peerDependencies?.[key] ?? ''
  if (current.split('||').map(s => s.trim()).includes(version)) return
  copyFileSync(awarenessPkgPath, `${awarenessPkgPath}.bak-peer-${version}`)
  pkg.peerDependencies[key] = `${current} || ${version}`
  writeFileSync(awarenessPkgPath, JSON.stringify(pkg, null, 2) + '\n')
  log(`[peer] awareness peer 放宽 → ${pkg.peerDependencies[key]}（备份 .bak-peer-${version}；请复跑全量测试）`)
}

try {
  for (const p of pending) {
    log(`\n===== 配套 ${p.version} =====`)
    run('prepare-dsh-home-generation.mjs', ['--root', root, '--generation', p.generation,
      '--runtime-version', p.version, '--runtime-source', p.dir, '--source-home', sourceHome])

    // 豁免迁移：源家园的授权整体改命名新版本（插件包随家园拷贝、版本不变，键保持 pkg@ver）
    const sourceCompat = join(sourceHome, 'profiles', 'web', 'compatibility.json')
    const newProfile = join(root, 'Data', 'DSH-generations', p.generation, 'home', 'profiles', 'web')
    if (existsSync(sourceCompat)) {
      const grants = {}
      for (const [key, versions] of Object.entries(readJson(sourceCompat))) {
        if (Array.isArray(versions) && versions.length) grants[key] = [p.version]
      }
      const tmp = `${newProfile}/compatibility.json.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(grants, null, 2) + '\n')
      renameSync(tmp, join(newProfile, 'compatibility.json'))
      log(`[exempt] 豁免迁移 ${Object.keys(grants).length} 条 → 命名 ${p.version}`)
    }

    widenAwarenessPeer(p.version)
    run('install-dsh-awareness-manual.mjs', ['--install', '--root', root, '--profile', newProfile])
  }
  if (activeVersion && !peerCovered) widenAwarenessPeer(activeVersion)

  log('\n===== 完成。下一步 =====')
  log('  1) 若新版本尚未在应用内激活：设置页点「检查更新」走完激活。')
  log('  2) 重启 DSH（托盘退出或「重启应用」）。')
  log(`  3) 可选验证：Tools/node/node.exe scripts/probe-runtime-boot.mjs --generation <代号>（就绪应 <30s）。`)
  log('  4) 重启后跑一键体检：Tools/node/node.exe scripts/check-open-behavior.mjs。')
  process.exit(0)
} catch (error) {
  log(`[失败] ${error.message}`)
  log('已完成的绑定/代际保留（可重入，重跑会跳过）；中断的代际目录见 *.incomplete-*。')
  process.exit(1)
}
