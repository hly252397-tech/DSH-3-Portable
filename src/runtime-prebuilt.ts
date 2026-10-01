import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

interface PrebuiltLookup {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
  exists?: (path: string) => boolean
}

/** 完成标记：只在"整棵复制成功"后写入。
 *  历史缺陷：旧实现用「入口文件存在」当完成判据 —— 复制中断后残缺运行时会被之后每次启动
 *  `skipped` 跳过，且 `cpSync(force:false)` 不会补全，坏槽因此永久留存。 */
export const PREBUILT_COMPLETE_MARKER = '.dsh-prebuilt-copied'

export function officialRuntimeEntry(dir: string): string {
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export function resolvePrebuiltOfficialRuntime(options: PrebuiltLookup): string | undefined {
  const exists = options.exists ?? existsSync
  const candidates = options.isPackaged
    ? [join(options.resourcesPath, 'dsh-runtime')]
    : [join(options.appPath, 'runtime-dsh')]
  return candidates.find((candidate) => exists(officialRuntimeEntry(candidate)))
}

/** 首启复制预装运行时，避免现场 pnpm add 整棵官方依赖。
 *
 *  返回语义：
 *   - `copied`  ：本次真实复制成功（**包括"目标残缺、已修复"**，调用方据此继续补种）
 *   - `skipped` ：目标已有**完成标记**且入口存在，可直接复用
 *   - `missing` ：源或目标不可用
 *
 *  复制流程：先复制到同卷暂存目录 → 校验入口 → 删掉残缺目标 → 改名就位 → 写完成标记。
 *  任何一步失败都不会留下"看着像完整"的目标。 */
export function copyPrebuiltOfficialRuntime(
  sourceDir: string,
  destDir: string,
  completeMarker: string = PREBUILT_COMPLETE_MARKER,
): 'copied' | 'skipped' | 'missing' {
  if (!existsSync(officialRuntimeEntry(sourceDir))) return 'missing'
  const markerPath = join(destDir, completeMarker)
  if (isCompleteCopy(sourceDir, destDir, markerPath)) return 'skipped'

  const stagingDir = `${destDir}.staging-${process.pid}`
  rmSync(stagingDir, { recursive: true, force: true })
  try {
    mkdirSync(stagingDir, { recursive: true })
    cpSync(sourceDir, stagingDir, { recursive: true, force: true })
    if (!existsSync(officialRuntimeEntry(stagingDir))) return 'missing'
    writeFileSync(join(stagingDir, completeMarker), `${canonicalPath(sourceDir)}\n`, 'utf8')
    // 只有确认暂存完整后才动目标：先删残缺目标，再同卷改名。
    rmSync(destDir, { recursive: true, force: true })
    mkdirSync(destDir, { recursive: true })
    for (const entry of readdirSync(stagingDir)) {
      renameSync(join(stagingDir, entry), join(destDir, entry))
    }
    return existsSync(officialRuntimeEntry(destDir)) ? 'copied' : 'missing'
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

/** 完整判据：完成标记存在、指向同一源目录、且入口仍在。 */
function isCompleteCopy(sourceDir: string, destDir: string, markerPath: string): boolean {
  if (!existsSync(officialRuntimeEntry(destDir))) return false
  if (!existsSync(markerPath)) return false
  let recorded: string
  try {
    recorded = readFileSync(markerPath, 'utf8').trim()
  } catch {
    return false
  }
  return recorded !== '' && recorded === canonicalPath(sourceDir)
}

/** 比对同一目录的不同写法（大小写、短名、正反斜杠）；解析失败时退回 basename 比较。 */
function canonicalPath(dir: string): string {
  try {
    const real = realpathSync.native(dir)
    return process.platform === 'win32' ? real.toLowerCase() : real
  } catch {
    return basename(dir).toLowerCase()
  }
}
