[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ApplicationArguments
)

$ErrorActionPreference = 'Stop'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $portableRoot 'Portable-Environment.ps1')
$portablePaths = Set-DshPortableEnvironment -PortableRoot $portableRoot

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
