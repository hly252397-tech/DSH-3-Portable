/**
 * 启动任务的**实测计量**：有总量的任务给出 `completed/total`，没有总量的任务保持不确定进度。
 * 与固定百分比阶梯（`STARTUP_PROGRESS`）并存：阶梯负责粗粒度里程碑，本模型负责真实计数，
 * 两者由 `advanceStartupProgress` 合并为单调不回退的显示值。
 */
export interface StartupProgress {
  phase: 'verify' | 'extract' | 'copy' | 'scan' | 'sync' | 'index' | 'install' | 'server' | 'renderer'
  completed?: number
  total?: number
  unit?: 'bytes' | 'files' | 'entries'
  detail?: { resolved: number; reused: number; downloaded: number; added: number }
}

/** pnpm 的实时输出行 → 实测进度。解析不出返回 undefined，交由调用方忽略该行。 */
export function parsePnpmProgress(line: string): StartupProgress | undefined {
  const match = /^Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/.exec(line)
  if (match === null) return undefined
  const [resolved, reused, downloaded, added] = match.slice(1).map(Number)
  return { phase: 'install', detail: { resolved, reused, downloaded, added } }
}

const STARTUP_PROGRESS_LABELS: Record<StartupProgress['phase'], readonly [string, string]> = {
  verify: ['正在校验随包资源', 'Verifying bundled resources'],
  extract: ['正在解压随包资源', 'Extracting bundled resources'],
  copy: ['正在写入运行环境文件', 'Writing runtime files'],
  scan: ['正在统计配套依赖文件', 'Counting bundled dependency files'],
  sync: ['正在同步配套依赖文件', 'Syncing bundled dependency files'],
  index: ['正在更新依赖索引', 'Updating the dependency index'],
  install: ['正在安装插件及依赖', 'Installing plugins and dependencies'],
  server: ['正在启动 DSH 服务', 'Starting the DSH service'],
  renderer: ['正在加载工作界面', 'Loading the workspace'],
}

/** 把实测进度渲染成启动窗口可直接显示的主文案 + 细节行。 */
export function formatStartupProgress(progress: StartupProgress, zh: boolean): {
  message: string
  detail: string
  completed?: number
  total?: number
} {
  let detail = ''
  const { completed, total } = progress
  const measured = typeof completed === 'number' && typeof total === 'number'
    && Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= 0 && completed <= total
  if (measured) {
    detail = progress.unit === 'bytes'
      ? `${(completed / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
      : `${completed.toLocaleString()} / ${total.toLocaleString()} ${progress.unit === 'entries'
        ? (zh ? '项' : 'entries')
        : progress.phase === 'sync'
          ? (zh ? '个文件（含已存在）' : 'files (including existing files)')
          : (zh ? '个文件' : 'files')}`
  }
  if (progress.detail !== undefined) {
    const { resolved, reused, downloaded, added } = progress.detail
    detail = zh
      ? `已解析 ${resolved} · 已复用 ${reused} · 已下载 ${downloaded} · 已安装 ${added}`
      : `Resolved ${resolved} · Reused ${reused} · Downloaded ${downloaded} · Added ${added}`
  }
  return {
    message: STARTUP_PROGRESS_LABELS[progress.phase][zh ? 0 : 1],
    detail,
    ...(measured ? { completed, total } : {}),
  }
}

export const STARTUP_PROGRESS = {
  boot: 5,
  firstLaunchPreparation: 10,
  runtimeExtractionStarted: 15,
  runtimeReady: 45,
  pluginStorePreparationStarted: 50,
  pluginStoreReady: 70,
  workspacePreparation: 74,
  bundledPluginsReady: 80,
  profileUpdatesApplied: 84,
  profileReady: 88,
  dshStarting: 90,
  dshReady: 97,
  complete: 100,
} as const

export function advanceStartupProgress(current: number, candidate: number): number {
  const normalizedCurrent = normalizePercentage(current)
  const normalizedCandidate = normalizePercentage(candidate)
  return Math.max(normalizedCurrent, normalizedCandidate)
}

function normalizePercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}
