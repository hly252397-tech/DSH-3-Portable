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

$expectedNodeHash = ([string]$manifest.config.bundledNodeSha256.'win32-x64').ToUpperInvariant()
$nodeNeedsInstall = -not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)
if (-not $nodeNeedsInstall) {
  $nodeNeedsInstall = (Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256).Hash.ToUpperInvariant() -ne $expectedNodeHash
  if ($nodeNeedsInstall) { Write-Host "便携构建 Node 与清单不一致，将更新到 $nodeVersion。" -ForegroundColor Yellow }
}
if ($nodeNeedsInstall) {
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
  $actualHash = (Get-FileHash -LiteralPath $extractedNode -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedNodeHash) { throw 'Node.js 可执行文件 SHA256 校验失败。' }
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
# pnpm 11.24 不读 .npmrc 里的 fetch-timeout，也不接受 --config.X=number（传 string 会 TypeError）。
# 唯一稳定路径是 npm_config_* 环境变量；显式拉长避免 react-icons / node-pty / mermaid 等大 tarball 抖动失败。
$env:npm_config_fetch_timeout = '600000'
$env:npm_config_fetch_retries = '5'
$previousCi = $env:CI
Push-Location $portableRoot
try {
  # 构建器必须可从设置页、CI 或隐藏启动器无人值守运行。整个 pnpm
  # 事务保持 CI 模式，覆盖 run/test 内部触发的依赖状态检查和子 pnpm。
  $env:CI = 'true'
  & $pnpmCommand install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败。' }
  $electronExecutable = Join-Path $portableRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
    & $nodeExecutable (Join-Path $portableRoot 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
      throw 'Electron 安装脚本未生成开发态可执行文件。'
    }
  }
  if (-not $SkipTests) {
    & $pnpmCommand test
    if ($LASTEXITCODE -ne 0) { throw '测试失败，未部署新构建。' }
  }
  & $pnpmCommand run pack
  if ($LASTEXITCODE -ne 0) { throw '桌面端打包失败。' }
} finally {
  $env:CI = $previousCi
  Pop-Location
}

$builtApp = Join-Path $portableRoot 'release\win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $builtApp 'DSH Codex Desktop.exe') -PathType Leaf)) {
  throw '未找到 release\win-unpacked 构建结果。'
}
Write-Host "源码构建及门禁已完成：$builtApp" -ForegroundColor Green
Write-Host '正在把本地构建送入统一 A/B 候选槽（不会覆盖或结束当前 App）…'
& $nodeExecutable (Join-Path $portableRoot 'dist\scripts\stage-local-desktop-candidate.js') $portableRoot $builtApp ([string]$manifest.version) --replace-pending
if ($LASTEXITCODE -ne 0) { throw '本地构建未能进入 A/B 候选槽。' }
Write-Host '候选已暂存。请从托盘正常退出或使用“重启应用”；启动器会部署、验证，失败时自动回滚。' -ForegroundColor Yellow
