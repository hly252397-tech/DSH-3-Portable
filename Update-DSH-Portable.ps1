[CmdletBinding()]
param(
  [string]$Version = 'latest',
  [switch]$LaunchAfterUpdate
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $portableRoot 'Portable-Environment.ps1')
$portablePaths = Set-DshPortableEnvironment -PortableRoot $portableRoot

function Assert-ChildPath {
  param([string]$Parent, [string]$Child)
  $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childPath = [System.IO.Path]::GetFullPath($Child)
  if (-not $childPath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作便携盘范围外的路径：$childPath"
  }
}

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -and [System.IO.Path]::GetFullPath($_.Path).StartsWith(([System.IO.Path]::GetFullPath($portablePaths.App).TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
}
if ($running) {
  throw '请先从托盘彻底退出 DSH Codex Desktop，再运行更新。'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'DSH-3-Portable-Updater' }
$releaseUri = if ($Version -eq 'latest') {
  'https://api.github.com/repos/MichengAI/dsh-codex-desktop/releases/latest'
} else {
  'https://api.github.com/repos/MichengAI/dsh-codex-desktop/releases/tags/v' + $Version.TrimStart('v')
}

Write-Host '正在读取 MichengAI 官方发布信息…'
$release = Invoke-RestMethod -Uri $releaseUri -Headers $headers
$asset = $release.assets | Where-Object { $_.name -match '^dsh-codex-desktop-.+-win-x64\.zip$' } | Select-Object -First 1
if (-not $asset) {
  throw "发布 $($release.tag_name) 中没有 Windows x64 ZIP。"
}

$updatesRoot = Join-Path $portablePaths.Data 'Updates'
$downloadsRoot = Join-Path $updatesRoot 'Downloads'
$stagingRoot = Join-Path $updatesRoot 'Staging'
$backupsRoot = Join-Path $updatesRoot 'Backups'
foreach ($directory in @($updatesRoot, $downloadsRoot, $stagingRoot, $backupsRoot)) {
  Assert-ChildPath -Parent $portablePaths.Data -Child $directory
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$archive = Join-Path $downloadsRoot $asset.name
Write-Host "正在下载 $($asset.name)…"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -Headers $headers

if ($asset.digest -and $asset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
  $expectedHash = $Matches[1].ToUpperInvariant()
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedHash) { throw '更新包 SHA256 校验失败，未替换当前应用。' }
  Write-Host 'SHA256 校验通过。'
} else {
  Write-Warning 'GitHub 未提供可用的 SHA256 摘要；本次更新仅使用 HTTPS 来源校验。'
}

$stage = Join-Path $stagingRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
Assert-ChildPath -Parent $stagingRoot -Child $stage
New-Item -ItemType Directory -Path $stage | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $stage

$newExecutable = Get-ChildItem -LiteralPath $stage -Recurse -File -Filter 'DSH Codex Desktop.exe' | Select-Object -First 1
if (-not $newExecutable) { throw '更新包中未找到 DSH Codex Desktop.exe，当前应用未被替换。' }
$newApp = $newExecutable.Directory.FullName
Assert-ChildPath -Parent $stage -Child $newApp
if (-not (Test-Path -LiteralPath (Join-Path $newApp 'resources\app.asar') -PathType Leaf)) {
  throw '更新包结构不完整，当前应用未被替换。'
}

$backup = Join-Path $backupsRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $release.tag_name)
Assert-ChildPath -Parent $backupsRoot -Child $backup
$oldAppMoved = $false
try {
  if (Test-Path -LiteralPath $portablePaths.App) {
    Move-Item -LiteralPath $portablePaths.App -Destination $backup
    $oldAppMoved = $true
  }
  Move-Item -LiteralPath $newApp -Destination $portablePaths.App

  $overlay = Join-Path $portableRoot 'Customize\App-Overlay'
  if (Test-Path -LiteralPath $overlay) {
    Copy-Item -Path (Join-Path $overlay '*') -Destination $portablePaths.App -Recurse -Force
  }
  $hook = Join-Path $portableRoot 'Customize\After-Update.ps1'
  if (Test-Path -LiteralPath $hook -PathType Leaf) {
    & $hook -PortableRoot $portableRoot -AppDirectory $portablePaths.App -Version ([string]$release.tag_name)
    if ($LASTEXITCODE) { throw "After-Update.ps1 返回退出码 $LASTEXITCODE。" }
  }

  $installed = [ordered]@{
    version = [string]$release.tag_name
    asset = [string]$asset.name
    installedAt = (Get-Date).ToString('o')
    source = [string]$asset.browser_download_url
  }
  $installed | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $updatesRoot 'installed.json') -Encoding UTF8
} catch {
  if ($oldAppMoved -and -not (Test-Path -LiteralPath $portablePaths.App) -and (Test-Path -LiteralPath $backup)) {
    Move-Item -LiteralPath $backup -Destination $portablePaths.App
  }
  throw
}

Write-Host "已部署 $($release.tag_name)。Data、Workspace、Customize 和源码均未改动。" -ForegroundColor Green
if ($oldAppMoved) { Write-Host "旧版可恢复备份：$backup" }
if ($LaunchAfterUpdate) { & (Join-Path $portableRoot 'Start-DSH-Portable.ps1') }
