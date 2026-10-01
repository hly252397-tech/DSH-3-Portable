# 2026-09-30 T12 僵尸进程清理
#
# 纪律（任务单 T12-3）：只杀「不属于当前桌面进程树」且「确认无业务在用」的；
# 杀前把 PID + 启动时间 + 命令行 + 占用端口落成证据文件，便于回溯。
#
# 保留白名单（任务单 T12-2）：
#   9800 / 9801 / 62060  —— DSH 内核 / Agent MCP / 会话服务
#   8975 / 8976 / 8977    —— 工作台与 hj 探测 broker（正在服务）
#   8799                 —— 宏建云系统 db 服务，跨项目，不在本轮范围
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File Scripts/zombie-sweep-20260930.ps1 [-Apply]

param(
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $root 'Data\Temp\zombie-sweep-20260930-evidence.json'

# 本轮判定为可清理的目标：显式 PID 清单，不用模糊匹配。
$targets = @(
  @{ pid = 27660; reason = '11 天前的 npx serve -l 3000（2026-09-19 16:32）' },
  @{ pid = 13432; reason = '上述 npx serve 的父进程（npm npx-cli），2026-09-19 16:32' },
  @{ pid = 65924; reason = 'python http.server 4173，2026-09-27 遗留' },
  @{ pid = 2548;  reason = 'python http.server 8848，2026-09-21 遗留' },
  @{ pid = 59104; reason = 'runtime-node serve.mjs 8932，2026-09-28 遗留' },
  @{ pid = 55344; reason = 'python http.server 8933，2026-09-29 10:11 遗留' },
  @{ pid = 61588; reason = 'python http.server 8980，2026-09-29 10:53 遗留' }
)

# 这些是重复副本：同端口已有一个在监听，其余根本不提供服务。
$duplicates = @(
  10648, 20908, 75124, 80412, 81776, 41160, 56848, 5992, 44600, 24796, 60436, 35024, 10936,
  72940, 26380, 63084, 47292, 57696, 15316, 9700, 22732, 46120,
  3848, 38056, 42016, 34104, 48868
)

function Get-ProcInfo([int]$processId) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $null }
  $listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $processId } |
    Select-Object -ExpandProperty LocalPort)
  return [ordered]@{
    pid           = $processId
    name          = $p.Name
    started       = $p.CreationDate
    commandLine   = $p.CommandLine
    listenPorts   = $listen
  }
}

# 持有这些端口的一律跳过，无论它出现在哪个清单里。
# 端口归属是唯一硬判据 —— 进程名/命令行会骗人，端口不会。
$keptPorts = @(9800, 9801, 62060, 8975, 8976, 8977, 8799)

$report = [ordered]@{
  generatedAt   = (Get-Date).ToString('o')
  mode          = if ($Apply) { 'apply' } else { 'report' }
  keptPorts     = $keptPorts
  targets       = @()
  duplicates    = @()
  skippedKept   = @()
  killed        = @()
  failed        = @()
}

foreach ($t in $targets) {
  $info = Get-ProcInfo $t.pid
  if ($null -eq $info) { continue }
  $info['reason'] = $t.reason
  $report.targets += $info
}

foreach ($d in $duplicates) {
  $info = Get-ProcInfo $d
  if ($null -eq $info) { continue }
  $info['reason'] = '重复副本：同端口已有一个在监听'
  $report.duplicates += $info
}

# 应用守卫：持有保留端口的移出待杀清单，记进 skippedKept。
$killable = @()
foreach ($info in @($report.targets) + @($report.duplicates)) {
  $held = @($info['listenPorts'] | Where-Object { $keptPorts -contains $_ })
  if ($held.Count -gt 0) {
    $info['skippedReason'] = "持有保留端口 $($held -join ',')，跳过"
    $report.skippedKept += $info
  } else {
    $killable += $info
  }
}
# 被跳过的要从待杀分组里摘掉，避免报告里既列"待杀"又列"跳过"。
$report.targets    = @($killable | Where-Object { $_.reason -ne '重复副本：同端口已有一个在监听' })
$report.duplicates = @($killable | Where-Object { $_.reason -eq '重复副本：同端口已有一个在监听' })

if ($Apply) {
  foreach ($info in $killable) {
    $id = $info['pid']
    try {
      Stop-Process -Id $id -Force -ErrorAction Stop
      $report.killed += $id
    } catch {
      $report.failed += [ordered]@{ pid = $id; error = $_.Exception.Message }
    }
  }
}

$report | ConvertTo-Json -Depth 6 | Set-Content -Path $evidence -Encoding UTF8

Write-Host "模式: $($report.mode)"
Write-Host "待杀: $($report.targets.Count)  重复副本: $($report.duplicates.Count)  守端口跳过: $($report.skippedKept.Count)"
foreach ($s in $report.skippedKept) { Write-Host "  SKIP $($s['pid']) $($s['skippedReason'])" }
if ($Apply) {
  Write-Host "已杀: $($report.killed.Count)  失败: $($report.failed.Count)"
  if ($report.failed.Count -gt 0) { $report.failed | ForEach-Object { Write-Host "  FAIL $($_.pid): $($_.error)" } }
} else {
  Write-Host "（报告模式，未杀任何进程。加 -Apply 执行）"
}
Write-Host "证据: $evidence"
