[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ApplicationArguments
)

$ErrorActionPreference = 'Stop'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $portableRoot 'Portable-Environment.ps1')
$portablePaths = Set-DshPortableEnvironment -PortableRoot $portableRoot

# 待部署的新构建（内置浏览器移植）在启动前自动落地，失败不影响继续启动
$deployScript = Join-Path $portableRoot 'deploy-new-build.ps1'
if (Test-Path -LiteralPath $deployScript -PathType Leaf) {
  try { & $deployScript -Auto } catch { Write-Warning "自动部署跳过：$($_.Exception.Message)" }
}

$application = Join-Path $portablePaths.App 'DSH Codex Desktop.exe'
if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
  throw "尚未部署桌面程序。请先运行 Update-DSH-Portable.cmd（官网下载）或 Build-DSH-Portable.cmd（从源码构建）。"
}

$launchArguments = @(
  '--user-data-dir="' + $portablePaths.UserData + '"'
  '--disk-cache-dir="' + $portablePaths.Cache + '"'
)
foreach ($argument in $ApplicationArguments) {
  if (-not [string]::IsNullOrEmpty($argument)) { $launchArguments += $argument }
}

Start-Process -FilePath $application -ArgumentList $launchArguments -WorkingDirectory $portablePaths.Workspace
