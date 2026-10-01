#!/usr/bin/env node
// 独立家园初始化器：为指定运行时版本创建 DSH-generations 代际副本并写 homes 绑定。
// 设计约束（对应 src/portable-paths.ts 的读取侧校验）：
//   - 绑定文件是"生效开关"，最后原子写；此前任何失败都只留下 .incomplete 目录，
//     启动路径查无绑定即走默认布局，绝不会引用半成品家园。
//   - 家园内链接按目标分类重建：官方层 → 新家园自带运行时（包缺失则跳过并记录，交新版启动
//     自愈摘除对应清单条目，符合上游 1.0.72-1.0.76 的升级语义）；家园内部 → 新家园同构路径；
//     其余目标一律记入 skipped 留档，绝不把指向家园外部的链接复制进新家园。
// 用法：
//   node scripts/prepare-dsh-home-generation.mjs --root <便携根> --generation <代号>
//     --runtime-version <版本> --runtime-source <已安装运行时目录>
//     [--source-home <源家园目录，默认 Data/DSH>] [--dry-run]

import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function parseArgs(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`)
    if (token === '--dry-run') { values.dryRun = true; continue }
    const name = token.slice(2)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${token} 缺少值。`)
    values[name] = value
  }
  for (const required of ['root', 'generation', 'runtime-version', 'runtime-source']) {
    if (!values[required]) throw new Error(`缺少必填参数 --${required}。`)
  }
  return values
}

function resolveInside(prefix, candidate) {
  const resolved = resolve(candidate)
  const child = relative(resolve(prefix), resolved)
  return child === '' || child.startsWith(`..${sep}`) || isAbsolute(child) ? undefined : resolved
}

function assertRuntimeSource(runtimeSource, runtimeVersion) {
  const manifestPath = join(runtimeSource, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const entryPath = join(runtimeSource, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(manifestPath) || !existsSync(entryPath)) {
    throw new Error(`运行时源不完整，缺少官方入口：${runtimeSource}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== runtimeVersion) {
    throw new Error(`运行时源版本 ${manifest.version}@${manifest.name} 与 --runtime-version ${runtimeVersion} 不一致。`)
  }
}

/** 旧家园官方层链接的槽前缀：Data/Runtime/Harness/slots/<slot>/node_modules */
function officialSlotPrefixes(root) {
  const prefixes = []
  const harnessSlots = join(root, 'Data', 'Runtime', 'Harness', 'slots')
  if (existsSync(harnessSlots)) {
    for (const slot of readdirSync(harnessSlots)) {
      const prefix = join(harnessSlots, slot, 'node_modules') + sep
      if (existsSync(dirname(prefix))) prefixes.push(prefix)
    }
  }
  // 历史布局与打包产物槽：老 profile 的官方层链接可能指向其中任何一个时代的位置。
  for (const legacy of [
    join(root, 'Data', 'Runtime', 'dsh-runtime', 'node_modules') + sep,
    join(root, 'release', 'win-unpacked', 'dsh-runtime', 'node_modules') + sep,
  ]) {
    if (existsSync(dirname(legacy))) prefixes.push(legacy)
  }
  return prefixes
}

function classifyLink(linkPath, target, home, officialPrefixes) {
  const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(dirname(linkPath), target)
  for (const prefix of officialPrefixes) {
    if (absoluteTarget.startsWith(prefix)) {
      return { kind: 'official', packageTail: absoluteTarget.slice(prefix.length) }
    }
  }
  const insideHome = resolveInside(home, absoluteTarget)
  if (insideHome !== undefined) return { kind: 'internal', relativeTail: relative(home, absoluteTarget) }
  // 历史槽可能已被按"只留 current+previous"的规则清理，链接目标的前缀不复存在；
  // 此时按目标里最后一个 node_modules 段提取包尾路径，交由"新运行时是否存在该包"决定重建或跳过。
  const nodeModulesIndex = absoluteTarget.toLowerCase().lastIndexOf(`${sep}node_modules${sep}`)
  if (nodeModulesIndex !== -1) {
    return { kind: 'official-legacy', packageTail: absoluteTarget.slice(nodeModulesIndex + `${sep}node_modules${sep}`.length) }
  }
  return { kind: 'unknown', absoluteTarget }
}

function countTree(root) {
  let files = 0
  let bytes = 0
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      const info = statSync(path)
      if (info.isDirectory()) walk(path)
      else { files += 1; bytes += info.size }
    }
  }
  if (existsSync(root)) walk(root)
  return { files, bytes }
}

function copyHomeTree(sourceHome, destinationHome, officialPrefixes, stats) {
  const copy = (directory, destinationDirectory) => {
    mkdirSync(destinationDirectory, { recursive: true })
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = join(directory, entry.name)
      const destinationPath = join(destinationDirectory, entry.name)
      if (entry.isSymbolicLink()) {
        const classification = classifyLink(sourcePath, readlinkSync(sourcePath), sourceHome, officialPrefixes)
        if (classification.kind.startsWith('official')) {
          const newTarget = join(destinationHome, '..', 'runtime', 'dsh-runtime', 'node_modules', classification.packageTail)
          if (!existsSync(newTarget)) {
            // 新运行时依赖树里没有该包（rc.2 官方移除/更名）：不重建链接，交新版启动自愈
            //（pruneMissingProfileBundles/隔离机制）摘除对应清单条目——这正是上游 1.0.72-1.0.76 的升级语义。
            stats.skipped.push(`${sourcePath} -> ${classification.packageTail}（新运行时缺失）`)
            continue
          }
          symlinkSync(newTarget, destinationPath, 'junction')
          stats.official += 1
        } else if (classification.kind === 'internal') {
          symlinkSync(join(destinationHome, classification.relativeTail), destinationPath, 'junction')
          stats.internal += 1
        } else {
          stats.skipped.push(`${sourcePath} -> ${classification.absoluteTarget}（非家园/运行时目标）`)
        }
        continue
      }
      if (entry.isDirectory()) { copy(sourcePath, destinationPath); continue }
      copyFileSync(sourcePath, destinationPath)
      stats.files += 1
      stats.bytes += statSync(sourcePath).size
    }
  }
  copy(sourceHome, destinationHome)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = resolve(args.root)
  const runtimeVersion = args['runtime-version']
  if (!VERSION_PATTERN.test(runtimeVersion)) throw new Error(`运行时版本格式无效：${runtimeVersion}`)
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(args.generation)) throw new Error(`家园代号格式无效：${args.generation}`)
  const generationRoot = join(root, 'Data', 'DSH-generations', args.generation)
  // 源家园默认为 legacy Data/DSH；运行时已绑到更新的代际家园时，应显式传 --source-home
  // 指向那一代的 home（否则新代际会带着旧数据倒退）。源必须在便携根 Data 内，防止误指外部树。
  const sourceHome = args['source-home'] ? resolve(args['source-home']) : join(root, 'Data', 'DSH')
  if (resolveInside(join(root, 'Data'), sourceHome) === undefined) {
    throw new Error(`--source-home 必须位于便携根 Data 目录内：${sourceHome}`)
  }
  const runtimeSource = resolve(args['runtime-source'])
  const homesDir = join(root, 'Data', 'Updates', 'Harness', 'homes')
  const bindingPath = join(homesDir, `${runtimeVersion}.json`)

  if (!existsSync(sourceHome)) throw new Error(`旧家园不存在：${sourceHome}`)
  if (existsSync(generationRoot)) throw new Error(`家园代号已存在，拒绝覆盖：${generationRoot}`)
  if (existsSync(bindingPath)) throw new Error(`绑定文件已存在，拒绝覆盖：${bindingPath}；如需重建请先人工移除。`)
  assertRuntimeSource(runtimeSource, runtimeVersion)

  const officialPrefixes = officialSlotPrefixes(root)
  if (args.dryRun) {
    const stats = { files: 0, bytes: 0, official: 0, internal: 0, skipped: [] }
    copyHomeTreeDryRun(sourceHome, officialPrefixes, stats, runtimeSource)
    console.log(JSON.stringify({ dryRun: true, generationRoot, bindingPath, officialPrefixes: officialPrefixes.length, ...stats }, null, 2))
    if (stats.skipped.length > 0) {
      console.warn(`预检跳过 ${stats.skipped.length} 条链接（新运行时缺失或非家园目标），对应清单条目由新版启动自愈摘除。`)
    }
    return
  }

  const destinationRuntime = join(generationRoot, 'runtime', 'dsh-runtime')
  const destinationHome = join(generationRoot, 'home')
  mkdirSync(dirname(destinationRuntime), { recursive: true })
  try {
    cpSync(runtimeSource, destinationRuntime, { recursive: true, dereference: true })
    const stats = { files: 0, bytes: 0, official: 0, internal: 0, skipped: [] }
    copyHomeTree(sourceHome, destinationHome, officialPrefixes, stats)
    if (stats.skipped.length > 0) {
      console.warn(`家园复制跳过 ${stats.skipped.length} 条链接，记录于 receipt 供复查。`)
    }
    // 社区包补丁必须在写绑定开关之前落到新家园：绑定一旦落盘就是"生效开关"，而 codex-ui 的
    // 「插件配置」分区补丁属 npm 就地补丁，会被下一次 profile 依赖物化覆盖成未打补丁的原始包
    // （2026-09-28 修过、2026-09-30 建 auto-020-rc2 时原样复发，副本 nlink=2 硬链到 pnpm store）。
    // 这里失败即走下方 catch：撤绑定 + 隔离整个代际目录，绝不留下补丁缺失的生效家园。
    const codexUiPatches = await import(new URL('../customizations/codex-ui-patches/apply.mjs', import.meta.url).href)
    const patchReport = codexUiPatches.run(root, false)
    if (!patchReport.ok) {
      const broken = patchReport.files.filter((item) => item.status === 'drift' || item.status === 'missing')
        .map((item) => `${item.status} ${item.file}${item.detail ? '\n' + item.detail : ''}`).join('\n')
      throw new Error(`codex-ui 社区包补丁未能落到全部家园，拒绝写出绑定开关。\n${broken}`)
    }
    console.warn(`已对 ${patchReport.files.length} 份家园副本应用/校验 codex-ui 补丁。`)
    mkdirSync(homesDir, { recursive: true })
    const binding = { schema: 1, runtimeVersion, generation: args.generation }
    const temporaryBinding = `${bindingPath}.tmp-${process.pid}`
    writeFileSync(temporaryBinding, JSON.stringify(binding, null, 2), 'utf8')
    renameSync(temporaryBinding, bindingPath)

    // 读取侧闭环校验：绑定必须能被启动路径接受；失败则撤绑定，绝不留下指向坏家园的生效开关。
    const portableModuleUrl = new URL('../dist/src/portable-paths.js', import.meta.url)
    let resolved
    try {
      resolved = await import(portableModuleUrl.href)
    } catch (error) {
      throw new Error('无法加载 dist/src/portable-paths.js，请先完成 tsc 构建再初始化家园。', { cause: error })
    }
    try {
      const paths = resolved.resolvePortablePaths(root, process.execPath, runtimeVersion)
      if (paths?.dshHome !== destinationHome || paths?.runtime !== destinationRuntime) {
        throw new Error(`绑定校验未命中家园：dshHome=${paths?.dshHome} runtime=${paths?.runtime}`)
      }
    } catch (error) {
      rmSync(bindingPath, { force: true })
      throw error
    }

    const runtimeStats = countTree(destinationRuntime)
    const receipt = {
      schema: 1,
      generation: args.generation,
      runtimeVersion,
      sourceHome,
      sourceRuntime: runtimeSource,
      home: destinationHome,
      runtime: destinationRuntime,
      homeFiles: stats.files,
      homeBytes: stats.bytes,
      runtimeFiles: runtimeStats.files,
      runtimeBytes: runtimeStats.bytes,
      relinks: { official: stats.official, internal: stats.internal, skipped: stats.skipped },
      communityPatches: { codexUi: { copies: patchReport.files.length, allApplied: patchReport.ok } },
      startedAt: new Date().toISOString(),
    }
    writeFileSync(join(generationRoot, 'receipt.json'), JSON.stringify(receipt, null, 2), 'utf8')
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    if (existsSync(bindingPath)) rmSync(bindingPath, { force: true })
    if (existsSync(generationRoot)) {
      const quarantine = `${generationRoot}.incomplete-${Date.now()}`
      try { renameSync(generationRoot, quarantine) } catch { /* 保留原目录供人工检查 */ }
    }
    throw error
  }
}

/** dry-run：只走分类与缺失检查，不复制不落盘。 */
function copyHomeTreeDryRun(sourceHome, officialPrefixes, stats, runtimeSource) {
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const classification = classifyLink(sourcePath, readlinkSync(sourcePath), sourceHome, officialPrefixes)
        if (classification.kind.startsWith('official')) {
          if (!existsSync(join(runtimeSource, 'node_modules', classification.packageTail))) {
            stats.skipped.push(`${sourcePath} -> ${classification.packageTail}（新运行时缺失）`)
          } else {
            stats.official += 1
          }
        } else if (classification.kind === 'internal') {
          stats.internal += 1
        } else {
          stats.skipped.push(`${sourcePath} -> ${classification.absoluteTarget}（非家园/运行时目标）`)
        }
        continue
      }
      if (entry.isDirectory()) { walk(sourcePath); continue }
      stats.files += 1
      stats.bytes += statSync(sourcePath).size
    }
  }
  walk(sourceHome)
}

await main()
