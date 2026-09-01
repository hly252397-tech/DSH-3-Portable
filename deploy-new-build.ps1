# 部署新构建到 App\（含内置浏览器移植）
# 用法：
#   直接运行           - 应用未运行时执行部署；运行中则报错退出
#   -Watch            - 等待 DSH Codex Desktop 完全退出后再部署（可放后台）
#   -Auto             - 供 Start-DSH-Portable.ps1 启动时调用：有 marker 才部署
[CmdletBinding()]
param(
  [switch]$Watch,
  [switch]$Auto
)
$ErrorActionPreference = 'Stop'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$builtApp = Join-Path $portableRoot 'release\win-unpacked'
$app = Join-Path $portableRoot 'App'
$backupsRoot = Join-Path $portableRoot 'Data\Updates\Backups'
$marker = Join-Path $backupsRoot 'browser-port-staged'
$log = Join-Path $backupsRoot 'deploy-browser-port.log'

function Write-Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Write-Host $line
  try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch {}
}

function Test-AppRunning {
  return [bool](Get-Process -Name 'DSH Codex Desktop' -ErrorAction SilentlyContinue)
}

function Invoke-Deploy {
  if (-not (Test-Path -LiteralPath (Join-Path $builtApp 'DSH Codex Desktop.exe') -PathType Leaf)) {
    throw "未找到构建产物：$builtApp"
  }
  if (Test-AppRunning) { throw 'DSH Codex Desktop 正在运行，请先从系统托盘彻底退出后再部署。' }
  New-Item -ItemType Directory -Path $backupsRoot -Force | Out-Null
  # 先在 Data 内复制并验证完整构建，再用同盘改名一次性切换 App。
  # 这样复制较慢或启动脚本被中断时，用户仍只能看到上一版完整 App。
  $stagingRoot = Join-Path $portableRoot 'Data\Updates\Staging'
  New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
  $stagedApp = Join-Path $stagingRoot ('browser-port-' + [guid]::NewGuid().ToString('N'))
  Copy-Item -LiteralPath $builtApp -Destination $stagedApp -Recurse
  foreach ($required in @(
    'DSH Codex Desktop.exe',
    'resources\app.asar',
    'resources\desktop-bridge\dsh-process.js',
    'resources\desktop-bridge\profile-bundle-health.js',
    'resources\desktop-bridge\profile-quarantine.js',
    'resources\node\node.exe',
    'resources\dsh-runtime.tgz',
    'resources\dsh-runtime.tgz.sha256',
    'resources\plugins-store.tgz',
    'resources\plugins-store.tgz.sha256'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $stagedApp $required) -PathType Leaf)) {
      throw "暂存构建不完整，缺少：$required"
    }
  }
  foreach ($pair in @(
    @('resources\dsh-runtime.tgz', 'resources\dsh-runtime.tgz.sha256'),
    @('resources\plugins-store.tgz', 'resources\plugins-store.tgz.sha256')
  )) {
    $archive = Join-Path $stagedApp $pair[0]
    $hashFile = Join-Path $stagedApp $pair[1]
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $expected = ([System.IO.File]::ReadAllText($hashFile)).Trim().Split()[0].ToLowerInvariant()
    if ($actual -ne $expected) { throw "暂存构建归档校验失败：$($pair[0])" }
  }
  if (Test-Path -LiteralPath $app) {
    $backup = Join-Path $backupsRoot ('browser-port-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $app -Destination $backup
    Write-Log "原 App 已备份到：$backup"
  }
  Move-Item -LiteralPath $stagedApp -Destination $app
  Write-Log '新构建（含内置浏览器）已部署到 App。'
}

if ($Auto) {
  # 启动时调用：仅当存在部署标记时才执行，失败不阻断启动
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { exit 0 }
  try {
    Invoke-Deploy
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Log "自动部署失败：$($_.Exception.Message)"
  }
  exit 0
}

if ($Watch) {
  Write-Log '监视模式：等待 DSH Codex Desktop 退出后自动部署…'
  while (Test-AppRunning) { Start-Sleep -Seconds 2 }
  Start-Sleep -Seconds 1
}

try {
  Invoke-Deploy
  New-Item -ItemType Directory -Path $backupsRoot -Force | Out-Null
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
} catch {
  Write-Log "部署失败：$($_.Exception.Message)"
  Write-Host "部署失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
Write-Host '部署完成。现在可以重新启动 DSH 便携版 3。' -ForegroundColor Green
