[CmdletBinding()]
param([switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $portableRoot 'Portable-Environment.ps1')
$portablePaths = Set-DshPortableEnvironment -PortableRoot $portableRoot
$manifest = Get-Content -LiteralPath (Join-Path $portableRoot 'package.json') -Raw | ConvertFrom-Json
$nodeVersion = [string]$manifest.engines.node
$pnpmVersion = ([string]$manifest.packageManager).Split('@')[-1]
$toolsRoot = Join-Path $portableRoot 'Tools'
$nodeRoot = Join-Path $toolsRoot 'node'
$nodeExecutable = Join-Path $nodeRoot 'node.exe'
$downloads = Join-Path $portablePaths.Development 'downloads'
New-Item -ItemType Directory -Path $downloads, $toolsRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  $archiveName = "node-v$nodeVersion-win-x64.zip"
  $archive = Join-Path $downloads $archiveName
  $downloadUri = "https://nodejs.org/dist/v$nodeVersion/$archiveName"
  Write-Host "正在把 Node.js $nodeVersion 下载到便携盘…"
  Invoke-WebRequest -Uri $downloadUri -OutFile $archive
  $stage = Join-Path $portablePaths.Development ('node-stage-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $stage
  $extracted = Join-Path $stage "node-v$nodeVersion-win-x64"
  $extractedNode = Join-Path $extracted 'node.exe'
  if (-not (Test-Path -LiteralPath $extractedNode)) { throw 'Node.js 解压结构无效。' }
  $expectedHash = ([string]$manifest.config.bundledNodeSha256.'win32-x64').ToUpperInvariant()
  $actualHash = (Get-FileHash -LiteralPath $extractedNode -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedHash) { throw 'Node.js 可执行文件 SHA256 校验失败。' }
  if (Test-Path -LiteralPath $nodeRoot) {
    Move-Item -LiteralPath $nodeRoot -Destination (Join-Path $portablePaths.Development ('node-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
  }
  Move-Item -LiteralPath $extracted -Destination $nodeRoot
}

$pnpmRoot = Join-Path $portableRoot 'Tools\pnpm'
$pnpmCommand = Join-Path $pnpmRoot 'pnpm.cmd'
if (-not (Test-Path -LiteralPath $pnpmCommand -PathType Leaf)) {
  Write-Host "正在把 pnpm $pnpmVersion 安装到便携盘…"
  & (Join-Path $nodeRoot 'npm.cmd') install --global "pnpm@$pnpmVersion" --prefix $pnpmRoot
  if ($LASTEXITCODE -ne 0) { throw '安装便携 pnpm 失败。' }
}

$env:PATH = "$nodeRoot;$pnpmRoot;$env:PATH"
Push-Location $portableRoot
try {
  & $pnpmCommand install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败。' }
  if (-not $SkipTests) {
    & $pnpmCommand test
    if ($LASTEXITCODE -ne 0) { throw '测试失败，未部署新构建。' }
  }
  & $pnpmCommand run pack
  if ($LASTEXITCODE -ne 0) { throw '桌面端打包失败。' }
} finally {
  Pop-Location
}

$builtApp = Join-Path $portableRoot 'release\win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $builtApp 'DSH Codex Desktop.exe') -PathType Leaf)) {
  throw '未找到 release\win-unpacked 构建结果。'
}
$backupsRoot = Join-Path $portablePaths.Data 'Updates\Backups'
New-Item -ItemType Directory -Path $backupsRoot -Force | Out-Null
if (Test-Path -LiteralPath $portablePaths.App) {
  $backup = Join-Path $backupsRoot ('source-build-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item -LiteralPath $portablePaths.App -Destination $backup
  Write-Host "原 App 已备份到：$backup"
}
Copy-Item -LiteralPath $builtApp -Destination $portablePaths.App -Recurse
Write-Host '便携版 3 已从源码构建并部署到 App。' -ForegroundColor Green
