import { spawn } from 'node:child_process'

export interface ProcessRow {
  pid: number
  parentPid: number
  commandLine: string
}

/**
 * 判定哪些 DSH 服务进程是"孤儿"——上一代应用退出时未回收的 harness（bin.js web）
 * 或旧架构桥接（Update-Bridge.js）。它们死占 127.0.0.1 端口，会让新代实例
 * 桥接失败 → 更新服务不可用、外壳拿不到 DSH 地址 → 主视图黑屏（2026-09-20 实证）。
 * 判定规则：不属于以 self 为根的进程树，且命令行匹配上述特征。
 */
export function orphanCandidates(procs: readonly ProcessRow[], self: number): number[] {
  const chain = new Set<number>([self])
  let changed = true
  while (changed) {
    changed = false
    for (const proc of procs) {
      if (chain.has(proc.parentPid) && !chain.has(proc.pid)) {
        chain.add(proc.pid)
        changed = true
      }
    }
  }
  return procs
    .filter(proc => !chain.has(proc.pid))
    .filter(proc => /\bbin\.js\s+web\b/.test(proc.commandLine) || /Update-Bridge\.js/.test(proc.commandLine))
    .map(proc => proc.pid)
}

/** 在启动 DSH 服务之前清扫孤儿进程；返回被杀掉的 PID 列表（无孤儿时为空数组）。 */
export function sweepOrphanDshProcesses(): Promise<number[]> {
  return new Promise(resolve => {
    const script = "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | ForEach-Object { Write-Output ($_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() + '|' + $_.CommandLine) }"
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })
    let out = ''
    let err = ''
    ps.stdout.on('data', chunk => { out += String(chunk) })
    ps.stderr.on('data', chunk => { err += String(chunk) })
    ps.on('error', () => resolve([]))
    ps.on('close', code => {
      if (code !== 0) { resolve([]); return }
      const procs: ProcessRow[] = []
      for (const line of out.split(/\r?\n/)) {
        const parts = line.split('|')
        if (parts.length < 3) continue
        const pid = Number(parts[0])
        const parentPid = Number(parts[1])
        if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue
        procs.push({ pid, parentPid, commandLine: parts.slice(2).join('|') })
      }
      const victims = orphanCandidates(procs, process.pid)
      for (const pid of victims) spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true })
      resolve(victims)
    })
  })
}
