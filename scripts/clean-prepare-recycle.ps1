<#
  清理 prepare-runtime 的回收区：Data\Temp\prepare-recycle

  背景：prepare-runtime 重建运行时前会把旧目录同卷 rename 进该回收区（O(1)），
  再由脱离进程树的清理器逐文件删除。G: 盘逐文件删除极慢（实测 ~1 文件/秒级），
  历史积压会累积到几十万文件（2026-09-28 实测：24 条 / 498,729 个文件，最早 9/14），
  串行清理器永远追不上。本脚本用原生 `rd /s /q` 并行清理这段积压。

  安全边界：
  - 只处理 Data\Temp\prepare-recycle 下的条目，永不触碰其它目录；
  - 保留 .sweeping 心跳文件（清理器的去重标记），不删回收区目录本身；
  - 默认 DryRun，只有显式 -Go 才真删；
  - 应用运行期间默认拒绝（需 -Force 显式覆盖）：9/19 事故的成因就是候选冷启动
    撞上大批量删除的盘 I/O（主视图 ERR_FAILED → 自动回滚）。

  用法：
    pwsh -File scripts\clean-prepare-recycle.ps1                 # 只报告（默认）
    pwsh -File scripts\clean-prepare-recycle.ps1 -Go             # 真删（需 app 已退出）
    pwsh -File scripts\clean-prepare-recycle.ps1 -Go -Force      # 应用运行中也删（自行承担风险）
    pwsh -File scripts\clean-prepare-recycle.ps1 -CountFiles     # 递归统计文件数（慢）
#>
param(
  [switch]$Go,
  [switch]$Force,
  [switch]$CountFiles,
  [int]$Parallel = 6
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$recycle = Join-Path $repoRoot 'Data\Temp\prepare-recycle'
$evidenceDir = Join-Path $repoRoot 'Data\Temp'

function Get-RecycleState {
  param([string]$Path, [switch]$Count)
  if (-not (Test-Path $Path)) { return [pscustomobject]@{ Exists = $false; Entries = 0; Names = @(); Files = $null } }
  $all = @(Get-ChildItem $Path -Force -ErrorAction SilentlyContinue)
  $entries = @($all | Where-Object { $_.Name -ne '.sweeping' })
  $files = $null
  if ($Count) {
    $sum = 0
    foreach ($e in $entries) {
      if ($e.PSIsContainer) { $sum += @(Get-ChildItem $e.FullName -Recurse -File -Force -ErrorAction SilentlyContinue).Count }
      else { $sum += 1 }
    }
    $files = $sum
  }
  return [pscustomobject]@{ Exists = $true; Entries = $entries.Count; Names = @($entries | Select-Object -ExpandProperty Name); Files = $files }
}

function Test-AppRunning {
  $names = @('DSH Codex Desktop', 'DSH便携版3', 'electron')
  foreach ($n in $names) {
    if (Get-Process -Name $n -ErrorAction SilentlyContinue) { return $n }
  }
  return $null
}

$before = Get-RecycleState -Path $recycle -Count:$CountFiles
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')

if (-not $before.Exists) {
  Write-Output "回收区不存在（无需清理）：$recycle"
  Write-Output 'RESULT: PASS (nothing to do)'
  exit 0
}

Write-Output "回收区：$recycle"
Write-Output ("清理前条目数：{0}" -f $before.Entries)
if ($before.Entries -gt 0) { Write-Output ('  ' + ($before.Names -join ', ')) }
if ($CountFiles) { Write-Output ("清理前递归文件数：{0}" -f $before.Files) }

if (-not $Go) {
  Write-Output 'DRY RUN：未删除任何内容。加 -Go 才会真删。'
  Write-Output 'RESULT: PASS (dry run)'
  exit 0
}

$running = Test-AppRunning
if ($running -and -not $Force) {
  Write-Output ("检测到应用仍在运行（{0}）：按 9/19 纪律拒绝在候选激活/运行期做大批量删除。" -f $running)
  Write-Output '请先从托盘退出应用，或显式加 -Force 自行承担风险。'
  Write-Output 'RESULT: FAIL (app running)'
  exit 2
}

if ($before.Entries -eq 0) {
  Write-Output '回收区已为空，无需删除。'
  Write-Output 'RESULT: PASS (already empty)'
  exit 0
}

$started = Get-Date
$i = 0
foreach ($name in $before.Names) {
  $target = Join-Path $recycle $name
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('rd /s /q "{0}"' -f $target) -WindowStyle Hidden | Out-Null
  $i++
  if ($i % $Parallel -eq 0) { Start-Sleep -Seconds 10 }
}
# 等到条目清空或超时（默认 30 分钟）
$deadline = (Get-Date).AddMinutes(30)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 15
  $now = Get-RecycleState -Path $recycle
  if ($now.Entries -eq 0) { break }
}

$after = Get-RecycleState -Path $recycle -Count:$CountFiles
$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
$evidence = [pscustomobject]@{
  ts              = (Get-Date).ToUniversalTime().ToString('o')
  recycleDir      = $recycle
  entriesBefore   = $before.Entries
  entriesAfter    = $after.Entries
  filesBefore     = $before.Files
  filesAfter      = $after.Files
  removed         = @($before.Names | Where-Object { $after.Names -notcontains $_ })
  remaining       = $after.Names
  elapsedSeconds  = $elapsed
  appRunningAtStart = $running
}
$evidencePath = Join-Path $evidenceDir ("clean-prepare-recycle-{0}.json" -f $stamp)
$evidence | ConvertTo-Json -Depth 4 | Set-Content -Path $evidencePath -Encoding UTF8

Write-Output ("清理后条目数：{0}" -f $after.Entries)
if ($after.Entries -gt 0) { Write-Output ('  残留：' + ($after.Names -join ', ')) }
if ($CountFiles) { Write-Output ("清理后递归文件数：{0}" -f $after.Files) }
Write-Output ("耗时：{0}s" -f $elapsed)
Write-Output ("证据：{0}" -f $evidencePath)

if ($after.Entries -eq 0) {
  Write-Output 'RESULT: PASS'
  exit 0
}
Write-Output 'RESULT: FAIL (entries remain)'
exit 1
